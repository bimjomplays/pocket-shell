// App only: make the page feel like an app under a finger - no tap flash, no long-press menus or text
// selection on the interface, no double-tap zoom delay, no rubber-banding of the whole page, no hover
// styles that stick after a tap, pressed states instead, and chats that slide in.
(() => {
  if (window.top !== window) return;
  const css = `
    html, body { overscroll-behavior: none !important; }
    * { -webkit-tap-highlight-color: transparent !important; -webkit-touch-callout: none !important; }
    body { -webkit-user-select: none !important; user-select: none !important; touch-action: manipulation; }
    input, textarea, [contenteditable="true"], [contenteditable="true"] *,
    html.dg-chat li[data-dg-bubble], html.dg-chat li[data-dg-bubble] * {
      -webkit-user-select: text !important; user-select: text !important;
    }
    a, button, [role="button"], [role="listitem"], [data-dg-fill] { touch-action: manipulation !important; }
    img { -webkit-user-drag: none !important; }
    .ReactVirtualized__Grid, [data-dg-column] ul, [data-dg-column] [role="list"] {
      -webkit-overflow-scrolling: touch; overscroll-behavior: contain !important;
    }
    /* a tap leaves :hover stuck on touch screens: rows only light up while pressed */
    html.dg-glass.dg-list [data-dg-fill]:hover { background-color: #121212 !important; }
    html.dg-glass.dg-list [data-dg-fill]:active { background-color: #232323 !important; }
    /* Pressed look, set by the touch handler below (not :active + :has(): those made every page update slower and
       :active only shows after iOS's tap delay). Pictures, GIFs, stickers, message media and chat rows don't press in. */
    button, [role="button"] { transition: transform 0.12s ease, opacity 0.12s ease !important; }
    [data-dg-pressed] { transform: scale(0.94) !important; opacity: 0.75 !important; transition: transform 0.05s ease, opacity 0.05s ease !important; }
    button[data-dg-pressed][data-dg-newchat] { transform: scale(0.92) !important; }
    /* chats slide in from the right, the list fades back in */
    @keyframes dg-slide-in { from { transform: translateX(28%); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes dg-fade-in { from { opacity: 0; } to { opacity: 1; } }
    html.dg-chat [data-dg-column] { animation: dg-slide-in 0.16s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
    html.dg-chat[data-dg-settling] [data-dg-column] { animation: none !important; opacity: 0 !important; }
    html.dg-list:not(.dg-stories) [data-dg-sidebar] { animation: dg-fade-in 0.18s ease both; }
    @media (prefers-reduced-motion: reduce) {
      html.dg-chat [data-dg-column], html.dg-list [data-dg-sidebar] { animation: none !important; }
    }`;
  let pressed = null, px = 0, py = 0;
  const release = () => { if (pressed) { pressed.removeAttribute("data-dg-pressed"); pressed = null; } };
  addEventListener("touchstart", (e) => {
    release();
    const t = e.touches[0], el = e.target.closest && e.target.closest('button, [role="button"]');
    if (!t || !el || e.touches.length > 1) return;
    if (el.closest('.dg-gif-panel, [data-dg-sidebar] .ReactVirtualized__Grid, #portal-container, ul[id^="cv-"]') || el.querySelector("img, video, canvas")) return;
    if (el.tagName !== "BUTTON" && el.closest("[data-dg-column]")) return; // (as before: no press-in on role=button elements in an open chat)
    pressed = el; px = t.clientX; py = t.clientY;
    el.setAttribute("data-dg-pressed", "");
  }, { capture: true, passive: true });
  addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (pressed && t && Math.hypot(t.clientX - px, t.clientY - py) > 10) release(); // a scroll, not a tap
  }, { capture: true, passive: true });
  addEventListener("touchend", () => setTimeout(release, 60), { capture: true, passive: true }); // long enough to be seen on a quick tap
  addEventListener("touchcancel", release, { capture: true, passive: true });

  (function start() {
    if (!document.documentElement) return void setTimeout(start, 10);
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
  })();
  // no pinch zoom (iOS ignores user-scalable=no for accessibility) and no long-press context menu
  for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest("input, textarea, [contenteditable='true']")) e.preventDefault();
  });
  // app back gesture (edge swipe, from App.swift): leave stories, else close the open chat
  window.__dgBack = () => {
    if ((document.documentElement.classList.contains("dg-stories") || document.documentElement.classList.contains("dg-camera")) && window.__dgCloseStories) return window.__dgCloseStories();
    if (document.querySelector('[data-dg-column] form [role="searchbox"]') && !document.documentElement.classList.contains("dg-chat")) {
      document.querySelector("button[data-dg-newchat]")?.click(); // the New Chat sheet
      return "ok";
    }
    const close = document.querySelector('button[title="Close Chat"]');
    if (close) close.click();
    return close ? "ok" : "none";
  };
})();
