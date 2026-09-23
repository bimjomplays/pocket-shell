// App only: bigger text and chat-list Bitmojis without zooming the rest (Snapchat Web's are small on a
// phone next to the real app). Every element that sets its own font size gets it multiplied by FACTOR as
// an inline style; elements that only inherit a size are left alone so nothing is scaled twice. Bitmojis
// and the camera icons in the chat list get a transform (AVATAR, CAMERA), which keeps the rows' layout.
(() => {
  if (window.top !== window) return;
  const FACTOR = 1.42;
  const AVATAR = 1.1;
  const CAMERA = 1.65;
  const BADGE = 0.85; // friend emoji on the Bitmojis
  const SUBTEXT = 1.34; // chat list: the small Opened / Delivered line under the names
  const MARK = "data-dg-fs";
  const LIST = ".ReactVirtualized__Grid__innerScrollContainer";

  // the box around a chat-list Bitmoji (not the small emoji badges), grown in place
  function avatar(img) {
    if (img.hasAttribute("data-dg-avatar") || !img.closest(LIST)) return;
    const w = img.getBoundingClientRect().width;
    if (!w) return void img.addEventListener("load", () => avatar(img), { once: true });
    if (w < 30) {
      img.setAttribute("data-dg-avatar", "");
      img.style.setProperty("transform", `scale(${BADGE})`, "important");
      return;
    }
    let box = img;
    while (box.parentElement && box.parentElement.getBoundingClientRect().width <= w + 8) box = box.parentElement;
    img.setAttribute("data-dg-avatar", "");
    box.style.setProperty("transform", `scale(${AVATAR})`, "important");
  }

  function scaledAncestor(el) {
    for (let p = el.parentElement; p; p = p.parentElement) if (p.hasAttribute(MARK)) return p;
    return null;
  }

  // the camera button icon at the right end of each chat row (not the small status icons by the text)
  function camera(svg) {
    if (svg.hasAttribute("data-dg-cam")) return;
    const list = svg.closest(LIST);
    if (!list) return;
    const r = svg.getBoundingClientRect(), l = list.getBoundingClientRect();
    if (!r.width || r.width < 14 || r.left < l.left + l.width * 0.7) return;
    svg.setAttribute("data-dg-cam", "");
    svg.style.setProperty("transform", `scale(${CAMERA})`, "important");
    svg.style.setProperty("overflow", "visible", "important");
  }

  function scale(el) {
    if (el.hasAttribute(MARK) || el.closest("svg")) return;
    // the story viewer's header has its own sizes (stories.css); scaling those again made the name huge
    if (el.closest('div:has(~ [aria-label="media content"])')) return;
    if (el.closest('[data-dg-apphead] [role="listbox"]')) return; // settings menu: sized by header.css
    if (el.closest('div:has(> [role="textbox"]) > div:has(header)')) return; // "replying to" quote in the message box: sized by chat.css
    if (el.closest('[data-dg-actionmenu]')) return; // long-press menu: sized by gestures.css
    // friend emoji badge on a Bitmoji (a text emoji in a small circle next to the <img>): smaller, not
    // bigger, and centred in its circle - scaled up it hung out of the bottom of the circle
    const badge = el.parentElement;
    if (badge && badge.previousElementSibling && badge.previousElementSibling.tagName === "IMG" && el.closest(LIST)) {
      el.setAttribute(MARK, "badge");
      el.style.setProperty("font-size", "12.5px", "important");
      el.style.setProperty("line-height", "1", "important");
      el.style.setProperty("display", "block", "important");
      badge.style.setProperty("display", "flex", "important");
      badge.style.setProperty("align-items", "center", "important");
      badge.style.setProperty("justify-content", "center", "important");
      return;
    }
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (!size) return;
    const anc = scaledAncestor(el);
    if (anc && parseFloat(getComputedStyle(anc).fontSize) === size) return; // inherited, already scaled
    el.setAttribute(MARK, String(size));
    const f = size < 15 && el.closest(LIST) ? SUBTEXT : el.closest("[data-dg-header]") ? 1.7 : FACTOR; // chat header name: bigger
    el.style.setProperty("font-size", (size * f).toFixed(2) + "px", "important");
    const lh = parseFloat(cs.lineHeight);
    // chat messages: Snapchat Web's airy desktop line spacing becomes the app's tighter one
    if (el.closest('[data-dg-column] ul[id^="cv-"]')) el.style.setProperty("line-height", (size * f * 1.28).toFixed(2) + "px", "important");
    else if (lh) el.style.setProperty("line-height", (lh * f).toFixed(2) + "px", "important");
  }

  const hasText = (el) => {
    for (const n of el.childNodes) if (n.nodeType === 3 && n.data.trim()) return true;
    return /^(INPUT|TEXTAREA|BUTTON)$/.test(el.tagName) || el.isContentEditable;
  };

  function visit(root) {
    if (root.nodeType !== 1) return;
    const check = (el) => {
      if (el.tagName === "IMG") avatar(el);
      else if (el.tagName.toLowerCase() === "svg") camera(el);
      else if (hasText(el)) scale(el);
    };
    check(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) check(el);
  }

  let pending = new Set(), queued = false;
  const flush = () => {
    queued = false;
    const roots = [...pending];
    pending = new Set();
    for (const r of roots) if (r.isConnected) visit(r);
  };
  (function start() {
    if (!document.body) return void setTimeout(start, 50);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") { if (r.target.parentElement) pending.add(r.target.parentElement); }
        else for (const n of r.addedNodes) pending.add(n.nodeType === 1 ? n : n.parentElement);
      }
      pending.delete(null);
      if (!queued) { queued = true; requestAnimationFrame(flush); }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    visit(document.body);
  })();
})();
