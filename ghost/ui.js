// Ghost UI — a completely new dark, Discord-like messaging UI drawn over a hidden Snapchat Web page.
// Nothing of Snapchat's own look is used anywhere in this file; everything lives inside one shadow root
// (<ghost-app>, "open" mode) so Snapchat's page CSS can never reach in and ours can never leak out.
//
// LOADING CONTRACT (see the note the app team sent, and snapchat-ios-app/ghost/API.md):
//   - Runs in the isolated "darkmobile" content world, injected at document start, AFTER gm-shim.js and
//     settings.js have already run in that same world (so `GM`, `dgSetting`, `dgOnSettings`, `dgSetSetting`,
//     `dgOpenSettings` are already defined as globals by the time this file executes) and BEFORE the DOM
//     necessarily exists — this file waits for document.documentElement itself, exactly like the app's
//     other content-world scripts do.
//   - The build step is expected to produce ios/Resources/ghost-ui.js = `const GHOST_CSS = <JSON string of
//     ghost/ui.css>;\n` followed by the *contents* of this file (not wrapped again) — so this whole file is
//     one IIFE that reads the outer `GHOST_CSS` binding through closure. Nothing here is declared at the
//     top level outside that IIFE, so concatenating this after another script can't clash with it.
//   - `window.__ghostScale` (a number, e.g. 0.8, or undefined/1) is set by the native side in this same
//     world before this file runs; it corrects for Snapchat Web's desktop-width layout being scaled down.
//   - bridge.js (ghost/bridge.js, page world, also document-start) may fire its `ready` event before or
//     after this file's message listener exists, so on start this file calls status() itself and treats the
//     result the same way as a `ready` event (see boot()).
(() => {
  "use strict";
  if (window.top !== window) return;
  if (window.__ghostUIBooted) return;
  window.__ghostUIBooted = true;

  const cssText = typeof GHOST_CSS !== "undefined" ? GHOST_CSS : "";

  // =====================================================================================================
  // Small utilities
  // =====================================================================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function el(tag, className, attrs) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function nowMs() { return Date.now(); }

  function haptic(style) {
    try {
      if (typeof window.dgSetting === "function" && window.dgSetting("haptics", true) === false) return;
    } catch (e) {}
    try { window.webkit.messageHandlers.dg.postMessage({ op: "haptic", style: style || "light" }).catch(() => {}); } catch (e) {}
  }

  // ---- inline icons (all authored here — trusted strings only, never mixed with user data) ------------
  const ICONS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    newMsg: '<path d="M21 11.5a8.4 8.4 0 01-8.9 8.4 8.5 8.5 0 01-3.8-.9L3 20l1.1-5.3a8.4 8.4 0 116.9-12.1 8.4 8.4 0 0110 8.9z"/><path d="M12 8v5M9.5 10.5h5" stroke-width="1.6"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>',
    photo: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-5-9 9"/>',
    camera: '<path d="M4 8a2 2 0 012-2h1.2a2 2 0 001.6-.8l.6-.8a2 2 0 011.6-.8h2a2 2 0 011.6.8l.6.8a2 2 0 001.6.8H18a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
    gifBadge: '<rect x="2" y="6" width="20" height="12" rx="3"/><text x="12" y="15" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">GIF</text>',
    emoji: '<circle cx="12" cy="12" r="9"/><path d="M8.5 10.5h.01M15.5 10.5h.01"/><path d="M8.5 14.5s1.2 2 3.5 2 3.5-2 3.5-2"/>',
    mic: '<path d="M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3z"/><path d="M19 11a7 7 0 01-14 0M12 18v3"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    pause: '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>',
    ghost: '<path d="M12 3a7 7 0 00-7 7v8.5c0 .6.7 1 1.2.6l1.6-1.2 1.7 1.3a1 1 0 001.2 0l1.3-1 1.3 1a1 1 0 001.2 0l1.7-1.3 1.6 1.2c.5.4 1.2 0 1.2-.6V10a7 7 0 00-7-7z"/><path d="M9.3 11h.01M14.7 11h.01" stroke-width="1.8"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
    checkDouble: '<path d="M2 13l4 4L14 8"/><path d="M9 13l4 4 9-11"/>',
    reply: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 016 6v2"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0l-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/>',
    star: '<path d="M12 2l3 6.5 7 1-5 5 1.2 7L12 18l-6.2 3.5 1.2-7-5-5 7-1z"/>',
    flip: '<path d="M17 2l4 4-4 4"/><path d="M3 12v-2a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 12v2a4 4 0 01-4 4H3"/>',
    speed: '<path d="M12 2v3M4.2 6.2l2.1 2.1M2 14h3M19 14h3M17.7 8.3l2.1-2.1"/><path d="M12 14l4-3"/><circle cx="12" cy="14" r="8"/>',
    call: '<path d="M22 16.9v2a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 013.1 4.2 2 2 0 015 2h2a2 2 0 012 1.7c.1.9.3 1.8.6 2.7a2 2 0 01-.4 2.1L8 9.9a16 16 0 006 6l1.4-1.2a2 2 0 012.1-.4c.9.3 1.8.5 2.7.6a2 2 0 011.8 2z"/>',
    videoCall: '<path d="M15 8l6-3v14l-6-3"/><rect x="1" y="6" width="14" height="12" rx="2"/>',
  };
  function icon(name, size) {
    const wrap = document.createElement("span");
    wrap.className = "gh-svg-wrap";
    const s = size || 20;
    wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
    return wrap.firstChild;
  }

  // ---- time formatting ------------------------------------------------------------------------------
  const DAY_MS = 86400000;
  function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return +d; }
  function fmtClock(ts) {
    const d = new Date(ts);
    let h = d.getHours(), m = d.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
  }
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtRowTime(ts) {
    const today0 = startOfDay(Date.now());
    const d0 = startOfDay(ts);
    if (d0 === today0) return fmtClock(ts);
    if (today0 - d0 <= 6 * DAY_MS) return WEEKDAYS[new Date(ts).getDay()];
    const d = new Date(ts);
    return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  function fmtDaySeparator(ts) {
    const today0 = startOfDay(Date.now());
    const d0 = startOfDay(ts);
    if (d0 === today0) return "Today";
    if (today0 - d0 === DAY_MS) return "Yesterday";
    const d = new Date(ts);
    return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function initials(name) {
    return (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  }
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h;
  }

  // =====================================================================================================
  // Bridge client: window.postMessage RPC + events, exactly as ghost/API.md defines
  // =====================================================================================================
  function createBridge() {
    let seq = 0;
    const pending = new Map();
    const listeners = new Map();
    window.addEventListener("message", (e) => {
      const msg = e && e.data;
      if (!msg || typeof msg !== "object" || msg.ghost == null) return;
      if (msg.ghost === "res") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(typeof msg.error === "string" ? msg.error : (msg.error && msg.error.message) || "ghost bridge error"));
      } else if (msg.ghost === "event") {
        const set = listeners.get(msg.type);
        if (set) for (const fn of Array.from(set)) { try { fn(msg.data); } catch (err) { /* one bad listener shouldn't break others */ } }
      }
    });
    function call(method, args) {
      return new Promise((resolve, reject) => {
        const id = "g" + (++seq);
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error("ghost bridge timeout: " + method));
        }, 15000);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        try { window.postMessage({ ghost: "req", id, method, args: args || [] }, "*"); }
        catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
      });
    }
    function on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => { const s = listeners.get(type); if (s) s.delete(fn); };
    }
    return { call, on };
  }
  const bridge = createBridge();
  const api = {
    status: () => bridge.call("status"),
    listConversations: () => bridge.call("listConversations"),
    openConversation: (id) => bridge.call("openConversation", [id]),
    closeConversation: (id) => bridge.call("closeConversation", [id]),
    loadOlder: (id) => bridge.call("loadOlder", [id]),
    sendText: (id, text, opts) => bridge.call("sendText", [id, text, opts || {}]),
    sendMedia: (id, blob, opts) => bridge.call("sendMedia", [id, blob, opts || {}]),
    sendSnap: (ids, blob, opts) => bridge.call("sendSnap", [ids, blob, opts || {}]),
    react: (id, messageId, emoji) => bridge.call("react", [id, messageId, emoji]),
    saveMessage: (id, messageId, saved) => bridge.call("saveMessage", [id, messageId, saved]),
    openSnap: (id, messageId) => bridge.call("openSnap", [id, messageId]),
    listStories: () => bridge.call("listStories"),
    openStory: (userId) => bridge.call("openStory", [userId]),
    newConversation: (userIds) => bridge.call("newConversation", [userIds]),
    searchFriends: (q) => bridge.call("searchFriends", [q]),
    debugShape: () => bridge.call("debugShape"),
  };

  // =====================================================================================================
  // GIF client — reuses the app's `dg` fetch bridge (GM.xmlHttpRequest), not chrome.runtime/background.js
  // (that path is the Safari-extension build only). A test harness can short-circuit everything through
  // window.__ghostGiphyMock(kind, params) so screenshots never touch the real network.
  // =====================================================================================================
  const GIPHY_ID_RE = /^[A-Za-z0-9]{1,64}$/;
  const giphyMedia = (id, file) => `https://media.giphy.com/media/${id}/${file}`;
  async function gmBytes(url) {
    if (typeof window.__ghostGiphyMock === "function") throw new Error("mock path should not reach gmBytes");
    if (typeof GM === "undefined" || !GM.xmlHttpRequest) throw new Error("no GM bridge");
    const r = await GM.xmlHttpRequest({ url, responseType: "arraybuffer" });
    return new Uint8Array(r.response);
  }
  function bytesToDataUrl(bytes, type) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${type || "application/octet-stream"};base64,${btoa(bin)}`;
  }
  const storage = {
    _mem: new Map(),
    async get(key, fallback) {
      if (typeof GM !== "undefined" && GM.getValue) { try { const v = await GM.getValue(key, fallback); return v == null ? fallback : v; } catch (e) {} }
      return storage._mem.has(key) ? storage._mem.get(key) : fallback;
    },
    async set(key, value) {
      if (typeof GM !== "undefined" && GM.setValue) { try { await GM.setValue(key, value); return; } catch (e) {} }
      storage._mem.set(key, value);
    },
  };
  async function giphyGetJson(url) {
    if (typeof window.__ghostGiphyMock === "function") return null; // callers check the mock first
    try {
      const bytes = await gmBytes(url);
      return { json: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch (e) {
      return { error: String(e && e.message || e), retryable: true };
    }
  }
  async function giphySearch(q, offset, rating) {
    if (typeof window.__ghostGiphyMock === "function") return window.__ghostGiphyMock("search", { q, offset, rating });
    const key = await storage.get("giphyKey", "");
    if (!key) return { needKey: true };
    const params = new URLSearchParams({ api_key: key, limit: "24", offset: String(offset || 0) });
    if (q) params.set("q", q);
    if (/^(g|pg|pg-13|r)$/.test(rating || "")) params.set("rating", rating);
    const r = await giphyGetJson(`https://api.giphy.com/v1/gifs/${q ? "search" : "trending"}?${params}`);
    if (!r || !r.json) return r || { error: "No response", retryable: true };
    const results = (r.json.data || []).filter((g) => GIPHY_ID_RE.test(g.id)).map((g) => {
      const f = (g.images && g.images.fixed_width) || {};
      return { id: g.id, w: +f.width || 200, h: +f.height || 200 };
    });
    const p = r.json.pagination || {};
    return { results, next: (p.offset || 0) + (p.count || results.length), total: p.total_count };
  }
  async function giphyPreviewUrl(id) {
    if (typeof window.__ghostGiphyMock === "function") return window.__ghostGiphyMock("preview", { id });
    try { return { dataUrl: bytesToDataUrl(await gmBytes(giphyMedia(id, "200w.webp")), "image/webp") }; }
    catch (e) { return { error: String(e && e.message || e) }; }
  }
  async function giphyFileUrl(id) {
    if (typeof window.__ghostGiphyMock === "function") return window.__ghostGiphyMock("file", { id });
    try { return { dataUrl: bytesToDataUrl(await gmBytes(giphyMedia(id, "giphy-downsized.gif")), "image/gif") }; }
    catch (e) { return { error: String(e && e.message || e) }; }
  }

  // =====================================================================================================
  // Custom element + shadow root
  // =====================================================================================================
  class GhostApp extends HTMLElement {
    constructor() {
      super();
      const shadow = this.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = cssText;
      shadow.appendChild(style);
      this._shadow = shadow;
    }
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      buildApp(this, this._shadow);
    }
  }
  if (!customElements.get("ghost-app")) customElements.define("ghost-app", GhostApp);

  function applyZoom(host) {
    const scale = (typeof window.__ghostScale === "number" && window.__ghostScale > 0) ? window.__ghostScale : 1;
    host.style.setProperty("--gh-zoom", String(1 / scale));
  }

  const ACCENTS = {
    blue: ["#5865f2", "#4752c4"], yellow: ["#f0b232", "#c9911c"], purple: ["#9b59f6", "#7c3fd1"],
    green: ["#23a55a", "#1a7f45"], pink: ["#ff5c9e", "#d63f80"],
  };
  function applyAccent(host) {
    let key = "blue";
    try { if (typeof window.dgSetting === "function") key = window.dgSetting("accent", "blue"); } catch (e) {}
    const pair = ACCENTS[key] || ACCENTS.blue;
    host.style.setProperty("--gh-accent", pair[0]);
    host.style.setProperty("--gh-accent-hover", pair[1]);
  }

  function mount() {
    if (!document.documentElement) return void setTimeout(mount, 10);
    if (document.getElementById("ghost-app-root")) return;
    // Light-DOM rule: hides Snapchat's own body once we're on screen. Lives outside the shadow root on
    // purpose (body is outside it); this is the only light-DOM CSS this file ever writes.
    const lightStyle = document.createElement("style");
    lightStyle.id = "ghost-light-style";
    lightStyle.textContent = 'html[data-ghost-on] body { visibility: hidden !important; }';
    document.documentElement.appendChild(lightStyle);
    const host = document.createElement("ghost-app");
    host.id = "ghost-app-root";
    document.documentElement.appendChild(host); // not body — see loading contract above
    applyZoom(host);
    applyAccent(host);
    window.addEventListener("resize", () => applyZoom(host));
    if (typeof window.dgOnSettings === "function") window.dgOnSettings(() => applyAccent(host));
  }

  // =====================================================================================================
  // App shell + boot/login sequence
  // =====================================================================================================
  function buildApp(host, shadow) {
    const root = el("div", "gh-root");
    shadow.appendChild(root);

    const boot = el("div", "gh-boot");
    boot.innerHTML = `<div class="gh-boot-logo"></div><div class="gh-spinner"></div>`;
    boot.querySelector(".gh-boot-logo").appendChild(icon("ghost", 40));
    root.appendChild(boot);

    const stack = el("div", "gh-stack");
    root.appendChild(stack);

    const state = {
      me: null,
      loggedIn: null,
      conversations: [],
      convById: new Map(),
      messagesByConv: new Map(), // id -> { messages: [], hasMore }
      typingByConv: new Map(),
      stories: [],
      homeReady: false,
      currentConvId: null,
      navProgress: 0, // 0 = home, 1 = conv (for the interactive swipe)
    };

    const ctx = { host, shadow, root, stack, state };
    ctx.home = buildHome(ctx);
    ctx.conv = buildConversation(ctx);
    stack.appendChild(ctx.home.screen);
    stack.appendChild(ctx.conv.screen);
    ctx.shade = el("div", "gh-shade");
    stack.appendChild(ctx.shade);

    const overlays = el("div", "gh-overlay-layer");
    root.appendChild(overlays);
    ctx.actionSheet = buildActionSheet(ctx, overlays);
    ctx.gifSheet = buildGifSheet(ctx, overlays);
    ctx.newChatSheet = buildNewChatSheet(ctx, overlays);

    ctx.viewer = buildViewer(ctx);
    root.appendChild(ctx.viewer.el);
    ctx.camera = buildCamera(ctx);
    root.appendChild(ctx.camera.el);

    initNavGesture(ctx);

    function markReady(isReady) {
      const de = document.documentElement;
      if (isReady) de.setAttribute("data-ghost-ready", "1");
      else de.removeAttribute("data-ghost-ready");
    }

    function showLoggedOut() {
      document.documentElement.removeAttribute("data-ghost-on");
      host.removeAttribute("data-on");
      markReady(false);
    }
    function showLoggedIn() {
      document.documentElement.setAttribute("data-ghost-on", "");
      host.setAttribute("data-on", "");
    }

    async function handleReady(data) {
      state.loggedIn = !!(data && data.loggedIn);
      state.me = (data && data.me) || null;
      if (!state.loggedIn) { showLoggedOut(); return; }
      showLoggedIn();
      if (!state.homeReady) await loadInitialData(ctx);
      boot.classList.add("gh-boot-fade");
      state.homeReady = true;
      markReady(true);
    }

    bridge.on("ready", handleReady);
    bridge.on("conversations", (data) => { applyConversations(ctx, (data && data.conversations) || []); });
    bridge.on("messages", (data) => { applyMessages(ctx, data); });
    bridge.on("typing", (data) => { applyTyping(ctx, data); });
    // bridge progress notes and internal failures go to the phone's log (trail.txt), not on screen
    const toTrail = (kind) => (data) => {
      try { window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GHOST " + kind + " " + (data && data.where || "") + ": " + String(data && data.message || "").slice(0, 400) }).catch(() => {}); } catch (e) {}
    };
    bridge.on("error", toTrail("error"));
    bridge.on("log", toTrail("log"));
    // first launch on the phone: record the SHAPE of Snapchat's data (keys and types only, never message text) so
    // missing pieces (stories, friends, "me", unread counts) can be wired from the log (GHOST shape ... in trail.txt)
    let shapeLogged = false;
    bridge.on("ready", (d) => {
      if (shapeLogged || !(d && d.loggedIn)) return;
      shapeLogged = true;
      // (log lines are cut at 400 characters, so long dumps go out in 380-character parts)
      const dump = (label, obj) => {
        const text = JSON.stringify(obj);
        for (let i = 0, n = 1; i < Math.min(text.length, 40000); i += 380, n++) toTrail(label)({ where: "part " + n, message: text.slice(i, i + 380) });
      };
      setTimeout(() => {
        bridge.call("debugSample").then((x) => dump("sample", x), (e) => toTrail("error")({ where: "debugSample", message: e }));
      }, 4000);
    });

    // bridge.js's own `ready` may already have fired before this listener existed — ask directly too.
    api.status().then(handleReady).catch(() => {});

    function showToast(msg) {
      let t = root.querySelector(".gh-toast");
      if (!t) {
        t = el("div", "gh-toast");
        root.appendChild(t);
      }
      t.textContent = msg;
      t.classList.add("gh-toast-show");
      clearTimeout(t._timer);
      t._timer = setTimeout(() => t.classList.remove("gh-toast-show"), 3000);
    }
    ctx.showToast = showToast;

    // exposed for the test harness / debugging only
    host.__ghost = ctx;
  }

  async function loadInitialData(ctx) {
    try {
      const [convs, stories] = await Promise.all([
        api.listConversations().catch(() => []),
        api.listStories().catch(() => []),
      ]);
      applyConversations(ctx, convs || []);
      ctx.state.stories = stories || [];
      renderStories(ctx);
    } catch (e) { /* home just stays empty; the "conversations" event may still arrive */ }
  }

  function applyConversations(ctx, list) {
    ctx.state.conversations = list.slice().sort((a, b) => (b.lastActivityTs || 0) - (a.lastActivityTs || 0));
    ctx.state.convById = new Map(ctx.state.conversations.map((c) => [c.id, c]));
    renderHomeList(ctx);
    if (ctx.state.currentConvId) {
      const c = ctx.state.convById.get(ctx.state.currentConvId);
      if (c) updateConvHeader(ctx, c);
    }
  }
  function applyMessages(ctx, data) {
    if (!data) return;
    const entry = { messages: data.messages || [], hasMore: !!data.hasMore };
    ctx.state.messagesByConv.set(data.conversationId, entry);
    if (ctx.state.currentConvId === data.conversationId) renderMessageList(ctx, ctx.conv, entry, { stick: true });
  }
  function applyTyping(ctx, data) {
    if (!data) return;
    ctx.state.typingByConv.set(data.conversationId, new Set(data.userIds || []));
    if (ctx.state.currentConvId === data.conversationId) updateTypingIndicator(ctx);
    renderHomeRowTyping(ctx, data.conversationId, (data.userIds || []).length > 0);
  }

  // =====================================================================================================
  // HOME
  // =====================================================================================================
  function buildHome(ctx) {
    const screen = el("div", "gh-screen");
    screen.dataset.screen = "home";
    screen.innerHTML = `
      <div class="gh-header">
        <div class="gh-header-title">Messages</div>
        <button class="gh-icon-btn gh-hit" data-act="settings"></button>
        <button class="gh-icon-btn gh-hit" data-act="new"></button>
      </div>
      <div class="gh-home-body">
        <div class="gh-search-wrap">
          <div class="gh-search"></div>
        </div>
        <div class="gh-stories"></div>
        <div class="gh-ptr"><div class="gh-spinner"></div></div>
        <div class="gh-list gh-scroll"></div>
      </div>
      <button class="gh-fab gh-press" data-act="new"></button>
    `;
    screen.querySelector('[data-act="settings"]').appendChild(icon("settings"));
    screen.querySelector('[data-act="new"].gh-icon-btn').appendChild(icon("newMsg"));
    screen.querySelector(".gh-fab").appendChild(icon("plus", 24));
    const search = screen.querySelector(".gh-search");
    search.appendChild(icon("search", 16));
    const input = el("input");
    input.type = "search";
    input.placeholder = "Search";
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    search.appendChild(input);

    const list = screen.querySelector(".gh-list");
    const storiesEl = screen.querySelector(".gh-stories");
    const ptr = screen.querySelector(".gh-ptr");

    screen.querySelector('[data-act="settings"]').addEventListener("click", () => {
      haptic();
      try { if (typeof window.dgOpenSettings === "function") window.dgOpenSettings(); } catch (e) {}
    });
    for (const b of screen.querySelectorAll('[data-act="new"]')) {
      b.addEventListener("click", () => { haptic(); openNewChatSheet(ctx); });
    }
    input.addEventListener("input", () => { home.query = input.value.trim().toLowerCase(); renderHomeList(ctx); });

    const home = { screen, list, storiesEl, input, ptr, rows: new Map(), query: "" };
    initPullToRefresh(ctx, home);
    return home;
  }

  function renderStories(ctx) {
    const home = ctx.home;
    const wrap = home.storiesEl;
    wrap.innerHTML = "";
    for (const s of ctx.state.stories) {
      const item = el("div", "gh-story");
      item.dataset.unviewed = s.viewed ? "0" : "1";
      const ring = el("div", "gh-story-ring");
      const av = makeAvatar(s.user, 58);
      ring.appendChild(av);
      const name = el("span", "gh-story-name");
      name.textContent = s.user && s.user.name ? s.user.name.split(" ")[0] : "?";
      item.append(ring, name);
      item.addEventListener("click", () => { haptic(); openStoryViewer(ctx, s); });
      wrap.appendChild(item);
    }
  }

  function makeAvatar(user, size) {
    const img = el("img", "gh-avatar");
    img.style.width = size + "px";
    img.style.height = size + "px";
    img.width = size; img.height = size;
    img.alt = "";
    img.loading = "lazy";
    if (user && user.avatarUrl) img.src = user.avatarUrl;
    else img.src = placeholderAvatarUrl(user);
    return img;
  }
  function placeholderAvatarUrl(user) {
    const name = (user && (user.name || user.username)) || "?";
    const color = (user && user.color) || AVATAR_PALETTE[Math.abs(hashStr(String((user && user.id) || name))) % AVATAR_PALETTE.length];
    const label = initials(name);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${color}"/><text x="48" y="56" font-family="system-ui,sans-serif" font-size="36" font-weight="700" fill="rgba(255,255,255,0.92)" text-anchor="middle">${label}</text></svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }
  const AVATAR_PALETTE = ["#5865f2", "#eb459e", "#23a55a", "#f0b232", "#9b59f6", "#3ba55d", "#ed4245", "#00a8fc"];

  function previewLine(conv) {
    const p = conv.preview || { kind: "none" };
    const you = p.fromMe ? "You: " : "";
    switch (p.kind) {
      case "text": return { text: you + (p.text || ""), iconName: null };
      case "chat-media": return { text: you + "Sent a photo", iconName: "photo" };
      case "gif": return { text: you + "Sent a GIF", iconName: "gifBadge" };
      case "audio": return { text: you + "Sent a voice message", iconName: "mic" };
      case "snap": {
        const label = p.fromMe
          ? ({ sent: "Snap sent", delivered: "Snap delivered", opened: "Snap opened" }[p.status] || "Snap sent")
          : ({ received: "New Snap", opened: "Opened", viewed: "Opened" }[p.status] || "New Snap");
        return { text: label, iconName: "camera" };
      }
      case "call": return { text: p.text || "Call", iconName: "call" };
      case "system": return { text: p.text || "", iconName: null };
      default: return { text: "No messages yet", iconName: null };
    }
  }

  function renderHomeList(ctx) {
    const home = ctx.home;
    const q = home.query;
    const list = home.list;
    const seen = new Set();
    let prevEl = null;
    for (const conv of ctx.state.conversations) {
      if (q && !(conv.title || "").toLowerCase().includes(q)) continue;
      seen.add(conv.id);
      let row = home.rows.get(conv.id);
      if (!row) { row = buildHomeRow(ctx, conv); home.rows.set(conv.id, row); }
      else updateHomeRow(row, conv);
      const desiredNext = prevEl ? prevEl.nextSibling : list.firstChild;
      if (row.el !== desiredNext) list.insertBefore(row.el, desiredNext);
      prevEl = row.el;
    }
    for (const [id, row] of Array.from(home.rows)) {
      if (!seen.has(id)) { row.el.remove(); home.rows.delete(id); }
    }
    if (!seen.size) {
      if (!list.querySelector(".gh-empty")) {
        const e = el("div", "gh-empty");
        e.textContent = q ? "No conversations match" : "No conversations yet";
        list.appendChild(e);
      }
    } else {
      const e = list.querySelector(".gh-empty");
      if (e) e.remove();
    }
  }

  function buildHomeRow(ctx, conv) {
    const rowEl = el("div", "gh-row gh-press");
    rowEl.dataset.id = conv.id;
    rowEl.innerHTML = `
      <div class="gh-row-avatar-wrap">
        <div class="gh-row-unread-ring"></div>
      </div>
      <div class="gh-row-body">
        <div class="gh-row-top">
          <div class="gh-row-name"></div>
          <div class="gh-row-time"></div>
        </div>
        <div class="gh-row-bottom">
          <div class="gh-row-preview"></div>
          <div class="gh-row-streak"></div>
          <div class="gh-row-badge"></div>
        </div>
      </div>
    `;
    const avatarWrap = rowEl.querySelector(".gh-row-avatar-wrap");
    const avatarUser = conv.isGroup ? { name: conv.title, avatarUrl: conv.avatarUrl } : (conv.participants && conv.participants[0]) || { name: conv.title };
    avatarWrap.insertBefore(makeAvatar(avatarUser, 52), avatarWrap.firstChild);
    rowEl.addEventListener("click", () => openConversationScreen(ctx, conv.id));
    const row = { el: rowEl, id: conv.id };
    updateHomeRow(row, conv);
    return row;
  }
  function updateHomeRow(row, conv) {
    const rowEl = row.el;
    rowEl.dataset.unread = conv.unreadCount > 0 || conv.hasUnreadSnap ? "1" : "0";
    rowEl.querySelector(".gh-row-name").textContent = conv.title || "Unknown";
    rowEl.querySelector(".gh-row-time").textContent = fmtRowTime(conv.lastActivityTs || Date.now());
    const previewEl = rowEl.querySelector(".gh-row-preview");
    const typing = row.typing;
    if (typing) {
      previewEl.innerHTML = "";
      const dots = el("span", "gh-row-dots");
      dots.innerHTML = "<span></span><span></span><span></span>";
      previewEl.appendChild(dots);
    } else {
      const { text, iconName } = previewLine(conv);
      previewEl.innerHTML = "";
      if (iconName) previewEl.appendChild(icon(iconName, 14));
      const span = el("span");
      span.textContent = text;
      span.style.overflow = "hidden";
      span.style.textOverflow = "ellipsis";
      span.style.whiteSpace = "nowrap";
      previewEl.appendChild(span);
    }
    const streakEl = rowEl.querySelector(".gh-row-streak");
    if (conv.streak && conv.streak.count) {
      streakEl.dataset.expiring = conv.streak.expiring ? "1" : "0";
      streakEl.textContent = `🔥${conv.streak.count}${conv.streak.expiring ? " ⌛" : ""}`;
      streakEl.style.display = "";
    } else streakEl.style.display = "none";
    const badge = rowEl.querySelector(".gh-row-badge");
    if (conv.unreadCount > 0) { badge.textContent = conv.unreadCount > 99 ? "99+" : String(conv.unreadCount); badge.style.display = ""; }
    else if (conv.hasUnreadSnap) { badge.textContent = ""; badge.style.width = "10px"; badge.style.minWidth = "10px"; badge.style.height = "10px"; badge.style.display = ""; }
    else badge.style.display = "none";
  }
  function renderHomeRowTyping(ctx, conversationId, isTyping) {
    const row = ctx.home.rows.get(conversationId);
    if (!row) return;
    row.typing = isTyping;
    const conv = ctx.state.convById.get(conversationId);
    if (conv) updateHomeRow(row, conv);
  }

  function initPullToRefresh(ctx, home) {
    const list = home.list;
    let startY = 0, pulling = false, dy = 0;
    list.addEventListener("touchstart", (e) => {
      if (list.scrollTop > 0 || e.touches.length !== 1) { pulling = false; return; }
      startY = e.touches[0].clientY; pulling = true; dy = 0;
    }, { passive: true });
    list.addEventListener("touchmove", (e) => {
      if (!pulling) return;
      dy = e.touches[0].clientY - startY;
      if (dy <= 0) { home.ptr.style.height = "0px"; return; }
      home.ptr.style.height = Math.min(56, dy * 0.5) + "px";
    }, { passive: true });
    list.addEventListener("touchend", () => {
      if (!pulling) return;
      pulling = false;
      if (dy > 90) {
        haptic();
        home.ptr.style.height = "44px";
        api.listConversations().then((cs) => applyConversations(ctx, cs || [])).finally(() => {
          setTimeout(() => { home.ptr.style.height = "0px"; }, 250);
        });
      } else home.ptr.style.height = "0px";
    }, { passive: true });
  }

  // =====================================================================================================
  // CONVERSATION
  // =====================================================================================================
  function buildConversation(ctx) {
    const screen = el("div", "gh-screen gh-conv-header");
    screen.dataset.screen = "conv";
    screen.dataset.side = "right";
    screen.innerHTML = `
      <div class="gh-header">
        <button class="gh-icon-btn gh-hit" data-act="back"></button>
        <div class="gh-header-title">
          <div class="gh-conv-title-row">
            <div class="gh-conv-name"></div>
          </div>
          <div class="gh-conv-sub"></div>
        </div>
        <div class="gh-conv-header-icons">
          <span class="gh-icon-btn"></span>
          <span class="gh-icon-btn"></span>
        </div>
      </div>
      <div class="gh-messages gh-scroll">
        <div class="gh-msg-top-spacer" style="flex:none;"></div>
        <div class="gh-msg-bottom-spacer" style="flex:none;"></div>
      </div>
      <div class="gh-typing-row" style="display:none;"></div>
      <button class="gh-jump gh-press"></button>
      <div class="gh-reply-bar">
        <div class="gh-reply-bar-line"></div>
        <div class="gh-reply-bar-body">
          <div class="gh-reply-bar-name"></div>
          <div class="gh-reply-bar-text"></div>
        </div>
        <button class="gh-reply-bar-close gh-hit"></button>
      </div>
      <div class="gh-composer">
        <button class="gh-composer-btn gh-hit" data-act="attach"></button>
        <div class="gh-composer-field">
          <textarea class="gh-composer-textarea" rows="1" placeholder="Message"></textarea>
        </div>
        <button class="gh-composer-btn gh-hit" data-act="gif"></button>
        <button class="gh-composer-btn gh-hit" data-act="emoji"></button>
        <button class="gh-composer-send gh-hit gh-press" data-act="send"></button>
      </div>
      <div class="gh-attach-menu">
        <div class="gh-attach-item" data-act="photo"></div>
        <div class="gh-attach-item" data-act="camera"></div>
      </div>
      <input type="file" accept="image/*,video/*" class="gh-file-input" style="display:none;">
    `;
    screen.querySelector('[data-act="back"]').appendChild(icon("back"));
    screen.querySelectorAll(".gh-conv-header-icons .gh-icon-btn")[0].appendChild(icon("call", 18));
    screen.querySelectorAll(".gh-conv-header-icons .gh-icon-btn")[1].appendChild(icon("videoCall", 18));
    screen.querySelector('[data-act="attach"]').appendChild(icon("plus"));
    screen.querySelector('[data-act="gif"]').appendChild(icon("gifBadge"));
    screen.querySelector('[data-act="emoji"]').appendChild(icon("emoji"));
    screen.querySelector('[data-act="send"]').appendChild(icon("send", 18));
    screen.querySelector('[data-act="photo"]').append(icon("photo"), Object.assign(document.createElement("span"), { textContent: "Photo & Video Library" }));
    screen.querySelector('[data-act="camera"]').append(icon("camera"), Object.assign(document.createElement("span"), { textContent: "Camera" }));
    screen.querySelector(".gh-reply-bar-close").appendChild(icon("close", 16));
    screen.querySelector(".gh-jump").append(icon("chevronDown", 16), Object.assign(document.createElement("span"), { textContent: "New messages" }));

    const conv = {
      screen,
      messages: screen.querySelector(".gh-messages"),
      topSpacer: screen.querySelector(".gh-msg-top-spacer"),
      bottomSpacer: screen.querySelector(".gh-msg-bottom-spacer"),
      typingRow: screen.querySelector(".gh-typing-row"),
      jump: screen.querySelector(".gh-jump"),
      replyBar: screen.querySelector(".gh-reply-bar"),
      textarea: screen.querySelector(".gh-composer-textarea"),
      sendBtn: screen.querySelector('[data-act="send"]'),
      attachMenu: screen.querySelector(".gh-attach-menu"),
      fileInput: screen.querySelector(".gh-file-input"),
      nameEl: screen.querySelector(".gh-conv-name"),
      subEl: screen.querySelector(".gh-conv-sub"),
      titleRow: screen.querySelector(".gh-conv-title-row"),
      rendered: new Map(), // messageId -> element
      windowStart: 0, windowEnd: 0,
      avgHeight: 64,
      replyTo: null,
      atBottom: true,
    };

    screen.querySelector('[data-act="back"]').addEventListener("click", () => closeConversationScreen(ctx));
    conv.textarea.addEventListener("input", () => {
      conv.textarea.style.height = "auto";
      conv.textarea.style.height = Math.min(100, conv.textarea.scrollHeight) + "px";
      conv.sendBtn.dataset.show = conv.textarea.value.trim() ? "1" : "0";
    });
    screen.querySelector('[data-act="send"]').addEventListener("click", () => sendCurrentText(ctx));
    screen.querySelector('[data-act="attach"]').addEventListener("click", (e) => {
      e.stopPropagation();
      haptic();
      conv.attachMenu.dataset.open = conv.attachMenu.dataset.open === "1" ? "0" : "1";
    });
    document.addEventListener("click", () => { conv.attachMenu.dataset.open = "0"; });
    screen.querySelector('[data-act="photo"]').addEventListener("click", () => { conv.attachMenu.dataset.open = "0"; conv.fileInput.click(); });
    screen.querySelector('[data-act="camera"]').addEventListener("click", () => { conv.attachMenu.dataset.open = "0"; openCamera(ctx, { mode: "snap" }); });
    conv.fileInput.addEventListener("change", () => {
      const f = conv.fileInput.files && conv.fileInput.files[0];
      conv.fileInput.value = "";
      if (f) sendMediaFile(ctx, f);
    });
    screen.querySelector('[data-act="gif"]').addEventListener("click", () => openGifSheet(ctx));
    screen.querySelector(".gh-reply-bar-close").addEventListener("click", () => setReplyTo(ctx, null));
    conv.jump.addEventListener("click", () => scrollConvToBottom(ctx, true));
    conv.messages.addEventListener("scroll", () => onConvScroll(ctx), { passive: true });

    initMessageGestures(ctx, conv);
    return conv;
  }

  function updateConvHeader(ctx, convData) {
    const conv = ctx.conv;
    conv.nameEl.textContent = convData.title || "Unknown";
    const typingSet = ctx.state.typingByConv.get(convData.id);
    if (typingSet && typingSet.size) conv.subEl.textContent = "typing…";
    else conv.subEl.textContent = convData.isGroup ? `${(convData.participants || []).length} members` : "";
    const av = convData.isGroup ? { name: convData.title, avatarUrl: convData.avatarUrl } : (convData.participants && convData.participants[0]) || { name: convData.title };
    const old = conv.titleRow.querySelector(".gh-avatar");
    if (old) old.remove();
    conv.titleRow.insertBefore(makeAvatar(av, 32), conv.titleRow.firstChild);
  }

  async function openConversationScreen(ctx, conversationId) {
    haptic("light");
    ctx.state.currentConvId = conversationId;
    const convData = ctx.state.convById.get(conversationId);
    if (convData) updateConvHeader(ctx, convData);
    navigateTo(ctx, "conv", true);
    const conv = ctx.conv;
    conv.rendered.forEach((elm) => elm.remove());
    conv.rendered.clear();
    conv.replyTo = null;
    conv.textarea.value = "";
    conv.sendBtn.dataset.show = "0";
    setReplyTo(ctx, null);
    let entry = ctx.state.messagesByConv.get(conversationId);
    if (!entry) {
      conv.messages.classList.add("gh-loading-skel");
      try {
        const res = await api.openConversation(conversationId);
        entry = { messages: res.messages || [], hasMore: !!res.hasMore };
        ctx.state.messagesByConv.set(conversationId, entry);
      } catch (e) { entry = { messages: [], hasMore: false }; }
      conv.messages.classList.remove("gh-loading-skel");
    } else {
      api.openConversation(conversationId).catch(() => {});
    }
    if (ctx.state.currentConvId !== conversationId) return; // navigated away while loading
    renderMessageList(ctx, conv, entry, { stick: true, initial: true });
  }
  function closeConversationScreen(ctx) {
    const id = ctx.state.currentConvId;
    if (id) api.closeConversation(id).catch(() => {});
    ctx.state.currentConvId = null;
    navigateTo(ctx, "home", true);
  }

  // ---- message list virtualization -------------------------------------------------------------------
  const CHUNK = 20, OVERSCAN = 10;
  function renderMessageList(ctx, conv, entry, opts) {
    opts = opts || {};
    const all = entry.messages || [];
    conv._all = all;
    conv._hasMore = entry.hasMore;
    const total = all.length;
    let start, end;
    if (opts.initial || conv.windowEnd === 0) {
      start = Math.max(0, total - (CHUNK * 2));
      end = total;
    } else {
      start = clamp(conv.windowStart, 0, total);
      end = clamp(Math.max(conv.windowEnd, total - 1), start, total);
      if (opts.stick) end = total; // new message(s) arrived — extend the window to include them
    }
    conv.windowStart = start;
    conv.windowEnd = end;
    paintWindow(ctx, conv);
    if (opts.initial || opts.stick) {
      if (conv.atBottom || opts.initial) requestAnimationFrame(() => scrollConvToBottom(ctx, false));
      else showJump(ctx, true);
    }
    updateTypingIndicator(ctx);
  }

  function groupsFor(all, start, end) {
    const groups = [];
    let cur = null;
    for (let i = start; i < end; i++) {
      const m = all[i];
      const prev = i > 0 ? all[i - 1] : null; // look back even outside the window for grouping context
      const sameDay = prev && startOfDay(prev.ts) === startOfDay(m.ts);
      const daySep = !sameDay ? fmtDaySeparator(m.ts) : null;
      const continuesFromPrev = !!prev && prev.from && m.from && prev.from.id === m.from.id
        && (m.ts - prev.ts) < 5 * 60 * 1000 && !daySep && prev.kind !== "system" && prev.kind !== "call" && m.kind !== "system" && m.kind !== "call";
      if (m.kind === "system" || m.kind === "call") { groups.push({ daySep, system: m }); cur = null; continue; }
      if (!continuesFromPrev || !cur || i === start) {
        cur = { daySep, from: m.from, first: true, items: [m] };
        groups.push(cur);
      } else cur.items.push(m);
    }
    return groups;
  }

  function paintWindow(ctx, conv) {
    const all = conv._all || [];
    const start = conv.windowStart, end = conv.windowEnd, total = all.length;
    const frag = document.createDocumentFragment();
    const groups = groupsFor(all, start, end);
    const meId = ctx.state.me && ctx.state.me.id;
    for (const g of groups) {
      if (g.daySep) frag.appendChild(sepEl(g.daySep));
      if (g.system) { frag.appendChild(systemLineEl(g.system)); continue; }
      const isMe = g.from && meId && g.from.id === meId;
      const groupEl = el("div", "gh-group");
      groupEl.dataset.me = isMe ? "1" : "0";
      groupEl.dataset.first = "1";
      const gutter = el("div", "gh-group-gutter");
      gutter.appendChild(makeAvatar(isMe ? (ctx.state.me || g.from || { name: "You" }) : g.from, 40)); // Discord: every run starts with a big avatar, yours too
      const col = el("div", "gh-group-col");
      const meta = el("div", "gh-group-meta");
      const nm = el("span", "gh-group-name");
      nm.textContent = isMe ? "You" : (g.from && g.from.name) || "Unknown";
      const tm = el("span", "gh-group-time");
      tm.textContent = fmtClock(g.items[0].ts);
      meta.append(nm, tm);
      col.appendChild(meta);
      for (const m of g.items) col.appendChild(messageWrapEl(ctx, m, isMe));
      groupEl.append(gutter, col);
      frag.appendChild(groupEl);
    }
    conv.messages.replaceChildren(conv.topSpacer, frag, conv.bottomSpacer);
    // measure & size spacers off the just-painted content
    requestAnimationFrame(() => {
      const rendered = end - start;
      if (rendered > 0) {
        const h = conv.messages.scrollHeight - conv.topSpacer.offsetHeight - conv.bottomSpacer.offsetHeight;
        conv.avgHeight = Math.max(24, h / rendered);
      }
      conv.topSpacer.style.height = Math.round(conv.avgHeight * start) + "px";
      conv.bottomSpacer.style.height = Math.round(conv.avgHeight * (total - end)) + "px";
    });
  }

  function sepEl(text) { const e = el("div", "gh-day-sep"); e.textContent = text; return e; }
  function systemLineEl(m) {
    const e = el("div", m.kind === "call" ? "gh-call-line" : "gh-system-line");
    if (m.kind === "call") e.appendChild(icon("call", 14));
    const span = el("span"); span.textContent = m.text || "";
    e.appendChild(span);
    return e;
  }

  function messageWrapEl(ctx, m, isMe) {
    const wrap = el("div", "gh-msg-wrap");
    wrap.dataset.messageId = m.id;
    const swipe = el("div", "gh-msg-swipe");
    const hint = el("div", "gh-reply-hint");
    hint.appendChild(icon("reply", 18));
    if (m.replyTo) swipe.appendChild(replyQuoteEl(m.replyTo));
    swipe.appendChild(bubbleEl(ctx, m, isMe));
    if (m.reactions && m.reactions.length) swipe.appendChild(reactionsEl(ctx, m));
    if (isMe) {
      const status = el("div", "gh-msg-status");
      status.textContent = m.pending ? "Sending…" : m.failed ? "Failed" : "";
      if (status.textContent) swipe.appendChild(status);
    }
    wrap.append(hint, swipe);
    return wrap;
  }
  function replyQuoteEl(r) {
    const q = el("div", "gh-reply-quote");
    const b = el("b"); b.textContent = (r.from && r.from.name) || "Someone";
    const s = el("span"); s.textContent = r.text || "…";
    q.append(b, document.createTextNode(" "), s);
    return q;
  }
  function reactionsEl(ctx, m) {
    const wrap = el("div", "gh-reactions");
    const meId = ctx.state.me && ctx.state.me.id;
    const counts = new Map();
    for (const r of m.reactions) {
      const key = r.emoji;
      if (!counts.has(key)) counts.set(key, { count: 0, mine: false });
      const c = counts.get(key);
      c.count++;
      if (meId && r.from && r.from.id === meId) c.mine = true;
    }
    for (const [emoji, c] of counts) {
      const pill = el("div", "gh-reaction-pill gh-press");
      pill.dataset.mine = c.mine ? "1" : "0";
      pill.textContent = emoji + " " + c.count;
      pill.addEventListener("click", () => {
        haptic("light");
        const convId = ctx.state.currentConvId;
        api.react(convId, m.id, c.mine ? null : emoji).catch(() => {});
      });
      wrap.appendChild(pill);
    }
    return wrap;
  }

  function bubbleEl(ctx, m, isMe) {
    switch (m.kind) {
      case "text": {
        const b = el("div", "gh-bubble");
        b.textContent = m.text || "";
        if (m.failed) b.dataset.failed = "1";
        return b;
      }
      case "chat-media": {
        const b = el("div", "gh-bubble", {});
        b.style.padding = "3px";
        const media = mediaEl(m.media && m.media[0], { fullscreenOnTap: true, ctx, message: m });
        b.appendChild(media);
        return b;
      }
      case "gif": {
        const b = el("div", "gh-bubble gh-gif-bubble");
        b.appendChild(mediaEl(m.media && m.media[0], { autoplay: true, ctx, message: m }));
        return b;
      }
      case "sticker": {
        const b = el("div", "gh-bubble gh-sticker");
        const ref = m.media && m.media[0];
        const img = el("img");
        img.src = (ref && (ref.url || (ref.blob && URL.createObjectURL(ref.blob)))) || "";
        b.appendChild(img);
        return b;
      }
      case "snap": return snapTileEl(ctx, m);
      case "audio": return audioBubbleEl(ctx, m, isMe);
      case "unknown": {
        const b = el("div", "gh-bubble gh-unknown");
        b.textContent = m.text || "Unsupported message";
        return b;
      }
      default: {
        const b = el("div", "gh-bubble gh-unknown");
        b.textContent = m.text || "";
        return b;
      }
    }
  }

  function mediaEl(ref, opts) {
    opts = opts || {};
    const wrap = el("div", "gh-media");
    if (!ref) { wrap.dataset.loading = "1"; return wrap; }
    const src = ref.url || (ref.blob ? URL.createObjectURL(ref.blob) : "");
    if (ref.type === "video") {
      const v = el("video");
      v.src = src; v.muted = true; v.playsInline = true; v.loop = !!opts.autoplay;
      if (opts.autoplay) v.autoplay = true; else v.controls = true;
      wrap.appendChild(v);
    } else {
      const img = el("img");
      img.loading = "lazy";
      img.src = src;
      wrap.appendChild(img);
    }
    if (opts.fullscreenOnTap) {
      wrap.classList.add("gh-press");
      wrap.addEventListener("click", () => openViewerSingle(opts.ctx, ref));
    }
    return wrap;
  }

  function snapTileEl(ctx, m) {
    const b = el("div", "gh-snap-tile");
    b.dataset.opened = m.opened ? "1" : "0";
    b.appendChild(icon("camera", 30));
    const label = el("div");
    label.textContent = m.opened ? "Opened" : "Tap to view";
    b.appendChild(label);
    b.classList.add("gh-press");
    b.addEventListener("click", async () => {
      if (m.opened) return;
      haptic();
      try {
        const res = await api.openSnap(ctx.state.currentConvId, m.id);
        m.opened = true;
        b.dataset.opened = "1";
        label.textContent = "Opened";
        const items = (res && res.media) || [];
        if (items.length) openViewerSequence(ctx, items, { title: (m.from && m.from.name) || "Snap" });
      } catch (e) { ctx.showToast("Couldn't open that Snap"); }
    });
    return b;
  }

  function audioBubbleEl(ctx, m, isMe) {
    const ref = (m.media && m.media[0]) || {};
    const b = el("div", "gh-bubble gh-audio");
    const playBtn = el("button", "gh-audio-play gh-hit");
    playBtn.appendChild(icon("play", 16));
    const wave = el("div", "gh-audio-wave");
    const seedBase = Math.abs(hashStr(m.id));
    for (let i = 0; i < 24; i++) {
      const bar = el("span");
      const h = 4 + (Math.abs((seedBase * (i + 1) * 2654435761) >>> 0) % 16);
      bar.style.height = h + "px";
      wave.appendChild(bar);
    }
    const speedBtn = el("button", "gh-audio-speed");
    speedBtn.textContent = "1x";
    const speeds = [1, 1.5, 2];
    let speedIdx = 0;
    let playing = false;
    // Lazy: no HTMLAudioElement is created until the user actually presses play. With a virtualized list
    // that can render dozens of audio messages at once, eagerly constructing an Audio() per message is
    // wasteful and (on constrained/software-rendering setups) can even destabilize the media pipeline.
    let audio = null;
    function ensureAudio() {
      if (audio) return audio;
      const src = ref.url || (ref.blob ? URL.createObjectURL(ref.blob) : "");
      audio = new Audio(src);
      audio.playbackRate = speeds[speedIdx];
      audio.addEventListener("play", () => { playing = true; playBtn.innerHTML = ""; playBtn.appendChild(icon("pause", 16)); });
      audio.addEventListener("pause", () => { playing = false; playBtn.innerHTML = ""; playBtn.appendChild(icon("play", 16)); });
      audio.addEventListener("ended", () => { playing = false; playBtn.innerHTML = ""; playBtn.appendChild(icon("play", 16)); });
      return audio;
    }
    playBtn.addEventListener("click", () => {
      haptic("light");
      const a = ensureAudio();
      if (playing) a.pause(); else a.play().catch(() => {});
    });
    speedBtn.addEventListener("click", () => {
      haptic("light");
      speedIdx = (speedIdx + 1) % speeds.length;
      if (audio) audio.playbackRate = speeds[speedIdx];
      speedBtn.textContent = speeds[speedIdx] + "x";
    });
    b.append(playBtn, wave, speedBtn);
    if (ref.durationSec) { const d = el("span", "gh-audio-speed"); d.style.background = "transparent"; d.textContent = fmtDuration(ref.durationSec); b.appendChild(d); }
    return b;
  }

  function onConvScroll(ctx) {
    const conv = ctx.conv;
    const m = conv.messages;
    const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    conv.atBottom = nearBottom;
    if (nearBottom) showJump(ctx, false);
    if (conv._scrollScheduled) return;
    conv._scrollScheduled = true;
    requestAnimationFrame(() => { conv._scrollScheduled = false; handleWindowScroll(ctx); });
  }
  function handleWindowScroll(ctx) {
    const conv = ctx.conv;
    const m = conv.messages;
    const total = (conv._all || []).length;
    if (!total) return;
    if (m.scrollTop < 240 && conv.windowStart > 0) {
      conv.windowStart = Math.max(0, conv.windowStart - CHUNK);
      paintWindow(ctx, conv);
      if (conv.windowStart === 0 && conv._hasMore && !conv._loadingOlder) loadOlderMessages(ctx);
    } else if (m.scrollHeight - m.scrollTop - m.clientHeight < 240 && conv.windowEnd < total) {
      conv.windowEnd = Math.min(total, conv.windowEnd + CHUNK);
      if (conv.windowEnd - conv.windowStart > CHUNK * 4) conv.windowStart = Math.min(conv.windowStart + CHUNK, conv.windowEnd - CHUNK * 2);
      paintWindow(ctx, conv);
    }
  }
  async function loadOlderMessages(ctx) {
    const conv = ctx.conv;
    const convId = ctx.state.currentConvId;
    if (!convId || conv._loadingOlder) return;
    conv._loadingOlder = true;
    const beforeHeight = conv.messages.scrollHeight;
    try {
      const res = await api.loadOlder(convId);
      const added = (res.messages || []).length;
      const entry = ctx.state.messagesByConv.get(convId) || { messages: [], hasMore: true };
      entry.messages = res.messages || entry.messages;
      entry.hasMore = !!res.hasMore;
      ctx.state.messagesByConv.set(convId, entry);
      conv.windowStart += added; conv.windowEnd += added; // same logical messages, just shifted by the prepend
      conv.windowStart = Math.max(0, conv.windowStart - added); // then re-open the new range at the top
      renderMessageList(ctx, conv, entry, {});
      requestAnimationFrame(() => {
        conv.messages.scrollTop += conv.messages.scrollHeight - beforeHeight;
      });
    } catch (e) { /* leave as-is; a manual pull will retry */ }
    conv._loadingOlder = false;
  }

  function scrollConvToBottom(ctx, animate) {
    const m = ctx.conv.messages;
    if (animate) m.scrollTo({ top: m.scrollHeight, behavior: "smooth" });
    else m.scrollTop = m.scrollHeight;
    showJump(ctx, false);
  }
  function showJump(ctx, show) { ctx.conv.jump.dataset.show = show ? "1" : "0"; }

  function updateTypingIndicator(ctx) {
    const convId = ctx.state.currentConvId;
    const set = convId && ctx.state.typingByConv.get(convId);
    const row = ctx.conv.typingRow;
    if (set && set.size) {
      row.style.display = "flex";
      row.innerHTML = "";
      const users = Array.from(set).map((id) => (ctx.state.convById.get(convId) || {}).participants && (ctx.state.convById.get(convId).participants || []).find((p) => p.id === id));
      const first = users[0];
      row.appendChild(makeAvatar(first || { name: "?" }, 22));
      const b = el("div", "gh-typing-bubble");
      b.innerHTML = "<span></span><span></span><span></span>";
      row.appendChild(b);
    } else row.style.display = "none";
  }

  function setReplyTo(ctx, msg) {
    const conv = ctx.conv;
    conv.replyTo = msg;
    if (msg) {
      conv.replyBar.dataset.show = "1";
      conv.replyBar.querySelector(".gh-reply-bar-name").textContent = (msg.from && msg.from.name) || "Reply";
      conv.replyBar.querySelector(".gh-reply-bar-text").textContent = msg.text || "(media)";
    } else conv.replyBar.dataset.show = "0";
  }

  async function sendCurrentText(ctx) {
    const conv = ctx.conv;
    const text = conv.textarea.value.trim();
    if (!text) return;
    const convId = ctx.state.currentConvId;
    if (!convId) return;
    haptic("light");
    conv.textarea.value = "";
    conv.textarea.style.height = "auto";
    conv.sendBtn.dataset.show = "0";
    const replyToMessageId = conv.replyTo ? conv.replyTo.id : undefined;
    setReplyTo(ctx, null);
    try { await api.sendText(convId, text, replyToMessageId ? { replyToMessageId } : {}); }
    catch (e) { ctx.showToast("Couldn't send that message"); }
  }
  async function sendMediaFile(ctx, file) {
    const convId = ctx.state.currentConvId;
    if (!convId) return;
    const kind = file.type.startsWith("video/") ? "video" : (file.type === "image/gif" ? "gif" : "image");
    try { await api.sendMedia(convId, file, { kind }); }
    catch (e) { ctx.showToast("Couldn't send that file"); }
  }

  // ---- swipe-to-reply + long-press action sheet, per message -----------------------------------------
  function initMessageGestures(ctx, conv) {
    const LONG_PRESS_MS = 360, MOVE_CANCEL = 10, LOCK_MIN = 8, REPLY_TRIGGER = 64, REPLY_MAX = 84;
    let g = null;
    function findWrap(target) { return target.closest && target.closest(".gh-msg-wrap"); }
    function messageFor(wrap) {
      const id = wrap.dataset.messageId;
      return (conv._all || []).find((m) => m.id === id);
    }
    conv.messages.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { g = null; return; }
      const target = e.target;
      if (target.closest("button, a, input, textarea, video, .gh-reaction-pill")) { g = null; return; }
      const wrap = findWrap(target);
      if (!wrap) { g = null; return; }
      const t = e.touches[0];
      g = { wrap, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, locked: null, longFired: false };
      g.timer = setTimeout(() => {
        g.longFired = true;
        haptic("medium");
        const m = messageFor(wrap);
        if (m) openActionSheet(ctx, m, wrap);
      }, LONG_PRESS_MS);
    }, { passive: true });
    conv.messages.addEventListener("touchmove", (e) => {
      if (!g || e.touches.length !== 1) return;
      const t = e.touches[0];
      g.dx = t.clientX - g.x0; g.dy = t.clientY - g.y0;
      if (g.timer && (Math.abs(g.dx) > MOVE_CANCEL || Math.abs(g.dy) > MOVE_CANCEL)) { clearTimeout(g.timer); g.timer = null; }
      if (g.longFired) { e.preventDefault(); return; }
      if (!g.locked) {
        if (Math.abs(g.dx) < LOCK_MIN && Math.abs(g.dy) < LOCK_MIN) return;
        g.locked = Math.abs(g.dx) > Math.abs(g.dy) * 1.2 ? "x" : "y";
      }
      if (g.locked !== "x" || g.dx <= 0) return;
      e.preventDefault();
      const dx = Math.min(g.dx, REPLY_MAX);
      const swipe = g.wrap.querySelector(".gh-msg-swipe");
      swipe.style.setProperty("--gh-swipe-x", dx * 0.72 + "px");
      const progress = clamp(dx / REPLY_TRIGGER, 0, 1);
      g.wrap.style.setProperty("--gh-reply-op", String(progress));
      g.wrap.style.setProperty("--gh-reply-scale", String(0.5 + 0.5 * progress));
      if (!g.hapticFired && dx > REPLY_TRIGGER) { g.hapticFired = true; haptic("light"); }
      if (g.hapticFired && dx <= REPLY_TRIGGER) g.hapticFired = false;
    }, { passive: false });
    function finish() {
      if (!g) return;
      const gs = g; g = null;
      if (gs.timer) clearTimeout(gs.timer);
      const swipe = gs.wrap.querySelector(".gh-msg-swipe");
      swipe.classList.add("gh-anim");
      if (!gs.longFired && gs.locked === "x" && gs.dx > REPLY_TRIGGER) {
        const m = messageFor(gs.wrap);
        if (m) { haptic(); setReplyTo(ctx, m); conv.textarea.focus(); }
      }
      swipe.style.setProperty("--gh-swipe-x", "0px");
      gs.wrap.style.setProperty("--gh-reply-op", "0");
      gs.wrap.style.setProperty("--gh-reply-scale", "0.6");
      setTimeout(() => swipe.classList.remove("gh-anim"), 260);
    }
    conv.messages.addEventListener("touchend", finish, { passive: true });
    conv.messages.addEventListener("touchcancel", finish, { passive: true });
  }

  // =====================================================================================================
  // Action sheet (long-press a message)
  // =====================================================================================================
  const REACTION_EMOJIS = ["❤️", "😂", "😮", "😢", "😡", "👍"];
  function buildActionSheet(ctx, overlaysRoot) {
    const backdrop = el("div", "gh-backdrop");
    const sheet = el("div", "gh-sheet gh-action-sheet");
    sheet.innerHTML = `
      <div class="gh-sheet-grip"></div>
      <div class="gh-react-row"></div>
      <div class="gh-action-list">
        <div class="gh-action-item" data-act="reply"></div>
        <div class="gh-action-item" data-act="copy"></div>
        <div class="gh-action-item" data-act="save"></div>
      </div>
    `;
    const reactRow = sheet.querySelector(".gh-react-row");
    for (const emoji of REACTION_EMOJIS) {
      const b = el("button", "gh-react-emoji gh-press");
      b.textContent = emoji;
      b.dataset.emoji = emoji;
      reactRow.appendChild(b);
    }
    const replyItem = sheet.querySelector('[data-act="reply"]');
    replyItem.append(icon("reply"), textSpan("Reply"));
    const copyItem = sheet.querySelector('[data-act="copy"]');
    copyItem.append(icon("copy"), textSpan("Copy"));
    const saveItem = sheet.querySelector('[data-act="save"]');
    saveItem.append(icon("star"), textSpan("Save"));

    overlaysRoot.appendChild(backdrop);
    overlaysRoot.appendChild(sheet);
    backdrop.addEventListener("click", () => closeSheetGeneric(backdrop, sheet));
    function textSpan(t) { const s = el("span"); s.textContent = t; return s; }

    const s = { backdrop, sheet, reactRow, replyItem, copyItem, saveItem, message: null };
    return s;
  }
  function closeSheetGeneric(backdrop, sheet) {
    backdrop.dataset.open = "0";
    sheet.classList.add("gh-anim");
    sheet.dataset.open = "0";
  }
  function openSheetGeneric(backdrop, sheet) {
    backdrop.dataset.open = "1";
    sheet.classList.add("gh-anim");
    requestAnimationFrame(() => { sheet.dataset.open = "1"; });
  }
  function openActionSheet(ctx, message, wrapEl) {
    const s = ctx.actionSheet;
    s.message = message;
    const convId = ctx.state.currentConvId;
    const meId = ctx.state.me && ctx.state.me.id;
    for (const b of s.reactRow.querySelectorAll(".gh-react-emoji")) {
      const mine = (message.reactions || []).some((r) => r.emoji === b.dataset.emoji && r.from && r.from.id === meId);
      b.dataset.mine = mine ? "1" : "0";
      b.onclick = () => {
        haptic("light");
        api.react(convId, message.id, mine ? null : b.dataset.emoji).catch(() => {});
        closeSheetGeneric(s.backdrop, s.sheet);
      };
    }
    s.replyItem.onclick = () => { setReplyTo(ctx, message); ctx.conv.textarea.focus(); closeSheetGeneric(s.backdrop, s.sheet); };
    s.copyItem.onclick = () => { copyToClipboard(message.text || ""); closeSheetGeneric(s.backdrop, s.sheet); };
    const saveLabel = s.saveItem.querySelector("span");
    saveLabel.textContent = message.saved ? "Unsave" : "Save";
    s.saveItem.onclick = () => {
      const next = !message.saved;
      message.saved = next;
      api.saveMessage(convId, message.id, next).catch(() => {});
      closeSheetGeneric(s.backdrop, s.sheet);
    };
    openSheetGeneric(s.backdrop, s.sheet);
  }
  function copyToClipboard(text) {
    try { navigator.clipboard.writeText(text); return; } catch (e) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    } catch (e) {}
  }

  // =====================================================================================================
  // GIF sheet
  // =====================================================================================================
  function buildGifSheet(ctx, overlaysRoot) {
    const backdrop = el("div", "gh-backdrop");
    const sheet = el("div", "gh-sheet gh-gif-sheet");
    sheet.innerHTML = `
      <div class="gh-sheet-grip"></div>
      <div class="gh-gif-search-row"><div class="gh-search"></div></div>
      <div class="gh-gif-tabs">
        <button class="gh-gif-tab" data-tab="trending">Trending</button>
        <button class="gh-gif-tab" data-tab="favorites">Favourites</button>
        <button class="gh-gif-tab" data-tab="recents">Recents</button>
      </div>
      <div class="gh-gif-body gh-scroll"></div>
    `;
    const searchWrap = sheet.querySelector(".gh-gif-search-row .gh-search");
    searchWrap.appendChild(icon("search", 16));
    const input = el("input");
    input.placeholder = "Search GIPHY";
    input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
    searchWrap.appendChild(input);
    overlaysRoot.append(backdrop, sheet);
    backdrop.addEventListener("click", () => closeSheetGeneric(backdrop, sheet));

    const s = { backdrop, sheet, input, body: sheet.querySelector(".gh-gif-body"), tabs: {}, tab: "trending", query: "", seq: 0 };
    for (const b of sheet.querySelectorAll(".gh-gif-tab")) {
      s.tabs[b.dataset.tab] = b;
      b.addEventListener("click", () => { haptic("light"); s.tab = b.dataset.tab; s.query = ""; input.value = ""; renderGifResults(ctx, s); });
    }
    let t;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { s.query = input.value.trim(); renderGifResults(ctx, s); }, 250); });
    return s;
  }
  function openGifSheet(ctx) {
    haptic();
    const s = ctx.gifSheet;
    s.tab = "trending"; s.query = ""; s.input.value = "";
    openSheetGeneric(s.backdrop, s.sheet);
    renderGifResults(ctx, s);
  }
  function paintGifTabs(s) {
    for (const [name, btn] of Object.entries(s.tabs)) btn.dataset.on = (!s.query && s.tab === name) ? "1" : "0";
  }
  async function renderGifResults(ctx, s) {
    paintGifTabs(s);
    const mySeq = ++s.seq;
    s.body.innerHTML = "";
    if (s.query) return void loadGifGrid(ctx, s, mySeq, () => giphySearch(s.query, 0, gifRating()));
    if (s.tab === "trending") return void loadGifGrid(ctx, s, mySeq, () => giphySearch("", 0, gifRating()));
    if (s.tab === "favorites") return void loadStaticGifGrid(ctx, s, mySeq, "ghostGifFavs");
    if (s.tab === "recents") return void loadStaticGifGrid(ctx, s, mySeq, "ghostGifRecents");
  }
  function gifRating() { try { return (typeof window.dgSetting === "function") ? window.dgSetting("gifRating", "pg-13") : "pg-13"; } catch (e) { return "pg-13"; } }
  async function loadStaticGifGrid(ctx, s, mySeq, key) {
    const list = await storage.get(key, []);
    if (mySeq !== s.seq) return;
    if (!list.length) { const note = el("div", "gh-gif-note"); note.textContent = key === "ghostGifFavs" ? "No favourites yet" : "GIFs you send will show up here"; s.body.appendChild(note); return; }
    paintGifGrid(ctx, s, list);
  }
  async function loadGifGrid(ctx, s, mySeq, fetcher) {
    const skelGrid = el("div", "gh-gif-grid");
    const cols = [el("div", "gh-gif-col"), el("div", "gh-gif-col")];
    skelGrid.append(...cols);
    s.body.appendChild(skelGrid);
    const res = await fetcher();
    if (mySeq !== s.seq) return;
    if (!res || res.needKey) { s.body.innerHTML = ""; const n = el("div", "gh-gif-note"); n.textContent = "GIF search needs a GIPHY API key (set via GIF settings)."; s.body.appendChild(n); return; }
    if (res.error) { s.body.innerHTML = ""; const n = el("div", "gh-gif-note"); n.textContent = res.error; s.body.appendChild(n); return; }
    if (!res.results || !res.results.length) { s.body.innerHTML = ""; const n = el("div", "gh-gif-note"); n.textContent = "No GIFs found"; s.body.appendChild(n); return; }
    s.body.innerHTML = "";
    paintGifGrid(ctx, s, res.results);
  }
  function paintGifGrid(ctx, s, list) {
    const grid = el("div", "gh-gif-grid");
    const cols = [el("div", "gh-gif-col"), el("div", "gh-gif-col")];
    grid.append(...cols);
    const heights = [0, 0];
    for (const g of list) {
      const i = heights[0] <= heights[1] ? 0 : 1;
      heights[i] += g.h / g.w;
      cols[i].appendChild(gifTileEl(ctx, g, s));
    }
    s.body.appendChild(grid);
  }
  function gifTileEl(ctx, g, s) {
    const tile = el("div", "gh-gif-tile");
    tile.style.aspectRatio = `${g.w} / ${g.h}`;
    const img = el("img");
    giphyPreviewUrl(g.id).then((r) => { if (r && r.dataUrl) img.src = r.dataUrl; });
    tile.appendChild(img);
    tile.addEventListener("click", async () => {
      haptic();
      const r = await giphyFileUrl(g.id);
      if (!r || !r.dataUrl) { ctx.showToast("Couldn't load that GIF"); return; }
      const convId = ctx.state.currentConvId;
      const bin = atob(r.dataUrl.slice(r.dataUrl.indexOf(",") + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/gif" });
      try { await api.sendMedia(convId, blob, { kind: "gif" }); } catch (e) { ctx.showToast("Couldn't send that GIF"); }
      const recents = await storage.get("ghostGifRecents", []);
      await storage.set("ghostGifRecents", [{ id: g.id, w: g.w, h: g.h }, ...recents.filter((r2) => r2.id !== g.id)].slice(0, 40));
      closeSheetGeneric(s.backdrop, s.sheet);
    });
    return tile;
  }

  // =====================================================================================================
  // New chat sheet
  // =====================================================================================================
  function buildNewChatSheet(ctx, overlaysRoot) {
    const backdrop = el("div", "gh-backdrop");
    const sheet = el("div", "gh-sheet", {});
    sheet.style.maxHeight = "88%";
    sheet.innerHTML = `
      <div class="gh-sheet-grip"></div>
      <div class="gh-newchat-header">
        <div class="gh-header-title">New Message</div>
        <button class="gh-icon-btn gh-hit" data-act="close"></button>
      </div>
      <div class="gh-newchat-search"><div class="gh-search"></div></div>
      <div class="gh-friend-list gh-scroll" style="flex:1;min-height:0;"></div>
      <button class="gh-newchat-create" disabled>Chat</button>
    `;
    sheet.querySelector('[data-act="close"]').appendChild(icon("close"));
    const searchWrap = sheet.querySelector(".gh-newchat-search .gh-search");
    searchWrap.appendChild(icon("search", 16));
    const input = el("input");
    input.placeholder = "To:"; input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
    searchWrap.appendChild(input);
    overlaysRoot.append(backdrop, sheet);
    backdrop.addEventListener("click", () => closeSheetGeneric(backdrop, sheet));
    const s = { backdrop, sheet, input, list: sheet.querySelector(".gh-friend-list"), createBtn: sheet.querySelector(".gh-newchat-create"), picked: new Map(), seq: 0 };
    sheet.querySelector('[data-act="close"]').addEventListener("click", () => closeSheetGeneric(backdrop, sheet));
    let t;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => runFriendSearch(ctx, s), 200); });
    s.createBtn.addEventListener("click", async () => {
      if (!s.picked.size) return;
      haptic();
      try {
        const res = await api.newConversation(Array.from(s.picked.keys()));
        closeSheetGeneric(backdrop, sheet);
        if (res && res.conversationId) {
          if (!ctx.state.convById.has(res.conversationId)) await api.listConversations().then((cs) => applyConversations(ctx, cs || []));
          openConversationScreen(ctx, res.conversationId);
        }
      } catch (e) { ctx.showToast("Couldn't start that chat"); }
    });
    return s;
  }
  function openNewChatSheet(ctx) {
    const s = ctx.newChatSheet;
    s.picked = new Map();
    s.input.value = "";
    s.createBtn.disabled = true;
    openSheetGeneric(s.backdrop, s.sheet);
    runFriendSearch(ctx, s);
  }
  async function runFriendSearch(ctx, s) {
    const mySeq = ++s.seq;
    const q = s.input.value.trim();
    let results = [];
    try { results = await api.searchFriends(q); } catch (e) { results = []; }
    if (mySeq !== s.seq) return;
    s.list.innerHTML = "";
    if (!results || !results.length) { const n = el("div", "gh-empty"); n.textContent = "No friends found"; s.list.appendChild(n); return; }
    for (const u of results) {
      const row = el("div", "gh-friend-row gh-press");
      row.dataset.picked = s.picked.has(u.id) ? "1" : "0";
      row.appendChild(makeAvatar(u, 40));
      const name = el("div", "gh-friend-name"); name.textContent = u.name || u.username || "Unknown";
      const check = el("div", "gh-friend-check");
      row.append(name, check);
      row.addEventListener("click", () => {
        haptic("light");
        if (s.picked.has(u.id)) s.picked.delete(u.id); else s.picked.set(u.id, u);
        row.dataset.picked = s.picked.has(u.id) ? "1" : "0";
        s.createBtn.disabled = s.picked.size === 0;
      });
      s.list.appendChild(row);
    }
  }

  // =====================================================================================================
  // Snap / story viewer (shared component)
  // =====================================================================================================
  function buildViewer(ctx) {
    const wrap = el("div", "gh-viewer");
    wrap.innerHTML = `
      <div class="gh-viewer-bars"></div>
      <div class="gh-viewer-top">
        <div class="gh-viewer-top-name"></div>
        <button class="gh-viewer-close gh-hit"></button>
      </div>
      <div class="gh-viewer-media"></div>
      <div class="gh-viewer-tapzone"><div data-z="prev"></div><div data-z="next"></div></div>
      <div class="gh-viewer-hint">Tap to advance · hold to pause · swipe down to close</div>
    `;
    wrap.querySelector(".gh-viewer-close").appendChild(icon("close", 20));
    const v = {
      el: wrap, bars: wrap.querySelector(".gh-viewer-bars"), media: wrap.querySelector(".gh-viewer-media"),
      nameEl: wrap.querySelector(".gh-viewer-top-name"), avatarSlot: wrap.querySelector(".gh-viewer-top"),
      items: [], idx: 0, timer: null, startedAt: 0, elapsedAtPause: 0, paused: false, single: false,
    };
    wrap.querySelector(".gh-viewer-close").addEventListener("click", () => closeViewer(ctx));
    wrap.querySelector('[data-z="prev"]').addEventListener("click", () => viewerStep(ctx, -1));
    wrap.querySelector('[data-z="next"]').addEventListener("click", () => viewerStep(ctx, 1));

    let holdTimer = null, startY = 0, dragging = false;
    wrap.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY; dragging = false;
      holdTimer = setTimeout(() => { pauseViewer(ctx, true); }, 180);
    }, { passive: true });
    wrap.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 12) {
        dragging = true;
        clearTimeout(holdTimer);
        wrap.style.transform = `translateY(${dy}px)`;
        wrap.style.opacity = String(clamp(1 - dy / 400, 0.4, 1));
      }
    }, { passive: true });
    wrap.addEventListener("touchend", (e) => {
      clearTimeout(holdTimer);
      const dy = (e.changedTouches[0].clientY - startY);
      if (dragging && dy > 100) { closeViewer(ctx); return; }
      wrap.style.transform = ""; wrap.style.opacity = "";
      if (v.paused) pauseViewer(ctx, false);
    }, { passive: true });
    return v;
  }
  function openViewerSingle(ctx, mediaRef) {
    const v = ctx.viewer;
    v.single = true; v.items = [mediaRef]; v.idx = 0;
    v.el.dataset.open = "1"; v.bars.style.display = "none"; v.avatarSlot.style.display = "none";
    paintViewerItem(ctx);
  }
  function openViewerSequence(ctx, items, opts) {
    const v = ctx.viewer;
    v.single = false; v.items = items || []; v.idx = 0;
    v.el.dataset.open = "1"; v.bars.style.display = "flex"; v.avatarSlot.style.display = "flex";
    v.nameEl.textContent = (opts && opts.title) || "";
    v.bars.innerHTML = "";
    for (let i = 0; i < v.items.length; i++) {
      const bar = el("div", "gh-viewer-bar");
      bar.appendChild(el("div", "gh-viewer-bar-fill"));
      v.bars.appendChild(bar);
    }
    paintViewerItem(ctx);
  }
  function openStoryViewer(ctx, story) {
    api.openStory(story.user.id).then((res) => {
      openViewerSequence(ctx, (res && res.items) || [], { title: story.user.name });
    }).catch(() => ctx.showToast("Couldn't open that story"));
  }
  function paintViewerItem(ctx) {
    const v = ctx.viewer;
    v.media.innerHTML = "";
    const ref = v.items[v.idx];
    if (!ref) { closeViewer(ctx); return; }
    if (ref.type === "video") {
      const video = el("video");
      video.src = ref.url || (ref.blob && URL.createObjectURL(ref.blob)) || "";
      video.muted = false; video.playsInline = true; video.autoplay = true;
      video.addEventListener("ended", () => viewerStep(ctx, 1));
      v.media.appendChild(video);
      startViewerTimer(ctx, (ref.durationSec || 6) * 1000);
    } else {
      const img = el("img");
      img.src = ref.url || (ref.blob && URL.createObjectURL(ref.blob)) || "";
      v.media.appendChild(img);
      startViewerTimer(ctx, 5000);
    }
    if (!v.single) {
      const fills = v.bars.querySelectorAll(".gh-viewer-bar-fill");
      fills.forEach((f, i) => { f.classList.remove("gh-anim"); f.style.width = i < v.idx ? "100%" : "0%"; });
    }
  }
  function startViewerTimer(ctx, durMs) {
    const v = ctx.viewer;
    clearTimeout(v.timer);
    v.startedAt = nowMs(); v.dur = durMs; v.paused = false;
    if (!v.single) {
      const fill = v.bars.querySelectorAll(".gh-viewer-bar-fill")[v.idx];
      if (fill) { fill.style.transition = "none"; fill.style.width = "0%"; requestAnimationFrame(() => { fill.classList.add("gh-anim"); fill.style.transitionDuration = durMs + "ms"; fill.style.width = "100%"; }); }
    }
    v.timer = setTimeout(() => viewerStep(ctx, 1), durMs);
  }
  function pauseViewer(ctx, pause) {
    const v = ctx.viewer;
    v.paused = pause;
    const video = v.media.querySelector("video");
    if (pause) {
      clearTimeout(v.timer);
      v.elapsedAtPause = nowMs() - v.startedAt;
      if (video) video.pause();
      if (!v.single) { const fill = v.bars.querySelectorAll(".gh-viewer-bar-fill")[v.idx]; if (fill) fill.style.animationPlayState = "paused"; }
    } else {
      if (video) video.play().catch(() => {});
      const remaining = Math.max(200, (v.dur || 5000) - v.elapsedAtPause);
      v.startedAt = nowMs() - v.elapsedAtPause;
      v.timer = setTimeout(() => viewerStep(ctx, 1), remaining);
    }
  }
  function viewerStep(ctx, dir) {
    const v = ctx.viewer;
    if (v.single) { if (dir > 0) closeViewer(ctx); return; }
    clearTimeout(v.timer);
    v.idx += dir;
    if (v.idx < 0) v.idx = 0;
    if (v.idx >= v.items.length) { closeViewer(ctx); return; }
    paintViewerItem(ctx);
  }
  function closeViewer(ctx) {
    const v = ctx.viewer;
    clearTimeout(v.timer);
    v.el.dataset.open = "0";
    v.el.style.transform = ""; v.el.style.opacity = "";
    v.media.innerHTML = "";
  }

  // =====================================================================================================
  // Camera (device required — see notes below)
  // =====================================================================================================
  function buildCamera(ctx) {
    const wrap = el("div", "gh-camera");
    wrap.innerHTML = `
      <div class="gh-camera-preview"><div class="gh-camera-note">Camera preview needs a real device (getUserMedia).</div></div>
      <div class="gh-camera-top">
        <button class="gh-icon-btn gh-hit" data-act="close"></button>
        <button class="gh-icon-btn gh-hit" data-act="flip"></button>
      </div>
      <div class="gh-camera-bottom"><button class="gh-shutter"></button></div>
      <div class="gh-camera-preview-screen">
        <div class="gh-camera-preview" style="flex:1;"></div>
        <div class="gh-header" style="background:transparent;border:none;">
          <button class="gh-icon-btn gh-hit" data-act="preview-close" style="color:#fff;"></button>
          <div class="gh-header-title" style="color:#fff;">Send to…</div>
        </div>
        <div class="gh-send-to-list gh-scroll" style="flex:1;min-height:0;background:var(--gh-bg-2);"></div>
        <button class="gh-newchat-create" style="margin:8px 16px calc(12px + var(--gh-safe-b));" data-act="send">Send</button>
      </div>
    `;
    wrap.querySelector('[data-act="close"]').appendChild(icon("close"));
    wrap.querySelector('[data-act="flip"]').appendChild(icon("flip"));
    wrap.querySelector('[data-act="preview-close"]').appendChild(icon("back"));

    const c = {
      el: wrap,
      previewHost: wrap.querySelector(".gh-camera-preview"),
      shutter: wrap.querySelector(".gh-shutter"),
      previewScreen: wrap.querySelector(".gh-camera-preview-screen"),
      sendToList: wrap.querySelector(".gh-send-to-list"),
      stream: null, video: null, facing: "user", recording: false, recorder: null, chunks: [], capturedBlob: null, picked: new Set(),
    };
    wrap.querySelector('[data-act="close"]').addEventListener("click", () => closeCamera(ctx));
    wrap.querySelector('[data-act="flip"]').addEventListener("click", () => flipCamera(ctx));
    wrap.querySelector('[data-act="preview-close"]').addEventListener("click", () => { c.previewScreen.dataset.open = "0"; startCameraStream(ctx); });
    wrap.querySelector('[data-act="send"]').addEventListener("click", () => sendSnapNow(ctx));

    let pressTimer = null;
    c.shutter.addEventListener("touchstart", (e) => {
      e.preventDefault();
      pressTimer = setTimeout(() => startRecording(ctx), 320);
    }, { passive: false });
    c.shutter.addEventListener("touchend", () => {
      clearTimeout(pressTimer);
      if (c.recording) stopRecording(ctx); else takePhoto(ctx);
    });
    return c;
  }
  function openCamera(ctx, opts) {
    haptic();
    ctx.camera.el.dataset.open = "1";
    startCameraStream(ctx);
  }
  function closeCamera(ctx) {
    ctx.camera.el.dataset.open = "0";
    stopCameraStream(ctx);
  }
  async function startCameraStream(ctx) {
    const c = ctx.camera;
    stopCameraStream(ctx);
    // DEVICE CHECK: getUserMedia is patched by the app's camhook.js to a canvas-based stream (front camera
    // default) — on a plain desktop/WebKit test rig with no camera it will reject, which is expected; the
    // note element (gh-camera-note) stays visible in that case instead of a broken <video>.
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: c.facing }, audio: true });
      c.stream = stream;
      c.previewHost.innerHTML = "";
      const video = el("video");
      video.autoplay = true; video.playsInline = true; video.muted = true;
      video.srcObject = stream;
      c.previewHost.appendChild(video);
      c.video = video;
    } catch (e) { /* no camera available here — the static note stays up */ }
  }
  function stopCameraStream(ctx) {
    const c = ctx.camera;
    if (c.stream) { c.stream.getTracks().forEach((t) => t.stop()); c.stream = null; }
    c.video = null;
  }
  function flipCamera(ctx) {
    haptic("light");
    ctx.camera.facing = ctx.camera.facing === "user" ? "environment" : "user";
    startCameraStream(ctx);
  }
  function takePhoto(ctx) {
    const c = ctx.camera;
    haptic();
    if (!c.video) { ctx.showToast("No camera on this device"); return; }
    const canvas = document.createElement("canvas");
    canvas.width = c.video.videoWidth || 720; canvas.height = c.video.videoHeight || 1280;
    canvas.getContext("2d").drawImage(c.video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => { if (blob) openSendPreview(ctx, blob, "image"); }, "image/jpeg", 0.92);
  }
  function startRecording(ctx) {
    const c = ctx.camera;
    if (!c.stream || typeof MediaRecorder === "undefined") return; // DEVICE CHECK: needs MediaRecorder + a real stream
    haptic("medium");
    c.chunks = [];
    try {
      c.recorder = new MediaRecorder(c.stream);
      c.recorder.ondataavailable = (e) => { if (e.data.size) c.chunks.push(e.data); };
      c.recorder.onstop = () => { const blob = new Blob(c.chunks, { type: "video/mp4" }); openSendPreview(ctx, blob, "video"); };
      c.recorder.start();
      c.recording = true;
      c.shutter.dataset.recording = "1";
    } catch (e) { c.recording = false; }
  }
  function stopRecording(ctx) {
    const c = ctx.camera;
    c.shutter.dataset.recording = "0";
    if (c.recording && c.recorder) { c.recorder.stop(); c.recording = false; }
  }
  function openSendPreview(ctx, blob, kind) {
    const c = ctx.camera;
    c.capturedBlob = blob; c.capturedKind = kind;
    stopCameraStream(ctx);
    c.previewScreen.querySelector(".gh-camera-preview").innerHTML = "";
    const url = URL.createObjectURL(blob);
    const media = kind === "video" ? el("video") : el("img");
    media.src = url;
    if (kind === "video") { media.autoplay = true; media.loop = true; media.muted = true; media.playsInline = true; }
    media.style.position = "absolute"; media.style.inset = "0"; media.style.width = "100%"; media.style.height = "100%"; media.style.objectFit = "cover";
    c.previewScreen.querySelector(".gh-camera-preview").appendChild(media);
    c.picked = new Set();
    c.sendToList.innerHTML = "";
    for (const conv of ctx.state.conversations.slice(0, 20)) {
      const row = el("div", "gh-friend-row gh-press");
      const avatarUser = conv.isGroup ? { name: conv.title } : (conv.participants && conv.participants[0]) || { name: conv.title };
      row.appendChild(makeAvatar(avatarUser, 40));
      const name = el("div", "gh-friend-name"); name.textContent = conv.title;
      const check = el("div", "gh-friend-check");
      row.append(name, check);
      row.addEventListener("click", () => {
        haptic("light");
        if (c.picked.has(conv.id)) c.picked.delete(conv.id); else c.picked.add(conv.id);
        row.dataset.picked = c.picked.has(conv.id) ? "1" : "0";
      });
      c.sendToList.appendChild(row);
    }
    c.previewScreen.dataset.open = "1";
  }
  async function sendSnapNow(ctx) {
    const c = ctx.camera;
    if (!c.picked.size || !c.capturedBlob) { ctx.showToast("Pick who to send to"); return; }
    haptic();
    try {
      await api.sendSnap(Array.from(c.picked), c.capturedBlob, { kind: c.capturedKind });
      closeCamera(ctx);
      c.previewScreen.dataset.open = "0";
    } catch (e) { ctx.showToast("Couldn't send that Snap"); }
  }

  // =====================================================================================================
  // Navigation: push/pop + interactive drag between home <-> conversation (like the native apps)
  // =====================================================================================================
  function navigateTo(ctx, screenName, animate) {
    const home = ctx.home.screen, conv = ctx.conv.screen, shade = ctx.shade;
    const showConv = screenName === "conv";
    if (animate) { conv.classList.add("gh-anim"); home.classList.add("gh-anim"); shade.classList.add("gh-anim"); }
    conv.style.transform = showConv ? "translate3d(0,0,0)" : "translate3d(100%,0,0)";
    home.style.transform = showConv ? "translate3d(-30%,0,0)" : "translate3d(0,0,0)";
    shade.style.opacity = showConv ? "0.15" : "0";
    ctx.state.navProgress = showConv ? 1 : 0;
    if (animate) setTimeout(() => { conv.classList.remove("gh-anim"); home.classList.remove("gh-anim"); shade.classList.remove("gh-anim"); }, 340);
  }

  function initNavGesture(ctx) {
    const stack = ctx.stack, home = ctx.home.screen, conv = ctx.conv.screen, shade = ctx.shade;
    const EDGE_ZONE = 24, TRIGGER = 0.35, FLICK_V = 0.5;
    let g = null;

    function widthPx() { return stack.getBoundingClientRect().width || 393; }
    function setProgress(p, animate) {
      p = clamp(p, 0, 1);
      if (animate) { conv.classList.add("gh-anim"); home.classList.add("gh-anim"); shade.classList.add("gh-anim"); }
      else { conv.classList.remove("gh-anim"); home.classList.remove("gh-anim"); shade.classList.remove("gh-anim"); }
      conv.style.transform = `translate3d(${(1 - p) * 100}%,0,0)`;
      home.style.transform = `translate3d(${-30 * p}%,0,0)`;
      shade.style.opacity = String(0.15 * p);
      ctx.state.navProgress = p;
    }

    function begin(kind, e, wrapRowId) {
      const t = e.touches[0];
      g = { kind, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, locked: null, p0: ctx.state.navProgress, rowId: wrapRowId, samples: [{ x: t.clientX, t: nowMs() }] };
    }
    function move(e) {
      if (!g || e.touches.length !== 1) return;
      const t = e.touches[0];
      g.dx = t.clientX - g.x0; g.dy = t.clientY - g.y0;
      g.samples.push({ x: t.clientX, t: nowMs() }); if (g.samples.length > 10) g.samples.shift();
      if (!g.locked) {
        if (Math.abs(g.dx) < 8 && Math.abs(g.dy) < 8) return;
        g.locked = Math.abs(g.dx) > Math.abs(g.dy) * 1.2 ? "x" : "y";
        if (g.locked !== "x") { g = null; return; }
      }
      e.preventDefault();
      const w = widthPx();
      const delta = g.dx / w;
      // Opening (progress 0 -> 1): dragging LEFT (delta negative) pulls the conversation in, like a row
      // sliding in from the right. Closing (progress 1 -> 0): dragging RIGHT (delta positive) reveals home
      // underneath, like the standard iOS edge-swipe-back — progress must DECREASE as delta increases.
      const p = g.kind === "open" ? clamp(g.p0 + Math.max(0, -delta) * 1.6, 0, 1) : clamp(g.p0 - delta, 0, 1);
      setProgress(p, false);
    }
    function end() {
      if (!g) { return; }
      const gs = g; g = null;
      if (gs.locked !== "x") return;
      const recent = gs.samples.filter((s) => nowMs() - s.t < 100);
      const v = recent.length > 1 ? (recent[recent.length - 1].x - recent[0].x) / Math.max(1, recent[recent.length - 1].t - recent[0].t) : 0;
      const opening = gs.kind === "open";
      if (opening) {
        const commit = ctx.state.navProgress > TRIGGER || v < -FLICK_V; // past the distance threshold, or a fast leftward flick
        if (commit) {
          haptic("light");
          setProgress(1, true);
          if (gs.rowId) { ctx.state.currentConvId = gs.rowId; const cd = ctx.state.convById.get(gs.rowId); if (cd) updateConvHeader(ctx, cd); openConversationScreen(ctx, gs.rowId); }
        } else {
          setProgress(0, true); // spring back to home, closed
        }
      } else {
        const commit = ctx.state.navProgress < (1 - TRIGGER) || v > FLICK_V; // dragged far enough closed, or a fast rightward flick
        if (commit) {
          haptic("light");
          setProgress(0, true);
          const id = ctx.state.currentConvId;
          if (id) api.closeConversation(id).catch(() => {});
          ctx.state.currentConvId = null;
        } else {
          setProgress(1, true); // spring back to the conversation, still open
        }
      }
    }

    stack.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { g = null; return; }
      const target = e.target;
      const onConv = ctx.state.navProgress > 0.5;
      if (!onConv) {
        const row = target.closest && target.closest(".gh-row");
        if (row && !target.closest("input, button")) begin("open", e, row.dataset.id);
        else g = null;
      } else {
        const x = e.touches[0].clientX;
        if (x <= EDGE_ZONE && !target.closest("input, textarea, button, .gh-msg-wrap")) begin("close", e, null);
        else g = null;
      }
    }, { passive: true });
    stack.addEventListener("touchmove", move, { passive: false });
    stack.addEventListener("touchend", end, { passive: true });
    stack.addEventListener("touchcancel", end, { passive: true });
    // iOS keeps delivering a touch's later events to the element it started on even if that element is
    // removed from the DOM mid-gesture (e.g. the row list re-renders under the finger) — bind there too.
    stack.addEventListener("touchstart", (e) => {
      const t = e.target;
      if (!t || !t.addEventListener) return;
      const onMove = (ev) => move(ev);
      const onEnd = (ev) => end(ev);
      t.addEventListener("touchmove", onMove, { passive: false });
      t.addEventListener("touchend", onEnd, { passive: true });
      t.addEventListener("touchcancel", onEnd, { passive: true });
      const drop = () => { t.removeEventListener("touchmove", onMove); t.removeEventListener("touchend", onEnd); t.removeEventListener("touchcancel", onEnd); };
      t.addEventListener("touchend", drop, { once: true });
      t.addEventListener("touchcancel", drop, { once: true });
    }, { passive: true });
  }

  // Called last on purpose: mount() synchronously builds the whole app (via the custom element's
  // connectedCallback), which touches every const/function declared above it — this must run only after
  // the whole IIFE body has executed once, so nothing above is still in its temporal dead zone.
  mount();
})();
