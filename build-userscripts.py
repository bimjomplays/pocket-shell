"""Build two Safari Userscripts files without changing the desktop extension."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent
out = root / 'safari-install'
out.mkdir(exist_ok=True)

def header(name, world, timing, grants):
    lines = ['// ==UserScript==', f'// @name {name}', '// @version 0.5.0',
             '// @description Experimental iPhone port of Dark Glass for Snapchat',
             '// @match https://www.snapchat.com/web*', '// @match https://web.snapchat.com/*',
             f'// @inject-into {world}', f'// @run-at {timing}', '// @noframes']
    lines += [f'// @grant {grant}' for grant in grants]
    return '\n'.join(lines + ['// ==/UserScript==', ''])

def read(name):
    return (root / name).read_text()

# Userscripts' own page injection is an inline <script>, which Snapchat's CSP blocks
# (script-src has no 'unsafe-inline' but does allow blob:). So this runs in the content
# world and loads the hooks into the page as a blob: script before Snapchat's deferred bundle.
hooks = '\n'.join(read(name) for name in ['presence.js', 'snap-clean.js', 'gifs-find.js'])
hooks = ('(() => { if (window.__dgHooks) return; window.__dgHooks = true;\n'
         'document.documentElement.dataset.dgHooks = document.readyState === "loading" ? "early" : "late";\n'
         + hooks + '\n})();\n')
page = header('Dark Mobile — page hooks', 'content', 'document-start', ['none'])
page += '(() => {\nif (window.top !== window) return;\nconst code = ' + json.dumps(hooks) + ';\n'
page += '''const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
const tag = document.createElement("script");
tag.src = url;
tag.onload = tag.onerror = () => { URL.revokeObjectURL(url); tag.remove(); };
(document.head || document.documentElement).appendChild(tag);
})();
'''
(out / 'dark-mobile-hooks.user.js').write_text(page)

content = header('Dark Mobile — theme and GIFs', 'content', 'document-start',
                 ['GM.getValue', 'GM.setValue', 'GM.xmlHttpRequest'])
content += '\n(() => {\nif (window.top !== window) return;\n'
content += read('userscripts-adapter.js') + '\n' + read('background.js') + '\n'
css = read('glass.css') + '\n' + read('mobile.css')
content += 'const css = ' + json.dumps(css) + ';\n'
content += '''function start() {
  if (!document.documentElement) return void setTimeout(start, 10);
  if (document.getElementById('dg-mobile-style')) return;
  const style = document.createElement('style');
  style.id = 'dg-mobile-style'; style.textContent = css;
  document.documentElement.appendChild(style);
'''
content += '\n'.join(read(name) for name in ['glass.js', 'gifs-show.js', 'gif-picker.js', 'gif-anim.js'])
# No console on iPhone: say so on screen if the page hooks didn't load.
content += '''
setTimeout(() => {
  // presence can only be fixed if the hooks ran before Snapchat's bundle; "late" here is a readyState
  // guess and was a false alarm on iPhone (hooks still in time), so only a missing script is reported
  if (document.documentElement.dataset.dgHooks) return;
  const note = document.createElement("div");
  note.textContent = "Dark Mobile: page hooks script isn't running";
  note.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;padding:10px 14px;border-radius:10px;background:#b3261e;color:#fff;font:14px system-ui;text-align:center";
  note.onclick = () => note.remove();
  document.body.appendChild(note);
  setTimeout(() => note.remove(), 8000);
}, 4000);
'''
content += '\n}\nstart();\n})();\n'
(out / 'dark-mobile-ui.user.js').write_text(content)

# iPhone app (ios/): the same code, injected by WKWebView instead of Userscripts
app = root / 'ios' / 'Resources'
(app / 'hooks.js').write_text(hooks)
(app / 'ui.js').write_text(content)

with zipfile.ZipFile(root / 'Dark-Mobile-Safari.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(out.glob('*.user.js')):
        archive.write(path, path.name)
print(root / 'Dark-Mobile-Safari.zip')
