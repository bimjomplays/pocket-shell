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
  // errors inside this world reach the app's log only as "Script error." - record the real message + stack
  addEventListener("error", (e) => { try { window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GHOST ui crash " + (e.error && (e.error.message + " | " + String(e.error.stack || "").split("\n").slice(0, 3).join(" < ")) || e.message) }).catch(() => {}); } catch (x) {} });
  addEventListener("unhandledrejection", (e) => { try { const r = e.reason; window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GHOST ui rejection " + (r && (r.message + " | " + String(r.stack || "").split("\n").slice(0, 3).join(" < ")) || r) }).catch(() => {}); } catch (x) {} });
  const gtrail = (text) => { try { window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GHOST gif " + String(text).slice(0, 300) }).catch(() => {}); } catch (e) {} };

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
    palette: '<path d="M12 3a9 9 0 100 18c1.1 0 1.7-.9 1.4-1.9-.3-.9.2-1.9 1.2-1.9H17a4 4 0 004-4c0-5.6-4-10.2-9-10.2z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
    database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
    vibrate: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M3 9v6M21 9v6"/>',
    motion: '<path d="M4 12h9M4 7h13M4 17h6"/><circle cx="18" cy="16" r="3"/>',
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
    attach: '<path d="M20.5 11.5L12 20a5 5 0 01-7-7l8.5-8.5a3.5 3.5 0 015 5L10 18a2 2 0 01-3-3l7-7"/>',
    compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    chatsTab: '<path d="M21 12a8 8 0 01-11.8 7L4 20l1.2-4.8A8 8 0 1121 12z"/>',
    storiesTab: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/>',
    settingsTab: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    gallery: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5.5-5.5L6 19"/>',
  };
  function icon(name, size, extraClass) {
    const wrap = document.createElement("span");
    wrap.className = "gh-svg-wrap";
    const s = size || 20;
    wrap.innerHTML = `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
    const svg = wrap.firstChild;
    if (extraClass) svg.setAttribute("class", extraClass);
    return svg;
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
    // whole characters, not UTF-16 halves: a name starting with an emoji used to yield half an emoji, which made
    // encodeURIComponent throw in the avatar and the whole chat list failed to draw (device log 2026-09-26)
    const out = (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0] || "").join("").toUpperCase();
    return out.replace(/[\uD800-\uDFFF]/g, (c, i, str) => (/[\uD800-\uDBFF]/.test(c) && /[\uDC00-\uDFFF]/.test(str[i + 1] || "")) || (/[\uDC00-\uDFFF]/.test(c) && /[\uD800-\uDBFF]/.test(str[i - 1] || "")) ? c : "") || "?";
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
    function call(method, args, timeoutMs) {
      return new Promise((resolve, reject) => {
        const id = "g" + (++seq);
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new Error("ghost bridge timeout: " + method));
        }, timeoutMs || 15000);
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
    sendSticker: (id, sticker) => bridge.call("sendSticker", [id, sticker], 30000),
    sendMedia: (id, blob, opts) => bridge.call("sendMedia", [id, blob, opts || {}], 120000), // uploads can be slow on cellular
    sendSnap: (ids, blob, opts) => bridge.call("sendSnap", [ids, blob, opts || {}], 120000),
    react: (id, messageId, emoji) => bridge.call("react", [id, messageId, emoji]),
    saveMessage: (id, messageId, saved) => bridge.call("saveMessage", [id, messageId, saved]),
    openSnap: (id, messageId) => bridge.call("openSnap", [id, messageId], 45000),
    closeSnap: (id, messageId) => bridge.call("closeSnap", [id, messageId]),
    listStories: () => bridge.call("listStories"),
    openStory: (userId) => bridge.call("openStory", [userId]),
    newConversation: (userIds) => bridge.call("newConversation", [userIds]),
    searchFriends: (q) => bridge.call("searchFriends", [q]),
    debugShape: () => bridge.call("debugShape"),
    loadMedia: (convId, msgId) => bridge.call("loadMedia", [convId, msgId]),
    markStoryViewed: (userId, item) => bridge.call("markStoryViewed", [userId, item]),
    storyThumb: (userId) => bridge.call("storyThumb", [userId], 30000),
    replyToStory: (userId, item, text) => bridge.call("replyToStory", [userId, item, text], 30000),
    setPresence: (convId) => bridge.call("setPresence", [convId]),
    setReadReceipts: (on) => bridge.call("setReadReceipts", [on]),
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
    blue: ["#3e88f7", "#2f74e0"], yellow: ["#f0b232", "#c9911c"], purple: ["#9b59f6", "#7c3fd1"],
    green: ["#23a55a", "#1a7f45"], pink: ["#ff5c9e", "#d63f80"],
  };
  function applyAccent(host) { /* colours now come from Ghost's own Appearance settings (applyPrefs) */ }
  function applyReduceMotion(host) {
    let on = false;
    try { if (typeof window.dgSetting === "function") on = !!window.dgSetting("reduceMotion", false); } catch (e) {}
    if (on) host.setAttribute("data-reduce-motion", ""); else host.removeAttribute("data-reduce-motion");
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
    applyReduceMotion(host);
    // KEYBOARD: App.swift resizes the WKWebView's own frame to end right above the keyboard (see its
    // keyboardChanged() note) rather than us reading any keyboard height ourselves - so from here, a
    // keyboard opening/closing is just a `resize` event like any other. The composer already rises for
    // free (it's a normal flex child of a screen that's now shorter); the one thing that does NOT happen
    // for free is the message list's scroll position - its scrollTop is an absolute pixel count, so when
    // clientHeight shrinks the same scrollTop now sits further from the new bottom, i.e. the chat visibly
    // "scrolls up" out from under the keyboard. Re-pin it instantly (no animation) whenever the user was
    // already at the bottom, exactly like the composer/list are pinned to the keyboard in Messages/Telegram.
    window.addEventListener("resize", () => {
      applyZoom(host);
      const c = host.__ghost;
      const conv = c && c.conv;
      if (conv && conv.atBottom && c.state.navProgress > 0.5) {
        conv.messages.scrollTop = conv.messages.scrollHeight;
      }
    });
    if (typeof window.dgOnSettings === "function") window.dgOnSettings(() => { applyAccent(host); applyReduceMotion(host); });
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
    ctx.stickerSheet = buildStickerSheet(ctx, overlays);
    ctx.newChatSheet = buildNewChatSheet(ctx, overlays);
    ctx.attachSheet = buildAttachSheet(ctx, overlays);
    // Every sheet starts fully out of the render tree (see closeSheetGeneric's note) — openSheetGeneric
    // clears this the moment a sheet is actually opened.
    for (const s of [ctx.actionSheet, ctx.gifSheet, ctx.newChatSheet, ctx.attachSheet]) s.sheet.style.display = "none";

    ctx.viewer = buildViewer(ctx);
    root.appendChild(ctx.viewer.el);
    ctx.camera = buildCamera(ctx);
    root.appendChild(ctx.camera.el);
    ctx.settings = buildSettings(ctx);
    root.appendChild(ctx.settings.el);
    loadPrefs(ctx);

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

    const uiTrail = (text) => { try { window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GHOST ui " + text }).catch(() => {}); } catch (e) {} };
    async function handleReady(data) {
      const was = state.loggedIn;
      state.loggedIn = !!(data && data.loggedIn);
      state.me = (data && data.me) || state.me || null;
      if (was !== state.loggedIn) uiTrail("logged in: " + state.loggedIn + (data && data.storeFound === false ? " (store not found yet)" : ""));
      if (!state.loggedIn) { showLoggedOut(); return; }
      showLoggedIn();
      if (!state.homeReady) {
        try { await loadInitialData(ctx); } catch (e) { uiTrail("first load failed: " + (e && e.message || e)); }
      }
      state.homeReady = true;
      ctx.revealHome = () => { boot.classList.add("gh-boot-fade"); markReady(true); };
      if (state.listShown) ctx.revealHome();
      // whatever happens with the list, never keep the loading screen longer than 5s (device: it hung forever)
      setTimeout(() => {
        if (boot.classList.contains("gh-boot-fade")) return;
        uiTrail("loading screen forced away after 5s (list shown: " + !!state.listShown + ")");
        state.listShown = true;
        try { if (state.pendingList) applyConversations(ctx, state.pendingList); } catch (e) { uiTrail("list render failed: " + e.message + " | " + String(e.stack || "").split("\n")[0]); }
        ctx.revealHome();
      }, 5000);
    }
    // Until logged in, keep asking (a `ready` from the page world can be missed, and login finishes after load).
    setInterval(() => { if (!state.loggedIn) api.status().then(handleReady).catch(() => {}); }, 1500);

    bridge.on("ready", handleReady);
    bridge.on("conversations", (data) => {
      try { applyConversations(ctx, (data && data.conversations) || []); }
      catch (e) { uiTrail("list render failed: " + e.message + " | " + String(e.stack || "").split("\n").slice(0, 3).join(" < ")); }
    });
    bridge.on("messages", (data) => { applyMessages(ctx, data); });
    bridge.on("typing", (data) => { applyTyping(ctx, data); });
    bridge.on("here", (data) => { applyHere(ctx, data); });
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
    document.addEventListener("visibilitychange", () => syncPresence(ctx));
    // double-tap a chat row: the first tap already opened the chat, so the second one lands on the chat screen
    // sliding in - catch it here (capture phase, before anything in the chat reacts) and open the camera for them
    root.addEventListener("click", (e) => {
      const rt = ctx.state.rowTap;
      if (!rt || nowMs() - rt.t > 330 || !pref("doubleTapCamera")) return;
      // only a second tap on the same row, or on the chat screen that row just opened - never another row/tab
      if (!(rt.row.contains(e.target) || (e.target.closest && e.target.closest(".gh-screen") === ctx.conv.screen))) { ctx.state.rowTap = null; return; }
      ctx.state.rowTap = null;
      e.stopPropagation(); e.preventDefault();
      openCamera(ctx, { to: rt.id });
    }, true);
    try { if (typeof window.dgOnSettings === "function") window.dgOnSettings(() => syncPresence(ctx)); } catch (e) {}
  }

  async function loadInitialData(ctx) {
    try {
      const [convs, stories] = await Promise.all([
        api.listConversations().catch(() => []),
        api.listStories().catch(() => []),
      ]);
      applyConversations(ctx, convs || []);
      setStories(ctx, stories || []);
    } catch (e) { /* home just stays empty; the "conversations" event may still arrive */ }
    // Friends' stories reach Snapchat's store a while after login (device: 0 at first load, 7 a minute later),
    // so keep asking; only repaint the rail when something actually changed.
    if (!ctx.state.storiesTimer) {
      ctx.state.storiesTimer = setInterval(() => refreshStories(ctx), 20000);
      setTimeout(() => refreshStories(ctx), 4000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshStories(ctx); });
    }
  }
  function refreshStories(ctx) {
    if (document.hidden) return;
    api.listStories().then((list) => setStories(ctx, list || [])).catch(() => {});
  }
  function setStories(ctx, list) {
    const sig = list.map((st) => (st.user && st.user.id) + ":" + st.count + ":" + (st.viewed ? 1 : 0)).join("|");
    if (sig === ctx.state.storiesSig) return;
    ctx.state.storiesSig = sig;
    ctx.state.stories = list;
    renderStories(ctx);
  }

  // Right after launch Snapchat's list arrives before the names do (device report: "empty conversations for a
  // little"): keep the loading screen up until most chats have a real name, or 4s have passed.
  const unnamed = (c) => !c.title || c.title === "Unknown" || c.title === "Conversation" || /^Unknown(, Unknown)*$/.test(c.title);
  function listLooksReady(list) {
    if (!list.length) return false;
    return list.filter(unnamed).length / list.length < 0.25;
  }
  function applyConversations(ctx, list) {
    if (!ctx.state.listShown) {
      if (!ctx.state.listWaitStart) {
        ctx.state.listWaitStart = performance.now();
        setTimeout(() => { if (!ctx.state.listShown && ctx.state.pendingList) { ctx.state.listShown = true; applyConversations(ctx, ctx.state.pendingList); ctx.revealHome && ctx.revealHome(); } }, 4000);
      }
      ctx.state.pendingList = list;
      if (!listLooksReady(list)) return;
      ctx.state.listShown = true;
      ctx.revealHome && ctx.revealHome();
    }
    // chats whose names still haven't arrived go to the end rather than sitting between real ones
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
    const prev = ctx.state.messagesByConv.get(data.conversationId);
    ctx.state.messagesByConv.set(data.conversationId, entry);
    if (ctx.state.currentConvId !== data.conversationId) return;
    // Snapchat's store changes many times a second (presence, typing...), and every update used to repaint the
    // chat, replay the "new message" pop and scroll - the jumping in group chats (device, 2026-09-27). Now:
    // nothing changed -> nothing; new messages at the end -> the normal arrival; anything else (reactions,
    // opened/saved state) -> repaint in place, scroll untouched.
    const sig = (list) => list.map((m) => m.id + ":" + (m.reactions ? m.reactions.length : 0) + ":" + (m.saved ? 1 : 0) + (m.opened ? 1 : 0) + ":" + (m.text || "").length).join("|");
    if (prev && sig(prev.messages) === sig(entry.messages) && prev.hasMore === entry.hasMore) return;
    const prevLast = prev && prev.messages.length ? prev.messages[prev.messages.length - 1].id : null;
    const newLast = entry.messages.length ? entry.messages[entry.messages.length - 1].id : null;
    const arrived = !prev || (newLast !== prevLast && entry.messages.length >= prev.messages.length);
    renderMessageList(ctx, ctx.conv, entry, arrived ? { stick: true } : {});
  }
  // friends currently looking at the open chat (bridge "here" event, from Snapchat's presence session)
  function applyHere(ctx, data) {
    if (!data) return;
    ctx.state.hereByConv = ctx.state.hereByConv || new Map();
    ctx.state.hereByConv.set(data.conversationId, data.users || []);
    if (ctx.state.currentConvId === data.conversationId) {
      updateTypingIndicator(ctx);
      const cd = ctx.state.convById.get(data.conversationId);
      if (cd) updateConvHeader(ctx, cd);
    }
  }
  function hereUsers(ctx, convId) {
    const list = (ctx.state.hereByConv && ctx.state.hereByConv.get(convId)) || [];
    const cd = ctx.state.convById.get(convId) || {};
    return list.map((u) => Object.assign({}, (cd.participants || []).find((p) => p.id === u.id) || { id: u.id, name: "Someone" }, { typing: u.typing, voice: u.voice }));
  }
  function applyTyping(ctx, data) {
    if (!data) return;
    ctx.state.typingByConv.set(data.conversationId, new Set(data.userIds || []));
    if (ctx.state.currentConvId === data.conversationId) {
      updateTypingIndicator(ctx);
      const cd = ctx.state.convById.get(data.conversationId);
      if (cd) updateConvHeader(ctx, cd);
    }
    renderHomeRowTyping(ctx, data.conversationId, (data.userIds || []).length > 0);
  }

  // =====================================================================================================
  // HOME
  // =====================================================================================================
  function buildHome(ctx) {
    const screen = el("div", "gh-screen");
    screen.dataset.screen = "home";
    screen.innerHTML = `
      <div class="gh-home-header">
        <div class="gh-home-nav-row">
          <button class="gh-edit-btn gh-hit">Edit</button>
          <div class="gh-collapsed-title">Chats</div>
          <button class="gh-icon-btn gh-hit" data-act="new"></button>
        </div>
        <div class="gh-large-title-row"><div class="gh-large-title">Chats</div></div>
      </div>
      <div class="gh-home-body">
        <div class="gh-ptr"><div class="gh-spinner"></div></div>
        <div class="gh-list gh-scroll">
          <div class="gh-search-sticky"><div class="gh-search"></div><button class="gh-search-cancel"></button></div>
          <div class="gh-stories"></div>
        </div>
      </div>
      <div class="gh-tab-bar">
        <button class="gh-tab-btn gh-hit" data-tab="chats" data-active="1"></button>
        <button class="gh-tab-btn gh-hit" data-tab="stories"></button>
        <button class="gh-tab-btn gh-hit" data-tab="settings"></button>
      </div>
    `;
    const newBtn = screen.querySelector('[data-act="new"].gh-icon-btn');
    newBtn.appendChild(icon("compose"));
    newBtn.setAttribute("aria-label", "New message");
    const tabChats = screen.querySelector('[data-tab="chats"]');
    tabChats.append(icon("chatsTab", 25), Object.assign(document.createElement("span"), { textContent: "Chats" }));
    const tabStories = screen.querySelector('[data-tab="stories"]');
    tabStories.append(icon("camera", 25), Object.assign(document.createElement("span"), { textContent: "Camera" }));
    tabStories.setAttribute("aria-label", "Camera");
    const tabSettings = screen.querySelector('[data-tab="settings"]');
    tabSettings.append(icon("settingsTab", 25), Object.assign(document.createElement("span"), { textContent: "Settings" }));
    const search = screen.querySelector(".gh-search");
    search.appendChild(icon("search", 16));
    const input = el("input");
    input.type = "search";
    input.placeholder = "Search";
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Search chats");
    search.appendChild(input);
    const searchSticky = screen.querySelector(".gh-search-sticky");
    const cancelBtn = screen.querySelector(".gh-search-cancel");
    cancelBtn.textContent = "Cancel";
    cancelBtn.setAttribute("aria-label", "Cancel search");

    const list = screen.querySelector(".gh-list");
    const storiesEl = screen.querySelector(".gh-stories");
    const ptr = screen.querySelector(".gh-ptr");

    screen.querySelector(".gh-edit-btn").addEventListener("click", () => { haptic(); ctx.showToast("Editing chats isn't available yet"); });
    for (const b of screen.querySelectorAll('[data-act="new"]')) {
      b.addEventListener("click", () => { haptic(); openNewChatSheet(ctx); });
    }
    tabSettings.addEventListener("click", () => {
      haptic();
      for (const t of [tabChats, tabStories, tabSettings]) t.dataset.active = "0";
      tabSettings.dataset.active = "1";
      openSettings(ctx);
      setTimeout(() => { tabSettings.dataset.active = "0"; tabChats.dataset.active = "1"; }, 400);
    });
    tabChats.addEventListener("click", () => {
      haptic();
      for (const t of [tabChats, tabStories, tabSettings]) t.dataset.active = "0";
      tabChats.dataset.active = "1";
      list.scrollTo({ top: 0, behavior: "smooth" });
    });
    tabStories.addEventListener("click", () => { openCamera(ctx, {}); }); // the middle tab is the snap camera now
    input.addEventListener("input", () => { home.query = input.value.trim().toLowerCase(); renderHomeList(ctx); });
    // iOS search-bar behaviour: a "Cancel" button slides in beside the field while it's active (focused or
    // holds text) and slides back out once it's empty and unfocused again.
    input.addEventListener("focus", () => { searchSticky.dataset.active = "1"; });
    input.addEventListener("blur", () => { if (!input.value) searchSticky.dataset.active = "0"; });
    cancelBtn.addEventListener("click", () => {
      haptic("light");
      input.value = "";
      home.query = "";
      renderHomeList(ctx);
      input.blur();
      searchSticky.dataset.active = "0";
    });

    const home = { screen, list, storiesEl, input, ptr, rows: new Map(), query: "" };
    let scrollScheduled = false;
    list.addEventListener("scroll", () => {
      if (scrollScheduled) return;
      scrollScheduled = true;
      requestAnimationFrame(() => {
        scrollScheduled = false;
        const p = clamp(list.scrollTop / 36, 0, 1);
        screen.style.setProperty("--gh-title-collapse", String(p));
      });
    }, { passive: true });
    initPullToRefresh(ctx, home);
    return home;
  }

  // Story rail: each friend's latest story as a round preview (Snapchat's own thumbnail), their Bitmoji as a badge.
  const storyThumbs = new Map(); // userId|count -> Promise<url|null>
  function storyThumbFor(st) {
    const key = st.user.id + "|" + st.count;
    if (!storyThumbs.has(key)) storyThumbs.set(key, api.storyThumb(st.user.id).then((r) => (r && r.url) || null, () => null));
    return storyThumbs.get(key);
  }
  function renderStories(ctx) {
    const home = ctx.home;
    const wrap = home.storiesEl;
    wrap.innerHTML = "";
    for (const s of ctx.state.stories) {
      const item = el("div", "gh-story gh-press");
      item.dataset.unviewed = s.viewed ? "0" : "1";
      item.setAttribute("role", "button");
      const ring = el("div", "gh-story-ring");
      const thumb = el("div", "gh-story-thumb");
      thumb.appendChild(makeAvatar(s.user, 58)); // until the preview arrives (or if it can't)
      ring.appendChild(thumb);
      const badge = el("div", "gh-story-badge");
      badge.appendChild(makeAvatar(s.user, 24));
      ring.appendChild(badge);
      storyThumbFor(s).then((url) => {
        if (!url) return;
        const img = el("img", "gh-story-img");
        img.alt = "";
        img.onload = () => { thumb.innerHTML = ""; thumb.appendChild(img); ring.dataset.preview = "1"; };
        img.src = url;
      });
      const name = el("span", "gh-story-name");
      name.textContent = s.user && s.user.name ? s.user.name.split(" ")[0] : "?";
      item.setAttribute("aria-label", (s.user && s.user.name ? s.user.name + "'s story" : "Story"));
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
    const fallback = placeholderAvatarUrl(user);
    const pic = user && (user.avatarUrl || (pref("avatars") !== "initials" ? user.bitmojiUrl : null));
    if (pic && !brokenAvatars.has(pic)) {
      // Bitmoji head (transparent webp) on the same Telegram gradient the letter avatar would use, so it
      // reads as part of this app rather than Snapchat's white circles. Letters if the image won't load.
      const [c1, c2] = gradientFor(user, (user.name || user.username || "?"));
      img.style.background = `radial-gradient(circle at 50% 30%, rgba(255,255,255,0.22), rgba(255,255,255,0) 62%), linear-gradient(160deg, ${c1}, ${c2})`;
      if (user.bitmojiUrl && pic === user.bitmojiUrl) img.dataset.bitmoji = "1";
      img.addEventListener("error", () => { brokenAvatars.add(pic); delete img.dataset.bitmoji; img.style.background = ""; img.src = fallback; }, { once: true });
      img.src = pic;
    } else img.src = fallback;
    return img;
  }
  const brokenAvatars = new Set();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) brokenAvatars.clear(); }); // a failure may have been a blip
  // Telegram-style gradient letter avatars: two-stop diagonal gradients, one of a small fixed palette
  // picked deterministically from the user's id/name so the same person always gets the same colors.
  const AVATAR_GRADIENTS = [
    ["#ff885e", "#ff516a"], ["#ffcd6a", "#ffa85c"], ["#82b1ff", "#665fff"], ["#a0de7e", "#54cb68"],
    ["#53edd6", "#28c9b7"], ["#72d5fd", "#2a9ef1"], ["#e0a2f3", "#d669ed"], ["#ff9dcb", "#e2506b"],
  ];
  function gradientFor(user, name) {
    if (user && user.color) return [user.color, user.color];
    return AVATAR_GRADIENTS[Math.abs(hashStr(String((user && user.id) || name))) % AVATAR_GRADIENTS.length];
  }
  function placeholderAvatarUrl(user) {
    const name = (user && (user.name || user.username)) || "?";
    const [c1, c2] = gradientFor(user, name);
    const label = initials(name).replace(/[<>&"]/g, "");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><text x="48" y="58" font-family="-apple-system,system-ui,sans-serif" font-size="36" font-weight="600" fill="#fff" text-anchor="middle">${label}</text></svg>`;
    try { return "data:image/svg+xml;utf8," + encodeURIComponent(svg); }
    catch (e) { return "data:image/svg+xml;utf8," + encodeURIComponent(svg.replace(/[\uD800-\uDFFF]/g, "")); }
  }

  // status -> tick state: single check = sent, double = delivered/opened/viewed (Telegram keeps both the
  // same grey — there's no "read = blue" convention there, unlike WhatsApp). Only rendered when the bridge
  // actually supplies conv.preview.status (an optional field per API.md); never fabricated.
  function tickFor(status) {
    if (status === "sent") return "single";
    if (status === "delivered" || status === "opened" || status === "viewed" || status === "received") return "double";
    return null;
  }
  function previewLine(conv) {
    const p = conv.preview || { kind: "none" };
    const you = p.fromMe ? "You: " : "";
    const tick = p.fromMe ? tickFor(p.status) : null;
    switch (p.kind) {
      case "text": return { text: you + (p.text || ""), iconName: null, tick };
      case "chat-media": return { text: you + "Sent a photo", iconName: "photo", tick };
      case "gif": return { text: you + "Sent a GIF", iconName: "gifBadge", tick };
      case "audio": return { text: you + "Sent a voice message", iconName: "mic", tick };
      case "snap": {
        const label = p.fromMe
          ? ({ sent: "Snap sent", delivered: "Snap delivered", opened: "Snap opened" }[p.status] || "Snap sent")
          : ({ received: "New Snap", opened: "Opened", viewed: "Opened" }[p.status] || "New Snap");
        return { text: label, iconName: "camera", tick: p.fromMe ? tickFor(p.status) : null };
      }
      case "call": return { text: p.text || "Call", iconName: "call", tick: null };
      case "system": return { text: p.text || "", iconName: null, tick: null };
      default: return { text: "No messages yet", iconName: null, tick: null };
    }
  }

  function renderHomeList(ctx) {
    const home = ctx.home;
    const q = home.query;
    const list = home.list;
    const seen = new Set();
    let prevEl = home.storiesEl; // the sticky search field + stories rail are permanent, pinned before all rows
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
    // WebKit on iOS sometimes keeps showing the old pixels of a scrolling list after its rows change, until the
    // list is scrolled (device report): a 1px scroll there and back forces the repaint, invisibly
    requestAnimationFrame(() => { const t = list.scrollTop; list.scrollTop = t + 1; list.scrollTop = t; });
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
    // tap = open the chat; double-tap = snap camera for this person (like Snapchat). The chat opens at once on the
    // first tap (no waiting to see if a second one comes); the camera then slides up over it.
    rowEl.addEventListener("click", () => {
      ctx.state.rowTap = { id: conv.id, t: nowMs(), row: rowEl }; // a 2nd tap lands on the chat screen - see the root listener
      openConversationScreen(ctx, conv.id);
    });
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
      const { text, iconName, tick } = previewLine(conv);
      previewEl.innerHTML = "";
      if (tick) previewEl.appendChild(icon(tick === "double" ? "checkDouble" : "check", 15, "gh-tick"));
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
    badge.dataset.muted = conv.muted ? "1" : "0";
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
        <div class="gh-back-wrap">
          <button class="gh-icon-btn gh-hit" data-act="back"></button>
          <div class="gh-back-badge" data-empty="1"></div>
        </div>
        <div class="gh-header-title">
          <div class="gh-conv-title-row">
            <div class="gh-conv-name"></div>
          </div>
          <div class="gh-conv-sub"></div>
        </div>
        <div class="gh-conv-header-avatar"></div>
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
      <div class="gh-mention-box" role="listbox"></div>
      <div class="gh-composer">
        <button class="gh-composer-btn gh-hit" data-act="attach"></button>
        <div class="gh-composer-field">
          <textarea class="gh-composer-textarea" rows="1" placeholder="Message" aria-label="Message"></textarea>
          <button class="gh-composer-emoji-btn gh-hit" data-act="emoji"></button>
        </div>
        <div class="gh-composer-send-wrap">
          <button class="gh-composer-mic gh-hit gh-press" data-act="mic"></button>
          <button class="gh-composer-send gh-hit gh-press" data-act="send"></button>
        </div>
      </div>
      <input type="file" accept="image/*,video/*" class="gh-file-input" style="display:none;">
    `;
    screen.querySelector('[data-act="back"]').append(icon("back"));
    screen.querySelector('[data-act="back"]').setAttribute("aria-label", "Back");
    screen.querySelector('[data-act="attach"]').appendChild(icon("attach"));
    screen.querySelector('[data-act="attach"]').setAttribute("aria-label", "Attach media");
    screen.querySelector('[data-act="emoji"]').appendChild(icon("emoji"));
    screen.querySelector('[data-act="emoji"]').setAttribute("aria-label", "Stickers");
    screen.querySelector('[data-act="emoji"]').addEventListener("click", () => openStickerSheet(ctx));
    screen.querySelector('[data-act="mic"]').appendChild(icon("mic"));
    screen.querySelector('[data-act="mic"]').setAttribute("aria-label", "Record voice message");
    screen.querySelector('[data-act="send"]').appendChild(icon("send", 18));
    screen.querySelector('[data-act="send"]').setAttribute("aria-label", "Send");
    screen.querySelector(".gh-reply-bar-close").appendChild(icon("close", 16));
    screen.querySelector(".gh-reply-bar-close").setAttribute("aria-label", "Cancel reply");
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
      micBtn: screen.querySelector('[data-act="mic"]'),
      fileInput: screen.querySelector(".gh-file-input"),
      nameEl: screen.querySelector(".gh-conv-name"),
      subEl: screen.querySelector(".gh-conv-sub"),
      titleRow: screen.querySelector(".gh-conv-title-row"),
      avatarSlot: screen.querySelector(".gh-conv-header-avatar"),
      backBadge: screen.querySelector(".gh-back-badge"),
      rendered: new Map(), // messageId -> element
      windowStart: 0, windowEnd: 0,
      avgHeight: 64,
      replyTo: null,
      atBottom: true,
      unreadBoundaryIndex: null, // index in _all where the "Unread Messages" divider goes, set once per open
      unreadBoundaryComputed: false,
      pendingUnreadForDivider: 0,
    };

    screen.querySelector('[data-act="back"]').addEventListener("click", () => closeConversationScreen(ctx));
    conv.textarea.addEventListener("input", () => {
      conv.textarea.style.height = "auto";
      conv.textarea.style.height = Math.min(100, conv.textarea.scrollHeight) + "px";
      const hasText = !!conv.textarea.value.trim();
      conv.sendBtn.dataset.show = hasText ? "1" : "0";
      conv.micBtn.dataset.hide = hasText ? "1" : "0";
    });
    screen.querySelector('[data-act="send"]').addEventListener("click", () => sendCurrentText(ctx));
    conv.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && pref("sendOnReturn") && !e.isComposing) { e.preventDefault(); sendCurrentText(ctx); }
    });
    conv.micBtn.addEventListener("click", () => { haptic(); ctx.showToast("Voice messages need a device"); });
    screen.querySelector('[data-act="attach"]').addEventListener("click", () => openAttachSheet(ctx));
    conv.fileInput.addEventListener("change", () => {
      const f = conv.fileInput.files && conv.fileInput.files[0];
      conv.fileInput.value = "";
      if (f) sendMediaFile(ctx, f);
    });
    screen.querySelector(".gh-reply-bar-close").addEventListener("click", () => { haptic("light"); setReplyTo(ctx, null); });
    conv.jump.addEventListener("click", () => scrollConvToBottom(ctx, true));
    conv.messages.addEventListener("scroll", () => onConvScroll(ctx), { passive: true });
    // @mentions: typing "@" + letters offers My AI and (in groups) the people in the chat; picking one inserts
    // "@username " - Snapchat itself turns @username / @myai in the text into real mentions when it sends.
    conv.mentionBox = screen.querySelector(".gh-mention-box");
    conv.textarea.addEventListener("input", () => updateMentions(ctx));
    conv.textarea.addEventListener("click", () => updateMentions(ctx));
    conv.textarea.addEventListener("blur", () => setTimeout(() => hideMentions(ctx), 150));
    const touched = () => { conv.userTouched = true; };
    conv.messages.addEventListener("touchstart", touched, { passive: true });
    conv.messages.addEventListener("wheel", touched, { passive: true });
    // Tapping anywhere in the message list, or starting a scroll drag, dismisses the keyboard exactly like
    // Messages/Telegram - the composer textarea is the only thing that should keep focus once you touch the
    // list itself (a tap that lands on an actual control there, e.g. a reaction pill, still works as normal;
    // blurring first just closes the keyboard, it never prevents the tap's own handler from also running).
    conv.messages.addEventListener("touchstart", () => {
      // NOT document.activeElement: focus inside an open shadow root is retargeted there, so the top-level
      // document only ever reports the <ghost-app> host as "active" - the real focused control is
      // ctx.shadow.activeElement (a footgun worth a comment, since it silently no-ops otherwise).
      if (ctx.shadow.activeElement === conv.textarea) conv.textarea.blur();
    }, { passive: true });

    initMessageGestures(ctx, conv);
    return conv;
  }

  function updateConvHeader(ctx, convData) {
    const conv = ctx.conv;
    conv.nameEl.textContent = convData.title || "Unknown";
    const typingSet = ctx.state.typingByConv.get(convData.id);
    if ((typingSet && typingSet.size) || hereUsers(ctx, convData.id).some((u) => u.typing)) {
      conv.subEl.innerHTML = "";
      conv.subEl.append(document.createTextNode("typing"), (() => { const d = el("span", "gh-row-dots"); d.innerHTML = "<span></span><span></span><span></span>"; return d; })());
      conv.subEl.dataset.typing = "1"; conv.subEl.dataset.here = "0";
      conv.subEl.style.display = "";
    } else if (hereUsers(ctx, convData.id).length) {
      const here = hereUsers(ctx, convData.id);
      conv.subEl.dataset.typing = "0";
      conv.subEl.dataset.here = "1";
      conv.subEl.textContent = convData.isGroup ? here.map((u) => (u.name || "").split(" ")[0]).join(", ") + " in chat" : "in chat";
      conv.subEl.style.display = "";
    } else {
      conv.subEl.dataset.typing = "0";
      conv.subEl.dataset.here = "0";
      // The bridge has no presence/"last seen" data (API.md) — showing one would be fabricated, so a 1:1
      // chat's subtitle is simply omitted (matches Telegram's own behaviour when it has nothing to say).
      // A group's member count IS real data (conv.participants, already part of the contract).
      if (convData.isGroup) {
        conv.subEl.textContent = `${(convData.participants || []).length} members`;
        conv.subEl.style.display = "";
      } else {
        conv.subEl.textContent = "";
        conv.subEl.style.display = "none";
      }
    }
    const av = convData.isGroup ? { name: convData.title, avatarUrl: convData.avatarUrl } : (convData.participants && convData.participants[0]) || { name: convData.title };
    conv.avatarSlot.innerHTML = "";
    conv.avatarSlot.appendChild(makeAvatar(av, 34));
    conv.messages.dataset.group = convData.isGroup ? "1" : "0";
    // back-button badge: how many OTHER conversations still have something unread, like iOS Mail/Messages
    let otherUnread = 0;
    for (const c of ctx.state.conversations) {
      if (c.id === convData.id) continue;
      if (c.unreadCount > 0 || c.hasUnreadSnap) otherUnread++;
    }
    conv.backBadge.dataset.empty = otherUnread > 0 ? "0" : "1";
    conv.backBadge.textContent = otherUnread > 99 ? "99+" : String(otherUnread);
  }

  async function openConversationScreen(ctx, conversationId) {
    haptic("light");
    ctx.conv.peekId = null;
    ctx.state.currentConvId = conversationId;
    const convData = ctx.state.convById.get(conversationId);
    if (convData) updateConvHeader(ctx, convData);
    navigateTo(ctx, "conv", true);
    const conv = ctx.conv;
    conv.rendered.forEach((elm) => elm.remove());
    conv.rendered.clear();
    conv.replyTo = null;
    conv.textarea.value = "";
    hideMentions(ctx);
    conv.sendBtn.dataset.show = "0";
    conv.micBtn.dataset.hide = "0";
    setReplyTo(ctx, null);
    // Capture the unread count BEFORE openConversation() marks the chat read below, so the "Unread Messages"
    // divider can be placed against the real number the bridge reported — never fabricated, never re-derived
    // after the fact (once marked read, unreadCount is gone). Reset every time a chat is (re)opened.
    conv.unreadBoundaryIndex = null;
    conv.unreadBoundaryComputed = false;
    conv.pinUntil = nowMs() + 4000; conv.userTouched = false; conv.atBottom = true;
    conv.pendingUnreadForDivider = (convData && convData.unreadCount) || 0;
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
    syncPresence(ctx);
  }
  // "Show me in chats" (Settings, default on): friends see my Bitmoji (phone, not laptop) in the chat I have
  // open, like the real app. Cleared when I leave the chat or Ghost goes to the background.
  function showInChats() { try { return typeof window.dgSetting !== "function" || window.dgSetting("showInChats", true) !== false; } catch (e) { return true; } }
  function syncPresence(ctx) {
    const want = (showInChats() && !document.hidden && ctx.state.currentConvId) || null;
    if (want === ctx.state.presenceConv) return;
    ctx.state.presenceConv = want;
    api.setPresence(want).then((r) => { if (r && r.ok === false) gtrail("presence " + r.reason); }).catch((e) => gtrail("presence failed " + (e && e.message || e)));
  }
  function closeConversationScreen(ctx) {
    const id = ctx.state.currentConvId;
    if (id) api.closeConversation(id).catch(() => {});
    ctx.state.currentConvId = null;
    stopVoice();
    syncPresence(ctx);
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
    if (opts.initial && !conv.unreadBoundaryComputed) {
      conv.unreadBoundaryComputed = true;
      const n = conv.pendingUnreadForDivider || 0;
      conv.unreadBoundaryIndex = (n > 0 && total > 0) ? Math.max(0, total - n) : null;
    }
    paintWindow(ctx, conv);
    // pop-in animation for a genuinely new message (never for a virtualized-scroll window shift, which
    // calls paintWindow directly instead of coming through here — see handleWindowScroll)
    if (opts.stick && !opts.initial) {
      const wraps = conv.messages.querySelectorAll(".gh-msg-wrap");
      const last = wraps[wraps.length - 1];
      if (last) {
        last.classList.add("gh-msg-pop");
        last.addEventListener("animationend", () => last.classList.remove("gh-msg-pop"), { once: true });
      }
    }
    if (opts.initial || opts.stick) {
      if (conv.atBottom || opts.initial) requestAnimationFrame(() => scrollConvToBottom(ctx, false));
      else showJump(ctx, true);
    }
    updateTypingIndicator(ctx);
  }

  function groupsFor(all, start, end, unreadBoundaryIndex) {
    const groups = [];
    let cur = null;
    for (let i = start; i < end; i++) {
      const m = all[i];
      // the divider also breaks bubble grouping: the first unread message always starts a fresh run,
      // never continues visually from the last-read one above the divider
      if (unreadBoundaryIndex != null && i === unreadBoundaryIndex) { groups.push({ unreadDivider: true }); cur = null; }
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
    const groups = groupsFor(all, start, end, conv.unreadBoundaryIndex);
    const meId = ctx.state.me && ctx.state.me.id;
    if (!groups.length && total === 0) frag.appendChild(chatEmptyEl());
    for (const g of groups) {
      if (g.unreadDivider) { frag.appendChild(unreadSepEl()); continue; }
      if (g.daySep) frag.appendChild(sepEl(g.daySep));
      if (g.system) { frag.appendChild(systemLineEl(g.system)); continue; }
      const isMe = g.from && meId && g.from.id === meId;
      const groupEl = el("div", "gh-group");
      groupEl.dataset.me = isMe ? "1" : "0";
      groupEl.dataset.first = "1";
      const gutter = el("div", "gh-group-gutter");
      gutter.appendChild(makeAvatar(isMe ? (ctx.state.me || g.from || { name: "You" }) : g.from, 32)); // Discord: every run starts with a big avatar, yours too
      const col = el("div", "gh-group-col");
      const meta = el("div", "gh-group-meta");
      const nm = el("span", "gh-group-name");
      nm.textContent = isMe ? "You" : (g.from && g.from.name) || "Unknown";
      const tm = el("span", "gh-group-time");
      tm.textContent = fmtClock(g.items[0].ts);
      meta.append(nm, tm);
      col.appendChild(meta);
      for (let i = 0; i < g.items.length; i++) col.appendChild(messageWrapEl(ctx, g.items[i], isMe, i === g.items.length - 1));
      groupEl.append(gutter, col);
      frag.appendChild(groupEl);
    }
    conv.messages.replaceChildren(conv.topSpacer, frag, conv.bottomSpacer);
    // photos/stickers/voice notes finish loading after this and grow the list: stay at the bottom if you were
    if (typeof ResizeObserver === "function") {
      if (!conv.ro) conv.ro = new ResizeObserver(() => {
        if (!ctx.state.currentConvId) return;
        if (conv.atBottom || pinnedToBottom(conv)) { conv.messages.scrollTop = conv.messages.scrollHeight; conv.atBottom = true; }
      });
      conv.ro.disconnect();
      for (const child of conv.messages.children) conv.ro.observe(child);
    }
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
  function unreadSepEl() { const e = el("div", "gh-unread-sep"); e.textContent = "Unread Messages"; return e; }
  function chatEmptyEl() {
    const e = el("div", "gh-chat-empty");
    e.appendChild(icon("ghost", 34));
    const t = el("div"); t.textContent = "No messages yet";
    e.appendChild(t);
    return e;
  }
  function systemLineEl(m) {
    const e = el("div", m.kind === "call" ? "gh-call-line" : "gh-system-line");
    if (m.kind === "call") e.appendChild(icon("call", 14));
    const span = el("span"); span.textContent = m.text || "";
    e.appendChild(span);
    return e;
  }

  function messageWrapEl(ctx, m, isMe, isLast) {
    const wrap = el("div", "gh-msg-wrap");
    wrap.dataset.messageId = m.id;
    const swipe = el("div", "gh-msg-swipe");
    const hint = el("div", "gh-reply-hint");
    hint.appendChild(icon("reply", 18));
    if (m.replyTo) swipe.appendChild(replyQuoteEl(m.replyTo));
    swipe.appendChild(bubbleEl(ctx, m, isMe, isLast));
    if (m.reactions && m.reactions.length) swipe.appendChild(reactionsEl(ctx, m));
    if (isMe && m.failed) {
      const status = el("div", "gh-msg-status-fail");
      status.textContent = "Not delivered — tap to retry";
      swipe.appendChild(status);
    }
    wrap.append(hint, swipe);
    return wrap;
  }
  // time + delivery ticks, rendered as a floated trailing element inside the bubble's flow-root so text
  // wraps around it exactly the way Telegram's own trailing timestamp does (see .gh-bubble-meta in ui.css).
  // Tick state comes only from fields ghost/API.md already defines (pending/failed) — there is no per-message
  // read-receipt field in the contract, so a normally-sent message always shows the "delivered" double tick.
  function tickMetaEl(m, isMe, extraClass) {
    const meta = el("span", (extraClass ? "gh-bubble-meta " + extraClass : "gh-bubble-meta"));
    meta.appendChild(document.createTextNode(fmtClock(m.ts)));
    if (isMe) {
      if (m.failed) meta.appendChild(icon("close", 14, "gh-tick gh-tick-fail"));
      else if (m.pending) meta.appendChild(icon("check", 14, "gh-tick gh-tick-pending"));
      else meta.appendChild(icon("checkDouble", 14, "gh-tick"));
    }
    return meta;
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

  function bubbleEl(ctx, m, isMe, isLast) {
    switch (m.kind) {
      case "text": {
        const b = el("div", "gh-bubble");
        if (isLast) b.dataset.tail = "1";
        // @mentions in the accent colour, like Snapchat
        for (const part of String(m.text || "").split(/((?:^|(?<=\s))@[\w.\-]+)/)) {
          if (/^@[\w.\-]+$/.test(part)) { const sp = el("span", "gh-mention"); sp.textContent = part; b.appendChild(sp); }
          else if (part) b.appendChild(document.createTextNode(part));
        }
        b.appendChild(tickMetaEl(m, isMe));
        if (m.failed) b.dataset.failed = "1";
        return b;
      }
      case "chat-media": {
        const b = el("div", "gh-bubble gh-gif-bubble", {});
        const build = (ref) => { const media = mediaEl(ref, { fullscreenOnTap: true, ctx, message: m, autoplay: ref && ref.type === "video" }); media.appendChild(tickMetaEl(m, isMe, "gh-media-meta")); return media; };
        let media = build(m.media && m.media[0]);
        b.appendChild(media);
        if (!(m.media && m.media.length)) fetchMediaFor(m).then((list) => {
          if (!list.length || !b.isConnected && !b.parentNode) return;
          const fresh = build(list[0]);
          media.replaceWith(fresh); media = fresh;
        });
        return b;
      }
      case "gif": {
        const b = el("div", "gh-bubble gh-gif-bubble");
        // Snapchat's page only allows images from its own hosts, so a giphy.com URL is fetched by the app
        // (native fetch, GIPHY hosts only) and shown as a data: URL, like the Snapchat-look app does
        let ref = m.media && m.media[0];
        const gid = ref && ref.url && (ref.url.match(/giphy\.com\/media\/([A-Za-z0-9]+)\//) || [])[1];
        if (gid) ref = { type: "image", url: "" };
        const media = mediaEl(ref, { autoplay: true, ctx, message: m });
        // play it as a looping muted video (GIPHY's 200w.mp4): animated images stayed on their first frame on the
        // phone; the still WebP is the fallback
        if (gid) (async () => {
          const img = media.querySelector("img");
          try {
            const bytes = await gmBytes(giphyMedia(gid, "200w.mp4"));
            const v = el("video");
            v.muted = true; v.loop = true; v.playsInline = true;
            if (pref("autoplayGifs")) v.autoplay = true;
            else { v.preload = "metadata"; v.addEventListener("click", (e) => { e.stopPropagation(); if (v.paused) v.play().catch(() => {}); else v.pause(); }); }
            v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
            v.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
            v.addEventListener("loadeddata", () => { if (img) img.remove(); v.play().catch(() => {}); }, { once: true });
            v.addEventListener("error", () => { gtrail("gif video failed " + gid); v.remove(); giphyPreviewUrl(gid).then((r) => { if (img && r && r.dataUrl) img.src = r.dataUrl; }); }, { once: true });
            media.insertBefore(v, media.firstChild);
          } catch (e) {
            gtrail("gif mp4 fetch failed " + gid + " " + (e && e.message));
            const r = await giphyPreviewUrl(gid);
            if (img && r && r.dataUrl) img.src = r.dataUrl;
          }
        })();
        media.appendChild(tickMetaEl(m, isMe, "gh-media-meta"));
        b.appendChild(media);
        return b;
      }
      case "sticker": {
        const b = el("div", "gh-bubble gh-sticker");
        const ref = m.media && m.media[0];
        const img = el("img");
        const src = (ref && (ref.url || (ref.blob && URL.createObjectURL(ref.blob)))) || "";
        if (src) img.src = src;
        else { // custom / GIF-style stickers are downloaded + decrypted on demand, like photos
          b.dataset.loading = "1";
          fetchMediaFor(m).then((list) => { const r = list[0]; if (r && (r.url || r.blob)) { img.src = r.url || URL.createObjectURL(r.blob); delete b.dataset.loading; } });
        }
        img.addEventListener("error", () => { b.dataset.broken = "1"; }, { once: true });
        b.appendChild(img);
        b.appendChild(tickMetaEl(m, isMe, "gh-sticker-meta"));
        return b;
      }
      case "snap": return snapTileEl(ctx, m, isMe);
      case "audio": return audioBubbleEl(ctx, m, isMe, isLast);
      case "unknown": {
        const b = el("div", "gh-bubble gh-unknown");
        b.appendChild(document.createTextNode(m.text || "Unsupported message"));
        b.appendChild(tickMetaEl(m, isMe));
        return b;
      }
      default: {
        const b = el("div", "gh-bubble gh-unknown");
        // @mentions in the accent colour, like Snapchat
        for (const part of String(m.text || "").split(/((?:^|(?<=\s))@[\w.\-]+)/)) {
          if (/^@[\w.\-]+$/.test(part)) { const sp = el("span", "gh-mention"); sp.textContent = part; b.appendChild(sp); }
          else if (part) b.appendChild(document.createTextNode(part));
        }
        b.appendChild(tickMetaEl(m, isMe));
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
      // GIFs sent as photos (yours included) stay on their first frame in an <img> on the phone: the GIF player
      // (gif-anim.js) decodes and plays multi-frame GIFs on a canvas over it; stills are left alone
      if (/^blob:/.test(src) && window.__dgAnimateGif) img.addEventListener("load", () => window.__dgAnimateGif(img), { once: true });
    }
    if (opts.fullscreenOnTap) {
      wrap.classList.add("gh-press");
      wrap.addEventListener("click", () => openViewerSingle(opts.ctx, ref));
    }
    return wrap;
  }

  // Snaps look like Snapchat's own chat rows: a small coloured square (red = photo / silent video, purple = video
  // with sound), filled while new, outlined once opened, plus a short status. Tap a new one you received to view it.
  function snapTileEl(ctx, m, isMe) {
    const b = el("div", "gh-snap-row");
    b.dataset.opened = m.opened ? "1" : "0";
    b.dataset.sound = m.snapSound ? "1" : "0";
    b.dataset.me = isMe ? "1" : "0";
    const mark = el("span", "gh-snap-mark");
    if (isMe) mark.innerHTML = '<svg viewBox="0 0 14 16" width="13" height="15"><path d="M1.5 1.5 L12.5 8 L1.5 14.5 Z" stroke-width="2" stroke-linejoin="round"/></svg>'; // sent = arrow, like Snapchat
    const label = el("span", "gh-snap-label");
    const paint = () => {
      b.dataset.opened = m.opened ? "1" : "0";
      label.textContent = isMe ? (m.opened ? "Opened" : "Delivered") : (m.opened ? "Opened" : "New Snap");
    };
    paint();
    const time = el("span", "gh-snap-time"); time.textContent = fmtClock(m.ts);
    b.append(mark, label, time);
    if (!isMe && !m.opened) {
      b.classList.add("gh-press");
      b.setAttribute("role", "button");
      b.setAttribute("aria-label", "View Snap");
      b.addEventListener("click", async () => {
        if (m.opened || b.dataset.loading === "1") return;
        haptic();
        b.dataset.loading = "1";
        label.textContent = "Loading…";
        try {
          const res = await api.openSnap(m.conversationId || ctx.state.currentConvId, m.id);
          const items = (res && res.media) || [];
          if (!items.length) throw new Error("empty");
          openViewerSequence(ctx, items, { title: (m.from && m.from.name) || "Snap" });
          ctx.viewer.snap = { convId: m.conversationId || ctx.state.currentConvId, msgId: m.id, onClose: () => { m.opened = true; paint(); } };
        } catch (e) { gtrail("snap open failed " + (e && e.message || e)); ctx.showToast("Couldn't load that Snap"); paint(); }
        finally { delete b.dataset.loading; if (!m.opened) paint(); }
      });
    }
    return b;
  }

  // Photos, videos and voice notes arrive without their file (Snapchat downloads + decrypts on demand): ask the
  // bridge for it (loadMedia -> Snapchat's own media resolver), 3 at a time, remembered per message.
  const mediaCache = new Map(), mediaWaiting = [];
  let mediaActive = 0;
  function fetchMediaFor(m) {
    const key = m.conversationId + "|" + m.id;
    if (mediaCache.has(key)) return mediaCache.get(key);
    const p = new Promise((resolve) => mediaWaiting.push({ m, resolve }));
    mediaCache.set(key, p);
    pumpMedia();
    return p;
  }
  // A photo/GIF you JUST sent has no downloadable copy until the upload finishes (device 2026-09-27: loadMedia came
  // back empty, the empty result was cached, and your sent GIFs never appeared). So an empty answer is retried a few
  // times with backoff, and is never cached - the next repaint asks again.
  const MEDIA_RETRY_MS = [1500, 3500, 7000, 15000];
  function pumpMedia() {
    while (mediaActive < 3 && mediaWaiting.length) {
      const job = mediaWaiting.shift();
      const { m, resolve } = job;
      mediaActive++;
      api.loadMedia(m.conversationId, m.id).then((r) => (r && r.media) || [], (e) => { gtrail("media load failed " + (e && e.message || e)); return []; })
        .then((list) => {
          if (list.length) { resolve(list); return; }
          const tries = job.tries || 0;
          if (tries < MEDIA_RETRY_MS.length) setTimeout(() => { job.tries = tries + 1; mediaWaiting.push(job); pumpMedia(); }, MEDIA_RETRY_MS[tries]);
          else { mediaCache.delete(m.conversationId + "|" + m.id); resolve([]); }
        })
        .finally(() => { mediaActive--; pumpMedia(); });
    }
  }
  // Voice notes, Telegram-style: round play button, a waveform that fills as it plays (tap/drag it to seek),
  // elapsed/remaining time and a 1x/1.5x/2x chip. The file comes from Snapchat's own voice-note loader (bridge
  // loadMedia); the waveform is the real one once the file is decoded, a stable per-message pattern until then.
  let playingVoice = null; // only one voice note plays at a time
  // waveform decoding, one file at a time, on an OfflineAudioContext: a live AudioContext would grab the
  // phone's audio session (and could pause the user's music) just from opening a chat
  let waveQueue = Promise.resolve();
  function decodeForWave(src) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return null;
    let waveCtx;
    try { waveCtx = new OAC(1, 1, 44100); } catch (e) { return null; }
    return fetch(src).then((r) => r.arrayBuffer()).then((buf) => new Promise((res) => {
      const p = waveCtx.decodeAudioData(buf, res, () => res(null));
      if (p && p.then) p.then(res, () => res(null));
    })).catch(() => null);
  }
  const WAVE_BARS = 30;
  // Playback state lives per MESSAGE, not per bubble: the chat list rebuilds bubbles on every new message / scroll,
  // and a bubble-owned <audio> kept playing with no controls (and a second copy started on the rebuilt bubble).
  const voices = new Map(); // conversationId|messageId -> { audio, src, duration, peaks, loaded, speedIdx, state, view }
  function stopVoice() { if (playingVoice) { try { playingVoice.pause(); } catch (e) {} playingVoice = null; } }
  function audioBubbleEl(ctx, m, isMe, isLast) {
    const ref = (m.media && m.media[0]) || {};
    const key = m.conversationId + "|" + m.id;
    let v = voices.get(key);
    if (!v) {
      const speeds0 = [1, 1.5, 2];
      v = { audio: null, src: null, duration: ref.durationSec || 0, peaks: null, loaded: null, state: "idle", view: null,
        speedIdx: Math.max(0, speeds0.indexOf(Number((typeof window.dgSetting === "function" && window.dgSetting("voiceNoteSpeed", "1")) || 1))) };
      voices.set(key, v);
    }
    const speeds = [1, 1.5, 2];
    const b = el("div", "gh-bubble gh-audio");
    if (isLast) b.dataset.tail = "1";
    const playBtn = el("button", "gh-audio-play gh-hit");
    playBtn.setAttribute("aria-label", "Play voice message");
    const body = el("div", "gh-audio-body");
    const wave = el("div", "gh-audio-wave");
    const seedBase = Math.abs(hashStr(m.id));
    const bars = [];
    for (let i = 0; i < WAVE_BARS; i++) {
      const bar = el("span");
      bar.style.height = (4 + (Math.abs((seedBase * (i + 1) * 2654435761) >>> 0) % 15)) + "px";
      wave.appendChild(bar); bars.push(bar);
    }
    const info = el("div", "gh-audio-info");
    const timeEl = el("span", "gh-audio-time");
    const speedBtn = el("button", "gh-audio-speed");
    speedBtn.textContent = speeds[v.speedIdx] + "x";
    info.append(timeEl, speedBtn, tickMetaEl(m, isMe, "gh-audio-meta"));
    body.append(wave, info);
    b.append(playBtn, body);

    const setIcon = (name) => { playBtn.innerHTML = ""; if (name === "spin") playBtn.appendChild(el("div", "gh-spinner gh-audio-spin")); else playBtn.appendChild(icon(name, 18)); };
    const paintBars = () => { if (v.peaks) { const top = Math.max(...v.peaks) || 1; v.peaks.forEach((x, i) => { bars[i].style.height = (3 + Math.round((x / top) * 17)) + "px"; }); } };
    const paint = () => {
      const a = v.audio;
      timeEl.textContent = fmtDuration(a && v.state !== "idle" && a.currentTime > 0 ? a.currentTime : v.duration);
      const p = a && v.duration ? Math.min(1, a.currentTime / v.duration) : 0;
      const n = Math.round(p * WAVE_BARS);
      for (let i = 0; i < WAVE_BARS; i++) bars[i].dataset.on = i < n ? "1" : "0";
      setIcon(v.state === "loading" ? "spin" : v.state === "playing" ? "pause" : "play");
      b.dataset.playing = v.state === "playing" ? "1" : "0";
    };
    v.view = { paint, paintBars, isConnected: () => b.isConnected };
    paintBars(); paint();
    const refresh = () => { if (v.view) { v.view.paintBars(); v.view.paint(); } };

    const ensureLoaded = () => {
      if (v.loaded) return v.loaded;
      v.loaded = ((ref.url || ref.blob) ? Promise.resolve([ref]) : fetchMediaFor(m)).then((list) => {
        const r = list[0];
        const src = r && (r.url || (r.blob ? URL.createObjectURL(r.blob) : ""));
        if (!src) throw new Error("no file");
        if (r.durationSec) v.duration = r.durationSec;
        v.src = src;
        // the real waveform (peak per bar); purely cosmetic, so failures are ignored
        waveQueue = waveQueue.then(() => decodeForWave(src)).then((ab) => {
          if (!ab) return;
          if (!v.duration && ab.duration) v.duration = ab.duration;
          const data = ab.getChannelData(0), step = Math.max(1, Math.floor(data.length / WAVE_BARS));
          v.peaks = [];
          for (let i = 0; i < WAVE_BARS; i++) { let mx = 0; for (let j = i * step, e = Math.min(data.length, j + step); j < e; j += 8) mx = Math.max(mx, Math.abs(data[j])); v.peaks.push(mx); }
          refresh();
        }).catch(() => {});
        return src;
      });
      v.loaded.catch(() => { v.loaded = null; });
      return v.loaded;
    };
    function makeAudio(src) {
      const a = new Audio();
      a.preload = "auto";
      a.src = src;
      a.playbackRate = speeds[v.speedIdx];
      a.addEventListener("loadedmetadata", () => { if (isFinite(a.duration) && a.duration > 0) { v.duration = a.duration; refresh(); } });
      a.addEventListener("play", () => { v.state = "playing"; refresh(); tickLoop(); });
      a.addEventListener("pause", () => { if (v.state !== "idle") v.state = "paused"; refresh(); });
      a.addEventListener("ended", () => { v.state = "idle"; a.currentTime = 0; if (playingVoice === a) playingVoice = null; refresh(); });
      a.addEventListener("error", () => { v.state = "idle"; refresh(); gtrail("voice note won't play: " + (a.error && a.error.code)); ctx.showToast("Couldn't play that voice message"); });
      return a;
    }
    function tickLoop() {
      if (v.state !== "playing") return;
      if (v.view && v.view.isConnected()) v.view.paint();
      requestAnimationFrame(tickLoop);
    }
    async function play() {
      if (!v.audio) {
        v.state = "loading"; refresh();
        let src;
        try { src = await ensureLoaded(); } catch (e) { v.state = "idle"; refresh(); ctx.showToast("Couldn't load that voice message"); return; }
        if (!v.audio) v.audio = makeAudio(src);
      }
      if (playingVoice && playingVoice !== v.audio) playingVoice.pause();
      playingVoice = v.audio;
      v.audio.play().catch((e) => { v.state = "paused"; refresh(); gtrail("voice play() rejected " + (e && e.name)); });
    }
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      haptic("light");
      if (v.state === "loading") return;
      if (v.state === "playing") v.audio.pause(); else play();
    });
    const seekTo = (clientX) => {
      if (!v.audio || !v.duration) return;
      const r = wave.getBoundingClientRect();
      v.audio.currentTime = clamp((clientX - r.left) / r.width, 0, 1) * v.duration;
      paint();
    };
    wave.addEventListener("click", (e) => { e.stopPropagation(); if (!v.audio) { play(); return; } seekTo(e.clientX); });
    wave.addEventListener("touchmove", (e) => { if (v.audio && e.touches[0]) { e.stopPropagation(); seekTo(e.touches[0].clientX); } }, { passive: true });
    speedBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      haptic("light");
      v.speedIdx = (v.speedIdx + 1) % speeds.length;
      if (v.audio) v.audio.playbackRate = speeds[v.speedIdx];
      speedBtn.textContent = speeds[v.speedIdx] + "x";
    });
    // fetch (not play) the file as soon as the bubble exists, so pressing play is instant and the time is right
    if (!ref.url && !ref.blob) ensureLoaded().then(() => refresh(), () => {});
    if (v.state === "playing") tickLoop();
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
  // Paint a chat's header + whatever messages we already have, without opening it (no read receipt, no
  // presence) - used while a row is being swiped open; openConversationScreen does the real open on release.
  function peekConversation(ctx, id) {
    const conv = ctx.conv;
    if (conv.peekId === id && ctx.state.currentConvId !== id) return;
    conv.peekId = id;
    const cd = ctx.state.convById.get(id);
    if (cd) updateConvHeader(ctx, cd);
    conv.rendered.forEach((elm) => elm.remove());
    conv.rendered.clear();
    const entry = ctx.state.messagesByConv.get(id);
    conv.unreadBoundaryIndex = null; conv.unreadBoundaryComputed = true;
    conv.pinUntil = nowMs() + 4000; conv.userTouched = false; conv.atBottom = true;
    if (entry) { conv.messages.classList.remove("gh-loading-skel"); renderMessageList(ctx, conv, entry, { initial: true }); }
    else { conv.messages.replaceChildren(conv.topSpacer, conv.bottomSpacer); conv.messages.classList.add("gh-loading-skel"); }
  }
  function mentionQuery(ta) {
    const upto = ta.value.slice(0, ta.selectionStart == null ? ta.value.length : ta.selectionStart);
    const mm = /(^|\s)@([\w.\-]*)$/.exec(upto);
    return mm ? { q: mm[2].toLowerCase(), start: upto.length - mm[2].length - 1, end: upto.length } : null;
  }
  function hideMentions(ctx) { const b = ctx.conv.mentionBox; if (b && b.dataset.open === "1") { b.dataset.open = "0"; b.innerHTML = ""; } }
  function updateMentions(ctx) {
    const conv = ctx.conv, box = conv.mentionBox;
    const mq = mentionQuery(conv.textarea);
    if (!mq) { hideMentions(ctx); return; }
    const cd = ctx.state.convById.get(ctx.state.currentConvId) || {};
    const meId = ctx.state.me && ctx.state.me.id;
    const people = [{ id: "myai", name: "My AI", username: "myai", ai: true }];
    if (cd.isGroup) for (const p of cd.participants || []) if (p && p.id !== meId && p.username) people.push(p);
    const list = people.filter((p) => !mq.q || (p.username || "").toLowerCase().startsWith(mq.q) || (p.name || "").toLowerCase().split(/\s+/).some((w) => w.startsWith(mq.q))).slice(0, 6);
    if (!list.length) { hideMentions(ctx); return; }
    box.innerHTML = "";
    for (const p of list) {
      const row = el("div", "gh-mention-row gh-press");
      row.setAttribute("role", "option");
      if (p.ai) { const av = el("div", "gh-mention-ai"); av.appendChild(icon("ghost", 18)); row.appendChild(av); }
      else row.appendChild(makeAvatar(p, 32));
      const nm = el("div", "gh-mention-name"); nm.textContent = p.name || p.username;
      const un = el("div", "gh-mention-user"); un.textContent = "@" + p.username;
      row.append(nm, un);
      // mousedown/touchstart so the textarea keeps focus (the keyboard stays up)
      const pick = (e) => {
        e.preventDefault();
        haptic("light");
        const ta = conv.textarea, cur = mentionQuery(ta);
        if (!cur) return;
        const ins = "@" + p.username + " ";
        ta.value = ta.value.slice(0, cur.start) + ins + ta.value.slice(cur.end);
        const pos = cur.start + ins.length;
        ta.setSelectionRange(pos, pos);
        ta.dispatchEvent(new Event("input"));
        hideMentions(ctx);
      };
      row.addEventListener("touchstart", pick, { passive: false });
      row.addEventListener("mousedown", pick);
      box.appendChild(row);
    }
    box.dataset.open = "1";
  }
  function pinnedToBottom(conv) { return !conv.userTouched && nowMs() < (conv.pinUntil || 0); }
  function handleWindowScroll(ctx) {
    const conv = ctx.conv;
    const m = conv.messages;
    const total = (conv._all || []).length;
    if (!total) return;
    // Right after a chat opens, swapping in its messages makes the list shrink and the scroll position snap
    // to the top for a moment; that used to count as "you scrolled up", which revealed + fetched older
    // messages and kept you up there (device 2026-09-27: "jumps me way far up"). Until you touch the list
    // yourself, the chat stays pinned to the newest message instead.
    if (pinnedToBottom(conv)) return;
    if (m.scrollTop < 240) {
      // Sliding the LOCAL window back (more already-fetched messages to reveal) and fetching MORE history
      // from the bridge (loadOlder) are two different things that both happen "near the top" - a freshly
      // opened conversation's first page often already satisfies windowStart === 0 with nothing local left to
      // reveal, but the bridge can still have plenty more history (hasMore). Gating the fetch on
      // `windowStart > 0` (as this used to) meant that common case never fetched anything at all.
      if (conv.windowStart > 0) {
        conv.windowStart = Math.max(0, conv.windowStart - CHUNK);
        paintWindow(ctx, conv);
      }
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
    // A real touch-scroll's momentum settles near the top once; a very fast/flung scroll can otherwise fire
    // this repeatedly within the same second (each near-top scroll event asking for another fetch+repaint the
    // instant the previous one resolves), which costs far more than any single call - measured on the
    // scripted-scroll perf rig (2026-09-27, after fixing the bug that used to keep this from firing at all).
    if (conv._lastLoadOlderAt && Date.now() - conv._lastLoadOlderAt < 600) return;
    conv._lastLoadOlderAt = Date.now();
    conv._loadingOlder = true;
    const beforeHeight = conv.messages.scrollHeight;
    try {
      const res = await api.loadOlder(convId);
      const prevEntry = ctx.state.messagesByConv.get(convId) || { messages: [], hasMore: true };
      const prevTotal = prevEntry.messages.length;
      const entry = { messages: res.messages || prevEntry.messages, hasMore: !!res.hasMore };
      ctx.state.messagesByConv.set(convId, entry);
      const newTotal = entry.messages.length;
      // `res.messages` (like openConversation's) is the WHOLE loaded slice from the new start onward, not just
      // the newly-fetched page - the actual number of messages prepended is the growth in that total, never
      // its raw length (using the raw length here used to double-count and, worse, leave windowEnd wherever
      // that miscalculation landed with nothing to cap it back down - see below).
      const added = Math.max(0, newTotal - prevTotal);
      conv.windowStart += added; conv.windowEnd += added; // shift indices: same logical messages, now further along the (bigger) array
      // Reveal only OVERSCAN's worth of the newly-fetched history per call - a smaller single-paint cost than
      // dumping the WHOLE freshly-fetched page (up to PAGE messages) in one go, which measurably blew the
      // scripted-scroll perf budget (2026-09-27 fix: the harness never actually exercised this path before,
      // because of the loadOlderMessages-never-fires bug fixed just above it). The rest of what was just
      // fetched is already sitting in conv._all, ready to be revealed near-instantly (no network) by the very
      // next ordinary scroll-driven window-shift once the user keeps scrolling toward it.
      conv.windowStart = Math.max(0, conv.windowStart - OVERSCAN);
      if (conv.windowEnd - conv.windowStart > CHUNK * 4) conv.windowEnd = conv.windowStart + CHUNK * 4; // backstop
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
    const here = convId ? hereUsers(ctx, convId) : [];
    if (here.length) {
      // like Snapchat's Bitmoji at the bottom of the chat: who's here right now, with dots while they type
      row.style.display = "flex";
      row.innerHTML = "";
      row.dataset.here = "1";
      for (const u of here.slice(0, 4)) {
        const a = el("div", "gh-here-av");
        a.appendChild(makeAvatar(u, 30));
        row.appendChild(a);
      }
      if (here.some((u) => u.typing)) { const b = el("div", "gh-typing-bubble"); b.innerHTML = "<span></span><span></span><span></span>"; row.appendChild(b); }
      else { const t = el("div", "gh-here-label"); t.textContent = here.length === 1 ? ((here[0].name || "").split(" ")[0] + " is here") : here.length + " here"; row.appendChild(t); }
      return;
    }
    row.dataset.here = "0";
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
    hideMentions(ctx);
    conv.textarea.style.height = "auto";
    conv.sendBtn.dataset.show = "0";
    conv.micBtn.dataset.hide = "0";
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
    const sheet = el("div", "gh-sheet gh-action-sheet"); sheet.style.display = "none";
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
      b.setAttribute("aria-label", "React " + emoji);
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
    function textSpan(t) { const s = el("span"); s.textContent = t; return s; }

    const s = { backdrop, sheet, reactRow, replyItem, copyItem, saveItem, message: null, liftedEl: null };
    function closeAction() {
      if (s.liftedEl) { s.liftedEl.classList.remove("gh-msg-lifted"); s.liftedEl = null; }
      closeSheetGeneric(backdrop, sheet);
    }
    s.close = closeAction;
    backdrop.addEventListener("click", closeAction);
    return s;
  }
  function closeSheetGeneric(backdrop, sheet) {
    backdrop.dataset.open = "0";
    sheet.classList.add("gh-anim");
    sheet.dataset.open = "0";
    // Fully drop the sheet out of the render tree once its slide-down finishes, instead of just leaving it
    // transformed off-screen: on this machine's software compositor, a long-lived page that keeps many
    // transform-animated overlay layers around (several sheets, each opened/closed a few times) can start
    // leaving a closed layer's last-painted pixels on screen even though its own geometry/attributes are
    // correctly "closed" (reproducible on the unmodified original code too, given enough sheet toggles) —
    // `display:none` sidesteps it outright since a display:none box has nothing to paint or leave behind.
    clearTimeout(sheet._closeTimer);
    sheet._closeTimer = setTimeout(() => { if (sheet.dataset.open === "0") sheet.style.display = "none"; }, 360);
  }
  function openSheetGeneric(backdrop, sheet) {
    clearTimeout(sheet._closeTimer);
    sheet.style.display = "";
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
        s.close();
      };
    }
    s.replyItem.onclick = () => { setReplyTo(ctx, message); ctx.conv.textarea.focus(); s.close(); };
    s.copyItem.onclick = () => { copyToClipboard(message.text || ""); s.close(); };
    const saveLabel = s.saveItem.querySelector("span");
    saveLabel.textContent = message.saved ? "Unsave" : "Save";
    s.saveItem.onclick = () => {
      const next = !message.saved;
      message.saved = next;
      api.saveMessage(convId, message.id, next).catch(() => {});
      s.close();
    };
    if (wrapEl) { wrapEl.classList.add("gh-msg-lifted"); s.liftedEl = wrapEl; }
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
  // Attach sheet (paperclip in the composer) — Telegram-style bottom sheet: Gallery, Camera, GIF
  // =====================================================================================================
  function buildAttachSheet(ctx, overlaysRoot) {
    const backdrop = el("div", "gh-backdrop");
    const sheet = el("div", "gh-sheet gh-attach-sheet"); sheet.style.display = "none";
    sheet.innerHTML = `
      <div class="gh-sheet-grip"></div>
      <div class="gh-action-list">
        <div class="gh-action-item" data-act="photo"></div>
        <div class="gh-action-item" data-act="camera"></div>
        <div class="gh-action-item" data-act="gif"></div>
      </div>
    `;
    const row = (act, tint, iconName, label) => {
      const item = sheet.querySelector(`[data-act="${act}"]`);
      const tag = el("div", "gh-attach-icon");
      tag.dataset.tint = tint;
      tag.appendChild(icon(iconName, 19));
      item.append(tag, Object.assign(document.createElement("span"), { textContent: label }));
    };
    row("photo", "blue", "gallery", "Gallery");
    row("camera", "pink", "camera", "Camera");
    row("gif", "green", "gifBadge", "GIF");
    overlaysRoot.append(backdrop, sheet);
    // Closing WITHOUT the slide-down transition here on purpose: the destination (gif sheet / camera /
    // file picker) covers the same screen area a moment later, so animating this sheet's own close at the
    // same time as another sheet's open animation just fights it for that space and never reads as
    // intentional. An instant close reads as "handed off", which is what it visually is.
    function closeInstant(next) {
      backdrop.classList.remove("gh-anim"); sheet.classList.remove("gh-anim");
      backdrop.dataset.open = "0"; sheet.dataset.open = "0";
      sheet.style.display = "none"; // see closeSheetGeneric's note — dropped from the render tree immediately
      next();
    }
    backdrop.addEventListener("click", () => closeSheetGeneric(backdrop, sheet));
    sheet.querySelector('[data-act="photo"]').addEventListener("click", () => closeInstant(() => ctx.conv.fileInput.click()));
    sheet.querySelector('[data-act="camera"]').addEventListener("click", () => closeInstant(() => openCamera(ctx, { to: ctx.state.currentConvId })));
    sheet.querySelector('[data-act="gif"]').addEventListener("click", () => closeInstant(() => openGifSheet(ctx)));
    return { backdrop, sheet };
  }
  function openAttachSheet(ctx) {
    haptic();
    openSheetGeneric(ctx.attachSheet.backdrop, ctx.attachSheet.sheet);
  }

  // =====================================================================================================
  // GIF sheet
  // =====================================================================================================
  // =====================================================================================================
  // Ghost Settings: its own Telegram-style screen (the native sheet is still under Advanced). Looks: themes,
  // accent, chat wallpaper, text size, bubble shape/style, list density, avatars; Chats; Privacy; Stickers & GIFs;
  // Storage. Ghost-only prefs live in GM storage ("ghostPrefs"); the few the app itself also reads (haptics,
  // reduce motion, show me in chats, voice-note speed, GIF rating) stay native settings.
  // =====================================================================================================
  const THEMES = {
    night:    { name: "Night",    app: "#0e161f", list: "#17212b", header: "rgba(21,30,39,0.96)", panel: "#1c2733", panel2: "#24313f", input: "#253340", in1: "#1c2936", in2: "#18232e", sub: "#8b98a5", ter: "#64707c", pill: "rgb(30,44,58)" },
    midnight: { name: "Midnight", app: "#000000", list: "#000000", header: "rgba(10,10,12,0.96)", panel: "#121214", panel2: "#1c1c1f", input: "#1c1c1f", in1: "#1f1f22", in2: "#1a1a1d", sub: "#8e8e93", ter: "#636366", pill: "rgb(28,28,31)" },
    ocean:    { name: "Ocean",    app: "#071a24", list: "#0c2330", header: "rgba(11,32,44,0.96)", panel: "#11303f", panel2: "#173b4c", input: "#183c4d", in1: "#123344", in2: "#0f2b3a", sub: "#86a6b5", ter: "#5e7d8b", pill: "rgb(17,48,63)" },
    forest:   { name: "Forest",   app: "#0b1712", list: "#12211a", header: "rgba(17,31,24,0.96)", panel: "#182b22", panel2: "#20372c", input: "#21382d", in1: "#1a2f25", in2: "#16291f", sub: "#8fa89a", ter: "#667d71", pill: "rgb(24,43,34)" },
    grape:    { name: "Grape",    app: "#130e1f", list: "#1b1529", header: "rgba(26,20,40,0.96)", panel: "#231b36", panel2: "#2d2443", input: "#2e2545", in1: "#261e39", in2: "#211a32", sub: "#a197b8", ter: "#776e8e", pill: "rgb(35,27,54)" },
    ember:    { name: "Ember",    app: "#1a0f0c", list: "#231612", header: "rgba(35,22,18,0.96)", panel: "#2e1d18", panel2: "#3a261f", input: "#3b2720", in1: "#31201a", in2: "#2a1b16", sub: "#b39a90", ter: "#86706a", pill: "rgb(46,29,24)" },
    graphite: { name: "Graphite", app: "#141517", list: "#1c1d20", header: "rgba(28,29,32,0.96)", panel: "#25262a", panel2: "#2e3035", input: "#2f3136", in1: "#27292d", in2: "#222428", sub: "#9a9ca3", ter: "#71737a", pill: "rgb(37,38,42)" },
  };
  const ACCENT_SET = {
    blue:   ["#3e88f7", "#2f74e0", "#3a6a94", "#2b5278"],
    purple: ["#9b59f6", "#7c3fd1", "#6a4a9e", "#523a7e"],
    pink:   ["#ff5c9e", "#d63f80", "#9a4870", "#7a3659"],
    red:    ["#f2555a", "#cf3d42", "#94474a", "#743538"],
    orange: ["#ff9433", "#e07a1c", "#9a6433", "#7a4d24"],
    yellow: ["#f0b232", "#c9911c", "#8f7432", "#705a24"],
    green:  ["#23a55a", "#1a7f45", "#2f7a52", "#235f3f"],
    teal:   ["#1fb8c4", "#14939d", "#2b7880", "#205d63"],
  };
  const WALLPAPERS = {
    aurora: { name: "Aurora", css: "radial-gradient(ellipse 120% 70% at 15% -5%, color-mix(in srgb, var(--gh-accent) 16%, transparent), transparent 55%), radial-gradient(ellipse 120% 70% at 100% 100%, rgba(93,74,173,0.14), transparent 55%), radial-gradient(circle, rgba(255,255,255,0.05) 1.4px, transparent 1.6px), radial-gradient(circle, rgba(255,255,255,0.035) 1.1px, transparent 1.3px)", size: "auto, auto, 64px 64px, 40px 40px", pos: "0 0, 0 0, 0 0, 20px 26px" },
    plain:  { name: "Plain", css: "none", size: "auto", pos: "0 0" },
    dots:   { name: "Dots", css: "radial-gradient(circle, rgba(255,255,255,0.07) 1.3px, transparent 1.5px)", size: "22px 22px", pos: "0 0" },
    glow:   { name: "Glow", css: "radial-gradient(ellipse 90% 60% at 50% 110%, color-mix(in srgb, var(--gh-accent) 30%, transparent), transparent 70%), radial-gradient(ellipse 80% 50% at 50% -10%, color-mix(in srgb, var(--gh-accent) 14%, transparent), transparent 70%)", size: "auto, auto", pos: "0 0, 0 0" },
    sunset: { name: "Sunset", css: "linear-gradient(170deg, rgba(255,120,90,0.16), transparent 45%, rgba(155,89,246,0.16))", size: "auto", pos: "0 0" },
    nebula: { name: "Nebula", css: "radial-gradient(circle at 20% 30%, rgba(155,89,246,0.22), transparent 40%), radial-gradient(circle at 80% 20%, rgba(31,184,196,0.16), transparent 40%), radial-gradient(circle at 60% 85%, rgba(255,92,158,0.16), transparent 45%), radial-gradient(circle, rgba(255,255,255,0.08) 0.9px, transparent 1.1px)", size: "auto, auto, auto, 30px 30px", pos: "0 0, 0 0, 0 0, 7px 11px" },
    grid:   { name: "Grid", css: "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)", size: "28px 28px, 28px 28px", pos: "0 0, 0 0" },
  };
  const PREF_DEFAULTS = {
    theme: "night", accent: "blue", wallpaper: "aurora", textScale: 1, bubbleRadius: 17, bubbleStyle: "gradient",
    compactList: false, showStoriesRail: true, avatars: "bitmoji", hidePreviews: false, readReceipts: true,
    doubleTapCamera: true, autoplayGifs: true, sendOnReturn: false, showTimes: true, showTyping: true,
  };
  let prefs = Object.assign({}, PREF_DEFAULTS);
  function pref(k) { return Object.prototype.hasOwnProperty.call(prefs, k) ? prefs[k] : PREF_DEFAULTS[k]; }
  async function loadPrefs(ctx) {
    try { prefs = Object.assign({}, PREF_DEFAULTS, await storage.get("ghostPrefs", {})); } catch (e) {}
    // older builds kept the accent as a native setting: carry it over once
    try { const legacy = typeof window.dgSetting === "function" && window.dgSetting("accent", null); if (legacy && ACCENT_SET[legacy] && !(await storage.get("ghostPrefs", null))) prefs.accent = legacy; } catch (e) {}
    applyPrefs(ctx);
  }
  function setPref(ctx, k, v) {
    prefs[k] = v;
    storage.set("ghostPrefs", prefs);
    applyPrefs(ctx);
  }
  function applyPrefs(ctx) {
    const host = ctx.host;
    if (!host) return;
    const t = THEMES[pref("theme")] || THEMES.night;
    const a = ACCENT_SET[pref("accent")] || ACCENT_SET.blue;
    const w = WALLPAPERS[pref("wallpaper")] || WALLPAPERS.aurora;
    const set = (k, v) => host.style.setProperty(k, v);
    set("--gh-bg-app", t.app); set("--gh-bg-list", t.list); set("--gh-bg-header", t.header);
    set("--gh-bg-panel", t.panel); set("--gh-bg-panel-2", t.panel2); set("--gh-bg-input", t.input);
    set("--gh-bubble-in-1", t.in1); set("--gh-bubble-in-2", t.in2);
    set("--gh-text-secondary", t.sub); set("--gh-text-tertiary", t.ter); set("--gh-pill-bg", t.pill);
    set("--gh-accent", a[0]); set("--gh-accent-hover", a[1]); set("--gh-bubble-out-1", a[2]); set("--gh-bubble-out-2", a[3]);
    set("--gh-wall-image", w.css); set("--gh-wall-size", w.size); set("--gh-wall-pos", w.pos);
    set("--gh-text-scale", String(pref("textScale")));
    set("--gh-radius-md", pref("bubbleRadius") + "px");
    const flag = (name, on) => { if (on) host.setAttribute(name, ""); else host.removeAttribute(name); };
    flag("data-flat-bubbles", pref("bubbleStyle") === "flat");
    flag("data-compact", !!pref("compactList"));
    flag("data-no-stories", !pref("showStoriesRail"));
    flag("data-hide-previews", !!pref("hidePreviews"));
    flag("data-no-times", !pref("showTimes"));
    // the app's own background (seen for a moment while the keyboard moves) follows the theme
    try { window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GHOST theme " + pref("theme") + "/" + pref("accent") }).catch(() => {}); } catch (e) {}
    api.setReadReceipts(!!pref("readReceipts")).catch(() => {});
  }

  function nativeSetting(key, def) { try { return typeof window.dgSetting === "function" ? window.dgSetting(key, def) : def; } catch (e) { return def; } }
  function setNativeSetting(key, v) { try { if (typeof window.dgSetSetting === "function") window.dgSetSetting(key, v); } catch (e) {} }

  function buildSettings(ctx) {
    const wrap = el("div", "gh-settings");
    const s = { el: wrap, stack: [] };
    wrap.addEventListener("click", (e) => e.stopPropagation());
    return s;
  }
  function openSettings(ctx) {
    haptic();
    const s = ctx.settings;
    s.el.innerHTML = "";
    s.stack = [];
    s.el.dataset.open = "1";
    pushSettingsPage(ctx, "main");
  }
  function closeSettings(ctx) {
    const s = ctx.settings;
    s.el.dataset.open = "0";
    setTimeout(() => { if (s.el.dataset.open !== "1") s.el.innerHTML = ""; }, 320);
  }
  function pushSettingsPage(ctx, name) {
    const s = ctx.settings;
    const page = el("div", "gh-set-page");
    const prev = s.stack[s.stack.length - 1];
    const head = el("div", "gh-set-head");
    const back = el("button", "gh-set-back gh-hit");
    back.append(icon("back", 22), Object.assign(el("span"), { textContent: prev ? SETTINGS_TITLES[prev.name] : "Chats" }));
    back.addEventListener("click", () => { haptic("light"); popSettingsPage(ctx); });
    const title = el("div", "gh-set-title"); title.textContent = SETTINGS_TITLES[name];
    head.append(back, title, el("div", "gh-set-head-spacer"));
    const body = el("div", "gh-set-body gh-scroll");
    page.append(head, body);
    SETTINGS_PAGES[name](ctx, body, page);
    s.el.appendChild(page);
    s.stack.push({ name, page });
    if (prev) { requestAnimationFrame(() => { prev.page.dataset.under = "1"; page.dataset.in = "1"; }); page.dataset.in = "0"; }
    else page.dataset.in = "1";
    // swipe from the left edge to go back, like every iOS screen
    let x0 = null, dx = 0;
    page.addEventListener("touchstart", (e) => { const t = e.touches[0]; x0 = t.clientX < 28 ? t.clientX : null; dx = 0; }, { passive: true });
    page.addEventListener("touchmove", (e) => { if (x0 == null) return; dx = Math.max(0, e.touches[0].clientX - x0); page.style.transition = "none"; page.style.transform = `translateX(${dx}px)`; }, { passive: true });
    page.addEventListener("touchend", () => { if (x0 == null) return; page.style.transition = ""; page.style.transform = ""; if (dx > 90) popSettingsPage(ctx); x0 = null; }, { passive: true });
  }
  function popSettingsPage(ctx) {
    const s = ctx.settings;
    if (s.stack.length <= 1) { closeSettings(ctx); return; }
    const top = s.stack.pop();
    const prev = s.stack[s.stack.length - 1];
    top.page.dataset.in = "0";
    prev.page.dataset.under = "0";
    if (prev.refresh) prev.refresh();
    setTimeout(() => top.page.remove(), 320);
  }

  // ---- building blocks -------------------------------------------------------------------------------
  function setGroup(body, title, footer) {
    if (title) { const h = el("div", "gh-set-group-title"); h.textContent = title; body.appendChild(h); }
    const g = el("div", "gh-set-group");
    body.appendChild(g);
    if (footer) { const f = el("div", "gh-set-group-foot"); f.textContent = footer; body.appendChild(f); }
    return g;
  }
  function setRow(group, opts) {
    const row = el(opts.onClick ? "button" : "div", "gh-set-row" + (opts.onClick ? " gh-press" : ""));
    if (opts.icon) { const ic = el("span", "gh-set-icon"); ic.style.background = opts.tint || "var(--gh-accent)"; ic.appendChild(icon(opts.icon, 17)); row.appendChild(ic); }
    const label = el("span", "gh-set-label"); label.textContent = opts.label; row.appendChild(label);
    if (opts.value != null) { const v = el("span", "gh-set-value"); v.textContent = opts.value; row.appendChild(v); row._value = v; }
    if (opts.toggle) {
      const sw = el("span", "gh-switch"); sw.dataset.on = opts.toggle.get() ? "1" : "0"; row.appendChild(sw);
      row.classList.add("gh-press");
      row.addEventListener("click", () => { const on = sw.dataset.on !== "1"; sw.dataset.on = on ? "1" : "0"; haptic("light"); opts.toggle.set(on); });
    }
    if (opts.onClick) { row.appendChild(Object.assign(icon("back", 16, "gh-set-chev"))); row.addEventListener("click", () => { haptic("light"); opts.onClick(row); }); }
    if (opts.danger) row.classList.add("gh-set-danger");
    group.appendChild(row);
    return row;
  }
  function setChoice(group, options, get, set) { // a checkmark list
    const rows = [];
    for (const [val, label] of options) {
      const row = el("button", "gh-set-row gh-press");
      const l = el("span", "gh-set-label"); l.textContent = label;
      const ck = el("span", "gh-set-check"); ck.appendChild(icon("check", 18));
      row.append(l, ck);
      row.addEventListener("click", () => { haptic("light"); set(val); paint(); });
      group.appendChild(row); rows.push([val, row]);
    }
    const paint = () => { for (const [val, row] of rows) row.dataset.on = String(get()) === String(val) ? "1" : "0"; };
    paint();
  }
  function setSlider(group, opts) {
    const row = el("div", "gh-set-row gh-set-slider-row");
    const small = el("span", "gh-set-slider-cap"); small.textContent = opts.minLabel;
    const input = el("input"); input.type = "range"; input.min = opts.min; input.max = opts.max; input.step = opts.step; input.value = opts.get();
    input.className = "gh-set-slider";
    const big = el("span", "gh-set-slider-cap gh-set-slider-cap-big"); big.textContent = opts.maxLabel;
    input.addEventListener("input", () => { opts.set(Number(input.value)); });
    input.addEventListener("change", () => haptic("light"));
    row.append(small, input, big);
    group.appendChild(row);
  }
  function previewChat(ctx) { // a tiny live chat that every appearance change repaints through the CSS vars
    const box = el("div", "gh-set-preview");
    box.innerHTML = `<div class="gh-set-prev-in">Did you see the new theme? 👀<span class="gh-set-prev-t">9:41</span></div>
      <div class="gh-set-prev-out">It looks so clean ✨<span class="gh-set-prev-t">9:42 ✓✓</span></div>`;
    return box;
  }

  const SETTINGS_TITLES = { main: "Settings", appearance: "Appearance", chats: "Chats", privacy: "Privacy", media: "Stickers & GIFs", storage: "Storage & Data", about: "About Ghost" };
  const SETTINGS_PAGES = {
    main(ctx, body) {
      const me = ctx.state.me || {};
      const prof = el("div", "gh-set-profile");
      prof.appendChild(makeAvatar(me, 84));
      const nm = el("div", "gh-set-profile-name"); nm.textContent = me.name || "You";
      const un = el("div", "gh-set-profile-user"); un.textContent = me.username ? "@" + me.username : "";
      prof.append(nm, un);
      body.appendChild(prof);
      let g = setGroup(body);
      setRow(g, { icon: "palette", tint: "linear-gradient(135deg,#ff5c9e,#9b59f6)", label: "Appearance", value: (THEMES[pref("theme")] || THEMES.night).name, onClick: () => pushSettingsPage(ctx, "appearance") });
      setRow(g, { icon: "newMsg", tint: "#3e88f7", label: "Chats", onClick: () => pushSettingsPage(ctx, "chats") });
      setRow(g, { icon: "lock", tint: "#8e8e93", label: "Privacy", onClick: () => pushSettingsPage(ctx, "privacy") });
      setRow(g, { icon: "emoji", tint: "#f0b232", label: "Stickers & GIFs", onClick: () => pushSettingsPage(ctx, "media") });
      setRow(g, { icon: "database", tint: "#23a55a", label: "Storage & Data", onClick: () => pushSettingsPage(ctx, "storage") });
      g = setGroup(body);
      setRow(g, { icon: "vibrate", tint: "#ff9433", label: "Haptics", toggle: { get: () => nativeSetting("haptics", true) !== false, set: (v) => setNativeSetting("haptics", v) } });
      setRow(g, { icon: "motion", tint: "#1fb8c4", label: "Reduce Motion", toggle: { get: () => !!nativeSetting("reduceMotion", false), set: (v) => setNativeSetting("reduceMotion", v) } });
      g = setGroup(body);
      setRow(g, { icon: "settings", tint: "#636366", label: "Advanced", onClick: () => { try { window.dgOpenSettings && window.dgOpenSettings(); } catch (e) {} } });
      setRow(g, { icon: "ghost", tint: "linear-gradient(135deg,#5865f2,#3e88f7)", label: "About Ghost", onClick: () => pushSettingsPage(ctx, "about") });
    },
    appearance(ctx, body, page) {
      body.appendChild(previewChat(ctx));
      let g = setGroup(body, "Theme");
      const themes = el("div", "gh-set-cards");
      for (const [key, t] of Object.entries(THEMES)) {
        const card = el("button", "gh-set-theme gh-press");
        card.style.setProperty("--c-app", t.app); card.style.setProperty("--c-in", t.in1); card.style.setProperty("--c-list", t.list);
        card.innerHTML = `<span class="gh-set-theme-art"><i></i><b></b><i></i></span><span class="gh-set-theme-name"></span>`;
        card.querySelector(".gh-set-theme-name").textContent = t.name;
        card.dataset.on = pref("theme") === key ? "1" : "0";
        card.addEventListener("click", () => { haptic("light"); setPref(ctx, "theme", key); for (const c of themes.children) c.dataset.on = "0"; card.dataset.on = "1"; });
        themes.appendChild(card);
      }
      g.appendChild(themes);
      g = setGroup(body, "Accent Color");
      const sw = el("div", "gh-set-swatches");
      for (const [key, a] of Object.entries(ACCENT_SET)) {
        const b = el("button", "gh-set-swatch gh-press"); b.style.background = a[0]; b.setAttribute("aria-label", key);
        b.dataset.on = pref("accent") === key ? "1" : "0";
        b.addEventListener("click", () => { haptic("light"); setPref(ctx, "accent", key); for (const c of sw.children) c.dataset.on = "0"; b.dataset.on = "1"; });
        sw.appendChild(b);
      }
      g.appendChild(sw);
      g = setGroup(body, "Chat Wallpaper");
      const walls = el("div", "gh-set-cards");
      for (const [key, w] of Object.entries(WALLPAPERS)) {
        const c = el("button", "gh-set-wall gh-press");
        c.style.backgroundImage = w.css; c.style.backgroundSize = w.size; c.style.backgroundPosition = w.pos;
        const n = el("span"); n.textContent = w.name; c.appendChild(n);
        c.dataset.on = pref("wallpaper") === key ? "1" : "0";
        c.addEventListener("click", () => { haptic("light"); setPref(ctx, "wallpaper", key); for (const x of walls.children) x.dataset.on = "0"; c.dataset.on = "1"; });
        walls.appendChild(c);
      }
      g.appendChild(walls);
      g = setGroup(body, "Message Text Size");
      setSlider(g, { min: 0.85, max: 1.3, step: 0.05, minLabel: "A", maxLabel: "A", get: () => pref("textScale"), set: (v) => setPref(ctx, "textScale", v) });
      g = setGroup(body, "Bubble Corners");
      setSlider(g, { min: 6, max: 24, step: 1, minLabel: "▢", maxLabel: "◯", get: () => pref("bubbleRadius"), set: (v) => setPref(ctx, "bubbleRadius", v) });
      g = setGroup(body, "Bubble Style");
      setChoice(g, [["gradient", "Gradient"], ["flat", "Flat"]], () => pref("bubbleStyle"), (v) => setPref(ctx, "bubbleStyle", v));
      g = setGroup(body, "Chat List");
      setRow(g, { label: "Compact Rows", toggle: { get: () => !!pref("compactList"), set: (v) => setPref(ctx, "compactList", v) } });
      setRow(g, { label: "Stories Row", toggle: { get: () => !!pref("showStoriesRail"), set: (v) => setPref(ctx, "showStoriesRail", v) } });
      g = setGroup(body, "Profile Pictures", "Bitmoji shows each friend's Bitmoji; Initials uses coloured letters.");
      setChoice(g, [["bitmoji", "Bitmoji"], ["initials", "Initials"]], () => pref("avatars"), (v) => { setPref(ctx, "avatars", v); refreshAllLists(ctx); });
    },
    chats(ctx, body) {
      let g = setGroup(body, null, "Friends see your Bitmoji (as on a phone) at the bottom of the chat you have open.");
      setRow(g, { label: "Show Me in Chats", toggle: { get: () => nativeSetting("showInChats", true) !== false, set: (v) => setNativeSetting("showInChats", v) } });
      g = setGroup(body);
      setRow(g, { label: "Double-Tap a Chat for Camera", toggle: { get: () => !!pref("doubleTapCamera"), set: (v) => setPref(ctx, "doubleTapCamera", v) } });
      setRow(g, { label: "Send with Return Key", toggle: { get: () => !!pref("sendOnReturn"), set: (v) => setPref(ctx, "sendOnReturn", v) } });
      setRow(g, { label: "Show Message Times", toggle: { get: () => !!pref("showTimes"), set: (v) => setPref(ctx, "showTimes", v) } });
      g = setGroup(body, "Voice Messages");
      setChoice(g, [["1", "Normal Speed"], ["1.5", "1.5×"], ["2", "2×"]], () => String(nativeSetting("voiceNoteSpeed", "1")), (v) => setNativeSetting("voiceNoteSpeed", v));
    },
    privacy(ctx, body) {
      let g = setGroup(body, null, "Turn off to read chats without friends seeing \"Opened\". Snaps still count when you open them.");
      setRow(g, { label: "Send Read Receipts", toggle: { get: () => !!pref("readReceipts"), set: (v) => setPref(ctx, "readReceipts", v) } });
      g = setGroup(body, null, "Blurs message previews in the chat list until you open the chat.");
      setRow(g, { label: "Hide Message Previews", toggle: { get: () => !!pref("hidePreviews"), set: (v) => setPref(ctx, "hidePreviews", v) } });
      g = setGroup(body, null, "Your Bitmoji in chats you have open.");
      setRow(g, { label: "Show Me in Chats", toggle: { get: () => nativeSetting("showInChats", true) !== false, set: (v) => setNativeSetting("showInChats", v) } });
    },
    media(ctx, body) {
      let g = setGroup(body);
      setRow(g, { label: "Autoplay GIFs", toggle: { get: () => !!pref("autoplayGifs"), set: (v) => setPref(ctx, "autoplayGifs", v) } });
      g = setGroup(body, "GIF Content Rating");
      setChoice(g, [["g", "G — everyone"], ["pg", "PG"], ["pg-13", "PG-13"], ["r", "R"]], () => nativeSetting("gifRating", "pg-13"), (v) => setNativeSetting("gifRating", v));
      g = setGroup(body);
      setRow(g, { label: "Clear Recent Stickers", danger: true, onClick: async () => { await storage.set("ghostStickerRecents", []); ctx.showToast("Recent stickers cleared"); } });
      setRow(g, { label: "Clear Recent GIFs", danger: true, onClick: async () => { await storage.set("ghostGifRecents", []); ctx.showToast("Recent GIFs cleared"); } });
    },
    storage(ctx, body) {
      let g = setGroup(body, null, "Downloaded photos, stickers and the sticker list are kept while Ghost is open. Clearing frees memory; they load again when needed.");
      setRow(g, { label: "Clear Media Cache", onClick: () => { mediaCache.clear(); storyThumbs.clear(); ctx.showToast("Media cache cleared"); } });
      setRow(g, { label: "Refresh Sticker List", onClick: async () => { stickerCatalog = null; await storage.set("ghostBitmojiCatalog", null); ctx.showToast("Sticker list will reload"); } });
      g = setGroup(body);
      setRow(g, { label: "Reset All Ghost Settings", danger: true, onClick: () => { prefs = Object.assign({}, PREF_DEFAULTS); storage.set("ghostPrefs", prefs); applyPrefs(ctx); ctx.showToast("Settings reset"); popSettingsPage(ctx); } });
    },
    about(ctx, body) {
      const hero = el("div", "gh-set-about");
      const logo = el("div", "gh-set-about-logo"); logo.appendChild(icon("ghost", 44));
      const nm = el("div", "gh-set-about-name"); nm.textContent = "Ghost";
      const v = el("div", "gh-set-about-ver"); v.textContent = "Messaging, reimagined.";
      hero.append(logo, nm, v);
      body.appendChild(hero);
      const g = setGroup(body, null, "Ghost is a personal project. It runs Snapchat Web underneath and sends everything through Snapchat's own code.");
      setRow(g, { label: "Reload", onClick: () => location.reload() });
    },
  };
  function refreshAllLists(ctx) { try { renderHomeList(ctx); renderStories(ctx); } catch (e) {} }

  // =====================================================================================================
  // Bitmoji stickers (the composer's smiley button). Catalog = Bitmoji's public sticker list (comic ids + tags, fetched
  // natively, cached a week); every sticker is drawn with YOUR Bitmoji (and, in a 1:1 chat, the friend's too) from
  // Snapchat's own render host, and sent as a real Bitmoji sticker message (bridge sendSticker).
  // =====================================================================================================
  const STICKER_CATALOG_URL = "https://api.bitmoji.com/content/templates";
  let stickerCatalog = null;
  async function loadStickerCatalog() {
    if (stickerCatalog) return stickerCatalog;
    const cached = await storage.get("ghostBitmojiCatalog", null);
    if (cached && cached.at && Date.now() - cached.at < 7 * 864e5 && Array.isArray(cached.solo) && cached.solo.length) return (stickerCatalog = cached);
    const bytes = await gmBytes(STICKER_CATALOG_URL);
    const json = JSON.parse(new TextDecoder().decode(bytes));
    const trim = (list) => (list || []).filter((x) => x && /^\d+$/.test(String(x.comic_id))).map((x) => [String(x.comic_id), ((x.tags || []).concat(x.alt_text || [])).join(" ").toLowerCase().slice(0, 240)]);
    stickerCatalog = { at: Date.now(), solo: trim(json.imoji), duo: trim(json.friends) };
    storage.set("ghostBitmojiCatalog", stickerCatalog);
    return stickerCatalog;
  }
  const stickerUrl = (comic, me, friend) => `https://cf-st.sc-cdn.net/3d/render/${[comic, me, friend].filter(Boolean).join("-")}-v1.webp?scale=1&ua=2`;
  function buildStickerSheet(ctx, overlaysRoot) {
    const backdrop = el("div", "gh-backdrop");
    const sheet = el("div", "gh-sheet gh-gif-sheet gh-sticker-sheet");
    sheet.style.display = "none"; // closed sheets are display:none (see closeSheetGeneric)
    sheet.innerHTML = `
      <div class="gh-sheet-grip"></div>
      <div class="gh-gif-search-row"><div class="gh-search"></div></div>
      <div class="gh-gif-tabs">
        <button class="gh-gif-tab" data-tab="recent">Recent</button>
        <button class="gh-gif-tab" data-tab="solo">Bitmoji</button>
        <button class="gh-gif-tab" data-tab="duo">With friend</button>
      </div>
      <div class="gh-gif-body gh-sticker-grid gh-scroll"></div>
    `;
    const searchWrap = sheet.querySelector(".gh-search");
    searchWrap.appendChild(icon("search", 16));
    const input = el("input");
    input.placeholder = "Search stickers";
    input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
    searchWrap.appendChild(input);
    overlaysRoot.append(backdrop, sheet);
    backdrop.addEventListener("click", () => closeSheetGeneric(backdrop, sheet));
    const s = { backdrop, sheet, input, body: sheet.querySelector(".gh-gif-body"), tabs: {}, tab: "solo", query: "", list: [], shown: 0 };
    for (const b of sheet.querySelectorAll(".gh-gif-tab")) {
      s.tabs[b.dataset.tab] = b;
      b.addEventListener("click", () => { haptic("light"); s.tab = b.dataset.tab; renderStickers(ctx, s); });
    }
    let t;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { s.query = input.value.trim().toLowerCase(); renderStickers(ctx, s); }, 200); });
    s.body.addEventListener("scroll", () => { if (s.body.scrollTop + s.body.clientHeight > s.body.scrollHeight - 400) moreStickers(ctx, s); }, { passive: true });
    return s;
  }
  function stickerPeople(ctx) {
    const me = ctx.state.me || {};
    const conv = ctx.state.convById.get(ctx.state.currentConvId) || {};
    const friend = !conv.isGroup && conv.participants && conv.participants[0];
    return { me: me.avatarId, friend: friend && friend.avatarId, friendName: friend && (friend.name || "").split(" ")[0] };
  }
  async function openStickerSheet(ctx) {
    haptic();
    const s = ctx.stickerSheet;
    let p = stickerPeople(ctx);
    if (!p.me) {
      // "me" arrives with the login event, often before Snapchat has loaded profiles - ask again now
      try { const st = await api.status(); if (st && st.me) ctx.state.me = st.me; } catch (e) {}
      p = stickerPeople(ctx);
    }
    if (!p.me) { ctx.showToast("Your Bitmoji hasn't loaded yet"); return; }
    s.tabs.duo.style.display = p.friend ? "" : "none";
    s.tabs.duo.textContent = p.friend ? "With " + p.friendName : "";
    s.query = ""; s.input.value = "";
    const recents = await storage.get("ghostStickerRecents", []);
    s.tab = recents.length ? "recent" : "solo";
    openSheetGeneric(s.backdrop, s.sheet);
    renderStickers(ctx, s);
  }
  async function renderStickers(ctx, s) {
    for (const [name, b] of Object.entries(s.tabs)) b.dataset.on = s.tab === name ? "1" : "0";
    s.body.innerHTML = "";
    s.body.scrollTop = 0;
    const p = stickerPeople(ctx);
    let list = [];
    if (s.tab === "recent") {
      list = (await storage.get("ghostStickerRecents", [])).filter((r) => !r.duo || p.friend).map((r) => [r.c, "", r.duo]);
      if (!list.length) { s.body.appendChild(Object.assign(el("div", "gh-gif-empty"), { textContent: "Stickers you send show up here" })); return; }
    } else {
      let cat;
      try { cat = await loadStickerCatalog(); }
      catch (e) { gtrail("sticker catalog failed " + (e && e.message || e)); s.body.appendChild(Object.assign(el("div", "gh-gif-empty"), { textContent: "Couldn't load stickers" })); return; }
      const duo = s.tab === "duo";
      list = (duo ? cat.duo : cat.solo).map((x) => [x[0], x[1], duo]);
    }
    if (s.query) list = list.filter((x) => x[1] && x[1].includes(s.query));
    s.list = list; s.shown = 0;
    if (!list.length) { s.body.appendChild(Object.assign(el("div", "gh-gif-empty"), { textContent: "No stickers found" })); return; }
    moreStickers(ctx, s);
  }
  function moreStickers(ctx, s) {
    if (s.shown >= s.list.length) return;
    const p = stickerPeople(ctx);
    const frag = document.createDocumentFragment();
    for (const [comic, , duo] of s.list.slice(s.shown, s.shown + 48)) {
      const tile = el("button", "gh-sticker-tile gh-press");
      tile.setAttribute("aria-label", "Send sticker");
      const img = el("img");
      img.loading = "lazy"; img.alt = "";
      img.src = stickerUrl(comic, p.me, duo ? p.friend : null);
      img.addEventListener("error", () => tile.remove(), { once: true }); // a few catalog stickers don't exist in 3D
      tile.appendChild(img);
      tile.addEventListener("click", () => sendStickerNow(ctx, s, comic, duo));
      frag.appendChild(tile);
    }
    s.shown += 48;
    s.body.appendChild(frag);
  }
  async function sendStickerNow(ctx, s, comic, duo) {
    const p = stickerPeople(ctx);
    const convId = ctx.state.currentConvId;
    if (!convId || !p.me) return;
    haptic();
    closeSheetGeneric(s.backdrop, s.sheet);
    try {
      await api.sendSticker(convId, { comicId: comic, myAvatarId: p.me, friendAvatarId: duo ? p.friend : undefined });
      const recents = await storage.get("ghostStickerRecents", []);
      await storage.set("ghostStickerRecents", [{ c: comic, duo: !!duo }, ...recents.filter((r) => !(r.c === comic && !!r.duo === !!duo))].slice(0, 48));
    } catch (e) {
      gtrail("sticker send failed " + (e && e.message || e));
      ctx.showToast("Couldn't send that sticker");
    }
  }

  function buildGifSheet(ctx, overlaysRoot) {
    const backdrop = el("div", "gh-backdrop");
    const sheet = el("div", "gh-sheet gh-gif-sheet");
    sheet.style.display = "none";
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
    input.setAttribute("aria-label", "Search GIPHY");
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
    if (!res || res.needKey) { // Ghost is its own app, so it has its own key store: ask for the key right here
      s.body.innerHTML = "";
      const n = el("div", "gh-gif-note");
      n.textContent = "GIFs need a free GIPHY API key once: developers.giphy.com \u2192 Create an App \u2192 API. Paste it here:";
      const input = document.createElement("input");
      input.className = "gh-gif-keyinput"; input.placeholder = "GIPHY API key"; input.setAttribute("aria-label", "GIPHY API key"); input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
      input.style.cssText = "display:block;width:calc(100% - 32px);margin:12px 16px;padding:12px 14px;border-radius:12px;border:0;background:rgba(255,255,255,.08);color:inherit;font:16px -apple-system,system-ui,sans-serif";
      const save = el("button", "gh-gif-keysave");
      save.textContent = "Save";
      save.style.cssText = "display:block;margin:0 16px;padding:11px 18px;border-radius:12px;border:0;background:#3e88f7;color:#fff;font:600 16px -apple-system,system-ui,sans-serif";
      const go = async () => { const k = input.value.trim(); if (!k) return; await storage.set("giphyKey", k); s.body.innerHTML = ""; s.seq++; loadGifGrid(ctx, s, s.seq, fetcher); };
      save.addEventListener("click", go);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      s.body.append(n, input, save);
      return;
    }
    if (res.error) { gtrail("search error " + res.error); s.body.innerHTML = ""; const n = el("div", "gh-gif-note"); n.textContent = res.error; s.body.appendChild(n); return; }
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
    const tile = el("div", "gh-gif-tile gh-press");
    tile.setAttribute("role", "button");
    tile.setAttribute("aria-label", "Send GIF");
    tile.style.aspectRatio = `${g.w} / ${g.h}`;
    const img = el("img");
    giphyPreviewUrl(g.id).then((r) => { if (r && r.dataUrl) img.src = r.dataUrl; });
    tile.appendChild(img);
    tile.addEventListener("click", async () => {
      haptic();
      const r = await giphyFileUrl(g.id);
      gtrail("picked " + g.id + (r && r.dataUrl ? " loaded " + r.dataUrl.length : " load failed " + (r && r.error)));
      if (!r || !r.dataUrl) { ctx.showToast("Couldn't load that GIF"); return; }
      const convId = ctx.state.currentConvId;
      const bin = atob(r.dataUrl.slice(r.dataUrl.indexOf(",") + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/gif" });
      try { await api.sendMedia(convId, blob, { kind: "gif" }); gtrail("sent " + g.id); } catch (e) { gtrail("send failed " + (e && e.message || e)); ctx.showToast("Couldn't send that GIF"); }
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
    const sheet = el("div", "gh-sheet", {}); sheet.style.display = "none";
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
    sheet.querySelector('[data-act="close"]').setAttribute("aria-label", "Close");
    const searchWrap = sheet.querySelector(".gh-newchat-search .gh-search");
    searchWrap.appendChild(icon("search", 16));
    const input = el("input");
    input.placeholder = "To:"; input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
    input.setAttribute("aria-label", "Search friends");
    searchWrap.appendChild(input);
    overlaysRoot.append(backdrop, sheet);
    backdrop.addEventListener("click", () => closeSheetGeneric(backdrop, sheet));
    const s = { backdrop, sheet, input, list: sheet.querySelector(".gh-friend-list"), createBtn: sheet.querySelector(".gh-newchat-create"), picked: new Map(), seq: 0 };
    sheet.querySelector('[data-act="close"]').addEventListener("click", () => { haptic("light"); closeSheetGeneric(backdrop, sheet); });
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
      <div class="gh-viewer-hint"><span class="gh-viewer-up"></span>Reply</div>
      <div class="gh-viewer-reply">
        <input type="text" placeholder="Send a chat" autocomplete="off" enterkeyhint="send">
        <button class="gh-viewer-reply-send gh-hit" aria-label="Send reply"></button>
      </div>
    `;
    wrap.querySelector(".gh-viewer-close").appendChild(icon("close", 20));
    wrap.querySelector(".gh-viewer-close").setAttribute("aria-label", "Close");
    const v = {
      el: wrap, bars: wrap.querySelector(".gh-viewer-bars"), media: wrap.querySelector(".gh-viewer-media"),
      nameEl: wrap.querySelector(".gh-viewer-top-name"), avatarSlot: wrap.querySelector(".gh-viewer-top"),
      items: [], idx: 0, timer: null, startedAt: 0, elapsedAtPause: 0, paused: false, single: false,
    };
    wrap.querySelector(".gh-viewer-close").addEventListener("click", () => { haptic("light"); closeViewer(ctx); });
    // a tap that ends a hold (or a swipe) must not also count as "next": swallow the click that follows
    let swallowClick = false;
    const zoneClick = (dir) => () => { if (swallowClick) { swallowClick = false; return; } if (v.replyOpen) { closeStoryReply(ctx); return; } viewerStep(ctx, dir); };
    wrap.querySelector('[data-z="prev"]').addEventListener("click", zoneClick(-1));
    wrap.querySelector('[data-z="next"]').addEventListener("click", zoneClick(1));

    v.reply = wrap.querySelector(".gh-viewer-reply");
    v.replyInput = v.reply.querySelector("input");
    v.hint = wrap.querySelector(".gh-viewer-hint");
    v.hint.querySelector(".gh-viewer-up").appendChild(icon("chevronDown", 16));
    const sendBtn = v.reply.querySelector(".gh-viewer-reply-send");
    sendBtn.appendChild(icon("send", 20));
    sendBtn.addEventListener("click", () => sendStoryReply(ctx));
    v.replyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendStoryReply(ctx); } });
    v.hint.addEventListener("click", () => openStoryReply(ctx));

    let holdTimer = null, startX = 0, startY = 0, mode = null, held = false;
    wrap.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1 || v.replyOpen) return;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY; mode = null; held = false;
      holdTimer = setTimeout(() => { held = true; pauseViewer(ctx, true); }, 200);
    }, { passive: true });
    wrap.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1 || v.replyOpen) return;
      const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
      if (!mode && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { mode = dy > 0 ? "down" : "up"; clearTimeout(holdTimer); }
      if (mode === "down") {
        wrap.style.transform = `translateY(${Math.max(0, dy)}px) scale(${clamp(1 - dy / 2000, 0.85, 1)})`;
        wrap.style.opacity = String(clamp(1 - dy / 500, 0.4, 1));
      } else if (mode === "up") {
        v.media.style.transform = `translateY(${Math.max(-60, dy / 3)}px)`;
      }
    }, { passive: true });
    const end = (e) => {
      clearTimeout(holdTimer);
      const t = e.changedTouches && e.changedTouches[0];
      const dy = t ? t.clientY - startY : 0;
      v.media.style.transform = "";
      if (mode === "down" && dy > 100) { swallowClick = true; closeViewer(ctx); return; }
      wrap.style.transform = ""; wrap.style.opacity = "";
      if (mode === "up" && dy < -50 && !v.single) { swallowClick = true; openStoryReply(ctx); return; }
      if (held || mode) { swallowClick = true; setTimeout(() => { swallowClick = false; }, 400); }
      if (held && v.paused && !v.replyOpen) pauseViewer(ctx, false);
      held = false; mode = null;
    };
    wrap.addEventListener("touchend", end, { passive: true });
    wrap.addEventListener("touchcancel", end, { passive: true });
    return v;
  }
  function openViewerSingle(ctx, mediaRef) {
    const v = ctx.viewer;
    v.story = null;
    v.single = true; v.items = [mediaRef]; v.idx = 0;
    v.el.dataset.open = "1"; v.bars.style.display = "none"; v.avatarSlot.style.display = "none";
    paintViewerItem(ctx);
  }
  function openViewerSequence(ctx, items, opts) {
    const v = ctx.viewer;
    if (!(opts && opts.keepStory)) v.story = null;
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
    // Open at once with a spinner: resolving + decrypting a whole story can take a couple of seconds, and
    // before this a tap looked like it did nothing.
    const v = ctx.viewer;
    const token = (v.loadToken = (v.loadToken || 0) + 1);
    clearTimeout(v.timer);
    v.single = true; v.items = [];
    v.el.dataset.open = "1"; v.bars.innerHTML = ""; v.avatarSlot.style.display = "flex";
    v.nameEl.textContent = (story.user && story.user.name) || "";
    v.media.innerHTML = "";
    v.media.appendChild(el("div", "gh-spinner gh-viewer-spinner"));
    api.openStory(story.user.id).then((res) => {
      if (v.loadToken !== token || v.el.dataset.open !== "1") return; // closed / another story while loading
      const items = (res && res.items) || [];
      if (!items.length) { closeViewer(ctx); ctx.showToast("That story isn't available right now"); return; }
      story.viewed = true;
      v.marked = new Set();
      v.story = story; // (set before the first paint so the first snap is counted too)
      openViewerSequence(ctx, items, { title: story.user.name, keepStory: true });
      v.el.dataset.story = "1";
    }).catch((e) => { gtrail("story open failed " + (e && e.message || e)); closeViewer(ctx); ctx.showToast("Couldn't open that story"); });
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
      // the bridge doesn't know a story video's length; once the file does, time the progress bar to it
      if (!ref.durationSec) video.addEventListener("loadedmetadata", () => {
        if (isFinite(video.duration) && video.duration > 0 && v.media.contains(video)) startViewerTimer(ctx, video.duration * 1000 + 300);
      }, { once: true });
    } else {
      const img = el("img");
      img.src = ref.url || (ref.blob && URL.createObjectURL(ref.blob)) || "";
      v.media.appendChild(img);
      startViewerTimer(ctx, 5000);
    }
    // a story snap counts as watched once it's on screen (receipt to the friend + grey ring here), like Snapchat
    if (v.story && ref.item != null) {
      v.marked = v.marked || new Set();
      if (!v.marked.has(ref.item)) { v.marked.add(ref.item); api.markStoryViewed(v.story.user.id, ref.item).then((r) => { if (r && r.ok === false) gtrail("story view " + r.reason); }).catch(() => {}); }
    }
    if (ref.overlay) { const ov = el("img", "gh-viewer-overlay"); ov.src = ref.overlay; ov.alt = ""; v.media.appendChild(ov); } // snap caption/drawing
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
    if (!!v.paused === !!pause) return; // already in that state: re-pausing would corrupt the elapsed time
    v.paused = pause;
    const video = v.media.querySelector("video");
    if (pause) {
      clearTimeout(v.timer);
      v.elapsedAtPause = nowMs() - v.startedAt;
      if (video) video.pause();
      if (!v.single) { // freeze the bar exactly where it is (it's a width transition, so pin the current width)
        const fill = v.bars.querySelectorAll(".gh-viewer-bar-fill")[v.idx];
        if (fill) { const w = fill.getBoundingClientRect().width, pw = fill.parentElement.getBoundingClientRect().width || 1; fill.style.transitionDuration = "0ms"; fill.style.width = (100 * w / pw) + "%"; }
      }
    } else {
      if (video) video.play().catch(() => {});
      const remaining = Math.max(200, (v.dur || 5000) - v.elapsedAtPause);
      v.startedAt = nowMs() - v.elapsedAtPause;
      v.timer = setTimeout(() => viewerStep(ctx, 1), remaining);
      if (!v.single) {
        const fill = v.bars.querySelectorAll(".gh-viewer-bar-fill")[v.idx];
        if (fill) requestAnimationFrame(() => { fill.style.transitionDuration = remaining + "ms"; fill.style.width = "100%"; });
      }
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
  function openStoryReply(ctx) {
    const v = ctx.viewer;
    if (v.single || !v.story) return;
    haptic("light");
    v.replyOpen = true;
    if (!v.paused) pauseViewer(ctx, true);
    v.el.dataset.reply = "1";
    v.replyInput.value = "";
    v.replyInput.placeholder = "Reply to " + ((v.story.user && v.story.user.name || "").split(" ")[0] || "story");
    v.replyInput.focus();
  }
  function closeStoryReply(ctx) {
    const v = ctx.viewer;
    if (!v.replyOpen) return;
    v.replyOpen = false;
    v.el.dataset.reply = "0";
    v.replyInput.blur();
    if (v.paused && v.el.dataset.open === "1") pauseViewer(ctx, false);
  }
  async function sendStoryReply(ctx) {
    const v = ctx.viewer;
    const text = v.replyInput.value.trim();
    if (!text || !v.story) return;
    const ref = v.items[v.idx] || {};
    haptic();
    v.replyInput.value = "";
    closeStoryReply(ctx);
    try { await api.replyToStory(v.story.user.id, ref.item || 0, text); ctx.showToast("Reply sent"); }
    catch (e) { gtrail("story reply failed " + (e && e.message || e)); ctx.showToast("Couldn't send your reply"); }
  }
  function closeViewer(ctx) {
    const v = ctx.viewer;
    if (v.snap) { const sn = v.snap; v.snap = null; api.closeSnap(sn.convId, sn.msgId).catch(() => {}); if (sn.onClose) sn.onClose(); }
    if (v.el.dataset.story === "1") setTimeout(() => refreshStories(ctx), 600); // ring goes grey right away
    v.el.dataset.story = "0";
    if (v.replyOpen) { v.replyOpen = false; v.el.dataset.reply = "0"; v.replyInput.blur(); }
    v.loadToken = (v.loadToken || 0) + 1;
    clearTimeout(v.timer);
    v.el.dataset.open = "0";
    v.el.style.transform = ""; v.el.style.opacity = "";
    v.media.innerHTML = "";
  }

  // =====================================================================================================
  // Camera (device required — see notes below)
  // =====================================================================================================
  // Snap camera: full-screen preview, tap = photo, hold = video (up to 60s, ring fills), double-tap = flip, library
  // button. Then a full-screen preview and a "Send To" sheet with search + multi-select (someone may already be
  // picked when the camera was opened from a chat or by double-tapping their row). Sends as a real Snap (bridge sendSnap).
  const MAX_VIDEO_MS = 60000;
  function buildCamera(ctx) {
    const wrap = el("div", "gh-camera");
    wrap.innerHTML = `
      <div class="gh-cam-live"><div class="gh-camera-note">Starting camera…</div></div>
      <div class="gh-camera-top">
        <button class="gh-cam-btn gh-hit" data-act="close"></button>
        <div class="gh-cam-to"></div>
        <button class="gh-cam-btn gh-hit" data-act="flip"></button>
      </div>
      <div class="gh-camera-bottom">
        <button class="gh-cam-btn gh-cam-lib gh-hit" data-act="library"></button>
        <button class="gh-shutter" aria-label="Take photo, hold for video">
          <svg class="gh-shutter-ring" viewBox="0 0 88 88"><circle cx="44" cy="44" r="40"/></svg>
        </button>
        <div class="gh-cam-spacer"></div>
      </div>
      <input type="file" accept="image/*,video/*" hidden>
      <div class="gh-cam-review">
        <div class="gh-cam-review-media"></div>
        <div class="gh-camera-top"><button class="gh-cam-btn gh-hit" data-act="retake"></button></div>
        <div class="gh-cam-review-bottom"><button class="gh-cam-sendto" data-act="sendto"><span>Send To</span></button></div>
      </div>
      <div class="gh-cam-picker">
        <div class="gh-cam-picker-head">
          <button class="gh-cam-picker-back gh-hit" data-act="picker-back"></button>
          <div class="gh-cam-picker-title">Send To</div>
          <div style="width:44px"></div>
        </div>
        <div class="gh-cam-search"><input type="search" placeholder="Search" autocapitalize="off" autocomplete="off" spellcheck="false"></div>
        <div class="gh-cam-list gh-scroll"></div>
        <div class="gh-cam-sendbar">
          <div class="gh-cam-chosen"></div>
          <button class="gh-cam-send" data-act="send" aria-label="Send"></button>
        </div>
      </div>
    `;
    const q = (sel) => wrap.querySelector(sel);
    q('[data-act="close"]').appendChild(icon("close", 22)); q('[data-act="close"]').setAttribute("aria-label", "Close camera");
    q('[data-act="flip"]').appendChild(icon("flip", 22)); q('[data-act="flip"]').setAttribute("aria-label", "Flip camera");
    q('[data-act="library"]').appendChild(icon("gallery", 22)); q('[data-act="library"]').setAttribute("aria-label", "Choose from library");
    q('[data-act="retake"]').appendChild(icon("close", 22)); q('[data-act="retake"]').setAttribute("aria-label", "Discard");
    q('[data-act="sendto"]').appendChild(icon("send", 18));
    q('[data-act="picker-back"]').appendChild(icon("back", 22)); q('[data-act="picker-back"]').setAttribute("aria-label", "Back");
    q('[data-act="send"]').appendChild(icon("send", 22));

    const c = {
      el: wrap, live: q(".gh-cam-live"), shutter: q(".gh-shutter"), ring: q(".gh-shutter-ring circle"), toEl: q(".gh-cam-to"),
      review: q(".gh-cam-review"), reviewMedia: q(".gh-cam-review-media"), picker: q(".gh-cam-picker"), list: q(".gh-cam-list"),
      search: q(".gh-cam-search input"), chosen: q(".gh-cam-chosen"), sendBtn: q('[data-act="send"]'), file: q('input[type="file"]'),
      stream: null, video: null, facing: "user", recording: false, recorder: null, chunks: [], recStart: 0, recTimer: null,
      captured: null, picked: new Set(), preselect: null, sending: false,
    };
    q('[data-act="close"]').addEventListener("click", () => { haptic("light"); closeCamera(ctx); });
    q('[data-act="flip"]').addEventListener("click", () => flipCamera(ctx));
    q('[data-act="library"]').addEventListener("click", () => { haptic("light"); c.file.click(); });
    c.file.addEventListener("change", () => {
      const f = c.file.files && c.file.files[0];
      c.file.value = "";
      if (f) openReview(ctx, f, f.type.startsWith("video") ? "video" : "image", false);
    });
    q('[data-act="retake"]').addEventListener("click", () => { haptic("light"); closeReview(ctx); startCameraStream(ctx); });
    q('[data-act="sendto"]').addEventListener("click", () => { haptic(); openPicker(ctx); });
    q('[data-act="picker-back"]').addEventListener("click", () => { haptic("light"); c.picker.dataset.open = "0"; });
    q('[data-act="send"]').addEventListener("click", () => sendSnapNow(ctx));
    c.search.addEventListener("input", () => renderPicker(ctx));

    // double-tap the preview to flip, like Snapchat
    let lastTap = 0;
    c.live.addEventListener("click", () => { const t = nowMs(); if (t - lastTap < 300) { flipCamera(ctx); lastTap = 0; } else lastTap = t; });

    let pressTimer = null, pressed = false;
    const down = (e) => { e.preventDefault(); pressed = true; pressTimer = setTimeout(() => { if (pressed) startRecording(ctx); }, 300); };
    const up = () => {
      if (!pressed) return;
      pressed = false;
      clearTimeout(pressTimer);
      if (c.recording) stopRecording(ctx); else takePhoto(ctx);
    };
    c.shutter.addEventListener("touchstart", down, { passive: false });
    c.shutter.addEventListener("touchend", up);
    c.shutter.addEventListener("touchcancel", up);
    c.shutter.addEventListener("mousedown", down);
    c.shutter.addEventListener("mouseup", up);
    return c;
  }
  function openCamera(ctx, opts) {
    const c = ctx.camera;
    haptic();
    c.preselect = (opts && opts.to) || null;
    const conv = c.preselect && ctx.state.convById.get(c.preselect);
    c.toEl.textContent = conv ? conv.title : "";
    c.toEl.style.display = conv ? "" : "none";
    closeReview(ctx);
    c.el.dataset.open = "1";
    requestAnimationFrame(() => { c.el.dataset.shown = "1"; });
    startCameraStream(ctx);
  }
  function closeCamera(ctx) {
    const c = ctx.camera;
    if (c.recording) { try { c.recorder.stop(); } catch (e) {} c.recording = false; }
    c.el.dataset.shown = "0";
    stopCameraStream(ctx);
    setTimeout(() => { if (c.el.dataset.shown !== "1") { c.el.dataset.open = "0"; closeReview(ctx); } }, 280);
  }
  async function startCameraStream(ctx) {
    const c = ctx.camera;
    stopCameraStream(ctx);
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { c.live.innerHTML = '<div class="gh-camera-note">No camera here</div>'; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: c.facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: c.facing }, audio: false }));
      if (ctx.camera.el.dataset.open !== "1") { stream.getTracks().forEach((t) => t.stop()); return; }
      c.stream = stream;
      c.live.innerHTML = "";
      const video = el("video");
      video.autoplay = true; video.playsInline = true; video.muted = true;
      video.srcObject = stream;
      video.dataset.mirror = c.facing === "user" ? "1" : "0";
      c.live.appendChild(video);
      c.video = video;
    } catch (e) {
      gtrail("camera failed " + (e && (e.name || e.message)));
      c.live.innerHTML = '<div class="gh-camera-note">Camera unavailable. Allow camera access for Ghost in Settings.</div>';
    }
  }
  function stopCameraStream(ctx) {
    const c = ctx.camera;
    if (c.stream) { c.stream.getTracks().forEach((t) => t.stop()); c.stream = null; }
    c.video = null;
  }
  function flipCamera(ctx) {
    haptic("light");
    const c = ctx.camera;
    if (c.recording) return;
    c.facing = c.facing === "user" ? "environment" : "user";
    startCameraStream(ctx);
  }
  function takePhoto(ctx) {
    const c = ctx.camera;
    haptic("medium");
    const v = c.video;
    if (!v || !v.videoWidth) { ctx.showToast("Camera isn't ready yet"); return; }
    // what you saw is what you send: crop the frame to the screen's shape (like the live preview), mirror selfies
    const W = v.videoWidth, H = v.videoHeight, target = c.live.clientWidth / Math.max(1, c.live.clientHeight);
    let sw = W, sh = H;
    if (W / H > target) sw = Math.round(H * target); else sh = Math.round(W / target);
    const canvas = document.createElement("canvas");
    canvas.width = sw; canvas.height = sh;
    const g = canvas.getContext("2d");
    if (c.facing === "user") { g.translate(sw, 0); g.scale(-1, 1); }
    g.drawImage(v, (W - sw) / 2, (H - sh) / 2, sw, sh, 0, 0, sw, sh);
    c.el.classList.add("gh-cam-flash");
    setTimeout(() => c.el.classList.remove("gh-cam-flash"), 160);
    canvas.toBlob((blob) => { if (blob) openReview(ctx, blob, "image", true, { width: sw, height: sh }); }, "image/jpeg", 0.9);
  }
  function startRecording(ctx) {
    const c = ctx.camera;
    if (!c.stream || typeof MediaRecorder === "undefined") { ctx.showToast("Video isn't available here"); return; }
    haptic("medium");
    c.chunks = [];
    try {
      const type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm"].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
      c.recorder = type ? new MediaRecorder(c.stream, { mimeType: type }) : new MediaRecorder(c.stream);
      const mime = (c.recorder.mimeType || type || "video/mp4").split(";")[0];
      const dims = { width: c.video ? c.video.videoWidth : 1080, height: c.video ? c.video.videoHeight : 1920, hasAudio: c.stream.getAudioTracks().length > 0 };
      c.recorder.ondataavailable = (e) => { if (e.data && e.data.size) c.chunks.push(e.data); };
      c.recorder.onstop = () => {
        const blob = new Blob(c.chunks, { type: mime });
        if (nowMs() - c.recStart < 500 || !blob.size) { takePhotoFallback(ctx); return; }
        openReview(ctx, blob, "video", true, dims);
      };
      c.recorder.start(250);
      c.recording = true; c.recStart = nowMs();
      c.shutter.dataset.recording = "1";
      const tick = () => {
        if (!c.recording) return;
        const p = Math.min(1, (nowMs() - c.recStart) / MAX_VIDEO_MS);
        c.ring.style.strokeDashoffset = String(251.3 * (1 - p));
        if (p >= 1) { stopRecording(ctx); return; }
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { c.recording = false; gtrail("recorder failed " + (e && e.message)); ctx.showToast("Couldn't start recording"); }
  }
  function takePhotoFallback(ctx) { startCameraStream(ctx).then(() => {}); } // a hold that ended almost at once
  function stopRecording(ctx) {
    const c = ctx.camera;
    c.shutter.dataset.recording = "0";
    c.ring.style.strokeDashoffset = "";
    if (c.recording && c.recorder) { c.recording = false; haptic("light"); try { c.recorder.stop(); } catch (e) {} }
  }
  function openReview(ctx, blob, kind, fromCamera, dims) {
    const c = ctx.camera;
    c.captured = { blob, kind, width: dims && dims.width, height: dims && dims.height, hasAudio: dims ? dims.hasAudio !== false : true };
    stopCameraStream(ctx);
    c.reviewMedia.innerHTML = "";
    const url = URL.createObjectURL(blob);
    c.captured.url = url;
    const media = kind === "video" ? el("video") : el("img");
    media.src = url;
    if (kind === "video") {
      media.autoplay = true; media.loop = true; media.playsInline = true; media.muted = false;
      media.addEventListener("loadedmetadata", () => { if (!c.captured.width) { c.captured.width = media.videoWidth; c.captured.height = media.videoHeight; } }, { once: true });
      media.play().catch(() => { media.muted = true; media.play().catch(() => {}); });
    } else if (!c.captured.width) {
      media.addEventListener("load", () => { c.captured.width = media.naturalWidth; c.captured.height = media.naturalHeight; }, { once: true });
    }
    c.reviewMedia.appendChild(media);
    c.review.dataset.open = "1";
    c.picked = new Set(c.preselect ? [c.preselect] : []);
  }
  function closeReview(ctx) {
    const c = ctx.camera;
    c.review.dataset.open = "0";
    c.picker.dataset.open = "0";
    const v = c.reviewMedia.querySelector("video"); if (v) v.pause();
    c.reviewMedia.innerHTML = "";
    if (c.captured && c.captured.url) URL.revokeObjectURL(c.captured.url);
    c.captured = null;
  }
  function openPicker(ctx) {
    const c = ctx.camera;
    c.search.value = "";
    renderPicker(ctx);
    c.picker.dataset.open = "1";
  }
  function renderPicker(ctx) {
    const c = ctx.camera;
    const qv = c.search.value.trim().toLowerCase();
    c.list.innerHTML = "";
    const all = ctx.state.conversations.filter((conv) => !qv || (conv.title || "").toLowerCase().includes(qv));
    // picked first, then most recent
    const rows = [...all.filter((x) => c.picked.has(x.id)), ...all.filter((x) => !c.picked.has(x.id))].slice(0, qv ? 80 : 60);
    const head = el("div", "gh-cam-section"); head.textContent = qv ? "Results" : "Recents"; c.list.appendChild(head);
    for (const conv of rows) {
      const row = el("div", "gh-friend-row gh-press");
      row.dataset.picked = c.picked.has(conv.id) ? "1" : "0";
      const avatarUser = conv.isGroup ? { name: conv.title } : (conv.participants && conv.participants[0]) || { name: conv.title };
      row.appendChild(makeAvatar(avatarUser, 44));
      const name = el("div", "gh-friend-name"); name.textContent = conv.title;
      const check = el("div", "gh-friend-check"); check.appendChild(icon("check", 14));
      row.append(name, check);
      row.addEventListener("click", () => {
        haptic("light");
        if (c.picked.has(conv.id)) c.picked.delete(conv.id); else c.picked.add(conv.id);
        row.dataset.picked = c.picked.has(conv.id) ? "1" : "0";
        paintChosen(ctx);
      });
      c.list.appendChild(row);
    }
    paintChosen(ctx);
  }
  function paintChosen(ctx) {
    const c = ctx.camera;
    const names = [...c.picked].map((id) => (ctx.state.convById.get(id) || {}).title || "").filter(Boolean);
    c.chosen.textContent = names.length ? names.join(", ") : "Pick friends";
    c.sendBtn.disabled = !names.length || c.sending;
    c.picker.dataset.has = names.length ? "1" : "0";
  }
  async function sendSnapNow(ctx) {
    const c = ctx.camera;
    if (!c.picked.size || !c.captured || c.sending) return;
    haptic();
    c.sending = true; c.sendBtn.dataset.sending = "1"; paintChosen(ctx);
    const cap = c.captured, ids = Array.from(c.picked);
    try {
      await api.sendSnap(ids, cap.blob, { kind: cap.kind, width: cap.width, height: cap.height, hasAudio: cap.hasAudio });
      haptic("success");
      closeCamera(ctx);
      ctx.showToast(ids.length > 1 ? `Snap sent to ${ids.length} chats` : "Snap sent");
    } catch (e) {
      gtrail("snap send failed " + (e && e.message || e));
      ctx.showToast("Couldn't send that Snap");
    } finally { c.sending = false; c.sendBtn.dataset.sending = "0"; paintChosen(ctx); }
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
        // swiping a row open: show THAT person's chat under your finger (it still showed the last chat you had open)
        if (g.kind === "open" && g.rowId) peekConversation(ctx, g.rowId);
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
          stopVoice();
          syncPresence(ctx);
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
