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
    addFriend: '<circle cx="10" cy="8" r="4"/><path d="M3 20c.8-3.6 3.6-6 7-6s6.2 2.4 7 6"/><path d="M19 8v6M16 11h6"/>',
    bookmark: '<path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/>',
    person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20c.8-3.6 3.9-6 7.5-6s6.7 2.4 7.5 6"/>',
    flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 01-10 0c0-2 1-3.5 2-4.5.3 1.6 1.2 2.5 2 2.5-.6-2.8 0-5.5 1-8z"/>',
    pin: '<path d="M9 4h6l-1 6 3 3H7l3-3-1-6z"/><path d="M12 13v7"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A9.8 9.8 0 0112 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.4 3.5M6.3 6.3C4.3 7.6 2.9 9.6 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.5 4.8-1.3"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>',
    download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>',
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
    camera: '<path d="M3 8.6A2.6 2.6 0 015.6 6h1.9l1.3-1.8A1.6 1.6 0 0110.1 3.5h3.8a1.6 1.6 0 011.3.7L16.5 6h1.9A2.6 2.6 0 0121 8.6v9.3a2.6 2.6 0 01-2.6 2.6H5.6A2.6 2.6 0 013 17.9z"/><circle cx="12" cy="12.9" r="3.9"/>',
    gifBadge: '<rect x="2" y="6" width="20" height="12" rx="3"/><text x="12" y="15" font-size="8" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">GIF</text>',
    emoji: '<circle cx="12" cy="12" r="9"/><path d="M8.5 10.5h.01M15.5 10.5h.01"/><path d="M8.5 14.5s1.2 2 3.5 2 3.5-2 3.5-2"/>',
    mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M9 21h6"/>',
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
    callEnd: '<path d="M3.6 13.6c4.6-4.1 12.2-4.1 16.8 0 .6.5.6 1.4.1 2l-1.4 1.6c-.5.5-1.3.6-1.9.2l-2.1-1.4c-.5-.3-.7-.9-.6-1.5l.3-1.4a11.4 11.4 0 00-5.6 0l.3 1.4c.1.6-.1 1.2-.6 1.5l-2.1 1.4c-.6.4-1.4.3-1.9-.2l-1.4-1.6c-.5-.6-.5-1.5.1-2z" fill="currentColor"/>',
    pip: '<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/>',
    speakerIc: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/>',
    attach: '<path d="M20.5 11.5L12 20a5 5 0 01-7-7l8.5-8.5a3.5 3.5 0 015 5L10 18a2 2 0 01-3-3l7-7"/>',
    compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    chatsTab: '<path d="M21 12a8 8 0 01-11.8 7L4 20l1.2-4.8A8 8 0 1121 12z"/>',
    storiesTab: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/>',
    settingsTab: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
    gallery: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5.5-5.5L6 19"/>',
    textTool: '<path d="M4 6.5h16"/><path d="M12 6.5V19"/><path d="M9 19h6"/>',
    undo: '<path d="M4 11h9a5.5 5.5 0 010 11h-3.5"/><path d="M8 6.5L3.5 11 8 15.5"/>',
    flash: '<path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="currentColor" stroke="none"/>',
    timerIcon: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/>',
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
        if (msg.ok) p.resolve(nickify(msg.result));
        else p.reject(new Error(typeof msg.error === "string" ? msg.error : (msg.error && msg.error.message) || "ghost bridge error"));
      } else if (msg.ghost === "event") {
        const set = listeners.get(msg.type);
        if (set) { const data = nickify(msg.data); for (const fn of Array.from(set)) { try { fn(data); } catch (err) { /* one bad listener shouldn't break others */ } } }
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
    stickerContent: (id, msgId) => bridge.call("stickerContent", [id, msgId]),
    sendStickerRaw: (id, content, type) => bridge.call("sendStickerRaw", [id, content, type], 30000),
    sendVoiceNote: (id, blob) => bridge.call("sendVoiceNote", [id, blob], 120000),
    sendMedia: (id, blob, opts) => bridge.call("sendMedia", [id, blob, opts || {}], 120000), // uploads can be slow on cellular
    sendSnap: (ids, blob, opts) => bridge.call("sendSnap", [ids, blob, opts || {}], 120000),
    react: (id, messageId, emoji) => bridge.call("react", [id, messageId, emoji]),
    shareInfo: (id, messageId) => bridge.call("shareInfo", [id, messageId], 30000),
    loadShare: (id, messageId) => bridge.call("loadShare", [id, messageId], 60000),
    deleteMessage: (id, messageId) => bridge.call("deleteMessage", [id, messageId]),
    saveMessage: (id, messageId, saved) => bridge.call("saveMessage", [id, messageId, saved]),
    openSnap: (id, messageId) => bridge.call("openSnap", [id, messageId], 45000),
    closeSnap: (id, messageId) => bridge.call("closeSnap", [id, messageId]),
    listStories: () => bridge.call("listStories"),
    openStory: (userId) => bridge.call("openStory", [userId]),
    setChatNotifications: (id, p) => bridge.call("setChatNotifications", [id, p]),
    setRetention: (id, m) => bridge.call("setRetention", [id, m]),
    chatSettings: (id) => bridge.call("chatSettings", [id]),
    clearChat: (id) => bridge.call("clearChat", [id]),
    renameGroup: (id, t) => bridge.call("renameGroup", [id, t]),
    addToGroup: (id, users) => bridge.call("addToGroup", [id, users]),
    leaveGroup: (id) => bridge.call("leaveGroup", [id]),
    createGroup: (users, t) => bridge.call("createGroup", [users, t], 30000),
    replaySnap: (id, msgId) => bridge.call("replaySnap", [id, msgId], 45000),
    newConversation: (userIds) => bridge.call("newConversation", [userIds]),
    chatColors: (convId) => bridge.call("chatColors", [convId]),
    releaseMedia: (convId) => bridge.call("releaseMedia", [convId]),
    retentionStatus: () => bridge.call("retentionStatus"),
    configureRetention: (on) => bridge.call("configureRetention", [on]),
    clearRetainedMessages: () => bridge.call("clearRetainedMessages"),
    searchFriends: (q) => bridge.call("searchFriends", [q]),
    findUsers: (q) => bridge.call("findUsers", [q]),
    friendRequests: () => bridge.call("friendRequests"),
    addFriend: (id) => bridge.call("addFriend", [id]),
    ignoreFriend: (id) => bridge.call("ignoreFriend", [id]),
    removeFriend: (id) => bridge.call("removeFriend", [id]),
    blockFriend: (id) => bridge.call("blockFriend", [id]),
    setNickname: (id, name) => bridge.call("setNickname", [id, name]),
    debugShape: () => bridge.call("debugShape"),
    loadMedia: (convId, msgId) => bridge.call("loadMedia", [convId, msgId]),
    markStoryViewed: (userId, item) => bridge.call("markStoryViewed", [userId, item]),
    storyThumb: (userId) => bridge.call("storyThumb", [userId], 30000),
    replyToStory: (userId, item, text) => bridge.call("replyToStory", [userId, item, text], 30000),
    setPresence: (convId) => bridge.call("setPresence", [convId]),
    sendTyping: (id) => bridge.call("sendTyping", [id]),
    setReadReceipts: (on) => bridge.call("setReadReceipts", [on]),
    startCall: (id, video) => bridge.call("startCall", [id, video], 30000),
    answerCall: (id, video) => bridge.call("answerCall", [id, video], 30000),
    endCall: (id) => bridge.call("endCall", [id]),
    setMicOn: (on) => bridge.call("setMicOn", [on]),
    setCameraOn: (id, on) => bridge.call("setCameraOn", [id, on]),
    flipCamera: () => bridge.call("flipCamera"),
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
  // Tenor (the default GIF source since 2026-09-27). Tenor's public API was shut down on 2026-06-30, but tenor.com's
  // own pages still carry their results as JSON in <script id="store-cache"> (search: universal.search[*].results,
  // home page: gifs.featured.results), each with Tenor's media_formats (tinywebp, mediumgif, gif, mp4...). Fetched
  // through the app's native fetch (tenor.com / *.tenor.com allowed) - if Tenor changes its site, this is the part
  // to update.
  const tenorCache = new Map();
  function tenorItem(r) {
    const f = (r && r.media_formats) || {};
    const pv = f.tinywebp || f.tinygif || f.webp || f.gifpreview;
    const small = (x) => x && x.url && (!x.size || x.size < 4e6);
    const file = small(f.mediumgif) ? f.mediumgif : small(f.gif) ? f.gif : f.tinygif;
    const dims = (pv && pv.dims) || (file && file.dims) || [200, 200];
    const mp4 = f.tinymp4 || f.mp4;
    return pv && file && r.id ? { src: "tenor", id: String(r.id), w: dims[0] || 200, h: dims[1] || 200, p: pv.url, f: file.url, v: mp4 && mp4.url } : null;
  }
  async function tenorSearch(q) {
    if (typeof window.__ghostGiphyMock === "function") return window.__ghostGiphyMock("search", { q, offset: 0 });
    const key = (q || "").toLowerCase().trim();
    const hit = tenorCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.res;
    const slug = key.split(/\s+/).filter(Boolean).map(encodeURIComponent).join("-");
    const url = key ? "https://tenor.com/search/" + slug + "-gifs" : "https://tenor.com/";
    let data;
    try {
      const html = new TextDecoder().decode(await gmBytes(url));
      const m = /<script[^>]*id="store-cache"[^>]*>([\s\S]*?)<\/script>/.exec(html);
      if (!m) throw new Error("Tenor changed its page (no results data)");
      data = JSON.parse(m[1]);
    } catch (e) { return { error: "Couldn't reach Tenor - " + String(e && e.message || e), retryable: true }; }
    let raw = [];
    if (key) { const sr = (data.universal && data.universal.search) || {}; for (const v of Object.values(sr)) if (v && Array.isArray(v.results)) { raw = v.results; break; } }
    else raw = (data.gifs && data.gifs.featured && data.gifs.featured.results) || [];
    const seen = new Set();
    const results = raw.map(tenorItem).filter((g) => g && !seen.has(g.id) && seen.add(g.id));
    const res = { results };
    if (results.length) tenorCache.set(key, { at: Date.now(), res });
    return res;
  }
  // preview/file for any saved GIF entry: Tenor ones carry their URLs, older GIPHY ones only an id
  async function gifPreviewFor(g) {
    if (g && g.src === "tenor" && typeof window.__ghostGiphyMock !== "function") {
      try { return { dataUrl: bytesToDataUrl(await gmBytes(g.p), /\.gif(\?|$)/.test(g.p) ? "image/gif" : "image/webp") }; } catch (e) { return { error: String(e && e.message || e) }; }
    }
    return giphyPreviewUrl(g.id);
  }
  async function gifFileFor(g) {
    if (g && g.src === "tenor" && typeof window.__ghostGiphyMock !== "function") {
      try { return { dataUrl: bytesToDataUrl(await gmBytes(g.f), "image/gif") }; } catch (e) { return { error: String(e && e.message || e) }; }
    }
    return giphyFileUrl(g.id);
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

  // finger distances (zoomed page px) -> distances inside the host (its own CSS px): multiply by this, or things
  // dragged under a finger move 25% further than the finger does (host zoom = 1 / __ghostScale)
  function pagePxToLocal() { return (typeof window.__ghostScale === "number" && window.__ghostScale > 0) ? window.__ghostScale : 1; }
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
    ctx.chatSheet = buildChatSheet(ctx, overlays);
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
    ctx.callScreen = buildCallScreen(ctx);
    root.appendChild(ctx.callScreen.el);
    ctx.callBar = el("button", "gh-call-bar");
    ctx.callBar.innerHTML = '<span class="gh-call-bar-dot"></span><span class="gh-call-bar-text"></span><span class="gh-call-bar-hint">Tap to return</span>';
    ctx.callBar.addEventListener("click", () => { haptic("light"); ctx.callScreen.el.dataset.open = "1"; updateCallBar(ctx); });
    root.appendChild(ctx.callBar);
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
      state.ready = true;
      // iOS killed the page (memory) and the app reloaded it: go straight back into the chat you were in
      storage.get("ghostResume", "").then(async (flag) => {
        if (String(flag) !== "1") return;
        await storage.set("ghostResume", "");
        const last = await storage.get("ghostLastConv", "");
        uiTrail("resume after reload -> " + (last ? "last chat" : "home"));
        if (last && state.convById.has(last)) setTimeout(() => openConversationScreen(ctx, last), 300);
      }).catch(() => {});
      startStreakKeeper(ctx);
      api.friendRequests().then((r) => { ctx.friendReqCount = (r || []).length; }).catch(() => {});
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
    bridge.on("calls", (data) => { applyCalls(ctx, data); });
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
    ctx.makeAvatar = makeAvatar; // (test harness)
    ctx._wallTest = async (file, fit) => { await saveWallPhoto("chat:" + ctx.state.currentConvId, file); setChatWall(ctx, ctx.state.currentConvId, { kind: "photo", dim: 0.2, fit }); }; // (test harness)
    document.addEventListener("visibilitychange", () => syncPresence(ctx));
    // double-tap a chat row: the first tap already opened the chat, so the second one lands on the chat screen
    // sliding in - catch it here (capture phase, before anything in the chat reacts) and open the camera for them
    // On the phone iOS often never turns that quick second tap into a click (it's still busy with the first one /
    // the screen sliding in), so the second tap is caught on touchend too - whichever comes first wins.
    const secondTap = (e) => {
      const rt = ctx.state.rowTap;
      if (!rt || nowMs() - rt.t > 420 || !pref("doubleTapCamera")) return;
      // only a second tap on the same row, or on the chat screen that row just opened - never another row/tab
      if (!(rt.row.contains(e.target) || (e.target.closest && e.target.closest(".gh-screen") === ctx.conv.screen))) { ctx.state.rowTap = null; return; }
      ctx.state.rowTap = null;
      e.stopPropagation(); if (e.cancelable) e.preventDefault();
      haptic("light");
      openCamera(ctx, { to: rt.id });
    };
    root.addEventListener("touchend", (e) => { if (e.changedTouches && e.changedTouches.length === 1) secondTap(e); }, true);
    root.addEventListener("click", secondTap, true);
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
    const sig = (list) => list.map((m) => m.id + ":" + (m.reactions ? m.reactions.length : 0) + ":" + (m.saved ? 1 : 0) + (m.opened ? 1 : 0) + ":" + (m.text || "").length + ":" + (m.seenBy ? m.seenBy.length : 0) + ":" + !!m.retained + ":" + !!m.retainedMedia).join("|");
    if (prev && sig(prev.messages) === sig(entry.messages) && prev.hasMore === entry.hasMore) return;
    const prevLast = prev && prev.messages.length ? prev.messages[prev.messages.length - 1].id : null;
    const newLast = entry.messages.length ? entry.messages[entry.messages.length - 1].id : null;
    const arrived = !prev || (newLast !== prevLast && entry.messages.length >= prev.messages.length);
    // while fetchOlderPages is shifting the window (search, gallery, bookmark jumps), don't repaint underneath it:
    // it repaints once when it's done
    if (ctx.conv._quietLoad) { ctx.conv._missedUpdate = true; return; }
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

    screen.querySelector(".gh-edit-btn").addEventListener("click", () => { haptic(); ctx.showToast("Hold a chat to pin or hide it"); });
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

  // chats: a person's avatar for 1:1, a group gets its members' Bitmojis side by side (like Snapchat Web)
  function convAvatarUser(conv) {
    if (!conv) return { name: "?" };
    if (conv.isGroup) return { name: conv.title, convId: conv.id, members: conv.participants || [], avatarUrl: conv.avatarUrl };
    return (conv.participants && conv.participants[0]) || { name: conv.title };
  }
  function avatarSig(conv) {
    const u = convAvatarUser(conv);
    return [pref("avatars"), u.convId && customAvatarUrls.get("conv:" + u.convId), u.id && customAvatarUrls.get("user:" + u.id), u.bitmojiUrl,
      (u.members || []).slice(0, 3).map((m) => m.bitmojiUrl || "").join(",")].join("|");
  }
  const customAvatarUrls = new Map(); // "user:<id>" / "conv:<id>" -> object URL of your chosen photo
  async function loadCustomAvatars() {
    for (const key of Object.keys(pref("customAvatars") || {})) {
      if (customAvatarUrls.has(key)) continue;
      const blob = await wallDB.get("avatar:" + key).catch(() => null);
      if (blob) customAvatarUrls.set(key, URL.createObjectURL(blob));
    }
  }
  async function saveCustomAvatar(ctx, key, file) {
    const d = await decodePhoto(file);
    try {
      const side = Math.min(d.w, d.h), out = 480;
      const c = document.createElement("canvas"); c.width = out; c.height = out;
      c.getContext("2d").drawImage(d.src, (d.w - side) / 2, (d.h - side) / 2, side, side, 0, 0, out, out);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.88));
      if (!blob) throw new Error("bad photo");
      await wallDB.put("avatar:" + key, blob);
      const old = customAvatarUrls.get(key); if (old) URL.revokeObjectURL(old);
      customAvatarUrls.set(key, URL.createObjectURL(blob));
      setPref(ctx, "customAvatars", Object.assign({}, pref("customAvatars") || {}, { [key]: true }));
    } finally { if (d.url) URL.revokeObjectURL(d.url); if (d.src && d.src.close) d.src.close(); }
    refreshAvatars(ctx);
  }
  async function clearCustomAvatar(ctx, key) {
    await wallDB.del("avatar:" + key);
    const old = customAvatarUrls.get(key); if (old) URL.revokeObjectURL(old);
    customAvatarUrls.delete(key);
    const all = Object.assign({}, pref("customAvatars") || {}); delete all[key];
    setPref(ctx, "customAvatars", all);
    refreshAvatars(ctx);
  }
  function refreshAvatars(ctx) {
    try { renderHomeList(ctx); } catch (e) {}
    const cd = ctx.state.currentConvId && ctx.state.convById.get(ctx.state.currentConvId);
    if (cd) updateConvHeader(ctx, cd);
    try { renderStories(ctx); } catch (e) {}
  }
  function groupAvatarEl(user, size) {
    const box = el("div", "gh-avatar gh-avatar-group");
    box.style.width = size + "px"; box.style.height = size + "px";
    const name = user.name || "?";
    const [c1, c2] = gradientFor({ id: user.convId }, name);
    box.style.background = `radial-gradient(circle at 50% 30%, rgba(255,255,255,0.22), rgba(255,255,255,0) 62%), linear-gradient(160deg, ${c1}, ${c2})`;
    const faces = (user.members || []).filter((m) => m && m.bitmojiUrl).slice(0, 3);
    box.dataset.n = String(faces.length);
    faces.forEach((m, i) => {
      const img = el("img", "gh-avatar-face");
      img.alt = ""; img.loading = "lazy"; img.dataset.i = String(i);
      img.addEventListener("error", () => img.remove(), { once: true });
      img.src = m.bitmojiUrl;
      box.appendChild(img);
    });
    return box;
  }
  function makeAvatar(user, size) {
    const custom = user && ((user.convId && customAvatarUrls.get("conv:" + user.convId)) || (user.id && customAvatarUrls.get("user:" + user.id)));
    if (custom) {
      const img = el("img", "gh-avatar");
      img.style.width = size + "px"; img.style.height = size + "px"; img.width = size; img.height = size; img.alt = "";
      img.src = custom;
      return img;
    }
    if (user && user.members && user.members.filter((m) => m && m.bitmojiUrl).length >= 2 && pref("avatars") !== "initials") return groupAvatarEl(user, size);
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
  // Snapchat's chat-list status, in Snapchat's colours but Ghost's shapes/sizes: red = snap without sound,
  // purple = snap with sound, blue = chat. Filled arrow = delivered, hollow arrow = opened, filled square = new,
  // hollow square = received (you opened it), crossed arrows = screenshot, circle arrow = replayed.
  const SNAP_RED = "#f23c57", SNAP_PURPLE = "#a05dcd", CHAT_BLUE = "#0eadff";
  const STATUS_WORD = { new: null, received: "Received", delivered: "Delivered", opened: "Opened", screenshot: "Screenshot",
    replayed: "Replayed", sending: "Sending\u2026", failed: "Failed to send", reacted: "Reacted" };
  function statusGlyph(shape, color, filled) {
    const f = filled ? color : "none";
    const paths = {
      arrow: `<path d="M3.2 2.8L13.4 8 3.2 13.2 5.4 8z" fill="${f}" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`,
      square: `<rect x="3" y="3" width="10" height="10" rx="2.6" fill="${f}" stroke="${color}" stroke-width="1.8"/>`,
      screenshot: `<path d="M2.2 5.2h8.6M8.4 2.8l2.4 2.4-2.4 2.4M13.8 10.8H5.2M7.6 8.4l-2.4 2.4 2.4 2.4" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
      replay: `<path d="M12.6 8a4.6 4.6 0 11-1.4-3.3M11.4 1.9v2.9H8.5" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`,
      failed: `<circle cx="8" cy="8" r="5.6" fill="none" stroke="${color}" stroke-width="1.7"/><path d="M8 5v3.4M8 10.7v.1" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>`,
      phone: `<path d="M13.4 10.9v1.6a1.3 1.3 0 01-1.4 1.3 12.8 12.8 0 01-5.6-2 12.6 12.6 0 01-3.9-3.9A12.8 12.8 0 01.5 2.3 1.3 1.3 0 011.8 1h1.6a1.3 1.3 0 011.3 1.1c.1.6.2 1.2.4 1.7a1.3 1.3 0 01-.3 1.4l-.7.7a10.3 10.3 0 003.9 3.9l.7-.7a1.3 1.3 0 011.4-.3c.5.2 1.1.3 1.7.4a1.3 1.3 0 011.1 1.3z" transform="translate(1.2 .6)" fill="${f}" stroke="${color}" stroke-width="1.3" stroke-linejoin="round"/>`,
    };
    const wrap = document.createElement("span");
    wrap.className = "gh-status-glyph";
    wrap.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">${paths[shape] || ""}</svg>`;
    return wrap;
  }
  function snapchatStatusLine(conv) {
    const p = conv.preview, st = p.state;
    const color = st.media === "snap" ? (st.audio ? SNAP_PURPLE : SNAP_RED) : st.media === "call" ? (st.status === "missed" ? SNAP_RED : "#8e8e93") : CHAT_BLUE;
    let shape, filled = false;
    switch (st.status) {
      case "new": shape = "square"; filled = true; break;
      case "received": shape = "square"; break;
      case "delivered": shape = "arrow"; filled = true; break;
      case "opened": case "reacted": shape = p.fromMe ? "arrow" : "square"; break;
      case "screenshot": shape = "screenshot"; break;
      case "replayed": shape = "replay"; break;
      case "sending": shape = "arrow"; break;
      case "failed": shape = "failed"; break;
      default: shape = "phone"; filled = st.status === "missed";
    }
    const glyphColor = st.status === "sending" ? "#8e8e93" : st.status === "failed" ? SNAP_RED : color;
    const you = p.fromMe ? "You: " : "";
    let text, emph = null;
    if (st.media === "call") {
      text = p.text || (st.status === "missed" ? (st.video ? "Missed video call" : "Missed call") : (st.video ? "Video call" : "Call"));
      if (st.status === "missed" && !p.fromMe) emph = SNAP_RED;
    } else if (st.media === "snap" || ["screenshot", "replayed", "sending", "failed", "reacted"].includes(st.status) || !(p.kind === "text" && p.text && !/^(New Chat|Received|Delivered|Opened)$/.test(p.text))) {
      // a status word, like Snapchat's list: snaps always; chats when there's an event or no text to show
      if (st.status === "new") { text = st.media === "snap" ? "New Snap" : st.voice ? "New Voice Note" : "New Chat"; emph = color; }
      else text = STATUS_WORD[st.status] || "";
      if (st.media === "chat" && st.voice && (st.status === "received" || st.status === "opened" || st.status === "delivered")) text = "Voice note \u00b7 " + text;
    } else {
      // a chat whose text we have: the glyph says delivered/opened/new/received, the line shows the message
      text = you + p.text;
      if (st.status === "new") emph = "var(--gh-text)";
    }
    return { text, glyph: statusGlyph(shape, glyphColor, filled), emph };
  }
  function previewLine(conv) {
    const p = conv.preview || { kind: "none" };
    if (p.state && p.state.status && p.kind !== "system") return snapchatStatusLine(conv);
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
    // pinned chats first (in pin order), hidden chats left out (Settings > Chats > Hidden Chats brings them back;
    // searching still finds them)
    const pins = pref("pinnedChats") || [], hidden = new Set(pref("hiddenChats") || []);
    const byId = new Map(ctx.state.conversations.map((c) => [c.id, c]));
    const ordered = [...pins.map((id) => byId.get(id)).filter(Boolean), ...ctx.state.conversations.filter((c) => !pins.includes(c.id))];
    for (const conv of ordered) {
      if (q && !(conv.title || "").toLowerCase().includes(q)) continue;
      if (!q && hidden.has(conv.id)) continue;
      seen.add(conv.id);
      let row = home.rows.get(conv.id);
      if (!row) { row = buildHomeRow(ctx, conv); home.rows.set(conv.id, row); }
      else updateHomeRow(row, conv);
      row.el.dataset.pinned = pins.includes(conv.id) ? "1" : "0";
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
    avatarWrap.insertBefore(makeAvatar(convAvatarUser(conv), 52), avatarWrap.firstChild);
    rowEl._avSig = avatarSig(conv);
    // tap = open the chat; double-tap = snap camera for this person (like Snapchat). The chat opens at once on the
    // first tap (no waiting to see if a second one comes); the camera then slides up over it.
    // hold a chat: pin / hide
    let holdT = null, held = false;
    rowEl.addEventListener("touchstart", () => { held = false; holdT = setTimeout(() => { held = true; haptic("medium"); openRowMenu(ctx, conv.id); }, 480); }, { passive: true });
    const cancelHold = () => clearTimeout(holdT);
    rowEl.addEventListener("touchmove", cancelHold, { passive: true });
    rowEl.addEventListener("touchend", cancelHold, { passive: true });
    // the first tap's moment is its touchend (the click can arrive ~100 ms later on the phone)
    rowEl.addEventListener("touchend", () => { if (!held) ctx.state.rowTapTouch = nowMs(); }, { passive: true });
    rowEl.addEventListener("click", (e) => { if (held) { held = false; e.stopImmediatePropagation(); } }, true);
    rowEl.addEventListener("click", () => {
      const t0 = ctx.state.rowTapTouch && nowMs() - ctx.state.rowTapTouch < 400 ? ctx.state.rowTapTouch : nowMs();
      ctx.state.rowTap = { id: conv.id, t: t0, row: rowEl }; // a 2nd tap lands on the chat screen - see the root listener
      openChatFromRow(ctx, conv.id);
    });
    const row = { el: rowEl, id: conv.id };
    updateHomeRow(row, conv);
    return row;
  }
  function togglePin(ctx, id) {
    const pins = (pref("pinnedChats") || []).slice();
    const i = pins.indexOf(id);
    if (i >= 0) pins.splice(i, 1); else pins.unshift(id);
    setPref(ctx, "pinnedChats", pins.slice(0, 15));
    renderHomeList(ctx);
    return i < 0;
  }
  function setHidden(ctx, id, hide) {
    const h = new Set(pref("hiddenChats") || []);
    if (hide) h.add(id); else h.delete(id);
    setPref(ctx, "hiddenChats", [...h]);
    if (hide) setPref(ctx, "pinnedChats", (pref("pinnedChats") || []).filter((x) => x !== id));
    renderHomeList(ctx);
  }
  // the menu you get by holding a chat in the list
  function openRowMenu(ctx, id) {
    const cd = ctx.state.convById.get(id);
    if (!cd) return;
    const s = ctx.chatSheet;
    s.sheet.innerHTML = "";
    s.sheet.appendChild(el("div", "gh-sheet-grip"));
    const head = el("div", "gh-chat-sheet-head");
    head.appendChild(makeAvatar(convAvatarUser(cd), 56));
    const nm = el("div", "gh-chat-sheet-name"); nm.textContent = cd.title || "Chat";
    head.appendChild(nm);
    s.sheet.appendChild(head);
    const g = el("div", "gh-set-group"); s.sheet.appendChild(g);
    const pinned = (pref("pinnedChats") || []).includes(id);
    const close = () => closeSheetGeneric(s.backdrop, s.sheet);
    setRow(g, { icon: "pin", tint: "#ff9433", label: pinned ? "Unpin" : "Pin to Top", onClick: () => { const now = togglePin(ctx, id); close(); ctx.showToast(now ? "Pinned" : "Unpinned"); } });
    setRow(g, { icon: "camera", tint: "#f23c57", label: "Send a Snap", onClick: () => { close(); openCamera(ctx, { to: id }); } });
    setRow(g, { icon: "eyeOff", tint: "#8e8e93", label: "Hide Chat", onClick: () => { setHidden(ctx, id, true); close(); ctx.showToast("Hidden - find it in Settings > Chats > Hidden Chats"); } });
    const f = el("div", "gh-set-group-foot"); f.textContent = "Hidden chats stay in Snapchat; they just leave this list. Searching still finds them."; s.sheet.appendChild(f);
    openSheetGeneric(s.backdrop, s.sheet);
  }
  function updateHomeRow(row, conv) {
    const rowEl = row.el;
    const sig = avatarSig(conv);
    if (rowEl._avSig !== sig) { // Bitmoji ids often arrive after the list, and custom photos can change
      rowEl._avSig = sig;
      const wrap = rowEl.querySelector(".gh-row-avatar-wrap");
      const old = wrap.querySelector(".gh-avatar");
      const fresh = makeAvatar(convAvatarUser(conv), 52);
      if (old) old.replaceWith(fresh); else wrap.insertBefore(fresh, wrap.firstChild);
    }
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
      const { text, iconName, tick, glyph, emph } = previewLine(conv);
      previewEl.innerHTML = "";
      if (glyph) previewEl.appendChild(glyph);
      if (tick) previewEl.appendChild(icon(tick === "double" ? "checkDouble" : "check", 15, "gh-tick"));
      if (iconName) previewEl.appendChild(icon(iconName, 14));
      const span = el("span");
      span.textContent = text;
      if (emph) { span.style.color = emph; span.style.fontWeight = "600"; } else { span.style.color = ""; span.style.fontWeight = ""; }
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
      if (list.scrollTop > 0 || !e.touches || e.touches.length !== 1) { pulling = false; return; }
      startY = e.touches[0].clientY; pulling = true; dy = 0;
    }, { passive: true });
    list.addEventListener("touchmove", (e) => {
      if (!pulling) return;
      dy = (e.touches[0].clientY - startY) * pagePxToLocal();
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
        <div class="gh-conv-calls">
          <button class="gh-icon-btn gh-hit" data-act="voice-call" aria-label="Voice call"></button>
          <button class="gh-icon-btn gh-hit" data-act="video-call" aria-label="Video call"></button>
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
    // Send without closing the keyboard: a tap on a <button> moves focus to it (blurring the textarea = keyboard
    // down). Handling the tap on touchend with preventDefault stops iOS from making the mouse events/focus change;
    // click stays for non-touch input.
    const sendBtnEl = screen.querySelector('[data-act="send"]');
    sendBtnEl.addEventListener("touchend", (e) => { e.preventDefault(); conv.sendTouchAt = nowMs(); sendCurrentText(ctx); });
    sendBtnEl.addEventListener("mousedown", (e) => e.preventDefault());
    sendBtnEl.addEventListener("click", () => { if (nowMs() - (conv.sendTouchAt || 0) > 600) sendCurrentText(ctx); });
    conv.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && pref("sendOnReturn") && !e.isComposing) { e.preventDefault(); sendCurrentText(ctx); }
    });
    initVoiceRecorder(ctx, screen, conv); // (ctx.conv isn't set yet while the screen is being built)
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
    // let them see "typing…" (at most every 3 s, like Snapchat's own composer; off with Settings > Privacy)
    conv.textarea.addEventListener("input", () => {
      const id = ctx.state.currentConvId;
      if (!id || !conv.textarea.value || !pref("showTyping") || nowMs() - (conv.lastTypingSent || 0) < 3000) return;
      conv.lastTypingSent = nowMs();
      api.sendTyping(id).catch(() => {});
    });
    conv.textarea.addEventListener("click", () => updateMentions(ctx));
    conv.textarea.addEventListener("blur", () => setTimeout(() => hideMentions(ctx), 150));
    // tap the name or picture at the top of a chat: that chat's options (wallpaper)
    screen.querySelector(".gh-conv-title-row").addEventListener("click", () => openChatSheet(ctx));
    screen.querySelector('[data-act="voice-call"]').appendChild(icon("call", 21));
    screen.querySelector('[data-act="video-call"]').appendChild(icon("videoCall", 23));
    screen.querySelector('[data-act="voice-call"]').addEventListener("click", () => startCallFrom(ctx, false));
    screen.querySelector('[data-act="video-call"]').addEventListener("click", () => startCallFrom(ctx, true));
    screen.querySelector(".gh-conv-header-avatar").addEventListener("click", () => openChatSheet(ctx));
    const touched = () => { conv.userTouched = true; conv.lastUserScrollAt = nowMs(); };
    conv.messages.addEventListener("touchstart", touched, { passive: true });
    conv.messages.addEventListener("touchmove", touched, { passive: true });
    conv.messages.addEventListener("touchend", touched, { passive: true }); // momentum keeps scrolling after the finger lifts
    conv.messages.addEventListener("wheel", touched, { passive: true });
    // the list box itself changing size (keyboard, composer growing/shrinking): stay on the newest message
    if (typeof ResizeObserver === "function") new ResizeObserver(() => {
      if (conv.atBottom && ctx.state.currentConvId) conv.messages.scrollTop = conv.messages.scrollHeight;
    }).observe(conv.messages);
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
    // Live wallpaper resume: ONE listener for the life of the page, not one per setLiveWall() call - it used to
    // add a fresh document-level listener (closed over that call's canvas/loop) every time the wallpaper kind
    // changed (switching chats, switching the wallpaper in Settings), and never removed the old ones, which
    // piled up forever (the exact "grew until iOS killed the page" problem this file already fights elsewhere).
    document.addEventListener("visibilitychange", () => { if (!document.hidden && conv.liveWall) conv.liveWall.start(); });
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
    const av = convAvatarUser(convData);
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

  // Tapping a chat row that has an unopened snap plays every unopened received snap in it (oldest first, any
  // sender in a group), full-screen, before the chat itself appears - landing in the chat once the last one ends
  // or the user swipes down to stop early (openSnapPlaythrough's teardown calls onDone either way). Only the row
  // tap itself goes through here (never sent snaps, never other ways into a conversation - search, jump-to-
  // message, resuming the last chat, gallery/bookmark jumps - which all still call openConversationScreen
  // directly), and a row with no unread snap badge skips the extra fetch entirely.
  function openChatFromRow(ctx, convId) {
    const cd = ctx.state.convById.get(convId);
    if (!cd || !cd.hasUnreadSnap) { openConversationScreen(ctx, convId); return; }
    (async () => {
      let entry;
      try {
        const res = await api.openConversation(convId);
        entry = { messages: res.messages || [], hasMore: !!res.hasMore };
        ctx.state.messagesByConv.set(convId, entry);
      } catch (e) { openConversationScreen(ctx, convId); return; }
      const unopened = entry.messages.filter((m) => m.kind === "snap" && !isFromMe(ctx, m) && !m.opened);
      if (!unopened.length) { openConversationScreen(ctx, convId); return; }
      openSnapPlaythrough(ctx, unopened, "unopened", {
        title: cd.title || "Snaps", convId,
        onDone: () => openConversationScreen(ctx, convId),
      });
    })();
  }
  async function openConversationScreen(ctx, conversationId) {
    haptic("light");
    closeChatSearch(ctx);
    storage.set("ghostLastConv", conversationId);
    if (ctx.state.currentConvId && ctx.state.currentConvId !== conversationId) {
      scheduleMediaRelease(ctx, ctx.state.currentConvId);
      // Going Home first closes the old chat (closeConversationScreen -> api.closeConversation), but jumping
      // straight from one open chat to another (bookmark, gallery tile, story reply's new group, nav-swipe,
      // new-chat sheet) skipped that, leaving the OLD conversation id in the bridge's openConversations set
      // forever - both ids then got emitMessagesFor() called every store change, and since that's a single
      // shared throttled function keyed by nothing, whichever id lost the race never received live message
      // updates again (see bridge.js's throttle()/emitMessagesFor). Close it exactly like leaving to Home does.
      api.closeConversation(ctx.state.currentConvId).catch(() => {});
    }
    loadChatColors(ctx, conversationId);
    ctx.conv.openedAt = nowMs();
    setTimeout(() => { if (ctx.conv.liveWall) ctx.conv.liveWall.start(); }, 0);
    ctx.conv.peekId = null;
    applyChatWallpaper(ctx, conversationId);
    ctx.state.currentConvId = conversationId;
    const convData = ctx.state.convById.get(conversationId);
    if (convData) updateConvHeader(ctx, convData);
    navigateTo(ctx, "conv", true);
    const conv = ctx.conv;
    conv.rendered.forEach((elm) => elm.remove());
    conv.rendered.clear();
    // hidden from here on (also covers a message-list update that arrives while the chat is still loading and
    // paints before we do) until settleOpen has it pinned to the newest message
    conv.messages.classList.add("gh-opening");
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
    settleOpen(ctx, conv, conversationId);
    // and once the screen has finished sliding in, nudge the list by a pixel: WebKit sometimes hasn't drawn the
    // newest bubbles yet (they appeared only once you scrolled) - a scroll makes it draw them
    for (const ms of [350, 900]) setTimeout(() => {
      if (ctx.state.currentConvId !== conversationId) return;
      const m = conv.messages; conv.stickUntil = nowMs() + 100;
      const top = m.scrollTop; m.scrollTop = top - 1; m.scrollTop = conv.atBottom ? m.scrollHeight : top;
    }, ms);
    syncPresence(ctx);
  }
  // Opening a chat showed it a little higher up for a frame, then jumped to the newest message (device report
  // 2026-09-27, "only some chats": the ones whose bubbles change height after the first layout - photos, stickers,
  // emoji, replies). The rig caught it too: 61px off the bottom on the first painted frame. So the messages stay
  // invisible (.gh-opening hides the bubbles, not the wallpaper) while they're pinned to the bottom every frame,
  // and appear once the list height has held still for 2 frames (at most ~0.3s, still inside the slide-in).
  function settleOpen(ctx, conv, id, peek) {
    const m = conv.messages;
    const t0 = nowMs();
    let last = -1, calm = 0;
    const stillHere = () => (peek ? conv.peekId === id || ctx.state.currentConvId === id : ctx.state.currentConvId === id);
    const pin = () => { if (conv.atBottom) { conv.stickUntil = nowMs() + 120; m.scrollTop = m.scrollHeight; } };
    pin();
    const step = () => {
      if (!stillHere()) return void m.classList.remove("gh-opening");
      pin();
      const h = m.scrollHeight;
      calm = h === last ? calm + 1 : 0;
      last = h;
      if (calm >= 2 || nowMs() - t0 > 300) { pin(); markStuckDates(ctx); m.classList.remove("gh-opening"); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
  // Photos/videos/voice notes of a chat you've left are freed a little later (bridge releaseMedia + our cache),
  // unless you went back into it. Keeping every chat's media forever made iOS kill the page after a few chats
  // (trail.txt 2026-09-27: "WEB PROCESS CRASHED" -> Ghost reloaded with its loading screen).
  function scheduleMediaRelease(ctx, convId) {
    if (!convId) return;
    setTimeout(() => {
      if (ctx.state.currentConvId === convId) return;
      for (const k of Array.from(mediaCache.keys())) if (k.startsWith(convId + "|")) mediaCache.delete(k);
      api.releaseMedia(convId).catch(() => {});
    }, 4000);
  }
  function closeConversationScreen(ctx) {
    closeChatSearch(ctx);
    scheduleMediaRelease(ctx, ctx.state.currentConvId);
    storage.set("ghostLastConv", "");
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
      // If the newest message was on screen, the newest message stays on screen - whatever else changed (a
      // re-sent slice, a read receipt...). Before, an update that wasn't counted as "new message arrived" kept the
      // old end, so your newest message wasn't drawn until you scrolled (device screenshots 2026-09-27).
      if (opts.stick || conv.windowEnd >= (conv._lastTotal || 0)) end = total;
    }
    conv.windowStart = start;
    conv.windowEnd = end;
    conv._lastTotal = total;
    if (opts.initial && !conv.unreadBoundaryComputed) {
      conv.unreadBoundaryComputed = true;
      const n = conv.pendingUnreadForDivider || 0;
      conv.unreadBoundaryIndex = (n > 0 && total > 0) ? Math.max(0, total - n) : null;
    }
    paintWindow(ctx, conv);
    // pop-in animation for a genuinely new message (never for a virtualized-scroll window shift, which
    // calls paintWindow directly instead of coming through here — see handleWindowScroll)
    // (no pop for the first second after opening: on the phone the animation could stay frozen on its first,
    // invisible frame while the screen slid in, so your newest message didn't show until you scrolled)
    if (opts.stick && !opts.initial && nowMs() - (conv.openedAt || 0) > 1200) {
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
      if (m.kind === "system" || m.kind === "call") {
        // both sides log the same call (one says voice, the other video): show it once, as video if either says so
        const last = groups[groups.length - 1];
        const tail = (t) => (String(t || "").split("\u00b7")[1] || "").trim();
        if (m.kind === "call" && last && last.system && last.system.kind === "call" && !daySep && Math.abs(m.ts - last.system.ts) < 120000 && tail(m.text) === tail(last.system.text)) {
          if (/^Video/.test(m.text || "") && !/^Video/.test(last.system.text || "")) last.system = m;
          continue;
        }
        groups.push({ daySep, system: m }); cur = null; continue;
      }
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
      if (g.system) { frag.appendChild(systemLineEl(g.system, ctx)); continue; }
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
      const pc = !isMe && personColor(ctx, g.from && g.from.id); if (pc) nm.style.color = pc;
      const tm = el("span", "gh-group-time");
      tm.textContent = fmtClock(g.items[0].ts);
      meta.append(nm, tm);
      col.appendChild(meta);
      for (let i = 0; i < g.items.length; i++) col.appendChild(messageWrapEl(ctx, g.items[i], isMe, i === g.items.length - 1));
      groupEl.append(gutter, col);
      frag.appendChild(groupEl);
    }
    if (end === total && total) { const seen = seenRowEl(ctx, all); if (seen) frag.appendChild(seen); }
    // keep what's on screen where it is: swapping every bubble (a new message, a read receipt...) briefly changes
    // the list's height, and the view used to jump up (device 2026-09-27: "sending a message makes me jump up")
    const mEl = conv.messages, fromBottom = mEl.scrollHeight - mEl.scrollTop, wasBottom = conv.atBottom;
    conv.stickUntil = nowMs() + 150; // the scroll events our own repaint causes aren't the user scrolling up
    conv.messages.replaceChildren(conv.topSpacer, frag, conv.bottomSpacer);
    const restore = () => { conv.stickUntil = nowMs() + 150; if (wasBottom) mEl.scrollTop = mEl.scrollHeight; else mEl.scrollTop = Math.max(0, mEl.scrollHeight - fromBottom); };
    restore();
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
      restore();
    });
  }

  // Read receipts under the newest message. 1:1: "Delivered" / "Opened" under your last message (like Snapchat).
  // Groups: "Seen by" + the faces of everyone who has read the newest message; tap for the names.
  function seenRowEl(ctx, all) {
    let m = null;
    for (let i = all.length - 1; i >= 0; i--) if (all[i].kind !== "system" && all[i].kind !== "call") { m = all[i]; break; }
    if (!m || m.pending || m.failed || m.retained) return null;
    const convId = ctx.state.currentConvId;
    const cd = ctx.state.convById.get(convId) || {};
    const meId = ctx.state.me && ctx.state.me.id;
    const mine = m.fromMe || (m.from && m.from.id === meId);
    const seen = (m.seenBy || []).filter((id) => id !== meId);
    const row = el("div", "gh-seen");
    row.dataset.side = mine ? "right" : "left";
    if (!cd.isGroup) {
      if (!mine) return null;
      const opened = seen.length > 0 || m.opened;
      row.dataset.state = opened ? "opened" : "delivered";
      const w = el("span", "gh-seen-word"); w.textContent = opened ? "Opened" : "Delivered";
      row.appendChild(w);
      return row;
    }
    if (!seen.length) {
      if (!mine) return null;
      const w = el("span", "gh-seen-word"); w.textContent = "Delivered"; row.appendChild(w);
      return row;
    }
    const people = seen.map((id) => (cd.participants || []).find((p) => p.id === id) || { id, name: "Someone" });
    row.dataset.state = "opened";
    const w = el("span", "gh-seen-word"); w.textContent = people.length >= ((cd.participants || []).length - (mine ? 0 : 1)) && people.length > 1 ? "Seen by everyone" : "Seen by";
    const faces = el("span", "gh-seen-faces");
    for (const u of people.slice(0, 7)) faces.appendChild(makeAvatar(u, 18));
    row.append(w, faces);
    if (people.length > 7) { const more = el("span"); more.textContent = "+" + (people.length - 7); row.appendChild(more); }
    row.classList.add("gh-press");
    row.addEventListener("click", () => {
      haptic("light");
      const s = ctx.chatSheet;
      s.sheet.innerHTML = "";
      s.sheet.appendChild(el("div", "gh-sheet-grip"));
      const t = el("div", "gh-set-group-title"); t.textContent = "Seen by " + people.length; s.sheet.appendChild(t);
      const g = el("div", "gh-set-group"); s.sheet.appendChild(g);
      for (const u of people) {
        const r2 = el("div", "gh-set-row gh-reactor-row");
        r2.appendChild(makeAvatar(u, 34));
        const nm = el("span", "gh-set-label"); nm.textContent = u.name || "Someone";
        const pc = personColor(ctx, u.id); if (pc) nm.style.color = pc;
        r2.appendChild(nm); g.appendChild(r2);
      }
      const unseen = (cd.participants || []).filter((p) => p.id !== meId && p.id !== (m.from && m.from.id) && !seen.includes(p.id));
      if (unseen.length) {
        const t2 = el("div", "gh-set-group-title"); t2.textContent = "Not yet"; s.sheet.appendChild(t2);
        const g2 = el("div", "gh-set-group"); s.sheet.appendChild(g2);
        for (const u of unseen) { const r3 = el("div", "gh-set-row gh-reactor-row"); r3.appendChild(makeAvatar(u, 34)); const nm = el("span", "gh-set-label"); nm.textContent = u.name || "Someone"; r3.appendChild(nm); g2.appendChild(r3); }
      }
      openSheetGeneric(s.backdrop, s.sheet);
    });
    return row;
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
  function systemLineEl(m, ctx) {
    const e = el("div", m.kind === "call" ? "gh-call-line" : "gh-system-line");
    if (m.kind === "call") {
      const video = /video/i.test(m.text || "");
      e.appendChild(icon(video ? "videoCall" : "call", 14));
      if (/^Missed/i.test(m.text || "")) e.dataset.missed = "1";
      if (ctx) { e.classList.add("gh-press"); e.addEventListener("click", () => startCallFrom(ctx, video)); } // tap to call back
    }
    const span = el("span"); span.textContent = m.text || "";
    e.appendChild(span);
    return e;
  }

  function messageWrapEl(ctx, m, isMe, isLast) {
    const wrap = el("div", "gh-msg-wrap");
    wrap.dataset.messageId = m.id;
    if (m.retained) wrap.dataset.retained = "1";
    const swipe = el("div", "gh-msg-swipe");
    const hint = el("div", "gh-reply-hint");
    hint.appendChild(icon("reply", 18));
    if (m.replyTo) swipe.appendChild(replyQuoteEl(m.replyTo));
    if (m.retained && m.mediaUnavailable) {
      const missing = el("div", "gh-bubble"); missing.textContent = "Media wasn't captured before deletion"; swipe.appendChild(missing);
    } else swipe.appendChild(bubbleEl(ctx, m, isMe, isLast));
    if (m.retained) { const label = el("div", "gh-retained-label"); label.textContent = "Deleted · kept on this device"; swipe.appendChild(label); }
    if (ctx.state.currentConvId && isBookmarked(ctx.state.currentConvId, m.id)) { wrap.dataset.bm = "1"; const bm = el("span", "gh-bm-mark"); bm.appendChild(icon("bookmark", 11)); swipe.appendChild(bm); }
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
    if (isMe && !m.retained) {
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
  // ---- group colours: each person's name (and @mention of them) in their own colour ------------------------
  // Snapchat's own colour for them in that group when it has one (bridge chatColors), else a steady pick by id.
  const NAME_COLORS = ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#38d9a9", "#4dabf7", "#748ffc", "#b197fc", "#f783ac", "#63e6be", "#ffc078", "#a9e34b"];
  const colorsByConv = new Map();
  function loadChatColors(ctx, convId) {
    const cd = ctx.state.convById.get(convId);
    if (!cd || !cd.isGroup || colorsByConv.has(convId)) return;
    colorsByConv.set(convId, {});
    api.chatColors(convId).then((c) => {
      if (!c || !Object.keys(c).length) return;
      colorsByConv.set(convId, c);
      if (ctx.state.currentConvId === convId && ctx.conv) paintWindow(ctx, ctx.conv);
    }).catch(() => {});
  }
  function personColor(ctx, userId) {
    const convId = ctx.state.currentConvId;
    const cd = convId && ctx.state.convById.get(convId);
    if (!cd || !cd.isGroup || !userId) return null;
    const own = (colorsByConv.get(convId) || {})[userId];
    if (own) return `color-mix(in srgb, ${own} 78%, #fff)`; // Snapchat's colours are made for a white chat: lift them
    let h = 0; for (const ch of String(userId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return NAME_COLORS[h % NAME_COLORS.length];
  }
  function mentionColor(ctx, handle) {
    const convId = ctx.state.currentConvId;
    const cd = convId && ctx.state.convById.get(convId);
    const h = String(handle || "").replace(/^@/, "").toLowerCase();
    if (!cd || !cd.isGroup || !h) return null;
    const me = ctx.state.me || {};
    if (me.username && me.username.toLowerCase() === h) return null; // you: the normal accent
    const p = (cd.participants || []).find((x) => (x.username || "").toLowerCase() === h);
    return p ? personColor(ctx, p.id) : null;
  }

  function reactionsEl(ctx, m) {
    const wrap = el("div", "gh-reactions");
    const meId = ctx.state.me && ctx.state.me.id;
    const cd = ctx.state.convById.get(ctx.state.currentConvId);
    const group = !!(cd && cd.isGroup);
    const counts = new Map();
    for (const r of m.reactions) {
      const key = r.emoji;
      if (!counts.has(key)) counts.set(key, { count: 0, mine: false, who: [] });
      const c = counts.get(key);
      c.count++;
      c.who.push(r.from || {});
      if (meId && r.from && r.from.id === meId) c.mine = true;
    }
    for (const [emoji, c] of counts) {
      const pill = el("div", "gh-reaction-pill gh-press");
      pill.dataset.mine = c.mine ? "1" : "0";
      pill.appendChild(document.createTextNode(emoji + " "));
      if (group && c.count <= 3) { // Telegram-style: the faces of who reacted, else the count
        const faces = el("span", "gh-reaction-faces");
        for (const u of c.who) faces.appendChild(makeAvatar(u, 18));
        pill.appendChild(faces);
      } else pill.appendChild(document.createTextNode(String(c.count)));
      pill.addEventListener("click", () => {
        haptic("light");
        // in a group, tapping shows who reacted (with your own react/unreact there); 1:1 just toggles yours
        if (group) { openReactorsSheet(ctx, m); return; }
        api.react(ctx.state.currentConvId, m.id, c.mine ? null : emoji).catch(() => {});
      });
      wrap.appendChild(pill);
    }
    return wrap;
  }
  function openReactorsSheet(ctx, m) {
    const s = ctx.chatSheet;
    const meId = ctx.state.me && ctx.state.me.id;
    const convId = ctx.state.currentConvId;
    s.sheet.innerHTML = "";
    s.sheet.appendChild(el("div", "gh-sheet-grip"));
    const t = el("div", "gh-set-group-title"); t.textContent = m.reactions.length + (m.reactions.length === 1 ? " Reaction" : " Reactions"); s.sheet.appendChild(t);
    const g = el("div", "gh-set-group"); s.sheet.appendChild(g);
    const list = m.reactions.slice().sort((a, b) => ((b.from && b.from.id === meId) ? 1 : 0) - ((a.from && a.from.id === meId) ? 1 : 0));
    for (const r of list) {
      const mine = r.from && r.from.id === meId;
      const row = el(mine ? "button" : "div", "gh-set-row gh-reactor-row" + (mine ? " gh-press" : ""));
      row.appendChild(makeAvatar(mine ? (ctx.state.me || r.from) : r.from, 34));
      const nm = el("span", "gh-set-label"); nm.textContent = mine ? "You" : (r.from && r.from.name) || "Someone";
      const col = !mine && personColor(ctx, r.from && r.from.id); if (col) nm.style.color = col;
      if (mine) { const sub = el("div", "gh-reactor-sub"); sub.textContent = "Tap to remove"; nm.appendChild(sub); }
      const em = el("span", "gh-reactor-emoji"); em.textContent = r.emoji;
      row.append(nm, em);
      if (mine) row.addEventListener("click", () => { haptic("light"); closeSheetGeneric(s.backdrop, s.sheet); api.react(convId, m.id, null).catch(() => {}); });
      g.appendChild(row);
    }
    openSheetGeneric(s.backdrop, s.sheet);
  }

  // Message text: @mentions in the accent colour (like Snapchat), tappable links, and the chat-search match marked.
  function appendRichText(ctx, b, text) {
    const q = ctx && ctx.conv && ctx.conv.searchQ;
    const plain = (t) => {
      if (!q) { b.appendChild(document.createTextNode(t)); return; }
      const low = t.toLowerCase(); let i = 0, j;
      while ((j = low.indexOf(q, i)) !== -1) {
        if (j > i) b.appendChild(document.createTextNode(t.slice(i, j)));
        const mk = el("mark", "gh-hl"); mk.textContent = t.slice(j, j + q.length); b.appendChild(mk);
        i = j + q.length;
      }
      if (i < t.length) b.appendChild(document.createTextNode(t.slice(i)));
    };
    for (const part of String(text || "").split(/((?:^|(?<=\s))@[\w.\-]+|https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])/i)) {
      if (!part) continue;
      if (/^@[\w.\-]+$/.test(part)) { const sp = el("span", "gh-mention"); sp.textContent = part; const mc = ctx && mentionColor(ctx, part); if (mc) sp.style.color = mc; b.appendChild(sp); }
      else if (/^https?:\/\//i.test(part)) {
        const a = el("span", "gh-link"); a.textContent = part;
        a.addEventListener("click", (e) => { e.stopPropagation(); openLink(part); });
        b.appendChild(a);
      } else plain(part);
    }
  }
  function openLink(url) {
    haptic("light");
    try { window.webkit.messageHandlers.dg.postMessage({ op: "openURL", url }).catch(() => {}); } catch (e) { try { window.open(url, "_blank"); } catch (e2) {} }
  }

  function bubbleEl(ctx, m, isMe, isLast) {
    if (m.retained && m.kind === "gif") m = { ...m, kind: "chat-media" }; // archived bytes load locally, without the live GIPHY fetch path
    switch (m.kind) {
      case "text": {
        const b = el("div", "gh-bubble");
        if (isLast) b.dataset.tail = "1";
        appendRichText(ctx, b, m.text);
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
            const mp4Url = await gifMp4Url(gid);
            const v = el("video");
            v.muted = true; v.loop = true; v.playsInline = true;
            if (pref("autoplayGifs")) v.autoplay = true;
            else { v.preload = "metadata"; v.addEventListener("click", (e) => { e.stopPropagation(); if (v.paused) v.play().catch(() => {}); else v.pause(); }); }
            v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
            v.src = mp4Url;
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
      case "snap": return (m.saved && (isMe || m.opened)) ? savedSnapMediaEl(ctx, m, isMe) : snapTileEl(ctx, m, isMe);
      case "share": return shareCardEl(ctx, m, isMe);
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

  // Shared Spotlight videos / stories: a card with the video's cover; tap to watch it here (bridge loadShare).
  function shareCardEl(ctx, m, isMe) {
    const b = el("div", "gh-bubble gh-share-card gh-press");
    const cover = el("div", "gh-share-cover");
    cover.appendChild(icon("play", 30));
    const meta = el("div", "gh-share-meta");
    const t1 = el("div", "gh-share-title"); t1.textContent = m.text === "Story" ? "Shared a Story" : m.text === "Spotlight" ? "Spotlight" : "Shared";
    const t2 = el("div", "gh-share-sub"); t2.textContent = "Tap to watch";
    meta.append(t1, t2);
    b.append(cover, meta, tickMetaEl(m, isMe, "gh-media-meta"));
    const convId = m.conversationId || ctx.state.currentConvId;
    api.shareInfo(convId, m.id).then((r) => {
      if (!r) return;
      if (r.thumb) { const img = el("img"); img.alt = ""; img.src = r.thumb; cover.prepend(img); }
      if (r.creator) t1.textContent = r.creator;
      if (r.kind === "legacyAd" || r.kind === "legacyDiscover") {
        t2.textContent = r.video ? "Video · Tap to watch" : "Tap to view";
        if (!r.video) api.loadShare(convId, m.id).then((x) => { const ref = x && x.media && x.media[0]; if (ref && ref.url) { const img = el("img"); img.alt = ""; img.src = ref.url; cover.prepend(img); cover.classList.add("gh-share-still"); } }).catch(() => {});
      }
      if (r.views) t2.textContent = Number(r.views).toLocaleString() + " views";
    }).catch(() => { t2.textContent = "No longer available"; });
    b.addEventListener("click", async () => {
      haptic();
      t2.textContent = "Loading…";
      try {
        const r = await api.loadShare(convId, m.id);
        const ref = r && r.media && r.media[0];
        if (!ref) throw new Error("none");
        openViewerSingle(ctx, ref);
        t2.textContent = "Tap to watch";
      } catch (e) { t2.textContent = "Can't play this one here"; ctx.showToast("Couldn't load that video"); }
    });
    return b;
  }

  // Snapchat splits a long recording into several ~10s video snaps sent back-to-back by the same sender; Ghost
  // detects a run of same-sender "snap" messages sent within this many ms of each other as candidate parts of ONE
  // continuous video (confirmed only once each part's media actually resolves to type "video" - see
  // openSnapPlaythrough). Used both for the "play every unopened snap before the chat" queue and for chaining a
  // tapped saved/replayed snap into its neighbouring parts.
  const SNAP_GROUP_GAP_MS = 12000;
  // m.fromMe is bridge.js's own convenience field (not part of API.md's documented Message shape), so it isn't
  // guaranteed on every message a caller might hand in - same fallback the rest of ui.js already uses (search
  // "m.fromMe ||" elsewhere) rather than trusting the bare field.
  function isFromMe(ctx, m) {
    const meId = ctx.state.me && ctx.state.me.id;
    return !!(m && (m.fromMe || (m.from && meId && m.from.id === meId)));
  }
  function snapRunFrom(all, startIdx, eligible) {
    const first = all[startIdx];
    const out = [first];
    let prevTs = first.ts;
    for (let j = startIdx + 1; j < all.length; j++) {
      const m = all[j];
      if (!eligible(m)) break;
      // same sender (this alone also implies the same fromMe-ness - no need to compare that separately)
      if ((m.from && m.from.id) !== (first.from && first.from.id)) break;
      if (m.ts - prevTs > SNAP_GROUP_GAP_MS) break;
      out.push(m); prevTs = m.ts;
    }
    return out;
  }

  // A snap saved in chat renders inline like a photo/video message, the same way Snapchat Web shows it, instead of
  // the small tap-to-view row: media loads/caches/releases exactly like chat-media (fetchMediaFor/mediaCache/
  // releaseMedia), respects aspect ratio via the shared .gh-media sizing, and a video autoplays muted+looping like
  // every other video bubble in Ghost. Tapping it opens the full viewer (openSnapPlaythrough, mode "saved") with an
  // Unsave control, chained into any neighbouring same-sender video parts (see SNAP_GROUP_GAP_MS above).
  function savedSnapMediaEl(ctx, m, isMe) {
    const b = el("div", "gh-bubble gh-gif-bubble gh-snap-media");
    const build = (ref) => {
      const media = mediaEl(ref, { ctx, message: m, autoplay: ref && ref.type === "video" });
      media.appendChild(tickMetaEl(m, isMe, "gh-media-meta"));
      const badge = el("span", "gh-snap-media-badge"); badge.appendChild(icon("bookmark", 12));
      media.appendChild(badge);
      media.classList.add("gh-press");
      media.addEventListener("click", () => openSavedSnapFromChat(ctx, m, isMe));
      return media;
    };
    let media = build(m.media && m.media[0]);
    b.appendChild(media);
    if (!(m.media && m.media.length)) fetchMediaFor(m).then((list) => {
      if (!list.length || (!b.isConnected && !b.parentNode)) return;
      const fresh = build(list[0]);
      media.replaceWith(fresh); media = fresh;
    });
    return b;
  }
  function openSavedSnapFromChat(ctx, m, isMe) {
    haptic();
    const convId = m.conversationId || ctx.state.currentConvId;
    const entry = ctx.state.messagesByConv.get(convId);
    const all = (entry && entry.messages) || [m];
    const idx = all.findIndex((x) => x.id === m.id);
    const msgs = idx < 0 ? [m] : snapRunFrom(all, idx, (x) => x.kind === "snap" && x.saved && (isFromMe(ctx, x) || x.opened));
    openSnapPlaythrough(ctx, msgs, "saved", { title: isMe ? "Your Snap" : (m.from && m.from.name) || "Snap", convId });
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
      b.dataset.saved = m.saved ? "1" : "0";
      label.textContent = m.saved && (isMe || m.opened) ? "Saved in Chat"
        : isMe ? (m.opened ? "Opened" : "Delivered") : (m.opened ? (m.replayable ? "Opened · Tap to replay" : "Opened") : "New Snap");
      if (saveBtn) { saveBtn.dataset.on = m.saved ? "1" : "0"; saveBtn.setAttribute("aria-label", m.saved ? "Unsave in Chat" : "Save in Chat"); }
    };
    // Save in Chat, like Snapchat Web's own button: your own snaps any time, received ones once opened. Saving
    // flips this tile into the inline media bubble (savedSnapMediaEl) instead, so this button only ever runs the
    // false -> true direction here; unsaving happens from the full viewer's "Unsave in Chat" control instead.
    let saveBtn = null;
    if (isMe || m.opened) {
      saveBtn = el("button", "gh-snap-save gh-hit");
      saveBtn.appendChild(icon("bookmark", 16));
      saveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        haptic("light");
        const convId = m.conversationId || ctx.state.currentConvId;
        m.saved = true;
        if (ctx.conv && ctx.state.currentConvId === convId) paintWindow(ctx, ctx.conv);
        try { await api.saveMessage(convId, m.id, true); ctx.showToast("Saved in chat"); }
        catch (err) { m.saved = false; if (ctx.conv && ctx.state.currentConvId === convId) paintWindow(ctx, ctx.conv); ctx.showToast("Couldn't save that Snap"); }
      });
    }
    paint();
    const time = el("span", "gh-snap-time"); time.textContent = fmtClock(m.ts);
    b.append(mark, label, time);
    if (saveBtn) b.appendChild(saveBtn);
    if (!isMe && m.opened && m.replayable) { // one replay, like Snapchat - chains into any neighbouring video parts
      b.classList.add("gh-press");
      b.addEventListener("click", () => {
        if (b.dataset.loading === "1" || !m.replayable || m.saved) return;
        haptic(); b.dataset.loading = "1";
        const convId = m.conversationId || ctx.state.currentConvId;
        const entry = ctx.state.messagesByConv.get(convId);
        const all = (entry && entry.messages) || [m];
        const idx = all.findIndex((x) => x.id === m.id);
        const msgs = idx < 0 ? [m] : snapRunFrom(all, idx, (x) => x.kind === "snap" && !isFromMe(ctx, x) && x.opened && x.replayable && !x.saved);
        m.replayable = false;
        openSnapPlaythrough(ctx, msgs, "replay", {
          title: (m.from && m.from.name) || "Snap", convId,
          onDone: () => { if (ctx.conv && ctx.state.currentConvId === convId) paintWindow(ctx, ctx.conv); },
        });
        delete b.dataset.loading;
      });
    }
    if (!isMe && !m.opened) {
      b.classList.add("gh-press");
      b.setAttribute("role", "button");
      b.setAttribute("aria-label", "View Snap");
      b.addEventListener("click", () => {
        if (m.opened || b.dataset.loading === "1") return;
        haptic();
        b.dataset.loading = "1";
        label.textContent = "Loading…";
        const convId = m.conversationId || ctx.state.currentConvId;
        const entry = ctx.state.messagesByConv.get(convId);
        const all = (entry && entry.messages) || [m];
        const idx = all.findIndex((x) => x.id === m.id);
        const msgs = idx < 0 ? [m] : snapRunFrom(all, idx, (x) => x.kind === "snap" && !isFromMe(ctx, x) && !x.opened);
        openSnapPlaythrough(ctx, msgs, "unopened", {
          title: (m.from && m.from.name) || "Snap", convId,
          onDone: () => { if (ctx.conv && ctx.state.currentConvId === convId) paintWindow(ctx, ctx.conv); },
        });
        delete b.dataset.loading;
      });
    }
    return b;
  }

  // Photos, videos and voice notes arrive without their file (Snapchat downloads + decrypts on demand): ask the
  // bridge for it (loadMedia -> Snapchat's own media resolver), 3 at a time, remembered per message.
  const mediaCache = new Map(), mediaWaiting = [];
  let mediaActive = 0;
  function fetchMediaFor(m) {
    if (m.retained && !m.retainedMedia) return Promise.resolve([]);
    const key = m.conversationId + "|" + m.id + (m.retained ? "|retained" : "");
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

  // Floating date pill, like Telegram: while you scroll, the day's date rides at the top; a moment after you stop
  // it fades away instead of sitting on top of a bubble (it looked like a layout collision at rest).
  function markStuckDates(ctx) {
    const m = ctx.conv.messages;
    for (const sep of m.querySelectorAll(".gh-day-sep")) {
      // stuck = it has been carried down over the content that follows it (in normal flow that content starts
      // below the pill)
      const next = sep.nextElementSibling;
      const stuck = !!next && next.getBoundingClientRect().top < sep.getBoundingClientRect().bottom - 1;
      if (stuck) sep.dataset.stuck = "1"; else delete sep.dataset.stuck;
    }
  }
  function noteConvScrolling(ctx) {
    const conv = ctx.conv;
    if (nowMs() - (conv.lastUserScrollAt || 0) > 1200) return; // our own pinning/repaints don't count
    if (conv.messages.dataset.scrolling !== "1") conv.messages.dataset.scrolling = "1";
    clearTimeout(conv._scrollIdleT);
    conv._scrollIdleT = setTimeout(() => { markStuckDates(ctx); delete conv.messages.dataset.scrolling; }, 900);
  }
  function onConvScroll(ctx) {
    const conv = ctx.conv;
    const m = conv.messages;
    noteConvScrolling(ctx);
    const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
    // Only YOUR scrolling may un-stick the chat from the bottom. The keyboard opening (the list gets shorter), the
    // composer shrinking after a send, or a bubble growing also fire scroll events; those used to count as "you
    // scrolled up", so the next message you sent landed below the keyboard (device 2026-09-27).
    const userScrolling = nowMs() - (conv.lastUserScrollAt || 0) < 1200;
    if (!userScrolling && conv.atBottom) {
      if (!nearBottom) m.scrollTop = m.scrollHeight;
      showJump(ctx, false);
      return;
    }
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
    applyChatWallpaper(ctx, id);
    const cd = ctx.state.convById.get(id);
    if (cd) updateConvHeader(ctx, cd);
    conv.rendered.forEach((elm) => elm.remove());
    conv.rendered.clear();
    const entry = ctx.state.messagesByConv.get(id);
    conv.unreadBoundaryIndex = null; conv.unreadBoundaryComputed = true;
    conv.pinUntil = nowMs() + 4000; conv.userTouched = false; conv.atBottom = true;
    if (entry) { conv.messages.classList.remove("gh-loading-skel"); conv.messages.classList.add("gh-opening"); renderMessageList(ctx, conv, entry, { initial: true }); settleOpen(ctx, conv, id, true); }
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
    if (pinnedToBottom(conv) || nowMs() < (conv.stickUntil || 0)) return; // (a repaint, not the user scrolling)
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
      // Navigated to a different chat while this fetch was in flight: `conv` is the single shared conversation
      // screen object, now showing that other chat, so update the cache above (harmless, keyed by convId) but
      // stop here - mutating conv.windowStart/windowEnd and repainting conv.messages with THIS entry would
      // splice the old chat's messages into whatever chat is on screen now (fetchOlderPages already guards the
      // same race the same way; this path was missing it).
      if (ctx.state.currentConvId !== convId) { conv._loadingOlder = false; return; }
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
      // (not when you're at the newest message - e.g. a load that started while the chat was opening: cutting the
      // window's end then dropped your newest messages until you scrolled)
      if (!conv.atBottom) {
        conv.windowStart = Math.max(0, conv.windowStart - OVERSCAN);
        if (conv.windowEnd - conv.windowStart > CHUNK * 4) conv.windowEnd = conv.windowStart + CHUNK * 4; // backstop
      }
      renderMessageList(ctx, conv, entry, {}); // (paintWindow keeps the view where it was as the older messages appear above)
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
      for (const u of here.slice(0, 8)) {
        const a = el("div", "gh-here-av");
        if (u.typing) a.dataset.typing = "1";
        a.appendChild(makeAvatar(u, 30));
        row.appendChild(a);
      }
      const first = (u) => (u.name || "Someone").split(" ")[0];
      const names = here.length <= 3 ? here.map(first).join(", ").replace(/, ([^,]*)$/, " & $1") : here.slice(0, 2).map(first).join(", ") + " & " + (here.length - 2) + " more";
      if (here.some((u) => u.typing)) { const b = el("div", "gh-typing-bubble"); b.innerHTML = "<span></span><span></span><span></span>"; row.appendChild(b); }
      const t = el("div", "gh-here-label"); t.textContent = names + (here.length === 1 ? " is here" : " are here"); row.appendChild(t);
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
    if (msg && msg.retained) { ctx.showToast("This message was deleted. You can copy its text instead."); return; }
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
    conv.atBottom = true; scrollConvToBottom(ctx, false);
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
      if (!e.touches || e.touches.length !== 1) { g = null; return; }
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
      if (!g || !e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      g.dx = t.clientX - g.x0; g.dy = t.clientY - g.y0;
      if (g.timer && (Math.abs(g.dx) > MOVE_CANCEL || Math.abs(g.dy) > MOVE_CANCEL)) { clearTimeout(g.timer); g.timer = null; }
      if (g.longFired) { e.preventDefault(); return; }
      if (!g.locked) {
        if (Math.abs(g.dx) < LOCK_MIN && Math.abs(g.dy) < LOCK_MIN) return;
        g.locked = Math.abs(g.dx) > Math.abs(g.dy) * 1.2 ? "x" : "y";
      }
      // swipe RIGHT on a message to reply (the user's preference, 2026-09-27: it used to be left, like Telegram);
      // any other horizontal swipe in the chat leaves it (initNavGesture)
      if (g.locked !== "x" || g.dx <= 0) return;
      e.preventDefault();
      const dx = Math.min(g.dx, REPLY_MAX);
      const swipe = g.wrap.querySelector(".gh-msg-swipe");
      swipe.style.setProperty("--gh-swipe-x", dx * 0.72 * pagePxToLocal() + "px");
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
  const REACTION_EMOJIS = ["\u2764\uFE0F", "\uD83D\uDE02", "\uD83D\uDD25", "\uD83D\uDC4D", "\uD83D\uDE2E", "\uD83D\uDE22", "\uD83D\uDC80"]; // Snapchat's own reaction set (sent as its reaction ids)
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
        <div class="gh-action-item" data-act="bookmark"></div>
        <div class="gh-action-item" data-act="fav"></div>
        <div class="gh-action-item" data-act="photos"></div>
        <div class="gh-action-item gh-action-danger" data-act="delete"></div>
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
    const more = el("button", "gh-react-more gh-press");
    more.appendChild(icon("plus", 20));
    more.setAttribute("aria-label", "More reactions");
    reactRow.appendChild(more);
    const replyItem = sheet.querySelector('[data-act="reply"]');
    replyItem.append(icon("reply"), textSpan("Reply"));
    const copyItem = sheet.querySelector('[data-act="copy"]');
    copyItem.append(icon("copy"), textSpan("Copy"));
    const saveItem = sheet.querySelector('[data-act="save"]');
    saveItem.append(icon("star"), textSpan("Save"));
    const bookmarkItem = sheet.querySelector('[data-act="bookmark"]');
    bookmarkItem.append(icon("bookmark"), textSpan("Bookmark"));
    const favItem = sheet.querySelector('[data-act="fav"]');
    favItem.append(icon("emoji"), textSpan("Add to Favorite Stickers"));
    const photosItem = sheet.querySelector('[data-act="photos"]');
    photosItem.append(icon("download"), textSpan("Save to Photos"));
    const delItem = sheet.querySelector('[data-act="delete"]');
    delItem.append(icon("trash"), textSpan("Delete for Everyone"));

    overlaysRoot.appendChild(backdrop);
    overlaysRoot.appendChild(sheet);
    function textSpan(t) { const s = el("span"); s.textContent = t; return s; }

    const s = { backdrop, sheet, reactRow, replyItem, copyItem, saveItem, bookmarkItem, favItem, delItem, photosItem, message: null, liftedEl: null };
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
    for (const item of [s.reactRow, s.replyItem, s.saveItem]) item.style.display = message.retained ? "none" : "";
    for (const b of s.reactRow.querySelectorAll(".gh-react-emoji")) {
      const mine = (message.reactions || []).some((r) => r.emoji === b.dataset.emoji && r.from && r.from.id === meId);
      b.dataset.mine = mine ? "1" : "0";
      b.onclick = () => {
        haptic("light");
        api.react(convId, message.id, mine ? null : b.dataset.emoji).catch(() => {});
        s.close();
      };
    }
    s.reactRow.querySelector(".gh-react-more").onclick = () => { haptic("light"); s.close(); openEmojiReactPicker(ctx, convId, message); };
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
    s.bookmarkItem.querySelector("span").textContent = isBookmarked(convId, message.id) ? "Remove Bookmark" : "Bookmark";
    s.bookmarkItem.onclick = () => { s.close(); haptic("light"); toggleBookmark(ctx, convId, message); };
    const isSticker = message.kind === "sticker" || message.kind === "gif";
    s.favItem.style.display = isSticker ? "" : "none";
    s.favItem.onclick = () => { s.close(); favoriteSticker(ctx, message, wrapEl); };
    const isMedia = message.kind === "chat-media" || message.kind === "gif" || message.kind === "sticker";
    s.photosItem.style.display = isMedia ? "" : "none";
    s.photosItem.onclick = async () => {
      s.close();
      const el0 = wrapEl && wrapEl.querySelector("video, img");
      const src = el0 && (el0.currentSrc || el0.src);
      if (src) saveRefToPhotos(ctx, { url: src, type: el0.tagName === "VIDEO" ? "video" : "image" });
      else { const list = await fetchMediaFor(message); if (list[0]) saveRefToPhotos(ctx, list[0]); else ctx.showToast("Still loading - try again"); }
    };
    const mineMsg = !!(message.fromMe || (message.from && message.from.id === meId));
    s.delItem.style.display = mineMsg && !message.retained ? "" : "none";
    s.delItem.onclick = async () => {
      s.close();
      haptic("medium");
      if (wrapEl) wrapEl.classList.add("gh-msg-deleting");
      try { await api.deleteMessage(convId, message.id); }
      catch (e) { if (wrapEl) wrapEl.classList.remove("gh-msg-deleting"); ctx.showToast("Couldn't delete that message"); }
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
  // header: fully opaque (no alpha) on purpose - it's the fixed bar/tab-bar tint drawn over a continuously
  // scrolling list, and a translucent value there depends on the compositor re-blending it every frame,
  // which is exactly the one place a list row must never show through (device-observed 2026-09-27).
  const THEMES = {
    night:    { name: "Night",    app: "#0e161f", list: "#17212b", header: "rgb(21,30,39)", panel: "#1c2733", panel2: "#24313f", input: "#253340", in1: "#1c2936", in2: "#18232e", sub: "#8b98a5", ter: "#64707c", pill: "rgb(30,44,58)" },
    midnight: { name: "Midnight", app: "#000000", list: "#000000", header: "rgb(10,10,12)", panel: "#121214", panel2: "#1c1c1f", input: "#1c1c1f", in1: "#1f1f22", in2: "#1a1a1d", sub: "#8e8e93", ter: "#636366", pill: "rgb(28,28,31)" },
    ocean:    { name: "Ocean",    app: "#071a24", list: "#0c2330", header: "rgb(11,32,44)", panel: "#11303f", panel2: "#173b4c", input: "#183c4d", in1: "#123344", in2: "#0f2b3a", sub: "#86a6b5", ter: "#5e7d8b", pill: "rgb(17,48,63)" },
    forest:   { name: "Forest",   app: "#0b1712", list: "#12211a", header: "rgb(17,31,24)", panel: "#182b22", panel2: "#20372c", input: "#21382d", in1: "#1a2f25", in2: "#16291f", sub: "#8fa89a", ter: "#667d71", pill: "rgb(24,43,34)" },
    grape:    { name: "Grape",    app: "#130e1f", list: "#1b1529", header: "rgb(26,20,40)", panel: "#231b36", panel2: "#2d2443", input: "#2e2545", in1: "#261e39", in2: "#211a32", sub: "#a197b8", ter: "#776e8e", pill: "rgb(35,27,54)" },
    ember:    { name: "Ember",    app: "#1a0f0c", list: "#231612", header: "rgb(35,22,18)", panel: "#2e1d18", panel2: "#3a261f", input: "#3b2720", in1: "#31201a", in2: "#2a1b16", sub: "#b39a90", ter: "#86706a", pill: "rgb(46,29,24)" },
    graphite: { name: "Graphite", app: "#141517", list: "#1c1d20", header: "rgb(28,29,32)", panel: "#25262a", panel2: "#2e3035", input: "#2f3136", in1: "#27292d", in2: "#222428", sub: "#9a9ca3", ter: "#71737a", pill: "rgb(37,38,42)" },
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
    liveAurora: { name: "Aurora Live", live: "aurora", css: "none", size: "auto", pos: "0 0" },
    liveLava:   { name: "Lava Live", live: "lava", css: "none", size: "auto", pos: "0 0" },
    liveStars:  { name: "Stars Live", live: "stars", css: "none", size: "auto", pos: "0 0" },
    grid:   { name: "Grid", css: "linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)", size: "28px 28px, 28px 28px", pos: "0 0, 0 0" },
  };
  const PREF_DEFAULTS = {
    theme: "night", accent: "blue", wallpaper: "aurora", textScale: 1, bubbleRadius: 17, bubbleStyle: "gradient",
    compactList: false, showStoriesRail: true, avatars: "bitmoji", hidePreviews: false, readReceipts: true,
    doubleTapCamera: true, autoplayGifs: true, sendOnReturn: false, showTimes: true, showTyping: true,
    wallDim: 0.25, wallFit: "fill", chatWalls: {}, customAvatars: {}, pinnedChats: [], hiddenChats: [], streakKeeper: {}, nicknames: {},
    bookmarks: [], chatBubbles: {},
  };
  let prefs = Object.assign({}, PREF_DEFAULTS);
  // Ghost nicknames: Snapchat Web's gateway doesn't allow changing a friend's display name (ChangeDisplayNameForFriends
  // - like RemoveFriends/BlockFriends - answers "Response closed without headers", device-probed 2026-09-27), so a
  // nickname is Ghost's own, kept on this phone and swapped in for every {id, name} person the bridge hands over.
  function nickify(data, depth) {
    let nicks = null; try { nicks = (prefs && prefs.nicknames) || null; } catch (e) { return data; }
    if (!data || typeof data !== "object" || (depth || 0) > 6) return data;
    if (Array.isArray(data)) { for (const x of data) nickify(x, (depth || 0) + 1); return data; }
    if (typeof data.id === "string" && typeof data.name === "string") {
      const n = nicks && nicks[data.id];
      if (n) { if (data._realName === undefined) data._realName = data.name; data.name = n; }
      else if (data._realName !== undefined) { data.name = data._realName; delete data._realName; }
    }
    // a 1:1 chat is titled by the person
    if (Array.isArray(data.participants) && data.isGroup === false && data.participants.length === 1) {
      const p = data.participants[0]; nickify(p, (depth || 0) + 1);
      const n = nicks && p && nicks[p.id];
      if (n) { if (data._realTitle === undefined) data._realTitle = data.title; data.title = n; }
      else if (data._realTitle !== undefined) { data.title = data._realTitle; delete data._realTitle; }
    }
    for (const k of ["from", "participants", "users", "conversations", "messages", "replyTo", "reactions", "me", "calls", "remote"]) if (data[k] && typeof data[k] === "object") nickify(data[k], (depth || 0) + 1);
    return data;
  }
  async function setNickname(ctx, userId, name) {
    const all = Object.assign({}, pref("nicknames") || {});
    if (name) all[userId] = name; else delete all[userId];
    setPref(ctx, "nicknames", all);
    // re-apply to what's already on screen: the chat list, the open chat
    const convs = Array.from(ctx.state.convById.values());
    nickify(convs);
    for (const e of ctx.state.messagesByConv.values()) nickify(e.messages);
    try { applyConversations(ctx, await api.listConversations()); } catch (e) {}
    const cd = ctx.state.currentConvId && ctx.state.convById.get(ctx.state.currentConvId);
    if (cd) { updateConvHeader(ctx, cd); if (ctx.conv) paintWindow(ctx, ctx.conv); }
  }
  function pref(k) { return Object.prototype.hasOwnProperty.call(prefs, k) ? prefs[k] : PREF_DEFAULTS[k]; }
  async function loadPrefs(ctx) {
    try { prefs = Object.assign({}, PREF_DEFAULTS, await storage.get("ghostPrefs", {})); } catch (e) {}
    loadCustomAvatars().then(() => { if (customAvatarUrls.size) refreshAvatars(ctx); }).catch(() => {});
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
    if (ctx.state && ctx.state.currentConvId) applyChatWallpaper(ctx, ctx.state.currentConvId);
    // the app's own background (seen for a moment while the keyboard moves) follows the theme
    try { window.webkit.messageHandlers.dg.postMessage({ op: "trail", text: "GHOST theme " + pref("theme") + "/" + pref("accent") }).catch(() => {}); } catch (e) {}
    if (ctx.lastRR !== !!pref("readReceipts")) { ctx.lastRR = !!pref("readReceipts"); api.setReadReceipts(ctx.lastRR).catch(() => {}); }
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
    s.stack = []; s.rootLabel = null;
    s.el.dataset.open = "1";
    pushSettingsPage(ctx, "main");
  }
  function closeSettings(ctx) {
    const s = ctx.settings;
    // A page like `gallery` can hand back a dispose() that tears down its own IntersectionObserver/etc; a
    // direct close (e.g. tapping a media tile) skips popSettingsPage for every level, so every page still on
    // the stack needs disposing here too, or its observer/tiles stay alive for the rest of the session.
    for (const entry of s.stack) if (entry.dispose) entry.dispose();
    s.el.dataset.open = "0";
    setTimeout(() => { if (s.el.dataset.open !== "1") s.el.innerHTML = ""; }, 320);
  }
  function pushSettingsPage(ctx, name) {
    const s = ctx.settings;
    const page = el("div", "gh-set-page");
    const prev = s.stack[s.stack.length - 1];
    const head = el("div", "gh-set-head");
    const back = el("button", "gh-set-back gh-hit");
    back.append(icon("back", 22), Object.assign(el("span"), { textContent: prev ? SETTINGS_TITLES[prev.name] : (s.rootLabel || "Chats") }));
    back.addEventListener("click", () => { haptic("light"); popSettingsPage(ctx); });
    const title = el("div", "gh-set-title"); title.textContent = SETTINGS_TITLES[name];
    head.append(back, title, el("div", "gh-set-head-spacer"));
    const body = el("div", "gh-set-body gh-scroll");
    page.append(head, body);
    // A page can optionally return a dispose() (e.g. gallery's IntersectionObserver); kept on the stack entry
    // so popSettingsPage/closeSettings/refresh can tear it down instead of leaking it.
    const initialDispose = SETTINGS_PAGES[name](ctx, body, page);
    const entry = { name, page, dispose: typeof initialDispose === "function" ? initialDispose : null };
    s.el.appendChild(page);
    s.stack.push(entry);
    page.dataset.in = "0";
    requestAnimationFrame(() => requestAnimationFrame(() => { if (prev) prev.page.dataset.under = "1"; page.dataset.in = "1"; }));
    // values shown on this page (e.g. the theme name) are rebuilt when you come back to it
    entry.refresh = () => { if (entry.dispose) entry.dispose(); body.innerHTML = ""; const d = SETTINGS_PAGES[name](ctx, body, page); entry.dispose = typeof d === "function" ? d : null; };
    // swipe from the left edge to go back, like every iOS screen
    let x0 = null, dx = 0;
    page.addEventListener("touchstart", (e) => { const t = e.touches[0]; x0 = t.clientX < 28 ? t.clientX : null; dx = 0; }, { passive: true });
    page.addEventListener("touchmove", (e) => { if (x0 == null) return; dx = Math.max(0, e.touches[0].clientX - x0); page.style.transition = "none"; page.style.transform = `translateX(${dx * pagePxToLocal()}px)`; }, { passive: true });
    page.addEventListener("touchend", () => { if (x0 == null) return; page.style.transition = ""; page.style.transform = ""; if (dx > 90) popSettingsPage(ctx); x0 = null; }, { passive: true });
  }
  function popSettingsPage(ctx) {
    const s = ctx.settings;
    if (s.stack.length <= 1) { closeSettings(ctx); return; }
    const top = s.stack.pop();
    const prev = s.stack[s.stack.length - 1];
    if (top.dispose) top.dispose();
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

  const SETTINGS_TITLES = { gallery: "Media & Links", bookmarks: "Bookmarks", friends: "Friends", friend: "Friend", hidden: "Hidden Chats", main: "Settings", appearance: "Appearance", chats: "Chats", privacy: "Privacy", media: "Stickers & GIFs", storage: "Storage & Data", about: "About Ghost" };
  const SETTINGS_PAGES = {
    // Every photo/video (and saved snap) and every link in the open chat, newest first. Older history loads on
    // demand. Only what Snapchat Web can still fetch shows up (media that has expired on Snapchat's side can't).
    gallery(ctx, body) {
      const convId = ctx.settings.galleryConv || ctx.state.currentConvId;
      const seg = el("div", "gh-seg");
      const tabs = [["media", "Media"], ["links", "Links"]];
      let tab = ctx.settings.galleryTab || "media";
      for (const [k, l] of tabs) { const b = el("button", "gh-seg-btn gh-press"); b.textContent = l; b.dataset.k = k; b.addEventListener("click", () => { haptic("light"); tab = ctx.settings.galleryTab = k; paint(); }); seg.appendChild(b); }
      const content = el("div", "gh-gallery");
      const more = el("button", "gh-gallery-more gh-press");
      body.append(seg, content, more);
      const io = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); e.target._load && e.target._load(); }
      }, { root: body, rootMargin: "300px" }) : null;
      const messages = () => ((ctx.state.messagesByConv.get(convId) || {}).messages || []);
      const paint = () => {
        for (const b of seg.children) b.dataset.on = b.dataset.k === tab ? "1" : "0";
        content.innerHTML = "";
        const all = messages().slice().reverse();
        if (tab === "media") {
          const items = all.filter((m) => m.kind === "chat-media" || (m.kind === "snap" && m.saved));
          const grid = el("div", "gh-gallery-grid");
          for (const m of items) {
            const t = el("button", "gh-gallery-tile gh-press");
            if (m.kind === "snap") t.dataset.snap = "1";
            t._load = () => fetchMediaFor(m).then((list) => {
              t._list = list;
              const r = list[0];
              if (!r) { t.dataset.empty = "1"; return; }
              if (r.type === "video") { const v = el("video"); v.muted = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.preload = "metadata"; v.src = r.url + (r.url.includes("#") ? "" : "#t=0.1"); t.appendChild(v); t.dataset.video = "1"; }
              else { const im = el("img"); im.alt = ""; im.loading = "lazy"; im.src = r.url; t.appendChild(im); }
            });
            t.addEventListener("click", async () => {
              const list = t._list || await fetchMediaFor(m);
              if (list && list.length) openViewerSequence(ctx, list, { title: (m.fromMe ? "You" : (m.from && m.from.name) || "") + " · " + fmtClock(m.ts) });
              else ctx.showToast("That one isn't available anymore");
            });
            grid.appendChild(t);
            if (io) io.observe(t); else t._load();
          }
          if (!items.length) { const e = el("div", "gh-set-group-foot"); e.textContent = "No photos or videos in the messages loaded so far."; content.appendChild(e); }
          else content.appendChild(grid);
        } else {
          const rows = [];
          for (const m of all) {
            if (m.kind !== "text") continue;
            const found = String(m.text || "").match(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]']/gi) || [];
            for (const u of found) rows.push({ u, m });
          }
          if (!rows.length) { const e = el("div", "gh-set-group-foot"); e.textContent = "No links in the messages loaded so far."; content.appendChild(e); }
          else {
            const g = setGroup(content);
            for (const { u, m } of rows) {
              const row = el("button", "gh-set-row gh-press gh-link-row");
              let host = u; try { host = new URL(u).hostname.replace(/^www\./, ""); } catch (e) {}
              const ic = el("span", "gh-link-ic"); ic.textContent = (host[0] || "?").toUpperCase();
              const col = el("div", "gh-set-label");
              const h = el("div", "gh-link-host"); h.textContent = host;
              const full = el("div", "gh-link-url"); full.textContent = u;
              const who = el("div", "gh-link-who"); who.textContent = (m.fromMe ? "You" : (m.from && m.from.name) || "") + " · " + fmtDaySeparator(m.ts);
              col.append(h, full, who); row.append(ic, col);
              row.addEventListener("click", () => openLink(u));
              g.appendChild(row);
            }
          }
        }
        const hasMore = (ctx.state.currentConvId === convId && ctx.conv && ctx.conv._hasMore);
        more.style.display = hasMore ? "" : "none";
        more.textContent = "Load Older Messages";
      };
      more.addEventListener("click", async () => {
        if (more.dataset.busy) return;
        more.dataset.busy = "1"; more.textContent = "Loading…";
        await fetchOlderPages(ctx, 5);
        delete more.dataset.busy; paint();
      });
      paint();
      // Tiles that never scrolled into view stay registered on `io` forever otherwise - the observer holds a
      // strong reference to every observed (even now-detached) target for the life of the page, and this page
      // is rebuilt from scratch on every visit/refresh (see pushSettingsPage's dispose plumbing).
      return () => { if (io) io.disconnect(); };
    },
    // Bookmarks: messages you marked (hold a message > Bookmark). Only on this phone - Snapchat never sees them.
    bookmarks(ctx, body) {
      const only = ctx.settings.bookmarksConv || null;
      const paint = () => {
        body.innerHTML = "";
        const list = (pref("bookmarks") || []).filter((b) => !only || b.convId === only);
        if (!list.length) {
          const e = el("div", "gh-empty-note");
          e.appendChild(icon("bookmark", 34));
          const t = el("div"); t.textContent = "No bookmarks yet"; const t2 = el("div", "gh-empty-sub"); t2.textContent = "Hold any message and tap Bookmark to keep it here.";
          e.append(t, t2); body.appendChild(e); return;
        }
        const g = setGroup(body, null, "Bookmarks stay on this phone only.");
        for (const b of list) {
          const row = el("div", "gh-set-row gh-press gh-bm-row");
          const col = el("div", "gh-set-label");
          const top = el("div", "gh-bm-top"); top.textContent = (only ? "" : (b.chat || "Chat") + " · ") + (b.from || "") + " · " + fmtDaySeparator(b.ts);
          const txt = el("div", "gh-bm-text"); txt.textContent = b.text || "Message";
          col.append(top, txt);
          const x = el("button", "gh-bm-remove gh-hit"); x.setAttribute("aria-label", "Remove bookmark"); x.appendChild(icon("close", 16));
          x.addEventListener("click", (e) => {
            e.stopPropagation(); haptic("light");
            setPref(ctx, "bookmarks", (pref("bookmarks") || []).filter((y) => !(y.convId === b.convId && y.id === b.id)));
            if (ctx.conv && ctx.state.currentConvId === b.convId) paintWindow(ctx, ctx.conv);
            paint();
          });
          row.append(col, x);
          row.addEventListener("click", () => { haptic("light"); openBookmark(ctx, b); });
          g.appendChild(row);
        }
      };
      paint();
    },
    // Friends: search anyone by username and add them, answer friend requests, and manage the people you have
    // (nickname / remove / block). Bridge: findUsers, friendRequests, addFriend, ignoreFriend, removeFriend,
    // blockFriend, setNickname - Snapchat's own FriendAction service, so it all shows up in the real app too.
    friends(ctx, body) {
      const bar = el("div", "gh-friends-search");
      const input = el("input"); input.type = "search"; input.placeholder = "Search username or name"; input.autocomplete = "off"; input.setAttribute("autocapitalize", "off");
      bar.append(icon("search", 17), input);
      body.appendChild(bar);
      const reqBox = el("div"), findBox = el("div"), mineBox = el("div");
      body.append(reqBox, findBox, mineBox);
      const statusLabel = { friend: "Friends", requested: "Requested", "added-me": "Accept", none: "Add" };
      const personRow = (g, u, actions) => {
        const row = el("div", "gh-set-row gh-friend-row");
        row.appendChild(makeAvatar(u, 40));
        const col = el("div", "gh-set-label gh-friend-text");
        const n = el("div", "gh-friend-name"); n.textContent = u.name || u.username || "Snapchatter";
        const un = el("div", "gh-friend-user"); un.textContent = [u.username ? "@" + u.username : "", u.source || ""].filter(Boolean).join(" \u00b7 ");
        col.append(n, un); row.appendChild(col);
        for (const a of actions) {
          const b = el("button", "gh-friend-btn gh-press" + (a.ghost ? " gh-friend-btn-ghost" : ""));
          b.textContent = a.label; b.disabled = !!a.disabled;
          b.addEventListener("click", async (e) => {
            e.stopPropagation(); haptic("light"); b.disabled = true;
            try { await a.run(); } catch (err) { ctx.showToast(String(err && err.message || err || "Couldn't do that")); b.disabled = false; }
          });
          row.appendChild(b);
        }
        g.appendChild(row);
        return row;
      };
      const paintRequests = async () => {
        reqBox.innerHTML = "";
        const reqs = await api.friendRequests().catch(() => []);
        ctx.friendReqCount = reqs.length;
        if (!reqs.length) return;
        const g = setGroup(reqBox, "Added Me");
        for (const u of reqs) {
          personRow(g, u, [
            { label: "Accept", run: async () => { await api.addFriend(u.id); ctx.showToast("You and " + (u.name || "them") + " are friends now"); paintRequests(); } },
            { label: "Ignore", ghost: true, run: async () => { await api.ignoreFriend(u.id); paintRequests(); } },
          ]);
        }
      };
      const friendsCache = { list: null };
      const paintMine = async (q) => {
        if (!friendsCache.list) friendsCache.list = await api.searchFriends("").catch(() => []);
        mineBox.innerHTML = "";
        const ql = (q || "").toLowerCase();
        const list = (friendsCache.list || []).filter((u) => !ql || (u.name || "").toLowerCase().includes(ql) || (u.username || "").toLowerCase().includes(ql)).slice(0, 80);
        if (!list.length) return;
        const g = setGroup(mineBox, "My Friends");
        for (const u of list) {
          const row = personRow(g, u, []);
          row.classList.add("gh-press"); row.appendChild(icon("back", 16, "gh-set-chev"));
          row.addEventListener("click", () => { haptic("light"); ctx.settings.friendTarget = u; pushSettingsPage(ctx, "friend"); });
        }
      };
      let seq = 0, timer = null;
      const sent = new Map(); // added from here: Snapchat's lists take a moment to catch up
      const paintFind = async (q) => {
        const mine = ++seq;
        findBox.innerHTML = "";
        if (q.length < 3) { if (q) { const f = el("div", "gh-set-group-foot"); f.textContent = "Type at least 3 letters to search everyone on Snapchat."; findBox.appendChild(f); } return; }
        const g = setGroup(findBox, "Add Friends");
        const wait = el("div", "gh-set-row gh-friend-wait"); wait.textContent = "Searching…"; g.appendChild(wait);
        let users = [];
        try { users = await api.findUsers(q); } catch (e) { if (mine === seq) wait.textContent = "Couldn't search - " + (e && e.message || "try again"); return; }
        if (mine !== seq) return;
        wait.remove();
        if (!users.length) { const n = el("div", "gh-set-row gh-friend-wait"); n.textContent = "No one found"; g.appendChild(n); return; }
        for (const u of users) {
          const st = sent.get(u.id) || u.friendStatus || "none";
          personRow(g, u, [{ label: statusLabel[st], disabled: st === "friend" || st === "requested", run: async () => {
            await api.addFriend(u.id);
            sent.set(u.id, st === "added-me" ? "friend" : "requested");
            ctx.showToast(st === "added-me" ? "Friend added" : "Friend request sent");
            paintFind(input.value.trim());
          } }]);
        }
      };
      input.addEventListener("input", () => {
        const q = input.value.trim();
        paintMine(q);
        clearTimeout(timer); timer = setTimeout(() => paintFind(q), 350);
      });
      paintRequests(); paintMine("");
    },
    friend(ctx, body) {
      const u = ctx.settings.friendTarget;
      if (!u) return;
      const prof = el("div", "gh-set-profile");
      prof.appendChild(makeAvatar(u, 84));
      const nm = el("div", "gh-set-profile-name"); nm.textContent = u.name || "Friend";
      const un = el("div", "gh-set-profile-user"); un.textContent = u.username ? "@" + u.username : "";
      prof.append(nm, un); body.appendChild(prof);
      let g = setGroup(body, null, "Nicknames show in Ghost only (Snapchat Web can't change names on Snapchat). Leave it empty to use their own name.");
      setRow(g, { icon: "edit", tint: "#3e88f7", label: "Edit Nickname", onClick: async () => {
        const v = await promptSheet(ctx, "Nickname for " + (u.username ? "@" + u.username : (u._realName || u.name)), (pref("nicknames") || {})[u.id] || "");
        if (v == null) return;
        await setNickname(ctx, u.id, v); nickify(u); nm.textContent = u.name;
        ctx.showToast(v ? "Nickname saved" : "Nickname removed");
      } });
      setRow(g, { icon: "newMsg", tint: "#23a55a", label: "Chat", onClick: async () => {
        try {
          const res = await api.newConversation([u.id]);
          if (res && res.conversationId) { closeSettings(ctx); if (!ctx.state.convById.has(res.conversationId)) await api.listConversations().then((cs) => applyConversations(ctx, cs || [])); openConversationScreen(ctx, res.conversationId); }
        } catch (e) { ctx.showToast("Couldn't open that chat"); }
      } });
      // (Remove/Block: Snapchat Web's gateway refuses those calls - use the Snapchat app for them)
    },
    main(ctx, body) {
      const me = ctx.state.me || {};
      const prof = el("div", "gh-set-profile");
      prof.appendChild(makeAvatar(me, 84));
      const nm = el("div", "gh-set-profile-name"); nm.textContent = me.name || "You";
      const un = el("div", "gh-set-profile-user"); un.textContent = me.username ? "@" + me.username : "";
      prof.append(nm, un);
      body.appendChild(prof);
      let g = setGroup(body);
      setRow(g, { icon: "bookmark", tint: "linear-gradient(135deg,#f0b232,#ff9433)", label: "Bookmarks", value: String((pref("bookmarks") || []).length || ""), onClick: () => { ctx.settings.bookmarksConv = null; pushSettingsPage(ctx, "bookmarks"); } });
      setRow(g, { icon: "addFriend", tint: "linear-gradient(135deg,#23a55a,#1fb8c4)", label: "Friends", value: ctx.friendReqCount ? String(ctx.friendReqCount) : "", onClick: () => pushSettingsPage(ctx, "friends") });
      g = setGroup(body);
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
      // App icon (iOS alternate icons, built into the app: ios/Resources/Assets.xcassets/AppIcon*.appiconset)
      g = setGroup(body, "App Icon", "iOS shows a short notice when the icon changes.");
      const icons = el("div", "gh-set-icons");
      const ICONS = [["default", "Ghost", "linear-gradient(180deg,#5764f1,#4a52d6)", "#fff"], ["AppIconMidnight", "Midnight", "linear-gradient(135deg,#181820,#000)", "#fff"],
        ["AppIconSunset", "Sunset", "linear-gradient(135deg,#ff9a44,#ec407a)", "#fff"], ["AppIconMint", "Mint", "linear-gradient(135deg,#2ecc8e,#16a085)", "#fff"],
        ["AppIconSnap", "Snap", "#fffc00", "#fff"], ["AppIconBerry", "Berry", "linear-gradient(135deg,#9b59f6,#ff5c9e)", "#fff"], ["AppIconGlass", "Glass", "linear-gradient(135deg,#283040,#0c0e14)", "#aac8ff"]];
      const paintIcons = (curName) => { for (const c of icons.children) c.dataset.on = c.dataset.k === curName ? "1" : "0"; };
      for (const [k, name, bg, fg] of ICONS) {
        const c = el("button", "gh-set-appicon gh-press"); c.dataset.k = k;
        const art = el("span", "gh-set-appicon-art"); art.style.background = bg; art.style.color = fg;
        if (k === "AppIconSnap") art.dataset.outline = "1";
        art.appendChild(icon("ghost", 30));
        const n = el("span", "gh-set-appicon-name"); n.textContent = name;
        c.append(art, n);
        c.addEventListener("click", async () => {
          haptic("light");
          try { await window.webkit.messageHandlers.dg.postMessage({ op: "appIcon", name: k }); paintIcons(k); }
          catch (e) { ctx.showToast("Couldn't change the icon" + (e && e.message ? " (" + e.message + ")" : "")); }
        });
        icons.appendChild(c);
      }
      g.appendChild(icons);
      paintIcons("default");
      try { window.webkit.messageHandlers.dg.postMessage({ op: "appIcon", get: true }).then((n) => paintIcons(n || "default"), () => {}); } catch (e) {}
      g = setGroup(body, "Chat Wallpaper", "Your default for every chat. Tap a chat's name to give that chat its own - it keeps it whatever you pick here.");
      const walls = el("div", "gh-set-cards");
      const dimHost = el("div");
      const paintWalls = async () => {
        walls.innerHTML = "";
        const photo = await wallUrl("default");
        const pc = el("button", "gh-set-wall gh-press");
        if (photo) { pc.style.backgroundImage = `url("${photo}")`; pc.style.backgroundSize = "cover"; pc.style.backgroundPosition = "center"; }
        else pc.appendChild(icon("photo", 26, "gh-wall-photo-ico"));
        const pn = el("span"); pn.textContent = photo ? "Photo" : "Choose Photo"; pc.appendChild(pn);
        pc.dataset.on = pref("wallpaper") === "photo" ? "1" : "0";
        pc.addEventListener("click", async () => {
          haptic("light");
          if (photo && pref("wallpaper") !== "photo") { setPref(ctx, "wallpaper", "photo"); paintWalls(); return; }
          const f = await pickPhoto(); if (!f) return;
          try { await saveWallPhoto("default", f); setPref(ctx, "wallpaper", "photo"); paintWalls(); }
          catch (e) { ctx.showToast("Couldn't use that photo"); }
        });
        walls.appendChild(pc);
        for (const [key, w] of Object.entries(WALLPAPERS)) {
          const c = el("button", "gh-set-wall gh-press");
          c.style.backgroundImage = w.css; c.style.backgroundSize = w.size; c.style.backgroundPosition = w.pos;
          const n = el("span"); n.textContent = w.name; c.appendChild(n);
          if (w.live) c.dataset.live = w.live;
          c.dataset.on = pref("wallpaper") === key ? "1" : "0";
          c.addEventListener("click", () => { haptic("light"); setPref(ctx, "wallpaper", key); paintWalls(); });
          walls.appendChild(c);
        }
        dimHost.innerHTML = "";
        if (pref("wallpaper") === "photo") {
          const cap = el("div", "gh-set-group-title"); cap.textContent = "Darken Photo";
          const dg = el("div", "gh-set-group");
          setSlider(dg, { min: 0, max: 0.7, step: 0.05, minLabel: "☀︎", maxLabel: "☾", get: () => pref("wallDim"), set: (v) => setPref(ctx, "wallDim", v) });
          const change = el("div", "gh-set-group");
          setRow(change, { label: "Change Photo…", onClick: async () => { const f = await pickPhoto(); if (!f) return; try { await saveWallPhoto("default", f); applyPrefs(ctx); paintWalls(); } catch (e) { ctx.showToast("Couldn't use that photo"); } } });
          const fcap = el("div", "gh-set-group-title"); fcap.textContent = "Photo Size";
          const fg = el("div", "gh-set-group");
          setChoice(fg, [["fill", "Fill Screen (zoom)"], ["fit", "Whole Photo (black bars)"]], () => pref("wallFit"), (v) => setPref(ctx, "wallFit", v));
          dimHost.append(cap, dg, fcap, fg, change);
        }
      };
      g.appendChild(walls);
      body.appendChild(dimHost);
      paintWalls();
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
      g = setGroup(body);
      setRow(g, { label: "Hidden Chats", value: String((pref("hiddenChats") || []).length), onClick: () => pushSettingsPage(ctx, "hidden") });
      g = setGroup(body, "Voice Messages");
      setChoice(g, [["1", "Normal Speed"], ["1.5", "1.5×"], ["2", "2×"]], () => String(nativeSetting("voiceNoteSpeed", "1")), (v) => setNativeSetting("voiceNoteSpeed", v));
    },
    hidden(ctx, body) {
      const ids = pref("hiddenChats") || [];
      if (!ids.length) { const e = el("div", "gh-set-group-foot"); e.textContent = "No hidden chats. Hold a chat in your list and tap Hide Chat."; body.appendChild(e); return; }
      const g = setGroup(body, null, "Tap Unhide to put a chat back in your list.");
      for (const id of ids) {
        const cd = ctx.state.convById.get(id) || { title: "Chat" };
        const row = el("div", "gh-set-row");
        row.appendChild(makeAvatar(convAvatarUser(cd), 34));
        const l = el("span", "gh-set-label"); l.textContent = cd.title || "Chat"; row.appendChild(l);
        const b = el("button", "gh-set-unhide"); b.textContent = "Unhide";
        b.addEventListener("click", () => { haptic("light"); setHidden(ctx, id, false); row.remove(); });
        const open = el("button", "gh-set-unhide gh-set-open"); open.textContent = "Open";
        open.addEventListener("click", () => { closeSettings(ctx); openConversationScreen(ctx, id); });
        row.append(open, b);
        g.appendChild(row);
      }
    },
    privacy(ctx, body) {
      let g = setGroup(body, null, "Turn off to read chats without friends seeing \"Opened\". Snaps still count when you open them.");
      setRow(g, { label: "Send Read Receipts", toggle: { get: () => !!pref("readReceipts"), set: (v) => setPref(ctx, "readReceipts", v) } });
      g = setGroup(body, null, "Friends see \"typing…\" while you write to them.");
      setRow(g, { label: "Show When I'm Typing", toggle: { get: () => !!pref("showTyping"), set: (v) => setPref(ctx, "showTyping", v) } });
      g = setGroup(body, null, "Covers Ghost in the app switcher and while your screen is recorded or mirrored. (iPhones don't let apps block a normal screenshot.)");
      setRow(g, { label: "Privacy Shield", toggle: { get: () => nativeSetting("privacyShield", true) !== false, set: (v) => setNativeSetting("privacyShield", v) } });
      g = setGroup(body, null, "Blurs message previews in the chat list until you open the chat.");
      setRow(g, { label: "Hide Message Previews", toggle: { get: () => !!pref("hidePreviews"), set: (v) => setPref(ctx, "hidePreviews", v) } });
      g = setGroup(body, null, "Your Bitmoji in chats you have open.");
      setRow(g, { label: "Show Me in Chats", toggle: { get: () => nativeSetting("showInChats", true) !== false, set: (v) => setNativeSetting("showInChats", v) } });
    },
    media(ctx, body) {
      let g = setGroup(body);
      setRow(g, { label: "Autoplay GIFs", toggle: { get: () => !!pref("autoplayGifs"), set: (v) => setPref(ctx, "autoplayGifs", v) } });
      g = setGroup(body);
      setRow(g, { label: "Clear Recent Stickers", danger: true, onClick: async () => { await storage.set("ghostStickerRecents", []); ctx.showToast("Recent stickers cleared"); } });
      setRow(g, { label: "Clear Recent GIFs", danger: true, onClick: async () => { await storage.set("ghostGifRecents", []); ctx.showToast("Recent GIFs cleared"); } });
    },
    storage(ctx, body) {
      buildRetentionSettings(ctx, body);
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

  function buildRetentionSettings(ctx, body) {
    const clearLocalViews = () => {
      mediaCache.clear();
      for (const [id, entry] of ctx.state.messagesByConv) ctx.state.messagesByConv.set(id, { ...entry, messages: entry.messages.filter((m) => !m.retained) });
    };
    const group = setGroup(body, "Deleted Messages", "Keeps text and chat media on this device for up to 30 days, within 500 MB total. Oldest copies are removed first. Individual media downloads are limited to 50 MB. Unopened snaps aren't captured. Messages deleted before Ghost receives them can't be recovered.");
    const status = el("div", "gh-set-group-foot"); status.textContent = "Loading archive…"; group.appendChild(status);
    let clearArmedUntil = 0;
    const paint = (info) => {
      group.replaceChildren();
      const toggle = setRow(group, { label: "Retain Deleted Messages", toggle: { get: () => info.enabled, set: async (on) => {
        toggle.style.pointerEvents = "none";
        try { if (!on) clearLocalViews(); paint(await api.configureRetention(on)); }
        catch (e) { paint(info); ctx.showToast("Couldn't change retention"); }
      } } });
      if (!info.accountReady) { toggle.style.pointerEvents = "none"; toggle.setAttribute("aria-disabled", "true"); }
      setRow(group, { label: "Local Archive", value: (info.bytes / (1024 * 1024)).toFixed(1) + " MB · " + info.count + " messages" });
      const clear = setRow(group, { label: "Clear Retained Messages", danger: true, onClick: async () => {
        if (Date.now() > clearArmedUntil) { clearArmedUntil = Date.now() + 5000; clear.querySelector(".gh-set-label").textContent = "Tap again to clear this account's copies"; return; }
        clear.style.pointerEvents = "none";
        try { clearLocalViews(); paint(await api.clearRetainedMessages()); ctx.showToast("Retained copies cleared"); }
        catch (e) { clear.style.pointerEvents = ""; ctx.showToast("Couldn't clear the archive"); }
      } });
      status.textContent = !info.accountReady ? "Waiting for your signed-in account." : info.error || info.captureError || (info.enabled ? "Captures while Ghost is running. Your existing read-receipt setting still applies when you open a chat." : "Capture and retained bubbles are off. Stored copies remain until cleared or expired.");
      group.appendChild(status);
    };
    api.retentionStatus().then(paint).catch(() => { status.textContent = "The local archive is unavailable. Try reloading Ghost."; });
    const awake = setGroup(body, "Background Capture", "Experimental: silent audio may help Ghost stay active, but iOS can still suspend the web view. Uses extra battery. Force-quitting or restarting the phone stops capture. Test with your phone locked before relying on it.");
    const awakeStatus = el("div", "gh-set-group-foot"); awakeStatus.textContent = "Checking background audio…"; awake.appendChild(awakeStatus);
    const request = (enabled) => {
      try { return Promise.resolve(window.webkit.messageHandlers.dg.postMessage({ op: "keepAwake", ...(enabled === undefined ? {} : { enabled }) })); }
      catch (e) { return Promise.reject(e); }
    };
    const paintAwake = (info) => {
      awake.replaceChildren();
      if (!info || typeof info.enabled !== "boolean") { awakeStatus.textContent = "Available in the Ghost iPhone app."; awake.appendChild(awakeStatus); return; }
      const toggle = setRow(awake, { label: "Keep Ghost Awake", toggle: { get: () => info.enabled, set: async (on) => {
        toggle.style.pointerEvents = "none";
        try { paintAwake(await request(on)); }
        catch (e) { awakeStatus.textContent = "Couldn't start background audio."; request().then(paintAwake).catch(() => paintAwake(info)); }
      } } });
      awakeStatus.textContent = info.error || (info.playing ? "Silent audio is running. Background message capture still needs a device test." : info.enabled ? "Enabled, but audio is paused. Return to Ghost after calls or interruptions." : "Off");
      awake.appendChild(awakeStatus);
    };
    request().then(paintAwake).catch(() => paintAwake(null));
  }

  // =====================================================================================================
  // Chat wallpapers: a default for every chat (a preset or your own photo) and per-chat overrides that always win
  // over the default. Photos are shrunk to ~1600px and kept in IndexedDB (this page's own storage, survives
  // restarts); the choice itself lives in prefs: wallpaper ("photo" or a preset) and chatWalls {convId: {kind, name}}.
  // =====================================================================================================
  const wallDB = {
    db: null,
    open() {
      if (this.db) return this.db;
      this.db = new Promise((res, rej) => {
        let r;
        try { r = indexedDB.open("ghost-walls", 1); } catch (e) { rej(e); return; }
        r.onupgradeneeded = () => r.result.createObjectStore("walls");
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      return this.db;
    },
    mem: new Map(), // fallback if IndexedDB isn't available (the photo then lasts until Ghost restarts)
    async idb() { try { return await this.open(); } catch (e) { this.db = Promise.reject(e); this.db.catch(() => {}); return null; } },
    async get(k) { const db = await this.idb(); if (!db) return this.mem.get(k) || null; return new Promise((res) => { const q = db.transaction("walls").objectStore("walls").get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); },
    async put(k, v) { const db = await this.idb(); if (!db) { this.mem.set(k, v); return; } return new Promise((res, rej) => { const t = db.transaction("walls", "readwrite"); t.objectStore("walls").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
    async del(k) { const db = await this.idb(); if (!db) { this.mem.delete(k); return; } return new Promise((res) => { const t = db.transaction("walls", "readwrite"); t.objectStore("walls").delete(k); t.oncomplete = res; t.onerror = res; }); },
  };
  const wallUrls = new Map(); // idb key -> object URL
  async function wallUrl(key) {
    if (wallUrls.has(key)) return wallUrls.get(key);
    const blob = await wallDB.get(key).catch(() => null);
    const url = blob ? URL.createObjectURL(blob) : null;
    wallUrls.set(key, url);
    return url;
  }
  // Decode any photo the picker hands us (big camera shots, panoramas, screenshots): createImageBitmap first
  // (handles EXIF rotation and huge images without an <img>), then a plain <img> as the fallback.
  async function decodePhoto(file) {
    if (typeof createImageBitmap === "function") {
      try { const b = await createImageBitmap(file, { imageOrientation: "from-image" }); return { src: b, w: b.width, h: b.height }; } catch (e) { gtrail("bitmap decode failed " + (e && e.message)); }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("unreadable image")); i.src = url; });
      if (img.decode) await img.decode().catch(() => {});
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, url };
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  }
  async function saveWallPhoto(key, file) {
    const d = await decodePhoto(file);
    try {
      const max = 1600, k = Math.min(1, max / Math.max(d.w, d.h));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(d.w * k)); c.height = Math.max(1, Math.round(d.h * k));
      c.getContext("2d").drawImage(d.src, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.86));
      if (!blob) throw new Error("couldn't read that photo");
      await wallDB.put(key, blob);
      const old = wallUrls.get(key); if (old) URL.revokeObjectURL(old);
      wallUrls.delete(key);
    } catch (e) { gtrail("wallpaper save failed " + (e && e.message)); throw e; }
    finally { if (d.url) URL.revokeObjectURL(d.url); if (d.src && d.src.close) d.src.close(); }
  }
  function pickPhoto() {
    return new Promise((res) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/*";
      input.style.cssText = "position:fixed;left:-9999px;opacity:0";
      // (a detached input doesn't always report the pick on iOS; Snapchat's own <body> is hidden, so it goes in Ghost's root)
      const hostRoot = document.getElementById("ghost-app-root");
      ((hostRoot && hostRoot.shadowRoot) || document.documentElement).appendChild(input);
      const done = (f) => { input.remove(); res(f); };
      input.addEventListener("change", () => done((input.files && input.files[0]) || null), { once: true });
      input.addEventListener("cancel", () => done(null), { once: true });
      input.click();
    });
  }
  // which wallpaper a chat gets: its own if you set one, else the default
  function wallFor(convId) {
    const own = convId && (pref("chatWalls") || {})[convId];
    if (own) return Object.assign({ own: true, key: "chat:" + convId }, own);
    const d = pref("wallpaper");
    return d === "photo" ? { kind: "photo", key: "default", dim: pref("wallDim"), fit: pref("wallFit") } : { kind: "preset", name: d };
  }
  // Live wallpapers: a small <canvas> behind the (then transparent) message list, drawn ~30 times a second only
  // while the chat is on screen. The first version used huge blurred/oversized CSS layers (4x the screen, x3) that
  // cost hundreds of MB on the phone - iOS then killed the page every 2-3 chats (device 2026-09-27). The blob kinds
  // draw at a tiny resolution and let CSS scale them up (they're meant to be blurry); stars draw at 1x.
  const LIVE_KINDS = {
    aurora: { lowRes: true, blobs: [["#1fb8c4", 0.1, 0.25, 0.55, 22], ["#9b59f6", 0.85, 0.45, 0.5, 26], ["#3e88f7", 0.35, 0.9, 0.5, 30], ["#23a55a", 0.8, 0.05, 0.35, 34]] },
    lava:   { lowRes: true, blobs: [["#ff5c3a", 0.15, 0.95, 0.45, 18], ["#ff9f2e", 0.85, 0.8, 0.42, 23], ["#ec407a", 0.5, 0.2, 0.4, 27], ["#9b59f6", 0.8, 0.05, 0.3, 31]] },
    stars:  { lowRes: false },
  };
  function setLiveWall(ctx, kind) {
    const conv = ctx.conv; if (!conv) return;
    const scr = conv.messages.parentNode;
    if (!kind || !LIVE_KINDS[kind]) {
      if (conv.liveWall) { conv.liveWall.stop(); conv.liveWall.el.remove(); conv.liveWall = null; }
      conv.messages.classList.remove("gh-live-on"); scr.style.isolation = "";
      return;
    }
    scr.style.isolation = "isolate";
    conv.messages.classList.add("gh-live-on");
    if (conv.liveWall && conv.liveWall.kind === kind) { conv.liveWall.start(); return; }
    if (conv.liveWall) { conv.liveWall.stop(); conv.liveWall.el.remove(); }
    const spec = LIVE_KINDS[kind];
    const cv = el("canvas", "gh-live-wall"); cv.dataset.kind = kind;
    scr.insertBefore(cv, conv.messages);
    const g = cv.getContext("2d");
    let raf = 0, last = 0, W = 0, H = 0, stars = null;
    const size = () => {
      const r = cv.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      const k = spec.lowRes ? 60 / w : Math.min(2, window.devicePixelRatio || 1);
      const nw = Math.round(w * k), nh = Math.round(h * k);
      if (nw !== W || nh !== H) { W = cv.width = nw; H = cv.height = nh; stars = null; }
    };
    const bg = () => getComputedStyle(ctx.host).getPropertyValue("--gh-bg-app").trim() || "#000";
    const draw = (t) => {
      size();
      const s = t / 1000;
      g.globalCompositeOperation = "source-over";
      if (spec.lowRes) {
        g.fillStyle = bg(); g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = "lighter";
        for (const [col, x, y, rad, per] of spec.blobs) {
          const px = (x + 0.18 * Math.sin(s * 6.283 / per)) * W, py = (y + 0.14 * Math.cos(s * 6.283 / (per * 1.3))) * H;
          const rr = rad * W * (1 + 0.15 * Math.sin(s * 6.283 / (per * 0.8)));
          const gr = g.createRadialGradient(px, py, 0, px, py, rr);
          gr.addColorStop(0, col + "88"); gr.addColorStop(1, col + "00");
          g.fillStyle = gr; g.fillRect(0, 0, W, H);
        }
      } else {
        if (!stars) { stars = []; for (let i = 0; i < 140; i++) stars.push([Math.random() * W, Math.random() * H, Math.random() * 1.3 + 0.3, Math.random() * 6.28, Math.random() < 0.3 ? 2.2 : 1]); }
        const grd = g.createRadialGradient(W / 2, H * 1.2, 0, W / 2, H * 1.2, H);
        grd.addColorStop(0, "#1a2440"); grd.addColorStop(1, bg());
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        g.fillStyle = "#fff";
        for (const st of stars) {
          const x = (st[0] - s * 4 * st[4] * (W / 400)) % W, y = (st[1] - s * 3 * st[4] * (W / 400)) % H;
          g.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(s * 0.8 + st[3]));
          g.beginPath(); g.arc(x < 0 ? x + W : x, y < 0 ? y + H : y, st[2] * (W / 400), 0, 6.283); g.fill();
        }
        g.globalAlpha = 1;
      }
    };
    const loop = (t) => {
      raf = 0;
      if (!cv.isConnected) return;
      const still = ctx.host.hasAttribute("data-reduce-motion");
      if (t - last > 33 || !last) { last = t; draw(t); }
      if (!still && !document.hidden && ctx.state.currentConvId) raf = requestAnimationFrame(loop);
    };
    const lw = { kind, el: cv, start: () => { if (!raf) raf = requestAnimationFrame(loop); }, stop: () => { if (raf) cancelAnimationFrame(raf); raf = 0; } };
    // (resume-on-visible is one page-lifetime listener set up once in buildConversation, not per-call here)
    conv.liveWall = lw;
    lw.start();
  }
  // your own bubble colour for one chat (Ghost-only): an accent from ACCENT_SET, only for your messages there
  function applyChatBubbles(ctx, convId) {
    const scr = ctx.conv && ctx.conv.messages && ctx.conv.messages.parentNode;
    if (!scr) return;
    const key = convId && (pref("chatBubbles") || {})[convId];
    const a = key && ACCENT_SET[key];
    if (a) { scr.style.setProperty("--gh-bubble-out-1", a[2]); scr.style.setProperty("--gh-bubble-out-2", a[3]); }
    else { scr.style.removeProperty("--gh-bubble-out-1"); scr.style.removeProperty("--gh-bubble-out-2"); }
  }
  async function applyChatWallpaper(ctx, convId) {
    const m = ctx.conv && ctx.conv.messages;
    if (!m) return;
    applyChatBubbles(ctx, convId);
    const w = wallFor(convId);
    const livePreset = w.kind === "preset" && WALLPAPERS[w.name] && WALLPAPERS[w.name].live;
    setLiveWall(ctx, livePreset || null);
    if (livePreset) { m.style.backgroundImage = "none"; m.style.backgroundColor = "transparent"; m.style.backgroundSize = ""; m.style.backgroundPosition = ""; m.style.backgroundRepeat = ""; return; }
    const token = (m._wallToken = (m._wallToken || 0) + 1);
    if (w.kind === "photo") {
      const url = await wallUrl(w.key);
      if (m._wallToken !== token) return;
      if (url) {
        const dim = Math.max(0, Math.min(0.8, w.dim != null ? w.dim : pref("wallDim")));
        const fit = (w.fit || pref("wallFit")) === "fit";
        m.style.backgroundImage = `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("${url}")`;
        // Fill = zoom to cover the whole chat; Fit = the whole photo, black bars where it doesn't reach
        m.style.backgroundSize = fit ? "100% 100%, contain" : "cover";
        m.style.backgroundRepeat = "no-repeat";
        m.style.backgroundPosition = "center";
        m.style.backgroundColor = fit ? "#000" : "";
        return;
      }
    }
    if (w.own && w.kind === "preset" && WALLPAPERS[w.name]) {
      const p = WALLPAPERS[w.name];
      m.style.backgroundImage = p.css === "none" ? "none" : p.css; m.style.backgroundSize = p.size; m.style.backgroundPosition = p.pos;
      return;
    }
    m.style.backgroundImage = ""; m.style.backgroundSize = ""; m.style.backgroundPosition = ""; m.style.backgroundRepeat = ""; m.style.backgroundColor = ""; // the default preset (CSS vars)
  }
  function setChatWall(ctx, convId, value) {
    const all = Object.assign({}, pref("chatWalls") || {});
    if (value) all[convId] = value; else delete all[convId];
    setPref(ctx, "chatWalls", all);
    if (ctx.state.currentConvId === convId) applyChatWallpaper(ctx, convId);
  }

  // small in-app confirm and text prompt (never window.confirm/prompt - those freeze the web view)
  function confirmSheet(ctx, text, okLabel) {
    return new Promise((res) => {
      const ov = el("div", "gh-confirm");
      ov.innerHTML = '<div class="gh-confirm-box"><div class="gh-confirm-text"></div><div class="gh-confirm-row"><button data-v="0">Cancel</button><button data-v="1" class="gh-confirm-ok"></button></div></div>';
      ov.querySelector(".gh-confirm-text").textContent = text;
      ov.querySelector(".gh-confirm-ok").textContent = okLabel || "OK";
      ov.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b && e.target !== ov) return; ov.remove(); res(!!(b && b.dataset.v === "1")); });
      ctx.root.appendChild(ov);
    });
  }
  function promptSheet(ctx, text, value) {
    return new Promise((res) => {
      const ov = el("div", "gh-confirm");
      ov.innerHTML = '<div class="gh-confirm-box"><div class="gh-confirm-text"></div><input class="gh-confirm-input" maxlength="60"><div class="gh-confirm-row"><button data-v="0">Cancel</button><button data-v="1" class="gh-confirm-ok">Save</button></div></div>';
      ov.querySelector(".gh-confirm-text").textContent = text;
      const inp = ov.querySelector("input"); inp.value = value || "";
      ov.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; ov.remove(); res(b.dataset.v === "1" ? inp.value.trim() : null); });
      ctx.root.appendChild(ov);
      setTimeout(() => inp.focus(), 50);
    });
  }
  async function renameGroupPrompt(ctx, convId, current) {
    const name = await promptSheet(ctx, "Group name", current);
    if (name == null || !name) return;
    try { await api.renameGroup(convId, name); ctx.showToast("Renamed"); } catch (e) { ctx.showToast("Couldn't rename"); }
  }
  function openSavedList(ctx, convId) {
    const s = ctx.chatSheet;
    const saved = ((ctx.state.messagesByConv.get(convId) || {}).messages || []).filter((m) => m.saved);
    s.sheet.innerHTML = "";
    s.sheet.appendChild(el("div", "gh-sheet-grip"));
    const t = el("div", "gh-set-group-title"); t.textContent = "Saved in Chat"; s.sheet.appendChild(t);
    if (!saved.length) { const e = el("div", "gh-set-group-foot"); e.textContent = "Nothing saved in this chat yet (among the messages loaded). Hold a message and tap Save."; s.sheet.appendChild(e); return; }
    const g = el("div", "gh-set-group"); s.sheet.appendChild(g);
    for (const m of saved.slice().reverse()) {
      const row = el("div", "gh-set-row gh-saved-row");
      const who = el("div", "gh-saved-who"); who.textContent = (m.fromMe ? "You" : (m.from && m.from.name) || "") + " \u00b7 " + fmtClock(m.ts);
      const txt = el("div", "gh-saved-text"); txt.textContent = m.kind === "text" ? m.text : ({ "chat-media": "Photo", snap: "Snap", audio: "Voice message", sticker: "Sticker", gif: "GIF" }[m.kind] || "Message");
      const col = el("div", "gh-set-label"); col.append(who, txt); row.appendChild(col);
      g.appendChild(row);
    }
  }

  // Chat sheet (tap the name/picture at the top of a chat): this chat's wallpaper.
  function buildChatSheet(ctx, overlaysRoot) {
    const backdrop = el("div", "gh-backdrop");
    const sheet = el("div", "gh-sheet gh-chat-sheet");
    sheet.style.display = "none";
    overlaysRoot.append(backdrop, sheet);
    backdrop.addEventListener("click", () => closeSheetGeneric(backdrop, sheet));
    return { backdrop, sheet };
  }

  // =====================================================================================================
  // Ghost-only tools: jump to a message, search in a chat, bookmarks, media gallery
  // =====================================================================================================
  // Fetch older history quietly (no repaint per page): for search, the gallery and bookmark jumps.
  async function fetchOlderPages(ctx, pages, until) {
    const conv = ctx.conv, convId = ctx.state.currentConvId;
    if (!convId || !conv || conv._loadingOlder) return 0;
    conv._loadingOlder = true; conv._quietLoad = true; conv._missedUpdate = false;
    let added = 0;
    try {
      for (let i = 0; i < pages; i++) {
        const prev = ctx.state.messagesByConv.get(convId) || { messages: [], hasMore: true };
        if (prev.hasMore === false) break;
        const res = await api.loadOlder(convId);
        if (ctx.state.currentConvId !== convId) break;
        const entry = { messages: (res && res.messages) || prev.messages, hasMore: !!(res && res.hasMore) };
        ctx.state.messagesByConv.set(convId, entry);
        const a = Math.max(0, entry.messages.length - prev.messages.length);
        added += a; conv.windowStart += a; conv.windowEnd += a;
        conv._all = entry.messages; conv._hasMore = entry.hasMore;
        if (!a && !entry.hasMore) break;
        if (until && until()) break;
      }
    } catch (e) { gtrail("older pages failed " + (e && e.message || e)); }
    finally {
      conv._loadingOlder = false; conv._quietLoad = false;
      const entry = ctx.state.messagesByConv.get(convId);
      if (entry && ctx.state.currentConvId === convId) { conv._all = entry.messages; conv._hasMore = entry.hasMore; }
      if (conv._missedUpdate && entry && ctx.state.currentConvId === convId) { conv._missedUpdate = false; renderMessageList(ctx, conv, entry, {}); }
    }
    return added;
  }
  async function jumpToMessage(ctx, id) {
    const conv = ctx.conv;
    if (!conv) return false;
    const find = () => (conv._all || []).findIndex((m) => m.id === id);
    let idx = find();
    if (idx < 0 && conv._hasMore) { await fetchOlderPages(ctx, 40, () => find() >= 0); idx = find(); }
    if (idx < 0) { ctx.showToast("Couldn't find that message"); return false; }
    const total = conv._all.length;
    conv.userTouched = true; conv.atBottom = false;
    conv.windowStart = Math.max(0, idx - CHUNK); conv.windowEnd = Math.min(total, idx + CHUNK);
    paintWindow(ctx, conv);
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    let w = [...conv.messages.querySelectorAll(".gh-msg-wrap")].find((x) => x.dataset.messageId === id);
    if (!w) { // a new message repainted the window meanwhile: place it around the target again
      const j = (conv._all || []).findIndex((m) => m.id === id);
      if (j < 0) return false;
      conv.windowStart = Math.max(0, j - CHUNK); conv.windowEnd = Math.min(conv._all.length, j + CHUNK);
      paintWindow(ctx, conv);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      w = [...conv.messages.querySelectorAll(".gh-msg-wrap")].find((x) => x.dataset.messageId === id);
      if (!w) return false;
    }
    conv.stickUntil = nowMs() + 450;
    const mr = conv.messages.getBoundingClientRect(), wr = w.getBoundingClientRect();
    // mr/wr are in zoomed page px (getBoundingClientRect); scrollTop is in the host's own local CSS px -
    // scale the page-px delta back down before applying it, or this overshoots by 1/appScale on the phone.
    conv.messages.scrollTop += ((wr.top - mr.top) - (mr.height / 2 - wr.height / 2)) * pagePxToLocal();
    w.classList.remove("gh-msg-flash"); void w.offsetWidth; w.classList.add("gh-msg-flash");
    if (conv.windowEnd < total) showJump(ctx, true);
    return true;
  }

  // ---- search in a chat -----------------------------------------------------------------------------
  function searchableText(m) { return m && m.kind === "text" ? String(m.text || "") : ""; }
  function openChatSearch(ctx) {
    const conv = ctx.conv;
    if (!conv) return;
    if (conv.searchBar) { conv.searchBar.querySelector("input").focus(); return; }
    const bar = el("div", "gh-chat-search");
    bar.innerHTML = `<div class="gh-chat-search-field"><input type="search" placeholder="Search this chat" enterkeyhint="search" autocomplete="off"></div>
      <button class="gh-chat-search-done gh-hit">Done</button>
      <div class="gh-chat-search-nav"><span class="gh-chat-search-count"></span>
      <button class="gh-icon-btn gh-hit" data-act="older" aria-label="Older match"></button>
      <button class="gh-icon-btn gh-hit" data-act="newer" aria-label="Newer match"></button></div>`;
    bar.querySelector(".gh-chat-search-field").prepend(icon("search", 16));
    bar.querySelector('[data-act="older"]').appendChild(icon("chevronDown", 20, "gh-flip-y"));
    bar.querySelector('[data-act="newer"]').appendChild(icon("chevronDown", 20));
    conv.messages.parentNode.appendChild(bar);
    conv.searchBar = bar;
    const input = bar.querySelector("input"), count = bar.querySelector(".gh-chat-search-count");
    const st = { q: "", matches: [], cur: -1, busy: false };
    const compute = () => {
      const all = conv._all || [];
      st.matches = [];
      if (st.q) for (let i = all.length - 1; i >= 0; i--) if (searchableText(all[i]).toLowerCase().includes(st.q)) st.matches.push(all[i].id);
    };
    const label = () => {
      if (!st.q) { count.textContent = ""; return; }
      if (st.busy) { count.textContent = "Searching…"; return; }
      count.textContent = st.matches.length ? (st.cur + 1) + " of " + st.matches.length + (conv._hasMore ? "+" : "") : (conv._hasMore ? "None yet - tap ↑" : "No results");
    };
    const go = (i) => { st.cur = i; label(); jumpToMessage(ctx, st.matches[i]); };
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        st.q = input.value.trim().toLowerCase();
        conv.searchQ = st.q || null;
        compute();
        if (st.matches.length) go(0); else { st.cur = -1; label(); paintWindow(ctx, conv); }
      }, 220);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    bar.querySelector('[data-act="older"]').addEventListener("click", async () => {
      if (!st.q || st.busy) return;
      haptic("light");
      if (st.cur + 1 < st.matches.length) { go(st.cur + 1); return; }
      if (!conv._hasMore) { ctx.showToast("That's the oldest match"); return; }
      st.busy = true; label();
      const had = st.matches.length;
      await fetchOlderPages(ctx, 8, () => { compute(); return st.matches.length > had; });
      compute(); st.busy = false;
      if (st.matches.length > had) go(had); else { label(); if (!conv._hasMore) ctx.showToast("No older matches"); }
    });
    bar.querySelector('[data-act="newer"]').addEventListener("click", () => { if (st.cur > 0) { haptic("light"); go(st.cur - 1); } });
    bar.querySelector(".gh-chat-search-done").addEventListener("click", () => closeChatSearch(ctx));
    requestAnimationFrame(() => { bar.dataset.open = "1"; input.focus(); });
  }
  function closeChatSearch(ctx) {
    const conv = ctx.conv;
    if (!conv || !conv.searchBar) return;
    conv.searchBar.remove(); conv.searchBar = null;
    if (conv.searchQ) { conv.searchQ = null; paintWindow(ctx, conv); }
  }

  // ---- bookmarks (Ghost-only, stored on this phone) ----------------------------------------------------
  let bmCache = { src: null, set: new Set() };
  function bookmarkSet() {
    const list = pref("bookmarks") || [];
    if (bmCache.src !== list) bmCache = { src: list, set: new Set(list.map((b) => b.convId + "|" + b.id)) };
    return bmCache.set;
  }
  function isBookmarked(convId, id) { return bookmarkSet().has(convId + "|" + id); }
  function messagePreview(m) {
    if (!m) return "";
    if (m.kind === "text") return String(m.text || "");
    return ({ "chat-media": "📷 Photo", snap: "👻 Snap", audio: "🎤 Voice message", sticker: "Sticker", gif: "GIF", share: "Shared link" }[m.kind] || "Message");
  }
  function toggleBookmark(ctx, convId, m) {
    const list = (pref("bookmarks") || []).slice();
    const i = list.findIndex((b) => b.convId === convId && b.id === m.id);
    if (i >= 0) list.splice(i, 1);
    else {
      const cd = ctx.state.convById.get(convId);
      const meId = ctx.state.me && ctx.state.me.id;
      const mine = m.fromMe || (m.from && m.from.id === meId);
      list.unshift({ convId, id: m.id, ts: m.ts || 0, kind: m.kind, text: messagePreview(m).slice(0, 400), from: mine ? "You" : (m.from && m.from.name) || "", chat: (cd && cd.title) || "", at: Date.now() });
    }
    setPref(ctx, "bookmarks", list);
    ctx.showToast(i >= 0 ? "Bookmark removed" : "Bookmarked");
    if (ctx.conv && ctx.state.currentConvId === convId) paintWindow(ctx, ctx.conv);
  }
  async function openBookmark(ctx, b) {
    closeSettings(ctx);
    if (ctx.state.currentConvId !== b.convId) {
      if (!ctx.state.convById.has(b.convId)) { ctx.showToast("That chat isn't in your list anymore"); return; }
      await openConversationScreen(ctx, b.convId);
    }
    for (let i = 0; i < 40 && !((ctx.conv && ctx.conv._all) || []).length; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 250));
    jumpToMessage(ctx, b.id);
  }
  function openSettingsAt(ctx, name, rootLabel) {
    haptic();
    const s = ctx.settings;
    s.el.innerHTML = ""; s.stack = []; s.rootLabel = rootLabel || "Chat";
    s.el.dataset.open = "1";
    pushSettingsPage(ctx, name);
  }

  // ---- Streak Keeper -----------------------------------------------------------------------------------
  // pref streakKeeper = { convId: {on, time: "HH:MM", last: "YYYY-MM-DD"} }. Checked every 30 s while Ghost runs and
  // whenever it comes back to the front: once it's past the time and today's hasn't gone, one black snap goes to all
  // the due chats together. `last` is only written after Snapchat accepted it.
  function todayKey(d) { d = d || new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function fmtTimeOfDay(hhmm) {
    const [h, m] = String(hhmm || "12:00").split(":").map(Number);
    const d = new Date(); d.setHours(h || 0, m || 0, 0, 0);
    try { return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return hhmm; }
  }
  let blackSnapBlob = null;
  function blackSnap() {
    if (blackSnapBlob) return Promise.resolve(blackSnapBlob);
    return new Promise((res, rej) => {
      const c = document.createElement("canvas"); c.width = 1080; c.height = 1920;
      const g = c.getContext("2d"); g.fillStyle = "#000"; g.fillRect(0, 0, c.width, c.height);
      c.toBlob((b) => { if (b) { blackSnapBlob = b; res(b); } else rej(new Error("no image")); }, "image/jpeg", 0.9);
    });
  }
  let streakBusy = false;
  async function runStreakKeeper(ctx) {
    if (streakBusy || !ctx.state.ready) return;
    const all = pref("streakKeeper") || {};
    const now = new Date(), today = todayKey(now), mins = now.getHours() * 60 + now.getMinutes();
    const due = Object.entries(all).filter(([id, c]) => {
      if (!c || !c.on || c.last === today) return false;
      const [h, m] = String(c.time || "12:00").split(":").map(Number);
      return mins >= (h || 0) * 60 + (m || 0);
    }).map(([id]) => id);
    if (!due.length) return;
    // a failed try (e.g. a timeout after Snapchat already took it) is retried at most 3 times a day, 10 min apart,
    // so a flaky send can't turn into a stream of black snaps
    const tries = ctx.streakTries && ctx.streakTries.day === today ? ctx.streakTries : (ctx.streakTries = { day: today, n: 0, at: 0 });
    if (tries.n >= 3 || Date.now() - tries.at < 600000) return;
    tries.n++; tries.at = Date.now();
    streakBusy = true;
    try {
      const blob = await blackSnap();
      await api.sendSnap(due, blob, { kind: "image", width: 1080, height: 1920 });
      const next = Object.assign({}, pref("streakKeeper") || {});
      for (const id of due) if (next[id]) next[id] = Object.assign({}, next[id], { last: today });
      setPref(ctx, "streakKeeper", next);
      scheduleStreakReminders(ctx);
      ctx.streakTries = null;
      gtrail("streak keeper sent to " + due.length);
    } catch (e) {
      gtrail("streak keeper failed " + (e && e.message || e));
    } finally { streakBusy = false; }
  }
  function startStreakKeeper(ctx) {
    if (ctx.streakTimer) return;
    ctx.streakTimer = setInterval(() => runStreakKeeper(ctx), 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(() => runStreakKeeper(ctx), 1500); });
    setTimeout(() => runStreakKeeper(ctx), 4000);
    scheduleStreakReminders(ctx);
  }
  // a local notification at each streak time, for when iOS has frozen Ghost (the app asks the native side)
  function scheduleStreakReminders(ctx) {
    const all = pref("streakKeeper") || {};
    const items = Object.entries(all).filter(([, c]) => c && c.on).map(([id, c]) => {
      const [h, m] = String(c.time || "12:00").split(":").map(Number);
      const cd = ctx.state.convById.get(id);
      return { id, hour: h || 0, minute: m || 0, name: (cd && cd.title) || "your friend", skipToday: c.last === todayKey() };
    });
    try { window.webkit.messageHandlers.dg.postMessage({ op: "streakReminders", items }).catch(() => {}); } catch (e) {}
  }

  async function openChatSheet(ctx) {
    const convId = ctx.state.currentConvId;
    const cd = convId && ctx.state.convById.get(convId);
    if (!cd) return;
    haptic();
    const s = ctx.chatSheet;
    s.sheet.innerHTML = "";
    s.sheet.appendChild(el("div", "gh-sheet-grip"));
    const head = el("div", "gh-chat-sheet-head");
    head.appendChild(makeAvatar(convAvatarUser(cd), 64));
    const nm = el("div", "gh-chat-sheet-name"); nm.textContent = cd.title || "Chat";
    head.appendChild(nm);
    s.sheet.appendChild(head);
    // profile photo: yours to choose for this person (1:1) or this group; Bitmoji is the default
    const avKey = cd.isGroup ? "conv:" + convId : (cd.participants && cd.participants[0] ? "user:" + cd.participants[0].id : null);
    if (avKey) {
      const pt = el("div", "gh-set-group-title"); pt.textContent = cd.isGroup ? "Group Photo" : "Profile Photo"; s.sheet.appendChild(pt);
      const pg = el("div", "gh-set-group"); s.sheet.appendChild(pg);
      setRow(pg, { label: "Choose Photo…", onClick: async () => {
        const f = await pickPhoto(); if (!f) return;
        try { await saveCustomAvatar(ctx, avKey, f); closeSheetGeneric(s.backdrop, s.sheet); ctx.showToast("Photo updated"); }
        catch (e) { ctx.showToast("Couldn't use that photo"); }
      } });
      if (customAvatarUrls.has(avKey)) setRow(pg, { label: cd.isGroup ? "Use Bitmojis" : "Use Their Bitmoji", danger: true, onClick: async () => { await clearCustomAvatar(ctx, avKey); closeSheetGeneric(s.backdrop, s.sheet); } });
      const pf = el("div", "gh-set-group-foot"); pf.textContent = "Only you see this - it doesn't change anything on Snapchat."; s.sheet.appendChild(pf);
    }
    // Ghost-only tools for this chat
    {
      const tg = el("div", "gh-chat-tools");
      const tool = (ic, label, fn) => { const b = el("button", "gh-chat-tool gh-press"); b.append(icon(ic, 22), Object.assign(el("span"), { textContent: label })); b.addEventListener("click", () => { haptic("light"); closeSheetGeneric(s.backdrop, s.sheet); fn(); }); tg.appendChild(b); };
      tool("search", "Search", () => openChatSearch(ctx));
      tool("photo", "Media", () => { ctx.settings.galleryConv = convId; ctx.settings.galleryTab = "media"; openSettingsAt(ctx, "gallery"); });
      tool("bookmark", "Bookmarks", () => { ctx.settings.bookmarksConv = convId; openSettingsAt(ctx, "bookmarks"); });
      s.sheet.appendChild(tg);
    }
    // their nickname (Ghost's own - see nickify)
    const other = !cd.isGroup && cd.participants && cd.participants[0];
    if (other) {
      const ng0 = el("div", "gh-set-group"); ng0.style.marginTop = "14px"; s.sheet.appendChild(ng0);
      setRow(ng0, { icon: "edit", tint: "#3e88f7", label: "Edit Nickname", value: "", onClick: async () => {
        const v = await promptSheet(ctx, "Nickname for " + (other.username ? "@" + other.username : (cd._realTitle || cd.title || "them")), (pref("nicknames") || {})[other.id] || "");
        if (v == null) return;
        await setNickname(ctx, other.id, v); nm.textContent = cd.title;
        ctx.showToast(v ? "Nickname saved" : "Nickname removed");
      } });
    }
    // Streak Keeper: a black snap to this chat at the same time every day
    {
      const sk = el("div", "gh-set-group-title"); sk.textContent = "Streak Keeper"; s.sheet.appendChild(sk);
      const sg = el("div", "gh-set-group"); s.sheet.appendChild(sg);
      const cur = () => (pref("streakKeeper") || {})[convId] || null;
      const save = (patch) => {
        const all = Object.assign({}, pref("streakKeeper") || {});
        const next = Object.assign({ on: false, time: "12:00", last: "" }, all[convId] || {}, patch);
        if (!next.on) delete all[convId]; else all[convId] = next;
        setPref(ctx, "streakKeeper", all);
        scheduleStreakReminders(ctx);
        paintSk();
      };
      const timeRow = el("label", "gh-set-row gh-streak-time");
      const tl = el("span", "gh-set-label"); tl.textContent = "Send Every Day At";
      const ti = el("input"); ti.type = "time"; ti.className = "gh-streak-input";
      timeRow.append(tl, ti);
      ti.addEventListener("change", () => { if (ti.value) save({ on: true, time: ti.value }); });
      setRow(sg, { icon: "flame", tint: "linear-gradient(135deg,#ff9f2e,#ff5c3a)", label: "Keep Streak", toggle: { get: () => !!(cur() && cur().on), set: (v) => save({ on: v }) } });
      sg.appendChild(timeRow);
      const skFoot = el("div", "gh-set-group-foot"); s.sheet.appendChild(skFoot);
      const paintSk = () => {
        const c = cur();
        ti.value = (c && c.time) || "12:00";
        timeRow.style.display = c && c.on ? "" : "none";
        skFoot.textContent = c && c.on
          ? "Sends a black snap at " + fmtTimeOfDay(c.time) + " every day. " + (c.last === todayKey() ? "Today's is sent. " : "") + "Ghost has to be open or in the background then - if it was closed, it sends as soon as you open it, and a reminder pops up at that time."
          : "Sends a plain black snap at the same time every day so you never lose the streak.";
      };
      paintSk();
    }
    // Open now, with everything built so far (photo, tools, nickname, streak keeper) already in the sheet:
    // the rest (notifications/retention need an await; the wallpaper cards need one for a photo thumbnail)
    // fills in a moment later, appended below what's already on screen. Awaiting all of that first, like this
    // used to, held the slide-in animation itself back by 100-150ms after every tap - dead time with zero
    // visual feedback, measured on the harness's sheet-open probe (tap-to-sheet-moving latency).
    openSheetGeneric(s.backdrop, s.sheet);
    // chat settings: notifications, when chats delete, saved messages; group tools
    const st = await api.chatSettings(convId).catch(() => ({}));
    const nt = el("div", "gh-set-group-title"); nt.textContent = "Notifications"; s.sheet.appendChild(nt);
    const ng = el("div", "gh-set-group"); s.sheet.appendChild(ng);
    let notif = st && st.notifications;
    setChoice(ng, cd.isGroup ? [[0, "All Messages"], [2, "Mentions Only"], [1, "Silent"]] : [[0, "All Messages"], [1, "Silent"]], () => notif, (v) => { notif = v; api.setChatNotifications(convId, v).catch(() => ctx.showToast("Couldn't change that")); });
    const rt = el("div", "gh-set-group-title"); rt.textContent = "Delete Chats"; s.sheet.appendChild(rt);
    const rg = el("div", "gh-set-group"); s.sheet.appendChild(rg);
    let ret = st && st.retention;
    setChoice(rg, [[0, "After Viewing"], [1, "24 Hours After Viewing"]], () => ret, (v) => { ret = v; api.setRetention(convId, v).catch(() => ctx.showToast("Couldn't change that")); });
    const og = el("div", "gh-set-group"); og.style.marginTop = "14px"; s.sheet.appendChild(og);
    const saved = ((ctx.state.messagesByConv.get(convId) || {}).messages || []).filter((m) => m.saved);
    setRow(og, { icon: "star", tint: "#f0b232", label: "Saved in Chat", value: String(saved.length), onClick: () => openSavedList(ctx, convId) });
    if (cd.isGroup) {
      setRow(og, { icon: "edit", tint: "#3e88f7", label: "Rename Group", onClick: () => renameGroupPrompt(ctx, convId, cd.title) });
      setRow(og, { icon: "plus", tint: "#23a55a", label: "Add Members", onClick: () => { closeSheetGeneric(s.backdrop, s.sheet); openNewChatSheet(ctx, convId); } });
      setRow(og, { label: "Leave Group", danger: true, onClick: async () => {
        if (!(await confirmSheet(ctx, "Leave " + (cd.title || "this group") + "?", "Leave"))) return;
        try { await api.leaveGroup(convId); closeSheetGeneric(s.backdrop, s.sheet); closeConversationScreen(ctx); ctx.showToast("You left the group"); } catch (e) { ctx.showToast("Couldn't leave"); }
      } });
    }
    setRow(og, { label: "Clear from Chat Feed", danger: true, onClick: async () => {
      if (!(await confirmSheet(ctx, "Clear this chat from your feed? Saved messages stay.", "Clear"))) return;
      try { await api.clearChat(convId); closeSheetGeneric(s.backdrop, s.sheet); closeConversationScreen(ctx); } catch (e) { ctx.showToast("Couldn't clear it"); }
    } });
    // your bubble colour in this chat only (Ghost-only)
    {
      const bt = el("div", "gh-set-group-title"); bt.textContent = "Your Bubble Color Here"; s.sheet.appendChild(bt);
      const sw = el("div", "gh-set-swatches gh-chat-swatches");
      const cur = () => (pref("chatBubbles") || {})[convId] || null;
      const mkSw = (key, bg) => {
        const b = el("button", "gh-set-swatch gh-press"); b.style.background = bg; b.setAttribute("aria-label", key || "Default");
        if (!key) { b.classList.add("gh-swatch-default"); b.textContent = "A"; }
        b.dataset.on = cur() === key ? "1" : "0";
        b.addEventListener("click", () => {
          haptic("light");
          const all = Object.assign({}, pref("chatBubbles") || {});
          if (key) all[convId] = key; else delete all[convId];
          setPref(ctx, "chatBubbles", all);
          for (const c of sw.children) c.dataset.on = "0"; b.dataset.on = "1";
        });
        sw.appendChild(b);
      };
      mkSw(null, "var(--gh-accent)");
      for (const [key, a] of Object.entries(ACCENT_SET)) mkSw(key, "linear-gradient(135deg," + a[2] + "," + a[3] + ")");
      s.sheet.appendChild(sw);
    }
    const title = el("div", "gh-set-group-title"); title.textContent = "Chat Wallpaper"; s.sheet.appendChild(title);
    const cards = el("div", "gh-set-cards gh-chat-walls");
    s.sheet.appendChild(cards);
    const foot = el("div", "gh-set-group-foot"); s.sheet.appendChild(foot);
    const dimRow = el("div", "gh-chat-dim");
    s.sheet.appendChild(dimRow);
    const paint = async () => {
      const own = (pref("chatWalls") || {})[convId];
      foot.textContent = own ? "This chat has its own wallpaper - changing the default won't touch it." : "Using your default wallpaper (Settings > Appearance).";
      cards.innerHTML = "";
      const mk = (label, on, style, onClick) => {
        const c = el("button", "gh-set-wall gh-press"); Object.assign(c.style, style || {});
        const n = el("span"); n.textContent = label; c.appendChild(n);
        c.dataset.on = on ? "1" : "0";
        c.addEventListener("click", async () => { haptic("light"); await onClick(); paint(); });
        cards.appendChild(c);
        return c;
      };
      mk("Default", !own, { backgroundColor: "var(--gh-bg-app)" }, () => setChatWall(ctx, convId, null)).classList.add("gh-wall-default");
      const photoUrl = own && own.kind === "photo" ? await wallUrl("chat:" + convId) : null;
      const pc = mk(photoUrl ? "Photo" : "Choose Photo", !!(own && own.kind === "photo"), photoUrl ? { backgroundImage: `url("${photoUrl}")`, backgroundSize: "cover", backgroundPosition: "center" } : {}, async () => {
        const f = await pickPhoto(); if (!f) return;
        try { await saveWallPhoto("chat:" + convId, f); setChatWall(ctx, convId, { kind: "photo", dim: own && own.dim != null ? own.dim : 0.25 }); }
        catch (e) { ctx.showToast("Couldn't use that photo"); }
      });
      if (!photoUrl) pc.appendChild(icon("photo", 26, "gh-wall-photo-ico"));
      for (const [key, w] of Object.entries(WALLPAPERS)) {
        const card = mk(w.name, !!(own && own.kind === "preset" && own.name === key), { backgroundImage: w.css === "none" ? "none" : w.css, backgroundSize: w.size, backgroundPosition: w.pos }, () => setChatWall(ctx, convId, { kind: "preset", name: key }));
        if (w.live) card.dataset.live = w.live;
      }
      dimRow.innerHTML = "";
      if (own && own.kind === "photo") {
        const g = el("div", "gh-set-group");
        setSlider(g, { min: 0, max: 0.7, step: 0.05, minLabel: "☀︎", maxLabel: "☾", get: () => own.dim != null ? own.dim : 0.25, set: (v) => { own.dim = v; setChatWall(ctx, convId, Object.assign({}, own, { dim: v })); } });
        const cap = el("div", "gh-set-group-title"); cap.textContent = "Darken Photo";
        const fcap = el("div", "gh-set-group-title"); fcap.textContent = "Photo Size";
        const fg = el("div", "gh-set-group");
        setChoice(fg, [["fill", "Fill Screen (zoom)"], ["fit", "Whole Photo (black bars)"]], () => own.fit || "fill", (v) => { own.fit = v; setChatWall(ctx, convId, Object.assign({}, own, { fit: v })); });
        dimRow.append(cap, g, fcap, fg);
      }
    };
    await paint(); // sheet is already open (see above); this only fills in the wallpaper cards below the fold
  }

  // =====================================================================================================
  // Calls (voice + video), Ghost's own screen over Snapchat's calling engine (bridge startCall / answerCall /
  // endCall / setMicOn / setCameraOn / flipCamera, and the "calls" event). The bridge drops the live
  // <video>/<audio> elements into .gh-call-remote / .gh-call-local / .gh-call-audio below.
  // =====================================================================================================
  function buildCallScreen(ctx) {
    const wrap = el("div", "gh-call");
    wrap.innerHTML = `
      <div class="gh-call-bg"></div>
      <div class="gh-call-remote"></div>
      <div class="gh-call-audio"></div>
      <div class="gh-call-center"><div class="gh-call-av"></div><div class="gh-call-name"></div><div class="gh-call-status"></div></div>
      <div class="gh-call-top">
        <button class="gh-call-min gh-hit" aria-label="Minimise call"></button>
        <div class="gh-call-top-text"><div class="gh-call-top-name"></div><div class="gh-call-top-status"></div></div>
        <button class="gh-call-pip gh-hit" aria-label="Picture in picture"></button>
      </div>
      <div class="gh-call-local"></div>
      <div class="gh-call-controls">
        <button class="gh-call-btn" data-act="speaker"><span class="gh-call-btn-ic"></span><span>Speaker</span></button>
        <button class="gh-call-btn" data-act="camera"><span class="gh-call-btn-ic"></span><span>Camera</span></button>
        <button class="gh-call-btn" data-act="mute"><span class="gh-call-btn-ic"></span><span>Mute</span></button>
        <button class="gh-call-btn" data-act="flip"><span class="gh-call-btn-ic"></span><span>Flip</span></button>
        <button class="gh-call-btn gh-call-end" data-act="end"><span class="gh-call-btn-ic"></span><span>End</span></button>
      </div>
      <div class="gh-call-incoming">
        <button class="gh-call-btn gh-call-end" data-act="decline"><span class="gh-call-btn-ic"></span><span>Decline</span></button>
        <button class="gh-call-btn gh-call-accept" data-act="accept-voice"><span class="gh-call-btn-ic"></span><span>Voice</span></button>
        <button class="gh-call-btn gh-call-accept" data-act="accept-video"><span class="gh-call-btn-ic"></span><span>Video</span></button>
      </div>`;
    const q = (s) => wrap.querySelector(s);
    const setIc = (act, name) => { const b = q(`[data-act="${act}"] .gh-call-btn-ic`); b.innerHTML = ""; b.appendChild(icon(name, 26)); };
    setIc("speaker", "speakerIc"); setIc("camera", "videoCall"); setIc("mute", "mic"); setIc("flip", "flip"); setIc("end", "callEnd");
    setIc("decline", "callEnd"); setIc("accept-voice", "call"); setIc("accept-video", "videoCall");
    q(".gh-call-min").appendChild(icon("chevronDown", 26));
    q(".gh-call-pip").appendChild(icon("pip", 24));
    // picture in picture: their video keeps playing in a floating window over other apps
    const enterPip = () => {
      const v = q(".gh-call-remote video");
      if (!v) { ctx.showToast("Picture in picture works once their video is on"); return false; }
      try {
        if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode("picture-in-picture")) { v.webkitSetPresentationMode("picture-in-picture"); return true; }
        if (v.requestPictureInPicture) { v.requestPictureInPicture().catch(() => {}); return true; }
      } catch (e) {}
      ctx.showToast("Picture in picture isn't available here"); return false;
    };
    q(".gh-call-pip").addEventListener("click", (e) => { e.stopPropagation(); haptic("light"); enterPip(); });
    const c = { el: wrap, speaker: false, openedFor: null, ignored: new Set(), liveSince: new Map(), timer: null };
    // calls you hung up / declined: late engine updates about them must not reopen the screen
    const ignore = (k) => { if (!k) return; c.ignored.add(k.sessionId || ("pending|" + k.conversationId)); if (c.ignored.size > 50) c.ignored.delete(c.ignored.values().next().value); };
    const cur = () => ctx.state.activeCall;
    const act = (name, fn) => q(`[data-act="${name}"]`).addEventListener("click", (e) => { e.stopPropagation(); haptic(name === "end" || name === "decline" ? "medium" : "light"); fn(); });
    act("end", () => { const k = cur(); if (k) { ignore(k); api.endCall(k.conversationId).catch(() => {}); } closeCallScreen(ctx, true); });
    act("decline", () => { const k = cur(); if (k) { ignore(k); api.endCall(k.conversationId).catch(() => {}); } closeCallScreen(ctx, true); });
    act("accept-voice", () => { const k = cur(); if (k) api.answerCall(k.conversationId, false).catch((e) => ctx.showToast("Couldn't answer: " + (e && e.message || e))); stopRing(); });
    act("accept-video", () => { const k = cur(); if (k) api.answerCall(k.conversationId, true).catch((e) => ctx.showToast("Couldn't answer: " + (e && e.message || e))); stopRing(); });
    act("mute", () => { const k = cur(); if (k) api.setMicOn(!k.micOn).catch(() => {}); });
    act("camera", () => { const k = cur(); if (k) api.setCameraOn(k.conversationId, !k.cameraOn).catch(() => ctx.showToast("Camera isn't available")); });
    act("flip", () => { api.flipCamera().catch(() => {}); });
    act("speaker", () => {
      c.speaker = !c.speaker;
      q('[data-act="speaker"]').dataset.on = c.speaker ? "1" : "0";
      const btn = q('[data-act="speaker"]');
      try {
        window.webkit.messageHandlers.dg.postMessage({ op: "speaker", on: c.speaker }).catch(() => {
          c.speaker = !c.speaker; btn.dataset.on = c.speaker ? "1" : "0"; ctx.showToast("Speaker isn't available yet - try again once the call connects");
        });
      } catch (e) {}
    });
    q(".gh-call-min").addEventListener("click", () => { haptic("light"); wrap.dataset.open = "0"; updateCallBar(ctx); });
    // tap the video to hide/show the controls, like FaceTime
    wrap.addEventListener("click", (e) => { if (wrap.dataset.mode === "live" && wrap.dataset.video === "1" && !e.target.closest("button, .gh-call-local")) wrap.dataset.chrome = wrap.dataset.chrome === "0" ? "1" : "0"; });
    // your own picture: drag it anywhere, it snaps to the nearest corner
    const pip = q(".gh-call-local");
    let drag = null;
    pip.addEventListener("touchstart", (e) => { const t = e.touches[0], r = pip.getBoundingClientRect(); drag = { dx: (t.clientX - r.left) * pagePxToLocal(), dy: (t.clientY - r.top) * pagePxToLocal() }; pip.style.transition = "none"; }, { passive: true });
    pip.addEventListener("touchmove", (e) => {
      if (!drag) return; e.preventDefault();
      const t = e.touches[0], W = wrap.clientWidth, H = wrap.clientHeight, w = pip.offsetWidth, h = pip.offsetHeight;
      pip.style.left = clamp(t.clientX * pagePxToLocal() - drag.dx, 8, W - w - 8) + "px"; pip.style.top = clamp(t.clientY * pagePxToLocal() - drag.dy, 8, H - h - 8) + "px"; pip.style.right = "auto"; pip.style.bottom = "auto";
    }, { passive: false });
    pip.addEventListener("touchend", () => {
      if (!drag) return; drag = null;
      // getBoundingClientRect() is zoomed page px; clientWidth/offsetWidth are the host's own local px - mix
      // them and the pip snaps to the wrong corner (or the wrong spot) on a zoomed phone.
      const W = wrap.clientWidth, H = wrap.clientHeight, pw = pip.offsetWidth, ph = pip.offsetHeight;
      const r = pip.getBoundingClientRect(), wr = wrap.getBoundingClientRect(), k = pageScaleOf(wrap);
      const pipLeft = (r.left - wr.left) / k, pipTop = (r.top - wr.top) / k;
      const left = pipLeft + pw / 2 < W / 2, top = pipTop + ph / 2 < H / 2;
      pip.style.transition = "";
      pip.style.left = left ? "14px" : (W - pw - 14) + "px";
      pip.style.top = top ? "calc(var(--gh-safe-t) + 64px)" : (H - ph - 150) + "px";
    }, { passive: true });
    pip.addEventListener("click", (e) => { e.stopPropagation(); api.flipCamera().catch(() => {}); }); // tap your picture to flip
    return c;
  }
  // ringtone for incoming calls: a soft two-tone ring made on the spot (no sound files), plus haptics
  let ring = null;
  function startRing() {
    if (ring) return;
    ring = { t: null, ac: null };
    const beat = () => {
      haptic("heavy");
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ring.ac = ring.ac || new AC();
        const ac = ring.ac, now = ac.currentTime;
        for (const [f, at] of [[880, 0], [660, 0.18], [880, 0.5], [660, 0.68]]) {
          const o = ac.createOscillator(), g = ac.createGain();
          o.type = "sine"; o.frequency.value = f;
          g.gain.setValueAtTime(0, now + at); g.gain.linearRampToValueAtTime(0.18, now + at + 0.02); g.gain.linearRampToValueAtTime(0, now + at + 0.16);
          o.connect(g).connect(ac.destination); o.start(now + at); o.stop(now + at + 0.18);
        }
      } catch (e) {}
    };
    beat();
    ring.t = setInterval(beat, 2200);
  }
  function stopRing() { if (!ring) return; clearInterval(ring.t); try { ring.ac && ring.ac.close(); } catch (e) {} ring = null; }
  function callPeer(ctx, call) {
    const cd = ctx.state.convById.get(call.conversationId) || {};
    const who = cd.isGroup ? { name: cd.title, convId: cd.id, members: cd.participants || [] } : ((cd.participants && cd.participants[0]) || { name: cd.title || "Call" });
    return { cd, who, name: cd.title || who.name || "Call" };
  }
  function fmtCallTime(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); }
  function applyCalls(ctx, data) {
    const calls = (data && data.calls) || [];
    const c = ctx.callScreen, wrap = c.el;
    const prev = ctx.state.activeCall;
    // incoming beats everything; then the call you're in
    const fresh = calls.filter((k) => !c.ignored.has(k.sessionId) && !(c.ignored.has("pending|" + k.conversationId) && k.state !== "incall"));
    const incoming = fresh.find((k) => k.state === "incoming" || (k.state === "none" && k.remote.some((r) => r.state === "outgoing")));
    const live = fresh.find((k) => k.state === "incall" || k.state === "answered" || k.state === "outgoing");
    const call = live || incoming || null;
    ctx.state.activeCall = call;
    if (!call) {
      if (!calls.length) for (const k of [...c.ignored]) if (k.startsWith("pending|")) c.ignored.delete(k); // engine confirms it's over
      stopRing();
      if (prev && c.liveSince.has(prev.conversationId)) ctx.showToast("Call ended · " + fmtCallTime(Date.now() - c.liveSince.get(prev.conversationId)));
      c.liveSince.clear();
      closeCallScreen(ctx, false);
      return;
    }
    const mode = call === live ? (call.state === "outgoing" ? "outgoing" : "live") : "incoming";
    const { who, name } = callPeer(ctx, call);
    if (mode === "live" && !c.liveSince.has(call.conversationId)) c.liveSince.set(call.conversationId, Date.now());
    if (mode === "incoming") startRing(); else stopRing();
    const video = call.remote.some((r) => r.video) || call.cameraOn;
    wrap.dataset.mode = mode;
    wrap.dataset.video = video ? "1" : "0";
    wrap.dataset.remoteVideo = mode === "live" && call.remote.some((r) => r.video) ? "1" : "0"; // (ringing: their picture, not a black box)
    wrap.querySelector('[data-act="mute"]').dataset.on = call.micOn ? "0" : "1";
    wrap.querySelector('[data-act="camera"]').dataset.on = call.cameraOn ? "1" : "0";
    if (c.openedFor !== call.conversationId) {
      c.openedFor = call.conversationId;
      const av = wrap.querySelector(".gh-call-av"); av.innerHTML = ""; av.appendChild(makeAvatar(who, 132));
      const bg = wrap.querySelector(".gh-call-bg"); const [g1, g2] = gradientFor({ id: call.conversationId }, name);
      bg.style.background = `radial-gradient(circle at 50% 30%, ${g1}, transparent 70%), linear-gradient(180deg, ${g2}, #05070a)`;
      wrap.querySelector(".gh-call-name").textContent = name;
      wrap.querySelector(".gh-call-top-name").textContent = name;
      wrap.dataset.open = "1"; wrap.dataset.chrome = "1";
    }
    if (mode === "incoming" && wrap.dataset.open !== "1") wrap.dataset.open = "1";
    const status = () => {
      const k = ctx.state.activeCall; if (!k) return "";
      const m = wrap.dataset.mode;
      if (m === "incoming") return (k.remote.some((r) => r.video) ? "Incoming video call" : "Incoming call") + "…";
      if (m === "outgoing") return k.remote.some((r) => r.state === "incoming" || r.state === "outgoing") ? "Ringing…" : "Calling…";
      const since = c.liveSince.get(k.conversationId);
      return since ? fmtCallTime(Date.now() - since) : "Connecting…";
    };
    const paint = () => { const t = status(); wrap.querySelector(".gh-call-status").textContent = t; wrap.querySelector(".gh-call-top-status").textContent = t; updateCallBar(ctx); };
    paint();
    clearInterval(c.timer); c.timer = setInterval(paint, 1000);
  }
  function closeCallScreen(ctx, userEnded) {
    const c = ctx.callScreen;
    stopRing();
    clearInterval(c.timer);
    c.el.dataset.open = "0"; c.openedFor = null;
    if (userEnded) ctx.state.activeCall = null;
    updateCallBar(ctx);
  }
  function updateCallBar(ctx) {
    const bar = ctx.callBar, k = ctx.state.activeCall, c = ctx.callScreen;
    const show = !!k && c.el.dataset.open !== "1";
    bar.dataset.show = show ? "1" : "0";
    if (show !== ctx.host.hasAttribute("data-callbar")) { if (show) ctx.host.setAttribute("data-callbar", "1"); else ctx.host.removeAttribute("data-callbar"); }
    if (show) {
      const since = c.liveSince.get(k.conversationId);
      bar.querySelector(".gh-call-bar-text").textContent = callPeer(ctx, k).name + " · " + (since ? fmtCallTime(Date.now() - since) : "Calling…");
    }
  }
  async function startCallFrom(ctx, video) {
    const convId = ctx.state.currentConvId;
    if (!convId) return;
    const busy = ctx.state.activeCall;
    if (busy) { ctx.callScreen.el.dataset.open = "1"; updateCallBar(ctx); if (busy.conversationId !== convId) ctx.showToast("You're already in a call"); return; }
    haptic("medium");
    const c = ctx.callScreen;
    c.ignored.delete("pending|" + convId);
    // show the screen right away; the engine's state catches up in a moment
    ctx.state.activeCall = { conversationId: convId, state: "outgoing", remote: [], micOn: true, cameraOn: !!video, startedAt: Date.now() };
    c.openedFor = null;
    applyCalls(ctx, { calls: [ctx.state.activeCall] });
    try { await api.startCall(convId, !!video); }
    catch (e) { gtrail("call start failed " + (e && e.message || e)); ctx.showToast("Couldn't start the call"); closeCallScreen(ctx, true); }
  }

  // =====================================================================================================
  // Voice messages, like Telegram: hold the mic to record, let go to send, slide left to cancel. Recorded here
  // (the phone's own recorder, AAC) and sent as a real Snapchat voice note (bridge sendVoiceNote).
  // =====================================================================================================
  function initVoiceRecorder(ctx, screen, conv) {
    const mic = conv.micBtn;
    const bar = el("div", "gh-rec-bar");
    bar.innerHTML = '<span class="gh-rec-dot"></span><span class="gh-rec-time">0:00</span><span class="gh-rec-hint">‹ Slide to cancel</span>';
    screen.querySelector(".gh-composer").appendChild(bar);
    const r = { rec: null, stream: null, chunks: [], t0: 0, timer: null, x0: 0, cancelled: false, starting: false };
    const stopAll = () => {
      clearInterval(r.timer);
      bar.dataset.on = "0"; mic.dataset.recording = "0"; bar.style.setProperty("--rec-x", "0px");
      if (r.stream) { r.stream.getTracks().forEach((t) => t.stop()); r.stream = null; }
    };
    const start = async (x) => {
      if (r.rec || r.starting) return;
      r.starting = true; r.cancelled = false; r.x0 = x; r.chunks = [];
      try {
        r.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (r.cancelled) { stopAll(); r.starting = false; return; }
        const type = ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
        r.rec = type ? new MediaRecorder(r.stream, { mimeType: type, audioBitsPerSecond: 64000 }) : new MediaRecorder(r.stream);
        r.rec.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
        r.rec.start(200);
        r.t0 = nowMs();
        haptic("medium");
        bar.dataset.on = "1"; mic.dataset.recording = "1";
        const tick = () => { const s2 = Math.floor((nowMs() - r.t0) / 1000); bar.querySelector(".gh-rec-time").textContent = Math.floor(s2 / 60) + ":" + String(s2 % 60).padStart(2, "0"); if (s2 >= 300) finish(false); };
        tick(); r.timer = setInterval(tick, 250);
      } catch (e) {
        gtrail("mic failed " + (e && (e.name || e.message)));
        ctx.showToast("Microphone isn't available - allow it for Ghost in Settings");
        stopAll();
      }
      r.starting = false;
    };
    const finish = (cancel) => {
      const rec = r.rec;
      if (!rec) { r.cancelled = true; return; }
      r.rec = null;
      const long = nowMs() - r.t0 > 700;
      rec.onstop = async () => {
        const blob = new Blob(r.chunks, { type: (rec.mimeType || "audio/mp4").split(";")[0] });
        stopAll();
        if (cancel || !long || !blob.size) { if (!cancel && !long) ctx.showToast("Hold to record, let go to send"); return; }
        haptic("light");
        const convId = ctx.state.currentConvId;
        try { await api.sendVoiceNote(convId, blob); }
        catch (e) { gtrail("voice send failed " + (e && e.message || e)); ctx.showToast("Couldn't send the voice message"); }
      };
      try { rec.stop(); } catch (e) { stopAll(); }
    };
    mic.addEventListener("touchstart", (e) => { e.preventDefault(); start(e.touches[0].clientX); }, { passive: false });
    mic.addEventListener("touchmove", (e) => {
      if (!r.rec) return;
      const dx = Math.min(0, e.touches[0].clientX - r.x0);
      bar.style.setProperty("--rec-x", dx * pagePxToLocal() + "px");
      if (dx < -110) { haptic("light"); finish(true); }
    }, { passive: true });
    mic.addEventListener("touchend", () => finish(false));
    mic.addEventListener("touchcancel", () => finish(true));
    mic.addEventListener("click", (e) => { if (!("ontouchstart" in window)) { if (r.rec) finish(false); else start(e.clientX); } });
  }

  // ---- Save to Photos (the app writes to the camera roll; nothing is sent to Snapchat) ------------------
  async function saveRefToPhotos(ctx, ref) {
    try {
      haptic("light");
      const url = ref.url || (ref.blob && URL.createObjectURL(ref.blob));
      if (!url) throw new Error("nothing to save");
      const blob = ref.blob || await fetch(url).then((r) => r.blob());
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await window.webkit.messageHandlers.dg.postMessage({ op: "saveToPhotos", data: btoa(bin), video: ref.type === "video" || /^video/.test(blob.type) });
      ctx.showToast("Saved to Photos");
    } catch (e) { ctx.showToast(String(e && e.message || e).includes("access") ? "Allow Photos access for Ghost in Settings" : "Couldn't save"); }
  }

  // any emoji as a reaction (Snapchat's newer apps show these; the fixed set above goes as Snapchat's reaction ids)
  const EMOJI_GRID = ("😀 😃 😄 😁 😆 🥹 😅 😂 🤣 🥲 ☺️ 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😮‍💨 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🫣 🤗 🫡 🤔 🫢 🤭 🤫 🤥 😶 🫠 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🫥 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾 " +
    "👍 👎 👊 ✊ 🤛 🤜 👏 🙌 🫶 👐 🤲 🤝 🙏 ✌️ 🤞 🫰 🤟 🤘 👌 🤌 🤏 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤙 💪 🦾 🖕 ✍️ 🤳 💅 👀 👁️ 👅 👄 🫦 🧠 " +
    "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 ⚡ 🌈 ☀️ 🌙 ❄️ 💧 🎉 🎊 🎁 🏆 🥇 ⚽ 🏀 🎮 🎵 🎶 🎤 📸 💡 💰 💎 🚀 ✅ ❌ ⚠️ ❓ ❗ 🆗 🆒 🆕 🔞 💤").split(" ").filter(Boolean);
  function openEmojiReactPicker(ctx, convId, message) {
    const s = ctx.chatSheet;
    s.sheet.innerHTML = "";
    s.sheet.appendChild(el("div", "gh-sheet-grip"));
    const t = el("div", "gh-set-group-title"); t.textContent = "React with any emoji"; s.sheet.appendChild(t);
    const grid = el("div", "gh-emoji-grid");
    for (const e of EMOJI_GRID) {
      const b = el("button", "gh-emoji-cell gh-press"); b.textContent = e;
      b.addEventListener("click", () => { haptic("light"); closeSheetGeneric(s.backdrop, s.sheet); api.react(convId, message.id, e).catch(() => ctx.showToast("Couldn't react")); });
      grid.appendChild(b);
    }
    s.sheet.appendChild(grid);
    openSheetGeneric(s.backdrop, s.sheet);
  }

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
  // ---- Favorite + your own stickers -------------------------------------------------------------------
  // Favorites: stickers friends sent you, kept as their exact message content (sent again as real stickers) with a
  // picture for the grid. My Stickers: made here from your photos - the subject is cut out by iOS (like holding a
  // subject in Photos) - and sent as transparent pictures: Snapchat Web has no way to upload new stickers.
  async function favoriteSticker(ctx, m, wrapEl) {
    try {
      const r = await api.stickerContent(m.conversationId || ctx.state.currentConvId, m.id);
      const img = wrapEl && wrapEl.querySelector("img, video");
      let thumb = null;
      if (img && img.tagName === "IMG" && img.src) thumb = await fetch(img.src).then((x) => x.blob()).catch(() => null);
      if (!thumb && img && img.tagName === "VIDEO") { // GIFs play as video: keep a still frame
        const c = document.createElement("canvas"); c.width = img.videoWidth || 200; c.height = img.videoHeight || 200;
        try { c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); thumb = await new Promise((res) => c.toBlob(res, "image/png")); } catch (e) {}
      }
      const id = "f" + Date.now().toString(36);
      if (thumb) await wallDB.put("favsticker:" + id, thumb);
      const favs = await storage.get("ghostStickerFavs", []);
      await storage.set("ghostStickerFavs", [{ id, content: r.content, contentType: r.contentType }, ...favs].slice(0, 120));
      haptic("light");
      ctx.showToast("Added to Favorite Stickers");
    } catch (e) { ctx.showToast(e && e.message ? e.message : "Couldn't save that sticker"); }
  }
  function buildStickerSheet(ctx, overlaysRoot) {
    const backdrop = el("div", "gh-backdrop");
    const sheet = el("div", "gh-sheet gh-gif-sheet gh-sticker-sheet");
    sheet.style.display = "none"; // closed sheets are display:none (see closeSheetGeneric)
    sheet.innerHTML = `
      <div class="gh-sheet-grip"></div>
      <div class="gh-gif-search-row"><div class="gh-search"></div></div>
      <div class="gh-gif-tabs">
        <button class="gh-gif-tab" data-tab="recent">Recent</button>
        <button class="gh-gif-tab" data-tab="favs">Favorites</button>
        <button class="gh-gif-tab" data-tab="gifs">GIFs</button>
        <button class="gh-gif-tab" data-tab="solo">Bitmoji</button>
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
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => {
      s.query = input.value.trim().toLowerCase();
      if (s.query && (s.tab === "recent" || s.tab === "favs")) s.tab = "gifs"; // typing in Recent/Favorites searches GIFs
      renderStickers(ctx, s);
    }, s.tab === "gifs" ? 300 : 200); });
    s.body.addEventListener("scroll", () => { if (s.tab === "solo" && s.body.scrollTop + s.body.clientHeight > s.body.scrollHeight - 400) moreStickers(ctx, s); }, { passive: true });
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
    s.query = ""; s.input.value = "";
    const recents = (await storage.get("ghostStickerRecents", [])).length + (await storage.get("ghostGifRecents", [])).length;
    s.tab = recents ? "recent" : "solo";
    openSheetGeneric(s.backdrop, s.sheet);
    renderStickers(ctx, s);
  }
  async function renderStickers(ctx, s) {
    const rseq = s.rseq = (s.rseq || 0) + 1; // a newer render (tab switch, typing) wins; an older one stops
    await loadFavSets();
    if (rseq !== s.rseq) return;
    for (const [name, b] of Object.entries(s.tabs)) b.dataset.on = s.tab === name ? "1" : "0";
    clearGifBody(s);
    s.body.scrollTop = 0;
    if (s.gif) s.gif.seq++; // a GIF search still loading must not land in another tab
    s.input.placeholder = s.tab === "gifs" ? "Search Tenor" : s.tab === "solo" ? "Search stickers" : "Search GIFs";
    s.body.classList.toggle("gh-sticker-grid", s.tab !== "gifs");
    if (s.tab === "gifs") { // the GIF picker, inside the sticker sheet
      const gs = s.gif || (s.gif = { backdrop: s.backdrop, sheet: s.sheet, body: s.body, tabs: {}, tab: "trending", query: "", seq: 0, input: s.input });
      gs.query = s.query;
      renderGifResults(ctx, gs);
      return;
    }
    if (s.tab === "favs" || s.tab === "recent") { renderMixed(ctx, s, s.tab); return; }
    const p = stickerPeople(ctx);
    let list = [];
    {
      let cat;
      try { cat = await loadStickerCatalog(); if (rseq !== s.rseq) return; }
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
      const toggle = () => toggleFav(ctx, "ghostBitmojiFavs", { c: comic, duo: !!duo }, (x) => x.c === comic && !!x.duo === !!duo);
      const star = favStar(tile, favSets.bitmoji.has(comic + "|" + !!duo), toggle);
      const held = onHold(tile, () => toggle().then((on) => { star.dataset.on = on ? "1" : "0"; }));
      tile.addEventListener("click", () => { if (held()) return; sendStickerNow(ctx, s, comic, duo); });
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
      await storage.set("ghostStickerRecents", [{ c: comic, duo: !!duo, t: Date.now() }, ...recents.filter((r) => !(r.c === comic && !!r.duo === !!duo))].slice(0, 48));
    } catch (e) {
      gtrail("sticker send failed " + (e && e.message || e));
      ctx.showToast("Couldn't send that sticker");
    }
  }

  // hold (0.5 s) = the tile's second action; returns a function the click handler asks "was that a hold?"
  function onHold(tile, fn) {
    let timer = null, fired = false;
    tile.addEventListener("touchstart", () => { fired = false; clearTimeout(timer); timer = setTimeout(() => { fired = true; haptic("medium"); fn(); }, 500); }, { passive: true });
    const cancel = () => clearTimeout(timer);
    tile.addEventListener("touchmove", cancel, { passive: true });
    tile.addEventListener("touchend", cancel, { passive: true });
    tile.addEventListener("touchcancel", cancel, { passive: true });
    return () => { if (fired) { fired = false; return true; } return false; };
  }
  async function toggleFav(ctx, key, item, same) {
    const list = await storage.get(key, []);
    const had = list.some(same);
    const next = had ? list.filter((x) => !same(x)) : [Object.assign({ t: Date.now() }, item), ...list].slice(0, 150);
    await storage.set(key, next);
    if (key === "ghostGifFavs") favSets.gif = new Set(next.map((x) => x.id));
    if (key === "ghostBitmojiFavs") favSets.bitmoji = new Set(next.map((x) => x.c + "|" + !!x.duo));
    ctx.showToast(had ? "Removed from Favorites" : "Added to Favorites");
    return !had;
  }
  // Recent = Bitmoji stickers + GIFs you sent; Favorites = stickers friends sent you, Bitmoji and GIFs you held to
  // favorite. Newest first (older entries without a time keep their own order).
  async function renderMixed(ctx, s, which) {
    const rseq = s.rseq;
    const stamp = (list) => list.map((x, i) => Object.assign({}, x, { _t: x.t || (x.id && /^f[0-9a-z]+$/.test(x.id) ? parseInt(x.id.slice(1), 36) : 0) || -i }));
    let items;
    if (which === "recent") {
      items = [...stamp(await storage.get("ghostStickerRecents", [])).map((x) => ({ kind: "bitmoji", x })),
               ...stamp(await storage.get("ghostGifRecents", [])).map((x) => ({ kind: "gif", x }))];
    } else {
      items = [...stamp(await storage.get("ghostStickerFavs", [])).map((x) => ({ kind: "raw", x })),
               ...stamp(await storage.get("ghostBitmojiFavs", [])).map((x) => ({ kind: "bitmoji", x })),
               ...stamp(await storage.get("ghostGifFavs", [])).map((x) => ({ kind: "gif", x }))];
    }
    if (s.tab !== which || rseq !== s.rseq) return;
    items.sort((a, b) => b.x._t - a.x._t);
    clearGifBody(s);
    if (!items.length) {
      s.body.appendChild(Object.assign(el("div", "gh-gif-empty"), { textContent: which === "recent" ? "Stickers and GIFs you send show up here" : "Hold any sticker or GIF to add it here. Stickers friends send: hold the message and tap \"Add to Favorite Stickers\"." }));
      return;
    }
    const p = stickerPeople(ctx);
    for (const { kind, x } of items) {
      const tile = el("button", "gh-sticker-tile gh-press");
      let img = el("img"); img.alt = "";
      if (kind !== "gif") tile.appendChild(img);
      let send, hold, starOn = which === "favs";
      if (kind === "bitmoji") {
        if (x.duo && !p.friend) continue;
        img.loading = "lazy"; img.src = stickerUrl(x.c, p.me, x.duo ? p.friend : null);
        img.addEventListener("error", () => tile.remove(), { once: true });
        starOn = favSets.bitmoji.has(x.c + "|" + !!x.duo);
        send = () => sendStickerNow(ctx, s, x.c, x.duo);
        hold = () => toggleFav(ctx, "ghostBitmojiFavs", { c: x.c, duo: !!x.duo }, (y) => y.c === x.c && !!y.duo === !!x.duo).then((on) => { if (!on && which === "favs") tile.remove(); return on; });
      } else if (kind === "gif") {
        tile.classList.add("gh-sticker-gif");
        gifThumb(tile, x);
        starOn = favSets.gif.has(x.id);
        send = () => sendGif(ctx, x, s);
        hold = () => toggleFav(ctx, "ghostGifFavs", gifEntry(x), (y) => y.id === x.id).then((on) => { if (!on && which === "favs") tile.remove(); return on; });
      } else {
        wallDB.get("favsticker:" + x.id).then((b) => { if (b) img.src = URL.createObjectURL(b); }).catch(() => {});
        send = async () => {
          const convId = ctx.state.currentConvId; if (!convId) return;
          haptic(); closeSheetGeneric(s.backdrop, s.sheet);
          try { await api.sendStickerRaw(convId, x.content, x.contentType); } catch (e) { gtrail("saved sticker send failed " + (e && e.message)); ctx.showToast("Couldn't send that sticker"); }
        };
        hold = async () => {
          const cur = await storage.get("ghostStickerFavs", []);
          await storage.set("ghostStickerFavs", cur.filter((y) => y.id !== x.id));
          wallDB.del("favsticker:" + x.id); tile.remove(); ctx.showToast("Removed from Favorites");
          return false;
        };
      }
      const star = favStar(tile, starOn, () => Promise.resolve(hold()).then((on) => on !== false && on !== undefined ? on : false));
      const held = onHold(tile, () => Promise.resolve(hold()).then((on) => { star.dataset.on = on ? "1" : "0"; }));
      tile.addEventListener("click", () => { if (held()) return; send(); });
      s.body.appendChild(tile);
    }
  }
  // One blob URL per GIF video, reused by every repaint (the chat re-draws its bubbles all the time; each used to
  // make - and never free - a new copy, which is part of what grew the page until iOS killed it). Oldest dropped.
  const gifMp4Cache = new Map();
  async function cachedBlobUrl(key, load) {
    if (gifMp4Cache.has(key)) { const v = gifMp4Cache.get(key); gifMp4Cache.delete(key); gifMp4Cache.set(key, v); return v; }
    const p = load().then((bytes) => URL.createObjectURL(new Blob([bytes], { type: "video/mp4" })));
    gifMp4Cache.set(key, p);
    p.catch(() => gifMp4Cache.delete(key));
    while (gifMp4Cache.size > 80) { const [k, old] = gifMp4Cache.entries().next().value; gifMp4Cache.delete(k); Promise.resolve(old).then((u) => setTimeout(() => URL.revokeObjectURL(u), 5000), () => {}); }
    return p;
  }
  function gifMp4Url(gid) { return cachedBlobUrl("giphy:" + gid, () => gmBytes(giphyMedia(gid, "200w.mp4"))); }
  function gifEntry(g) { return g.src === "tenor" ? { src: "tenor", id: g.id, w: g.w, h: g.h, p: g.p, f: g.f, v: g.v } : { id: g.id, w: g.w, h: g.h }; }
  // Animated previews: animated images stay on their first frame on the phone (see the GIF bubble note), so a tile
  // shows Tenor's still/WebP first and swaps in its small looping MP4 once it scrolls into view; off-screen = paused.
  let gifIO = null;
  function gifVideoIO() {
    if (gifIO || typeof IntersectionObserver !== "function") return gifIO;
    gifIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const t = e.target;
        if (!e.isIntersecting) { if (t._video) t._video.pause(); continue; }
        if (t._video) { t._video.play().catch(() => {}); continue; }
        if (t._loading) continue;
        t._loading = true;
        cachedBlobUrl("tenor:" + t._gif.v, () => gmBytes(t._gif.v)).then((url) => {
          const v = el("video");
          v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
          v.setAttribute("playsinline", ""); v.setAttribute("muted", "");
          v.src = url;
          v.addEventListener("loadeddata", () => { t.classList.add("gh-gif-playing"); v.play().catch(() => {}); }, { once: true });
          t._video = v;
          t.insertBefore(v, t.firstChild);
        }).catch(() => {});
      }
    }, { rootMargin: "150px" });
    return gifIO;
  }
  function gifThumb(tile, g) {
    const img = el("img"); img.alt = "";
    gifPreviewFor(g).then((r) => { if (r && r.dataUrl) img.src = r.dataUrl; });
    tile.appendChild(img);
    const io = g.v && typeof window.__ghostGiphyMock !== "function" && gifVideoIO();
    if (io) { tile._gif = g; io.observe(tile); }
  }
  // gifIO (above) is created once and never recreated, so every tile it ever observed stays registered - and kept
  // alive, playing/paused video and all - until unobserved. Every repaint here used to just throw the old tiles
  // away with body.innerHTML="", so scrolling/searching/switching tabs in the sticker or GIF sheet grew gifIO's
  // watch list without bound (the exact unbounded-growth problem this file already fights for blob URLs).
  function clearGifBody(s) {
    if (gifIO) for (const t of s.body.querySelectorAll(".gh-gif-tile, .gh-sticker-gif")) { if (t._video) t._video.pause(); gifIO.unobserve(t); }
    s.body.innerHTML = "";
  }
  // favorites, kept in memory while the sheet is open so every tile knows its star
  const favSets = { gif: new Set(), bitmoji: new Set() };
  async function loadFavSets() {
    favSets.gif = new Set((await storage.get("ghostGifFavs", [])).map((x) => x.id));
    favSets.bitmoji = new Set((await storage.get("ghostBitmojiFavs", [])).map((x) => x.c + "|" + !!x.duo));
  }
  // Discord-style: a little star in the top-left corner of every sticker/GIF adds or removes it from Favorites
  function favStar(tile, on, toggle) {
    const b = el("button", "gh-fav-star");
    b.setAttribute("aria-label", "Favorite");
    b.dataset.on = on ? "1" : "0";
    b.appendChild(icon("star", 13));
    b.addEventListener("click", async (e) => { e.stopPropagation(); haptic("light"); const now = await toggle(); b.dataset.on = now ? "1" : "0"; });
    tile.appendChild(b);
    return b;
  }
  async function sendGif(ctx, g, s) {
    haptic();
    const r = await gifFileFor(g);
    gtrail("picked " + g.id + (r && r.dataUrl ? " loaded " + r.dataUrl.length : " load failed " + (r && r.error)));
    if (!r || !r.dataUrl) { ctx.showToast("Couldn't load that GIF"); return; }
    const convId = ctx.state.currentConvId;
    const bin = atob(r.dataUrl.slice(r.dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/gif" });
    closeSheetGeneric(s.backdrop, s.sheet);
    try { await api.sendMedia(convId, blob, { kind: "gif" }); gtrail("sent " + g.id); } catch (e) { gtrail("send failed " + (e && e.message || e)); ctx.showToast("Couldn't send that GIF"); }
    const recents = await storage.get("ghostGifRecents", []);
    await storage.set("ghostGifRecents", [Object.assign({ t: Date.now() }, gifEntry(g)), ...recents.filter((r2) => r2.id !== g.id)].slice(0, 40));
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
    input.placeholder = "Search Tenor";
    input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
    input.setAttribute("aria-label", "Search Tenor");
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
    await loadFavSets();
    paintGifTabs(s);
    const mySeq = ++s.seq;
    clearGifBody(s);
    if (s.query) return void loadGifGrid(ctx, s, mySeq, () => tenorSearch(s.query));
    if (s.tab === "trending") return void loadGifGrid(ctx, s, mySeq, () => tenorSearch(""));
    if (s.tab === "favorites") return void loadStaticGifGrid(ctx, s, mySeq, "ghostGifFavs");
    if (s.tab === "recents") return void loadStaticGifGrid(ctx, s, mySeq, "ghostGifRecents");
  }
  async function loadStaticGifGrid(ctx, s, mySeq, key) {
    const list = await storage.get(key, []);
    if (mySeq !== s.seq) return;
    if (!list.length) { const note = el("div", "gh-gif-note"); note.textContent = key === "ghostGifFavs" ? "Hold a GIF to add it to Favorites" : "GIFs you send will show up here"; s.body.appendChild(note); return; }
    paintGifGrid(ctx, s, list);
  }
  async function loadGifGrid(ctx, s, mySeq, fetcher) {
    const skelGrid = el("div", "gh-gif-grid");
    const cols = [el("div", "gh-gif-col"), el("div", "gh-gif-col")];
    skelGrid.append(...cols);
    s.body.appendChild(skelGrid);
    const res = await fetcher();
    if (mySeq !== s.seq) return;
    if (!res) { s.body.innerHTML = ""; return; }
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
    gifThumb(tile, g);
    const toggle = () => toggleFav(ctx, "ghostGifFavs", gifEntry(g), (y) => y.id === g.id);
    const star = favStar(tile, favSets.gif.has(g.id), toggle);
    const held = onHold(tile, () => toggle().then((on) => { star.dataset.on = on ? "1" : "0"; }));
    tile.addEventListener("click", () => { if (held()) return; sendGif(ctx, g, s); });
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
      <input class="gh-newchat-title" placeholder="Group name (optional)" maxlength="60" style="display:none">
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
    const s = { backdrop, sheet, input, list: sheet.querySelector(".gh-friend-list"), createBtn: sheet.querySelector(".gh-newchat-create"), titleInput: sheet.querySelector(".gh-newchat-title"), picked: new Map(), seq: 0, addTo: null };
    sheet.querySelector('[data-act="close"]').addEventListener("click", () => { haptic("light"); closeSheetGeneric(backdrop, sheet); });
    let t;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => runFriendSearch(ctx, s), 200); });
    s.createBtn.addEventListener("click", async () => {
      if (!s.picked.size) return;
      haptic();
      if (s.addTo) { // "Add to group" mode
        try { await api.addToGroup(s.addTo, Array.from(s.picked.keys())); closeSheetGeneric(backdrop, sheet); ctx.showToast("Added to the group"); }
        catch (e) { ctx.showToast("Couldn't add them"); }
        return;
      }
      try {
        const res = s.picked.size > 1 ? await api.createGroup(Array.from(s.picked.keys()), s.titleInput.value.trim()) : await api.newConversation(Array.from(s.picked.keys()));
        closeSheetGeneric(backdrop, sheet);
        if (res && res.conversationId) {
          if (!ctx.state.convById.has(res.conversationId)) await api.listConversations().then((cs) => applyConversations(ctx, cs || []));
          openConversationScreen(ctx, res.conversationId);
        }
      } catch (e) { ctx.showToast("Couldn't start that chat"); }
    });
    return s;
  }
  function openNewChatSheet(ctx, addTo) {
    const s = ctx.newChatSheet;
    s.addTo = addTo || null;
    s.picked = new Map();
    s.input.value = "";
    s.titleInput.value = "";
    s.titleInput.style.display = "none";
    s.createBtn.textContent = addTo ? "Add to Group" : "Chat";
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
        if (!s.addTo) { s.titleInput.style.display = s.picked.size > 1 ? "" : "none"; s.createBtn.textContent = s.picked.size > 1 ? "Create Group" : "Chat"; }
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
        <button class="gh-viewer-save gh-hit" aria-label="Save to Photos"></button>
        <button class="gh-viewer-unsave gh-hit" aria-label="Unsave in Chat"></button>
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
    wrap.querySelector(".gh-viewer-save").appendChild(icon("download", 20));
    wrap.querySelector(".gh-viewer-save").addEventListener("click", (e) => { e.stopPropagation(); const ref = ctx.viewer.currentRef; if (ref) saveRefToPhotos(ctx, ref); });
    // Unsave in Chat: only shown while viewing a saved-in-chat snap (openSnapPlaythrough mode "saved" sets
    // el.dataset.unsave). Confirms, calls the existing saveMessage(convId, id, false) path, then closes and lets
    // the chat's own repaint swap the bubble back to the small snap row.
    const unsaveBtn = wrap.querySelector(".gh-viewer-unsave");
    unsaveBtn.appendChild(icon("bookmark", 18));
    unsaveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const v = ctx.viewer;
      const q = v.snapQ;
      if (!q || q.mode !== "saved") return;
      const m = q.msgs[v.idx];
      if (!m) return;
      haptic("light");
      const ok = await confirmSheet(ctx, "Unsave this Snap? It'll show as a Snap you have to tap to view again.", "Unsave");
      if (!ok || v.snapQ !== q) return;
      const convId = m.conversationId || q.convId || ctx.state.currentConvId;
      m.saved = false;
      closeViewer(ctx);
      if (ctx.conv && ctx.state.currentConvId === convId) paintWindow(ctx, ctx.conv);
      try { await api.saveMessage(convId, m.id, false); ctx.showToast("Unsaved"); }
      catch (err) { m.saved = true; if (ctx.conv && ctx.state.currentConvId === convId) paintWindow(ctx, ctx.conv); ctx.showToast("Couldn't unsave that Snap"); }
    });
    const v = {
      el: wrap, bars: wrap.querySelector(".gh-viewer-bars"), media: wrap.querySelector(".gh-viewer-media"),
      nameEl: wrap.querySelector(".gh-viewer-top-name"), avatarSlot: wrap.querySelector(".gh-viewer-top"),
      items: [], idx: 0, timer: null, startedAt: 0, elapsedAtPause: 0, paused: false, single: false,
      currentRef: null, snapQ: null,
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
      if (!e.touches || e.touches.length !== 1 || v.replyOpen) return;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY; mode = null; held = false;
      holdTimer = setTimeout(() => { held = true; pauseViewer(ctx, true); }, 200);
    }, { passive: true });
    wrap.addEventListener("touchmove", (e) => {
      if (!e.touches || e.touches.length !== 1 || v.replyOpen) return;
      const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
      if (!mode && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { mode = dy > 0 ? "down" : "up"; clearTimeout(holdTimer); }
      if (mode === "down") {
        wrap.style.transform = `translateY(${Math.max(0, dy) * pagePxToLocal()}px) scale(${clamp(1 - dy / 2000, 0.85, 1)})`;
        wrap.style.opacity = String(clamp(1 - dy / 500, 0.4, 1));
      } else if (mode === "up") {
        v.media.style.transform = `translateY(${Math.max(-60, dy * pagePxToLocal() / 3)}px)`;
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
    v.story = null; v.snapQ = null; v.el.dataset.unsave = "0";
    v.single = true; v.items = [mediaRef]; v.idx = 0;
    v.el.dataset.open = "1"; v.bars.style.display = "none"; v.avatarSlot.style.display = "none";
    paintViewerItem(ctx);
  }
  function openViewerSequence(ctx, items, opts) {
    const v = ctx.viewer;
    if (!(opts && opts.keepStory)) v.story = null;
    v.snapQ = null; v.el.dataset.unsave = "0";
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
    v.snapQ = null; v.el.dataset.unsave = "0";
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
    v.currentRef = ref;
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
      // A snap-queue video segment resumes on its own (the <video> itself, paused above, just keeps playing) and
      // its 'ended' event is what drives the swap to the next part - a second timer here racing that would double-
      // advance. Everything else (images, queue or not; stories; single/sequence video) keeps the timer-driven step.
      if (!(v.snapQ && video)) v.timer = setTimeout(() => { if (v.snapQ) advanceSnapQueue(ctx, v.snapQ, v.idx); else viewerStep(ctx, 1); }, remaining);
      if (!v.single) {
        const fill = v.bars.querySelectorAll(".gh-viewer-bar-fill")[v.idx];
        if (fill) requestAnimationFrame(() => { fill.style.transitionDuration = remaining + "ms"; fill.style.width = "100%"; });
      }
    }
  }
  function viewerStep(ctx, dir) {
    const v = ctx.viewer;
    if (v.snapQ) { clearTimeout(v.timer); const next = v.idx + dir; if (next >= 0) paintSnapQueueItem(ctx, next); return; }
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
    teardownSnapQueue(ctx);
    if (v.el.dataset.story === "1") {
      setTimeout(() => refreshStories(ctx), 600); // ring goes grey right away
      // openStory's resolved photos/videos are fresh blob URLs every open (bridge.js re-resolves each time) and
      // were never freed - leaving them stacking up for as long as Ghost stays open. Same key bridge.js tracked
      // them under when it returned them.
      if (v.story) api.releaseMedia("story:" + v.story.user.id).catch(() => {});
    }
    v.el.dataset.story = "0";
    if (v.replyOpen) { v.replyOpen = false; v.el.dataset.reply = "0"; v.replyInput.blur(); }
    v.loadToken = (v.loadToken || 0) + 1;
    clearTimeout(v.timer);
    v.el.dataset.open = "0";
    v.el.style.transform = ""; v.el.style.opacity = "";
    v.media.innerHTML = "";
  }

  // =====================================================================================================
  // Snap playthrough (shared engine): plays one or more snap MESSAGES full-screen, resolving each one's media
  // lazily (never before it's actually reached, matching openSnap's own "mark opened" semantics) via whichever
  // bridge call the mode needs: "unopened" (api.openSnap, marks opened + a read for the peer), "replay" (a
  // one-time api.replaySnap, also marks opened), "saved" (api.loadMedia - a saved-in-chat snap's media stays
  // downloadable and re-viewing it is not a new view or a receipt, same as the resolver Snapchat Web itself
  // uses to show a saved snap inline - see BRIDGE_NOTES.md's "Media loader" section).
  //
  // Consecutive same-sender parts within SNAP_GROUP_GAP_MS (snapRunFrom, defined above snapTileEl) are treated as
  // candidate segments of one multi-part video; once a segment resolves to type "video", the NEXT candidate's
  // media is resolved ahead of time (one segment ahead, only while a confirmed video plays) and, if it also turns
  // out to be a video, swapped in on 'ended' with an already-loaded <video> element - no spinner, no black frame,
  // no progress-bar reset - continuing the single per-snap-segment bar strip started by openSnapPlaythrough.
  function teardownSnapQueue(ctx) {
    const v = ctx.viewer;
    const q = v.snapQ;
    if (!q) return;
    q.live = false;
    v.snapQ = null;
    v.el.dataset.unsave = "0";
    // Finish (finishedViewingSnap) every part that actually got a real "started viewing" call, whether the user
    // watched it (advanced past it) or it was already pre-resolved as the next segment of a video in progress
    // when the viewer closed - it was already marked opened server-side either way. Never sent for "saved" (its
    // loadMedia resolver never starts a viewing session to begin with, so there is nothing to finish).
    if (q.mode === "unopened" || q.mode === "replay") {
      for (const idx of q.openedForClose) {
        const m = q.msgs[idx];
        api.closeSnap(m.conversationId || q.convId || ctx.state.currentConvId, m.id).catch(() => {});
      }
    }
    if (q.onDone) q.onDone();
  }
  function resolveSnapPart(ctx, m, mode, convId) {
    if (mode === "saved") return api.loadMedia(convId, m.id).then((r) => (r && r.media) || []);
    if (mode === "replay") return api.replaySnap(convId, m.id).then((r) => (r && r.media) || []);
    return api.openSnap(convId, m.id).then((r) => (r && r.media) || []);
  }
  // Resolves (and caches) segment `idx`'s media, exactly once, the first time it's asked for - by the normal
  // paint path when playback reaches it, or by maybePrefetchNext one segment early while the previous video plays.
  function getSnapRef(ctx, q, idx) {
    if (idx < 0 || idx >= q.msgs.length) return Promise.resolve(null);
    if (q.cache.has(idx)) return q.cache.get(idx);
    const m = q.msgs[idx];
    const convId = m.conversationId || q.convId || ctx.state.currentConvId;
    const p = resolveSnapPart(ctx, m, q.mode, convId).then((media) => {
      const ref = (media && media[0]) || null;
      if (ref) {
        m.opened = true;
        if (q.mode === "unopened" || q.mode === "replay") {
          if (q.live) q.openedForClose.add(idx);
          else api.closeSnap(convId, m.id).catch(() => {}); // the queue already closed before this resolved - finish the view we already started
        }
      }
      return ref;
    }).catch((e) => { gtrail("snap-queue part failed " + (e && e.message || e)); return null; });
    q.cache.set(idx, p);
    return p;
  }
  function inSameRun(msgs, i, j) {
    if (j < 0 || j >= msgs.length || j <= i) return false;
    const a = msgs[i], b = msgs[j];
    if (b.kind !== "snap") return false;
    // same sender (this alone also implies the same fromMe-ness - see isFromMe's comment above snapRunFrom)
    if ((b.from && b.from.id) !== (a.from && a.from.id)) return false;
    if (b.ts < a.ts || b.ts - a.ts > SNAP_GROUP_GAP_MS) return false;
    return true;
  }
  function makeSnapVideoEl(ref) {
    const video = el("video");
    video.muted = false; video.playsInline = true; video.preload = "auto";
    video.src = ref.url || (ref.blob && URL.createObjectURL(ref.blob)) || "";
    return video;
  }
  // Only called once the CURRENT segment is confirmed to be a video - a photo never chains, so there's nothing to
  // preload ahead of it (the next segment, if any, resolves fresh and lazily when actually reached, same as always).
  function maybePrefetchNext(ctx, q, idx) {
    const nextIdx = idx + 1;
    if (!inSameRun(q.msgs, idx, nextIdx) || q.preloaded.has(nextIdx) || q.cache.has(nextIdx)) return;
    getSnapRef(ctx, q, nextIdx).then((ref) => {
      if (!q.live || ctx.viewer.snapQ !== q) return;
      if (!ref || ref.type !== "video") { q.preloaded.set(nextIdx, { ref, video: null }); return; }
      q.preloaded.set(nextIdx, { ref, video: makeSnapVideoEl(ref) });
    });
  }
  function startSnapSegmentTimer(ctx, idx, durMs, onExpire) {
    const v = ctx.viewer;
    clearTimeout(v.timer);
    v.startedAt = nowMs(); v.dur = durMs; v.paused = false;
    const fills = v.bars.querySelectorAll(".gh-viewer-bar-fill");
    fills.forEach((f, i) => { if (i !== idx) { f.classList.remove("gh-anim"); f.style.transition = "none"; f.style.width = i < idx ? "100%" : "0%"; } });
    const fill = fills[idx];
    if (fill) { fill.style.transition = "none"; fill.style.width = "0%"; requestAnimationFrame(() => { fill.classList.add("gh-anim"); fill.style.transitionDuration = durMs + "ms"; fill.style.width = "100%"; }); }
    if (onExpire) v.timer = setTimeout(onExpire, durMs);
  }
  function advanceSnapQueue(ctx, q, idx) {
    const v = ctx.viewer;
    if (v.snapQ !== q || v.idx !== idx) return; // stale timer racing a real advance/close
    clearTimeout(v.timer);
    paintSnapQueueItem(ctx, idx + 1);
  }
  function showSnapImage(ctx, q, idx, ref) {
    const v = ctx.viewer;
    v.media.innerHTML = "";
    const img = el("img");
    img.src = ref.url || (ref.blob && URL.createObjectURL(ref.blob)) || "";
    v.media.appendChild(img);
    if (ref.overlay) { const ov = el("img", "gh-viewer-overlay"); ov.src = ref.overlay; ov.alt = ""; v.media.appendChild(ov); }
    v.currentRef = ref;
    startSnapSegmentTimer(ctx, idx, 5000, () => advanceSnapQueue(ctx, q, idx));
  }
  function showSnapVideo(ctx, q, idx, ref, video) {
    const v = ctx.viewer;
    v.media.innerHTML = "";
    v.media.appendChild(video);
    if (ref.overlay) { const ov = el("img", "gh-viewer-overlay"); ov.src = ref.overlay; ov.alt = ""; v.media.appendChild(ov); }
    v.currentRef = ref;
    video.currentTime = 0;
    video.play().catch(() => {});
    video.addEventListener("ended", () => {
      if (ctx.viewer.snapQ !== q || v.idx !== idx) return;
      const nextIdx = idx + 1;
      const pre = q.preloaded.get(nextIdx);
      if (pre && pre.video) { q.preloaded.delete(nextIdx); v.idx = nextIdx; showSnapVideo(ctx, q, nextIdx, pre.ref, pre.video); }
      else advanceSnapQueue(ctx, q, idx);
    }, { once: true });
    // 'ended' is the real advance signal; the timer here only drives the visual bar fill (no onExpire - see the
    // pauseViewer resume-branch note for why a competing advance timer would double-fire for a queue video).
    if (ref.durationSec) startSnapSegmentTimer(ctx, idx, ref.durationSec * 1000, null);
    else video.addEventListener("loadedmetadata", () => {
      if (isFinite(video.duration) && video.duration > 0 && ctx.viewer.snapQ === q && v.idx === idx) startSnapSegmentTimer(ctx, idx, video.duration * 1000 + 200, null);
    }, { once: true });
    maybePrefetchNext(ctx, q, idx);
  }
  async function paintSnapQueueItem(ctx, idx) {
    const v = ctx.viewer;
    const q = v.snapQ;
    if (!q) return;
    clearTimeout(v.timer);
    if (idx >= q.msgs.length) { closeViewer(ctx); return; }
    v.idx = idx;
    const pre = q.preloaded.get(idx);
    if (pre) {
      q.preloaded.delete(idx);
      if (pre.ref && pre.video) { showSnapVideo(ctx, q, idx, pre.ref, pre.video); return; }
      if (pre.ref) { showSnapImage(ctx, q, idx, pre.ref); return; }
      paintSnapQueueItem(ctx, idx + 1); return; // that prefetch failed to resolve - skip it, same as a fresh failure below
    }
    v.media.innerHTML = "";
    v.media.appendChild(el("div", "gh-spinner gh-viewer-spinner"));
    const token = (v.snapLoadToken = (v.snapLoadToken || 0) + 1);
    const ref = await getSnapRef(ctx, q, idx);
    if (v.snapQ !== q || v.snapLoadToken !== token) return; // closed, or advanced again while this was loading
    if (!ref) {
      if (idx === 0) ctx.showToast("Couldn't load that Snap");
      paintSnapQueueItem(ctx, idx + 1);
      return;
    }
    if (ref.type === "video") showSnapVideo(ctx, q, idx, ref, makeSnapVideoEl(ref));
    else showSnapImage(ctx, q, idx, ref);
  }
  // msgs: ordered (oldest-first) snap messages to play through, already curated by the caller for `mode`'s
  // eligibility (all unopened+received, all opened+replayable+unsaved, or all saved+viewable). A single caller-
  // built run (snapTileEl's replay/open handlers, savedSnapMediaEl) is usually 1-4 messages (one logical clip);
  // the pre-chat-open queue (openChatFromRow) can be the whole conversation's unopened snaps, independent clips
  // and multi-part groups mixed together - grouping is detected automatically as adjacent entries resolve.
  function openSnapPlaythrough(ctx, msgs, mode, opts) {
    opts = opts || {};
    const v = ctx.viewer;
    v.story = null;
    v.single = false;
    v.snapQ = { msgs, mode, convId: opts.convId, cache: new Map(), preloaded: new Map(), openedForClose: new Set(), live: true, onDone: opts.onDone || null };
    v.el.dataset.open = "1";
    v.el.dataset.unsave = mode === "saved" ? "1" : "0";
    v.avatarSlot.style.display = "flex";
    v.bars.style.display = msgs.length > 1 ? "flex" : "none";
    v.bars.innerHTML = "";
    for (let i = 0; i < msgs.length; i++) { const bar = el("div", "gh-viewer-bar"); bar.appendChild(el("div", "gh-viewer-bar-fill")); v.bars.appendChild(bar); }
    v.nameEl.textContent = opts.title || "";
    v.idx = 0;
    paintSnapQueueItem(ctx, 0);
  }

  // =====================================================================================================
  // Camera (device required — see notes below)
  // =====================================================================================================
  // Snap camera: full-screen preview, tap = photo, hold = video (up to 60s, ring fills), double-tap = flip, library
  // button. Then a full-screen preview and a "Send To" sheet with search + multi-select (someone may already be
  // picked when the camera was opened from a chat or by double-tapping their row). Sends as a real Snap (bridge sendSnap).
  const MAX_VIDEO_MS = 60000;
  function perfNow() { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); }
  function fmtRecTime(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

  function buildCamera(ctx) {
    const wrap = el("div", "gh-camera");
    wrap.innerHTML = `
      <div class="gh-cam-live"><div class="gh-camera-note">Starting camera…</div></div>
      <canvas class="gh-cam-freeze"></canvas>
      <div class="gh-cam-focus"></div>
      <div class="gh-camera-top">
        <button class="gh-cam-btn gh-hit" data-act="close"></button>
        <div class="gh-cam-to"></div>
        <div class="gh-cam-spacer"></div>
      </div>
      <div class="gh-cam-rail">
        <button class="gh-cam-btn gh-hit" data-act="flip"></button>
        <button class="gh-cam-btn gh-hit" data-act="flash" data-state="off"></button>
        <button class="gh-cam-btn gh-hit gh-cam-timer-btn" data-act="timer" data-mode="0"><span class="gh-cam-timer-label"></span></button>
      </div>
      <div class="gh-cam-zoom-pill" data-show="0">1.0x</div>
      <div class="gh-cam-selftimer" data-show="0"></div>
      <div class="gh-cam-rectimer">0:00</div>
      <div class="gh-cam-lock"></div>
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
        <canvas class="gh-editor-draw"></canvas>
        <div class="gh-editor-items"></div>
        <div class="gh-editor-textwrap">
          <div class="gh-editor-textinput" contenteditable="true" data-style="0"></div>
        </div>
        <div class="gh-editor-colorbar"><div class="gh-editor-colorthumb"></div></div>
        <div class="gh-editor-sizes">
          <button class="gh-editor-size gh-hit" data-size="0"><i></i></button>
          <button class="gh-editor-size gh-hit" data-size="1"><i></i></button>
          <button class="gh-editor-size gh-hit" data-size="2"><i></i></button>
        </div>
        <div class="gh-camera-top">
          <button class="gh-cam-btn gh-hit" data-act="retake"></button>
          <div class="gh-cam-spacer"></div>
          <button class="gh-cam-btn gh-hit gh-editor-tool" data-tool="undo" style="display:none"></button>
        </div>
        <div class="gh-editor-rail">
          <button class="gh-cam-btn gh-hit gh-editor-tool" data-tool="text"></button>
          <button class="gh-cam-btn gh-hit gh-editor-tool" data-tool="draw"></button>
          <button class="gh-cam-btn gh-hit gh-editor-tool" data-tool="sticker"></button>
        </div>
        <div class="gh-editor-trash"><div class="gh-editor-trash-ic"></div></div>
        <div class="gh-cam-review-bottom-l"><button class="gh-cam-save gh-hit" data-act="save"></button></div>
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
    q('[data-act="flash"]').appendChild(icon("flash", 18)); q('[data-act="flash"]').setAttribute("aria-label", "Flash");
    q('[data-act="timer"]').insertBefore(icon("timerIcon", 15), q('[data-act="timer"]').firstChild); q('[data-act="timer"]').setAttribute("aria-label", "Self-timer");
    q(".gh-cam-lock").appendChild(icon("lock", 16));
    q('[data-act="library"]').appendChild(icon("gallery", 22)); q('[data-act="library"]').setAttribute("aria-label", "Choose from library");
    q('[data-act="retake"]').appendChild(icon("close", 22)); q('[data-act="retake"]').setAttribute("aria-label", "Discard");
    q('[data-act="sendto"]').appendChild(icon("send", 18));
    q('[data-act="picker-back"]').appendChild(icon("back", 22)); q('[data-act="picker-back"]').setAttribute("aria-label", "Back");
    q('[data-act="send"]').appendChild(icon("send", 22));
    q('[data-act="save"]').appendChild(icon("download", 20)); q('[data-act="save"]').setAttribute("aria-label", "Save to Photos");
    q('[data-tool="text"]').appendChild(icon("textTool", 20)); q('[data-tool="text"]').setAttribute("aria-label", "Add text");
    q('[data-tool="draw"]').appendChild(icon("edit", 20)); q('[data-tool="draw"]').setAttribute("aria-label", "Draw");
    q('[data-tool="sticker"]').appendChild(icon("emoji", 20)); q('[data-tool="sticker"]').setAttribute("aria-label", "Stickers");
    q('[data-tool="undo"]').appendChild(icon("undo", 20)); q('[data-tool="undo"]').setAttribute("aria-label", "Undo stroke");

    const c = {
      el: wrap, live: q(".gh-cam-live"), shutter: q(".gh-shutter"), ring: q(".gh-shutter-ring circle"), toEl: q(".gh-cam-to"),
      review: q(".gh-cam-review"), reviewMedia: q(".gh-cam-review-media"), picker: q(".gh-cam-picker"), list: q(".gh-cam-list"),
      search: q(".gh-cam-search input"), chosen: q(".gh-cam-chosen"), sendBtn: q('[data-act="send"]'), file: q('input[type="file"]'),
      flashBtn: q('[data-act="flash"]'), timerBtn: q('[data-act="timer"]'), timerLabel: q(".gh-cam-timer-label"),
      zoomPill: q(".gh-cam-zoom-pill"), focusRing: q(".gh-cam-focus"), freeze: q(".gh-cam-freeze"), lockTarget: q(".gh-cam-lock"),
      recTimerEl: q(".gh-cam-rectimer"), selfTimerEl: q(".gh-cam-selftimer"),
      stream: null, video: null, facing: "user", recording: false, recorder: null, chunks: [], recStart: 0, recTimer: null,
      captured: null, picked: new Set(), preselect: null, sending: false,
      gen: 0,                                            // bumped on every stream (re)start so a stale getUserMedia
                                                           // promise (flip/open spam) stops its tracks instead of applying
      devices: { user: null, environment: null, ultra: null }, devicesReady: false,
      audioTrack: null,                                   // mic track, requested once on first recording, then reused
      torchSupported: false, torchOn: false, flash: "off",
      timerMode: 0,                                       // 0 / 3 / 10 (seconds)
      selfTimerRunning: false, selfTimerTimer: null,
      zoom: 1, zoomMin: 1, zoomMax: 1, zoomHardware: false, usingUltra: false, pinch: null,
      lockedRecording: false, startingRecording: false, recordCancelled: false, recTickTimer: null,
      _zoomTimer: null, _zoomPillTimer: null,
    };
    q('[data-act="close"]').addEventListener("click", () => { haptic("light"); closeCamera(ctx); });
    q('[data-act="flip"]').addEventListener("click", () => flipCamera(ctx));
    c.flashBtn.addEventListener("click", () => toggleFlash(ctx));
    c.timerBtn.addEventListener("click", () => cycleTimer(ctx));
    q('[data-act="library"]').addEventListener("click", () => { haptic("light"); c.file.click(); });
    c.file.addEventListener("change", () => {
      const f = c.file.files && c.file.files[0];
      c.file.value = "";
      if (f) openReview(ctx, f, f.type.startsWith("video") ? "video" : "image", false);
    });
    q('[data-act="retake"]').addEventListener("click", () => { haptic("light"); discardReview(ctx); });
    q('[data-act="sendto"]').addEventListener("click", () => { haptic(); openPicker(ctx); });
    q('[data-act="picker-back"]').addEventListener("click", () => { haptic("light"); c.picker.dataset.open = "0"; });
    q('[data-act="send"]').addEventListener("click", () => sendSnapNow(ctx));
    q('[data-act="save"]').addEventListener("click", () => saveSnapNow(ctx));
    c.search.addEventListener("input", () => renderPicker(ctx));
    buildSnapEditor(ctx, c);

    // double-tap the preview to flip (kept as before); a single tap instead shows a focus ring and, on
    // hardware that advertises point-of-interest focus (iOS cameras currently don't), asks for a real focus
    // there. Two fingers pinching zooms (see beginPinch/movePinch below).
    let lastTap = 0, tapTimer = null;
    c.live.addEventListener("click", (e) => {
      const t = nowMs();
      if (t - lastTap < 300) { clearTimeout(tapTimer); lastTap = 0; flipCamera(ctx); return; }
      lastTap = t;
      const x = e.clientX, y = e.clientY;
      tapTimer = setTimeout(() => { if (!c.pinch) tapToFocus(ctx, x, y); }, 300);
    });
    c.live.addEventListener("touchstart", (e) => { if (e.touches.length === 2) { clearTimeout(tapTimer); beginPinch(ctx, e); } }, { passive: true });
    c.live.addEventListener("touchmove", (e) => { if (c.pinch && e.touches.length === 2) { e.preventDefault(); movePinch(ctx, e); } }, { passive: false });
    c.live.addEventListener("touchend", (e) => { if (c.pinch && e.touches.length < 2) endPinch(ctx); }, { passive: true });
    c.live.addEventListener("touchcancel", () => endPinch(ctx), { passive: true });

    // shutter: tap = photo (through the self-timer if one is set), hold = record, drag up while holding =
    // zoom (like Snapchat), drag onto the lock target while holding = hands-free recording.
    let pressTimer = null, pressed = false, holdX0 = 0, holdY0 = 0, holdZoom0 = 1;
    const down = (e) => {
      if (c.lockedRecording) return; // once locked, only the shutter's click (below) stops it
      if (c.selfTimerRunning) return; // a photo is already counting down
      e.preventDefault();
      pressed = true;
      const t = (e.touches && e.touches[0]) || e;
      holdX0 = t.clientX; holdY0 = t.clientY; holdZoom0 = c.zoom;
      pressTimer = setTimeout(() => { if (pressed) startRecording(ctx); }, 300);
    };
    const moveHold = (e) => {
      if (!pressed || !c.recording) return;
      const t = (e.touches && e.touches[0]) || e;
      const dx = t.clientX - holdX0, dy = t.clientY - holdY0;
      if (!c.lockedRecording) {
        const rect = c.lockTarget.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        if (Math.hypot(t.clientX - cx, t.clientY - cy) < 34) lockRecording(ctx);
      }
      // Slide up to zoom while holding, like Snapchat - but gentler (device feedback 2026-09-28: a tiny thumb
      // movement went all the way in): a 24px dead zone, then doubling every ~170px, so 1x -> 5x takes ~400px.
      const lift = -dy > 24 ? -dy - 24 : dy > 24 ? -(dy - 24) : 0;
      setZoom(ctx, clamp(holdZoom0 * Math.pow(2, lift / 170), c.zoomMin, c.zoomMax), { showPill: true });
      void dx; // horizontal delta only feeds the lock-target hit test above, not the zoom
    };
    const up = () => {
      if (!pressed) return;
      pressed = false;
      clearTimeout(pressTimer);
      if (c.lockedRecording) return; // stays recording until the shutter (or lock target) is tapped again
      if (c.recording) { stopRecording(ctx); scheduleZoomPillHide(ctx); return; }
      if (c.timerMode > 0) runSelfTimerThen(ctx, () => takePhoto(ctx));
      else takePhoto(ctx);
    };
    c.shutter.addEventListener("touchstart", down, { passive: false });
    c.shutter.addEventListener("touchmove", moveHold, { passive: true });
    c.shutter.addEventListener("touchend", up);
    c.shutter.addEventListener("touchcancel", up);
    c.shutter.addEventListener("mousedown", down);
    c.shutter.addEventListener("mousemove", moveHold);
    c.shutter.addEventListener("mouseup", up);
    c.shutter.addEventListener("click", () => { if (c.lockedRecording) stopRecording(ctx); });
    c.lockTarget.addEventListener("click", () => { haptic("light"); if (c.lockedRecording) stopRecording(ctx); });
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
    c.zoom = 1; c.zoomShown = 1; c.usingUltra = false;
    c.timerMode = 0; c.timerBtn.dataset.mode = "0"; c.timerLabel.textContent = "";
    c.flash = "off"; c.torchOn = false;
    c.el.dataset.open = "1";
    requestAnimationFrame(() => { c.el.dataset.shown = "1"; });
    startCameraStream(ctx);
  }
  function closeCamera(ctx) {
    const c = ctx.camera;
    c.gen++; // void any getUserMedia still in flight (open/flip spam) once it resolves
    if (c.recording) { try { c.recorder.stop(); } catch (e) {} c.recording = false; }
    c.lockedRecording = false; c.el.dataset.locked = "0"; c.el.dataset.recording = "0";
    clearInterval(c.recTickTimer); c.recTickTimer = null;
    clearTimeout(c.selfTimerTimer); c.selfTimerRunning = false; c.selfTimerEl.dataset.show = "0";
    c.el.dataset.shown = "0";
    closeCameraTracks(ctx);
    setTimeout(() => { if (c.el.dataset.shown !== "1") { c.el.dataset.open = "0"; closeReview(ctx); } }, 280);
  }
  async function startCameraStream(ctx, opts) {
    const c = ctx.camera;
    const myGen = ++c.gen;
    stopCameraStream(ctx);
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { c.live.innerHTML = '<div class="gh-camera-note">No camera here</div>'; return; }
    // Video-only by default: the mic is requested (and cached) the first time recording actually needs it,
    // so flipping or reopening the camera never re-prompts for microphone access. A cached exact deviceId
    // (see refreshDeviceMap) makes flips instant; otherwise we fall back to facingMode like before.
    const wantDeviceId = opts && opts.deviceId;
    const primary = wantDeviceId
      ? { deviceId: { exact: wantDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: c.facing, width: { ideal: 1920 }, height: { ideal: 1080 } };
    const fallback = wantDeviceId ? { deviceId: { exact: wantDeviceId } } : { facingMode: c.facing };
    const t0 = perfNow();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: primary, audio: false })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: fallback, audio: false }));
      if (myGen !== c.gen || c.el.dataset.open !== "1") { stream.getTracks().forEach((t) => t.stop()); return; }
      c.stream = stream;
      c.live.innerHTML = "";
      const video = el("video");
      video.autoplay = true; video.playsInline = true; video.muted = true;
      video.srcObject = stream;
      video.dataset.mirror = c.facing === "user" ? "1" : "0";
      c.live.appendChild(video);
      c.video = video;
      trackFirstFrame(video, t0, (opts && opts.label) || "open");
      setupZoomCapability(ctx);
      if (!c.devicesReady) refreshDeviceMap(ctx);
    } catch (e) {
      gtrail("camera failed " + (e && (e.name || e.message)));
      c.live.innerHTML = '<div class="gh-camera-note">Camera unavailable. Allow camera access for Ghost in Settings.</div>';
    }
  }
  function trackFirstFrame(video, t0, label) {
    // Prefer requestVideoFrameCallback (WebKit has shipped it since Safari 15.4) for a true first-decoded-
    // frame timestamp; fall back to loadeddata on anything older. Logged through gtrail so device logs carry
    // real open/flip timings instead of guesses.
    const done = (how) => { gtrail("camera " + label + " ttff " + Math.round(perfNow() - t0) + "ms (" + how + ")"); };
    if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(() => done("rVFC"));
    else video.addEventListener("loadeddata", () => done("loadeddata"), { once: true });
  }
  function stopCameraStream(ctx) {
    const c = ctx.camera;
    if (c.stream) { c.stream.getTracks().forEach((t) => t.stop()); c.stream = null; }
    if (c.video) { c.video.srcObject = null; c.video.remove(); }
    c.video = null;
  }
  function closeCameraTracks(ctx) {
    const c = ctx.camera;
    stopCameraStream(ctx);
    if (c.audioTrack) { try { c.audioTrack.stop(); } catch (e) {} c.audioTrack = null; }
  }
  async function refreshDeviceMap(ctx) {
    const c = ctx.camera;
    c.devicesReady = true; // set up front so concurrent stream starts don't queue duplicate enumerations
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      for (const d of list) {
        if (d.kind !== "videoinput") continue;
        const label = (d.label || "").toLowerCase();
        if (label.includes("front")) c.devices.user = c.devices.user || d.deviceId;
        else if (label.includes("ultra")) c.devices.ultra = c.devices.ultra || d.deviceId;
        else if (label.includes("back") || label.includes("rear") || label.includes("environment")) c.devices.environment = c.devices.environment || d.deviceId;
      }
      // Labels can be blank pre-permission or generic on some devices: whichever facing we're already
      // streaming from, if still unclassified, is at least the deviceId under our feet right now.
      if (!c.devices[c.facing]) { const t = c.stream && c.stream.getVideoTracks()[0]; if (t) c.devices[c.facing] = (t.getSettings().deviceId) || null; }
    } catch (e) { gtrail("enumerateDevices failed " + (e && e.message)); }
  }
  function setupZoomCapability(ctx) {
    const c = ctx.camera;
    c.zoomHardware = false;
    const track = c.stream && c.stream.getVideoTracks()[0];
    let caps = null;
    if (track && typeof track.getCapabilities === "function") { try { caps = track.getCapabilities(); } catch (e) {} }
    // Hardware zoom via the MediaStreamTrack `zoom` constraint is part of the Media Capture spec, but as of
    // iOS 26 WebKit does not advertise a `zoom` entry from getCapabilities() on iPhone camera tracks (the
    // Safari 26.0 release notes list no getUserMedia changes, and third-party testing confirms it - see
    // oberhofer.co's MediaStreamTrack capabilities writeup and the Dynamsoft camera-zoom-control piece).
    // This branch is here for whenever WebKit ships it; until then every device on this build takes the
    // digital-zoom path below.
    if (caps && caps.zoom && typeof caps.zoom.max === "number") {
      c.zoomHardware = true;
      c.zoomMin = caps.zoom.min || 1; c.zoomMax = caps.zoom.max;
      c.zoom = clamp(c.zoom || 1, c.zoomMin, c.zoomMax);
      throttledApplyHardwareZoom(ctx);
    } else {
      c.zoomMin = 1; c.zoomMax = 5; c.zoom = 1; c.zoomShown = 1; // digital crop-in only; see applyZoomVisual/captureFrame
    }
    applyZoomVisual(ctx);
    setupTorchCapability(ctx, caps);
  }
  function setupTorchCapability(ctx, caps) {
    const c = ctx.camera;
    // Torch (the back-camera flash constraint) IS supported by WebKit - added October 2023, confirmed
    // working from iOS 17.5.1 onward (webkit.org bug 243075) - so this is a real hardware capability check,
    // not a stub. Front camera has no torch; its "flash" is a screen-brightness flash at capture (takePhoto).
    c.torchSupported = !!(caps && caps.torch);
    c.torchOn = false;
    paintFlashBtn(ctx);
  }
  function toggleFlash(ctx) {
    const c = ctx.camera;
    haptic("light");
    if (c.facing === "environment") {
      if (!c.torchSupported) { ctx.showToast("Flash isn't supported on this camera"); return; }
      applyTorch(ctx, !c.torchOn);
    } else {
      c.flash = c.flash === "on" ? "off" : "on"; // front camera: a screen-flash right at capture (takePhoto)
      paintFlashBtn(ctx);
    }
  }
  function applyTorch(ctx, on) {
    const c = ctx.camera;
    const track = c.stream && c.stream.getVideoTracks()[0];
    if (!track) return;
    track.applyConstraints({ advanced: [{ torch: on }] })
      .then(() => { c.torchOn = on; c.flash = on ? "on" : "off"; paintFlashBtn(ctx); })
      .catch((e) => { gtrail("torch failed " + (e && e.message)); ctx.showToast("Couldn't switch on the flash"); });
  }
  function paintFlashBtn(ctx) {
    const c = ctx.camera;
    if (c.facing === "environment") c.flashBtn.dataset.state = !c.torchSupported ? "unsupported" : (c.torchOn ? "on" : "off");
    else c.flashBtn.dataset.state = c.flash === "on" ? "on" : "off";
  }
  function cycleTimer(ctx) {
    const c = ctx.camera;
    haptic("light");
    c.timerMode = c.timerMode === 0 ? 3 : c.timerMode === 3 ? 10 : 0;
    c.timerBtn.dataset.mode = String(c.timerMode);
    c.timerLabel.textContent = c.timerMode ? c.timerMode + "s" : "";
  }
  function runSelfTimerThen(ctx, fn) {
    const c = ctx.camera;
    if (c.selfTimerRunning) return;
    c.selfTimerRunning = true;
    let n = c.timerMode;
    c.selfTimerEl.textContent = String(n);
    c.selfTimerEl.dataset.show = "1";
    const step = () => {
      n--;
      if (n <= 0) { c.selfTimerEl.dataset.show = "0"; c.selfTimerRunning = false; fn(); return; }
      haptic("light");
      c.selfTimerEl.textContent = String(n);
      c.selfTimerTimer = setTimeout(step, 1000);
    };
    c.selfTimerTimer = setTimeout(step, 1000);
  }
  // Ghost's host is CSS-zoomed (--gh-zoom = 1/appScale). WebKit reports touch clientX/Y and getBoundingClientRect
  // in zoomed page pixels, but positions/canvas coordinates inside the host are in the host's own CSS pixels - so
  // every finger position must be scaled back (device report 2026-09-28: drawing landed "an inch below" the finger).
  function pageScaleOf(elx) { const r = elx.getBoundingClientRect(); return (r.width && elx.offsetWidth) ? r.width / elx.offsetWidth : 1; }
  function toLocal(elx, clientX, clientY) {
    const r = elx.getBoundingClientRect(), k = pageScaleOf(elx);
    return { x: (clientX - r.left) / k, y: (clientY - r.top) / k };
  }
  function tapToFocus(ctx, clientX, clientY) {
    const c = ctx.camera;
    const { x, y } = toLocal(c.live, clientX, clientY);
    c.focusRing.style.left = x + "px"; c.focusRing.style.top = y + "px";
    c.focusRing.dataset.show = "0"; void c.focusRing.offsetWidth; c.focusRing.dataset.show = "1";
    setTimeout(() => { c.focusRing.dataset.show = "0"; }, 700);
    const track = c.stream && c.stream.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== "function") return;
    let caps = null; try { caps = track.getCapabilities(); } catch (e) {}
    // Real point-of-interest focus needs `pointsOfInterest` + a manual/single-shot focusMode in
    // getCapabilities(); iOS camera tracks don't currently advertise either, so this stays best-effort and
    // the ring above (always shown) is the feedback that actually reaches the user on this hardware.
    if (caps && caps.pointsOfInterest && caps.focusMode && caps.focusMode.indexOf("single-shot") !== -1) {
      const nx = clamp(x / Math.max(1, c.live.offsetWidth), 0, 1), ny = clamp(y / Math.max(1, c.live.offsetHeight), 0, 1);
      track.applyConstraints({ advanced: [{ focusMode: "single-shot", pointsOfInterest: [{ x: nx, y: ny }] }] }).catch(() => {});
    }
  }
  function beginPinch(ctx, e) {
    const c = ctx.camera;
    const [a, b] = e.touches;
    c.pinch = { d0: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY), zoom0: c.zoom };
  }
  function movePinch(ctx, e) {
    const c = ctx.camera;
    if (!c.pinch) return;
    const [a, b] = e.touches;
    const d = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const raw = d / Math.max(1, c.pinch.d0); // unclamped gesture ratio, also used to detect the 0.5x crossing
    if (c.devices.ultra && !c.recording) {
      if (!c.usingUltra && c.pinch.zoom0 * raw < 0.7) { switchUltraWide(ctx, true); return; }
      if (c.usingUltra && c.pinch.zoom0 * raw > 1.6) { switchUltraWide(ctx, false); return; }
    }
    setZoom(ctx, clamp(c.pinch.zoom0 * raw, c.zoomMin, c.zoomMax), { showPill: true });
  }
  function endPinch(ctx) {
    const c = ctx.camera;
    if (!c.pinch) return;
    c.pinch = null;
    scheduleZoomPillHide(ctx);
  }
  function switchUltraWide(ctx, toUltra) {
    // Optional/cheap: iPhone exposes the 0.5x lens as its own deviceId, so crossing the ~0.7x pinch
    // threshold does a fast device-id switch (same freeze-frame path as flipCamera) instead of pretending to
    // "zoom out" digitally, which the wide (already object-fit:cover) preview can't actually do.
    const c = ctx.camera;
    const targetId = toUltra ? c.devices.ultra : c.devices.environment;
    if (!targetId) return;
    c.usingUltra = toUltra;
    haptic("light");
    freezeCurrentFrame(ctx, "lens");
    startCameraStream(ctx, { deviceId: targetId, label: "ultra-switch" }).then(() => {
      c.zoom = 1; c.zoomShown = 1;
      if (c.pinch) c.pinch = { d0: c.pinch.d0, zoom0: 1 };
      applyZoomVisual(ctx);
      thawFrame(ctx);
    });
    setTimeout(() => thawFrame(ctx), 900);
  }
  function setZoom(ctx, value, opts) {
    const c = ctx.camera;
    c.zoom = value;
    applyZoomVisual(ctx);
    if (opts && opts.showPill) showZoomPill(ctx);
    if (c.zoomHardware) throttledApplyHardwareZoom(ctx);
  }
  function applyZoomVisual(ctx) {
    const c = ctx.camera;
    const display = c.usingUltra ? c.zoom * 0.5 : c.zoom;
    c.zoomPill.textContent = display.toFixed(1) + "x";
    if (!c.video) return;
    if (c.zoomHardware) { c.video.style.transform = ""; return; }
    // Digital zoom: scale (and later crop, in captureFrame) the preview. For video we deliberately only
    // zoom the live preview, not the recorded output - re-rendering every frame through a canvas into
    // MediaRecorder to bake the crop in would cost a per-frame draw for the whole clip's length, which is
    // exactly the "hurts recording" case the brief says to avoid; a still photo pays that cost exactly once.
    // eased toward the target every frame instead of jumping with each touch event (device feedback: "needs to
    // be smoother between different zooms")
    if (!c.zoomAnim) {
      const step = () => {
        const v = c.video;
        if (!v) { c.zoomAnim = 0; return; }
        const cur = c.zoomShown || 1, target = c.zoomHardware ? 1 : c.zoom;
        const next = Math.abs(target - cur) < 0.004 ? target : cur + (target - cur) * 0.3;
        c.zoomShown = next;
        v.style.transform = next === 1 && target === 1 ? "" : (c.facing === "user" ? "scaleX(-1) " : "") + "scale(" + next.toFixed(4) + ")";
        c.zoomAnim = next === target ? 0 : requestAnimationFrame(step);
      };
      c.zoomAnim = requestAnimationFrame(step);
    }
  }
  function throttledApplyHardwareZoom(ctx) {
    const c = ctx.camera;
    if (c._zoomTimer) return;
    c._zoomTimer = setTimeout(() => {
      c._zoomTimer = null;
      const track = c.stream && c.stream.getVideoTracks()[0];
      if (track) track.applyConstraints({ advanced: [{ zoom: c.zoom }] }).catch((e) => gtrail("zoom constraint failed " + (e && e.message)));
    }, 60);
  }
  function showZoomPill(ctx) {
    const c = ctx.camera;
    clearTimeout(c._zoomPillTimer);
    c.zoomPill.dataset.show = "1";
  }
  function scheduleZoomPillHide(ctx) {
    const c = ctx.camera;
    clearTimeout(c._zoomPillTimer);
    c._zoomPillTimer = setTimeout(() => { c.zoomPill.dataset.show = "0"; }, 900);
  }
  function lockRecording(ctx) {
    const c = ctx.camera;
    if (c.lockedRecording) return;
    c.lockedRecording = true;
    c.el.dataset.locked = "1";
    haptic("medium");
  }
  // kind "flip" (front/back: blurred frame with the flip animation) or "lens" (1x <-> 0.5x: the last frame held
  // sharp and cross-faded into the new lens - no flip animation, it isn't a different camera to the user)
  function freezeCurrentFrame(ctx, kind) {
    const c = ctx.camera;
    const v = c.video;
    if (!v || !v.videoWidth) return;
    const cv = c.freeze;
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    const g = cv.getContext("2d");
    g.save();
    if (c.facing === "user") { g.translate(cv.width, 0); g.scale(-1, 1); }
    g.drawImage(v, 0, 0);
    g.restore();
    c.el.dataset.freeze = kind === "lens" ? "lens" : "1";
    c.el.classList.add("gh-cam-flipping");
  }
  function thawFrame(ctx) {
    const c = ctx.camera;
    if (c.el.dataset.freeze !== "1" && c.el.dataset.freeze !== "lens") return;
    c.el.dataset.freeze = "0";
    setTimeout(() => c.el.classList.remove("gh-cam-flipping"), 260);
  }
  function flipCamera(ctx) {
    const c = ctx.camera;
    if (c.recording || c.pinch) return;
    haptic("light");
    freezeCurrentFrame(ctx);
    c.facing = c.facing === "user" ? "environment" : "user";
    c.torchOn = false; c.flash = "off"; c.zoom = 1; c.zoomShown = 1; c.usingUltra = false;
    const targetId = c.devices[c.facing];
    startCameraStream(ctx, targetId ? { deviceId: targetId, label: "flip" } : { label: "flip" }).then(() => thawFrame(ctx));
    setTimeout(() => thawFrame(ctx), 900); // never leave the freeze frame up if the new stream stalls
  }
  function takePhoto(ctx) {
    const c = ctx.camera;
    const v = c.video;
    if (!v || !v.videoWidth) { ctx.showToast("Camera isn't ready yet"); return; }
    haptic("medium");
    if (c.facing === "user" && c.flash === "on") {
      // Front camera has no torch, so "flash" is a screen-brightness flash timed around the capture.
      c.el.classList.add("gh-cam-frontflash");
      setTimeout(() => { captureFrame(ctx); setTimeout(() => c.el.classList.remove("gh-cam-frontflash"), 160); }, 120);
    } else captureFrame(ctx);
  }
  function captureFrame(ctx) {
    const c = ctx.camera;
    const v = c.video;
    // what you saw is what you send: crop the frame to the screen's shape (like the live preview), mirror
    // selfies, and bake in whatever digital zoom the preview was showing (hardware zoom already changed the
    // sensor's own output, so no extra crop is needed on that path).
    const W = v.videoWidth, H = v.videoHeight, target = c.live.clientWidth / Math.max(1, c.live.clientHeight);
    let sw = W, sh = H;
    if (W / H > target) sw = Math.round(H * target); else sh = Math.round(W / target);
    if (!c.zoomHardware && c.zoom > 1) { sw = Math.round(sw / c.zoom); sh = Math.round(sh / c.zoom); }
    const canvas = document.createElement("canvas");
    canvas.width = sw; canvas.height = sh;
    const g = canvas.getContext("2d");
    if (c.facing === "user") { g.translate(sw, 0); g.scale(-1, 1); }
    g.drawImage(v, (W - sw) / 2, (H - sh) / 2, sw, sh, 0, 0, sw, sh);
    c.el.classList.add("gh-cam-flash");
    setTimeout(() => c.el.classList.remove("gh-cam-flash"), 160);
    canvas.toBlob((blob) => { if (blob) openReview(ctx, blob, "image", true, { width: sw, height: sh }); }, "image/jpeg", 0.9);
  }
  async function ensureAudioTrack(ctx) {
    const c = ctx.camera;
    if (c.audioTrack && c.audioTrack.readyState === "live") return c.audioTrack;
    const a = await navigator.mediaDevices.getUserMedia({ audio: true });
    c.audioTrack = a.getAudioTracks()[0] || null;
    return c.audioTrack;
  }
  async function startRecording(ctx) {
    const c = ctx.camera;
    if (!c.stream || typeof MediaRecorder === "undefined") { ctx.showToast("Video isn't available here"); return; }
    haptic("medium");
    c.chunks = [];
    c.startingRecording = true; c.recordCancelled = false;
    c.el.dataset.recording = "1";
    c.recTimerEl.textContent = "0:00";
    let recStream = c.stream, hasAudio = false;
    try {
      // Mic permission/track is requested here, the first time a recording actually needs it, then cached
      // on ctx.camera.audioTrack and reused - flipping or reopening the camera never touches the mic again.
      const audioTrack = await ensureAudioTrack(ctx);
      const videoTrack = c.stream.getVideoTracks()[0];
      if (audioTrack && videoTrack) { recStream = new MediaStream([videoTrack, audioTrack]); hasAudio = true; }
    } catch (e) { gtrail("mic permission failed " + (e && e.message)); }
    c.startingRecording = false;
    if (c.recordCancelled || c.el.dataset.open !== "1") { c.el.dataset.recording = "0"; return; }
    try {
      const type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm"].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
      c.recorder = type ? new MediaRecorder(recStream, { mimeType: type }) : new MediaRecorder(recStream);
      const mime = (c.recorder.mimeType || type || "video/mp4").split(";")[0];
      const dims = { width: c.video ? c.video.videoWidth : 1080, height: c.video ? c.video.videoHeight : 1920, hasAudio };
      c.recorder.ondataavailable = (e) => { if (e.data && e.data.size) c.chunks.push(e.data); };
      c.recorder.onstop = () => {
        clearInterval(c.recTickTimer); c.recTickTimer = null;
        c.el.dataset.recording = "0"; c.el.dataset.locked = "0"; c.lockedRecording = false;
        const blob = new Blob(c.chunks, { type: mime });
        if (nowMs() - c.recStart < 500 || !blob.size) { takePhotoFallback(ctx); return; }
        openReview(ctx, blob, "video", true, dims);
      };
      c.recorder.start(250);
      c.recording = true; c.recStart = nowMs();
      c.shutter.dataset.recording = "1";
      c.recTickTimer = setInterval(() => { c.recTimerEl.textContent = fmtRecTime(nowMs() - c.recStart); }, 250);
      const tick = () => {
        if (!c.recording) return;
        const p = Math.min(1, (nowMs() - c.recStart) / MAX_VIDEO_MS);
        c.ring.style.strokeDashoffset = String(251.3 * (1 - p));
        if (p >= 1) { stopRecording(ctx); return; }
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      c.recording = false; c.el.dataset.recording = "0";
      gtrail("recorder failed " + (e && e.message)); ctx.showToast("Couldn't start recording");
    }
  }
  function takePhotoFallback(ctx) { startCameraStream(ctx).then(() => {}); } // a hold that ended almost at once
  function stopRecording(ctx) {
    const c = ctx.camera;
    if (c.startingRecording) { c.recordCancelled = true; return; } // released while still awaiting mic permission
    c.shutter.dataset.recording = "0";
    c.ring.style.strokeDashoffset = "";
    if (c.recording && c.recorder) { c.recording = false; haptic("light"); try { c.recorder.stop(); } catch (e) {} }
    else { c.el.dataset.recording = "0"; c.el.dataset.locked = "0"; c.lockedRecording = false; clearInterval(c.recTickTimer); c.recTickTimer = null; }
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
      media.addEventListener("loadedmetadata", () => { if (c.captured && !c.captured.width) { c.captured.width = media.videoWidth; c.captured.height = media.videoHeight; } }, { once: true });
      media.play().catch(() => { media.muted = true; media.play().catch(() => {}); });
    } else if (!c.captured.width) {
      media.addEventListener("load", () => { if (c.captured) { c.captured.width = media.naturalWidth; c.captured.height = media.naturalHeight; } }, { once: true });
    }
    c.reviewMedia.appendChild(media);
    c.review.dataset.open = "1";
    c.picked = new Set(c.preselect ? [c.preselect] : []);
    resetEditor(ctx, c);
  }
  function closeReview(ctx) {
    const c = ctx.camera;
    c.review.dataset.open = "0";
    c.picker.dataset.open = "0";
    const v = c.reviewMedia.querySelector("video"); if (v) v.pause();
    c.reviewMedia.innerHTML = "";
    if (c.captured && c.captured.url) URL.revokeObjectURL(c.captured.url);
    c.captured = null;
    teardownEditor(ctx, c);
  }
  function discardReview(ctx) {
    const c = ctx.camera;
    commitPendingEdits(ctx, c);
    const go = () => { closeReview(ctx); c.zoom = 1; c.zoomShown = 1; c.usingUltra = false; startCameraStream(ctx); }; // retake opens the normal lens at 1x
    if (c.editor && c.editor.hasEdits()) confirmSheet(ctx, "Discard this Snap and your edits?", "Discard").then((ok) => { if (ok) go(); });
    else go();
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
    if (!qv) { // posting to your story: only when you pick it here
      const sh = el("div", "gh-cam-section"); sh.textContent = "Stories"; c.list.appendChild(sh);
      const row = el("div", "gh-friend-row gh-press gh-story-dest");
      row.dataset.picked = c.picked.has("__story__") ? "1" : "0";
      const av = el("div", "gh-story-dest-ic"); av.appendChild(makeAvatar(ctx.state.me || { name: "Me" }, 44)); row.appendChild(av);
      const name = el("div", "gh-friend-name"); name.innerHTML = "My Story<span>Friends can view for 24 hours</span>";
      const check = el("div", "gh-friend-check"); check.appendChild(icon("check", 14));
      row.append(name, check);
      row.addEventListener("click", () => { haptic("light"); if (c.picked.has("__story__")) c.picked.delete("__story__"); else c.picked.add("__story__"); row.dataset.picked = c.picked.has("__story__") ? "1" : "0"; paintChosen(ctx); });
      c.list.appendChild(row);
    }
    const head = el("div", "gh-cam-section"); head.textContent = qv ? "Results" : "Recents"; c.list.appendChild(head);
    for (const conv of rows) {
      const row = el("div", "gh-friend-row gh-press");
      row.dataset.picked = c.picked.has(conv.id) ? "1" : "0";
      const avatarUser = convAvatarUser(conv);
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
    const names = [...c.picked].map((id) => id === "__story__" ? "My Story" : (ctx.state.convById.get(id) || {}).title || "").filter(Boolean);
    c.chosen.textContent = names.length ? names.join(", ") : "Pick friends";
    c.sendBtn.disabled = !names.length || c.sending;
    c.picker.dataset.has = names.length ? "1" : "0";
  }
  async function sendSnapNow(ctx) {
    const c = ctx.camera;
    if (!c.picked.size || !c.captured || c.sending) return;
    haptic();
    commitPendingEdits(ctx, c);
    c.sending = true; c.sendBtn.dataset.sending = "1"; paintChosen(ctx);
    const cap = c.captured, ids = Array.from(c.picked);
    try {
      const out = await renderEditorOutput(ctx, c);
      await api.sendSnap(ids.filter((x) => x !== "__story__"), out.blob, {
        kind: cap.kind, width: out.width || cap.width, height: out.height || cap.height,
        hasAudio: cap.hasAudio, myStory: ids.includes("__story__"), overlay: out.overlay,
      });
      haptic("success");
      closeCamera(ctx);
      ctx.showToast(ids.includes("__story__") ? (ids.length > 1 ? "Posted to your story and sent" : "Posted to your story") : ids.length > 1 ? `Snap sent to ${ids.length} chats` : "Snap sent");
    } catch (e) {
      gtrail("snap send failed " + (e && e.message || e));
      ctx.showToast("Couldn't send that Snap");
    } finally { c.sending = false; c.sendBtn.dataset.sending = "0"; paintChosen(ctx); }
  }
  async function saveSnapNow(ctx) {
    const c = ctx.camera;
    if (!c.captured || c.saving) return;
    commitPendingEdits(ctx, c);
    c.saving = true;
    try {
      const out = await renderEditorOutput(ctx, c);
      if (c.captured.kind === "video" && out.overlay) {
        // No local re-encode pipeline exists (MediaRecorder here only captures a live stream, not an
        // offline photo+overlay composite) - Photos gets the untouched video; the edits still reach the
        // recipient via sendSnap's separate overlay (see BRIDGE_NOTES.md "sendSnap overlayMedia").
        await saveRefToPhotos(ctx, { blob: c.captured.blob, type: "video" });
        ctx.showToast("Saved to Photos (drawing/text send to friends, but aren't baked into the saved video yet)");
      } else {
        await saveRefToPhotos(ctx, { blob: out.blob, type: c.captured.kind === "video" ? "video" : "image" });
      }
    } catch (e) { gtrail("editor save failed " + (e && e.message || e)); ctx.showToast("Couldn't save"); }
    finally { c.saving = false; }
  }

  // =====================================================================================================
  // Snap editor — text, drawing and stickers on top of a captured photo/video, drawn in ITS OWN functions
  // (called once from buildCamera) so the live-camera code (buildCamera/startCameraStream/flipCamera/
  // takePhoto/startRecording) never has to change here. Everything below only touches openReview's review
  // screen (c.review / c.reviewMedia) and c.captured - never the live preview.
  //
  // Coordinate model: every stroke point and item x/y is stored in REVIEW-BOX css-pixel space (c.review's
  // own client rect - same box the media fills via object-fit:cover). At send/save time, `coverTransform`
  // maps that box onto the captured media's real pixel size exactly the way object-fit:cover would have
  // shown it, so what you drew lines up with what you saw, whether the photo/video's aspect ratio matches
  // the screen or not (a recorded video's native resolution, unlike a photo's screen-cropped capture, can
  // differ from the screen and get cropped by "cover" - handled the same way here).
  // =====================================================================================================
  const EDITOR_COLOR_STOPS = ["#ffffff", "#ff3b30", "#ff9500", "#ffd60a", "#34c759", "#00c7be", "#0a84ff", "#5e5ce6", "#bf5af2", "#ff2d55", "#000000"];
  const BRUSH_SIZES = [4, 9, 16];
  const TEXT_BASE_PX = 30;
  // Font size per text style, matching Snapchat's own proportions (device feedback 2026-09-28: the caption was far
  // too big): classic caption bar 17px medium, big text 30px heavy, pill 21px. Kept in sync with ui.css.
  const TEXT_STYLE_PX = { 0: 17, 1: 30, 2: 21, 3: 30 };

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "#ffffff");
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 255, g: 255, b: 255 };
  }
  function luminance(hex) { const p = hexToRgb(hex); return (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b) / 255; }
  function hexToRgba(hex, a) { const p = hexToRgb(hex); return `rgba(${p.r},${p.g},${p.b},${a})`; }
  function colorAtFraction(stops, t) {
    t = clamp(t, 0, 1);
    const n = stops.length - 1;
    const seg = Math.min(n - 1, Math.floor(t * n));
    const lt = t * n - seg;
    const a = hexToRgb(stops[seg]), b = hexToRgb(stops[seg + 1]);
    const mix = (x, y) => clamp(Math.round(x + (y - x) * lt), 0, 255);
    return "#" + [mix(a.r, b.r), mix(a.g, b.g), mix(a.b, b.b)].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function angle(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }
  function coverTransform(vw, vh, mw, mh) {
    const scale = Math.max(vw / mw, vh / mh) || 1;
    return { scale, ox: (vw - mw * scale) / 2, oy: (vh - mh * scale) / 2 };
  }
  function viewportToMedia(t, x, y) { return { x: (x - t.ox) / t.scale, y: (y - t.oy) / t.scale }; }
  function textColorFor(item) {
    const col = item.color;
    if (item.style === 0) return col ? (luminance(col) > 0.55 ? "#000000" : "#ffffff") : "#ffffff";
    if (item.style === 2) return col ? (luminance(col) > 0.55 ? "#000000" : "#ffffff") : "#000000";
    return col || "#ffffff";
  }
  function bgColorFor(item) {
    if (item.style === 0) return item.color ? hexToRgba(item.color, 0.6) : "rgba(0,0,0,0.6)";
    if (item.style === 2) return item.color || "#ffffff";
    return "";
  }
  function roundRectPath(cx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cx.beginPath();
    cx.moveTo(x + r, y); cx.arcTo(x + w, y, x + w, y + h, r); cx.arcTo(x + w, y + h, x, y + h, r);
    cx.arcTo(x, y + h, x, y, r); cx.arcTo(x, y, x + w, y, r); cx.closePath();
  }

  function buildSnapEditor(ctx, c) {
    const root = c.review;
    const ed = {
      tool: null, editingText: null, trashOver: false, colorFrac: 0.5, color: null, sizeIdx: 1,
      viewport: { w: 393, h: 852 }, items: [], itemSeq: 0, strokes: [], curStroke: null, stickerSheetObj: null,
      drawCanvas: root.querySelector(".gh-editor-draw"), drawCtx: null,
      itemsLayer: root.querySelector(".gh-editor-items"),
      colorbar: root.querySelector(".gh-editor-colorbar"), colorthumb: root.querySelector(".gh-editor-colorthumb"),
      sizesEl: root.querySelector(".gh-editor-sizes"),
      textWrap: root.querySelector(".gh-editor-textwrap"), textInput: root.querySelector(".gh-editor-textinput"),
      railText: root.querySelector('[data-tool="text"]'), railDraw: root.querySelector('[data-tool="draw"]'),
      railSticker: root.querySelector('[data-tool="sticker"]'), railUndo: root.querySelector('[data-tool="undo"]'),
      trash: root.querySelector(".gh-editor-trash"),
      hasEdits: () => ed.strokes.length > 0 || ed.items.length > 0,
    };
    c.editor = ed;
    ed.trash.querySelector(".gh-editor-trash-ic").appendChild(icon("trash", 24));
    ed.colorbar.style.background = `linear-gradient(to bottom, ${EDITOR_COLOR_STOPS.join(",")})`;
    ed.textInput.dataset.placeholder = "Tap to type";

    // Tapping any rail button while the caption keyboard is open must NOT blur the contenteditable first -
    // a plain <button> steals focus on mousedown/touchstart by default, which would fire our own blur ->
    // commitTextEditing before the click handler below ever runs (so "tap T again to cycle styles" would
    // instead see editingText already cleared and start a stray new item every time). preventDefault on the
    // pointer-down phase keeps focus exactly where it was; the click still fires normally afterwards.
    // On iPhone, preventDefault on touchstart also CANCELS the click that would follow (device report 2026-09-27:
    // "clicking the pencil and the text thing ... does nothing") - so for touch the action runs on touchend itself
    // (whose preventDefault just stops the synthetic mouse events), and click only serves a real mouse.
    const keepFocus = (e) => e.preventDefault();
    let lastTouchTap = 0;
    const onTap = (elx, fn) => {
      let t0 = null;
      elx.addEventListener("mousedown", keepFocus);
      elx.addEventListener("touchstart", (e) => { e.preventDefault(); const t = e.touches[0]; t0 = t ? { x: t.clientX, y: t.clientY } : null; }, { passive: false });
      elx.addEventListener("touchend", (e) => {
        const t = e.changedTouches && e.changedTouches[0];
        const start = t0; t0 = null;
        if (!start || !t || Math.hypot(t.clientX - start.x, t.clientY - start.y) > 12) return;
        e.preventDefault();
        lastTouchTap = nowMs();
        fn({ clientX: t.clientX, clientY: t.clientY });
      }, { passive: false });
      elx.addEventListener("click", (e) => { if (nowMs() - lastTouchTap > 600) fn(e); });
    };
    onTap(ed.railText, () => { haptic("light"); onTextToolTap(ctx, c); });
    onTap(ed.railDraw, () => { haptic("light"); toggleDrawTool(ctx, c); });
    onTap(ed.railSticker, () => { haptic("light"); openStickerPicker(ctx, c); });
    onTap(ed.railUndo, () => { haptic("light"); undoStroke(ctx, c); });
    // Tapping the photo: same focus race (its default mousedown/touchstart would blur the caption first, so the
    // handler would misread "just committed" as "idle tap" and start a stray item) - same tap helper.
    const mediaEl = root.querySelector(".gh-cam-review-media");
    onTap(mediaEl, (e) => {
      if (ed.editingText) { commitTextEditing(ctx, c); return; }
      if (ed.tool) return;
      const p = toLocal(c.review, e.clientX, e.clientY);
      startNewTextItem(ctx, c, p.x, p.y);
    });

    initDrawCanvas(ctx, c);
    initColorbar(ctx, c);
    initSizePicker(ctx, c);
    initTextInput(ctx, c);
  }

  function resetEditor(ctx, c) {
    const ed = c.editor;
    if (!ed) return;
    for (const item of ed.items) if (item.el) item.el.remove();
    ed.items = []; ed.strokes = []; ed.curStroke = null; ed.itemSeq = 0;
    ed.tool = null; ed.editingText = null; ed.trashOver = false;
    ed.colorFrac = 0.5; ed.color = null; ed.sizeIdx = 1;
    setColorThumb(ed, colorAtFraction(EDITOR_COLOR_STOPS, ed.colorFrac), ed.colorFrac);
    paintSizeButtons(ed);
    ed.textWrap.dataset.open = "0"; ed.textInput.textContent = ""; ed.colorbar.dataset.show = "0"; ed.sizesEl.dataset.show = "0";
    ed.railText.dataset.on = "0"; ed.railDraw.dataset.on = "0"; ed.railSticker.dataset.on = "0"; ed.railUndo.style.display = "none";
    if (ed.stickerSheetObj) closeSheetGeneric(ed.stickerSheetObj.backdrop, ed.stickerSheetObj.sheet);
    hideTrash(ctx, c);
    requestAnimationFrame(() => {
      ed.viewport = { w: c.review.offsetWidth || 393, h: c.review.offsetHeight || 852 }; // host CSS px, not zoomed page px
      sizeDrawCanvas(ed, ed.viewport.w, ed.viewport.h);
    });
  }
  function teardownEditor(ctx, c) {
    const ed = c.editor;
    if (!ed) return;
    ed.curStroke = null;
    if (ed.editingText) { ed.editingText = null; ed.textWrap.dataset.open = "0"; try { ed.textInput.blur(); } catch (e) {} }
    for (const item of ed.items) if (item.el) item.el.remove();
    ed.items = []; ed.strokes = [];
    if (ed.drawCtx) ed.drawCtx.clearRect(0, 0, ed.drawCanvas.width, ed.drawCanvas.height);
    if (ed.stickerSheetObj) closeSheetGeneric(ed.stickerSheetObj.backdrop, ed.stickerSheetObj.sheet);
    setTool(ctx, c, null);
    hideTrash(ctx, c);
  }
  function commitPendingEdits(ctx, c) { if (c.editor && c.editor.editingText) commitTextEditing(ctx, c); }

  function setTool(ctx, c, tool) {
    const ed = c.editor;
    if (!ed) return;
    ed.tool = tool;
    ed.railText.dataset.on = tool === "text" ? "1" : "0";
    ed.railDraw.dataset.on = tool === "draw" ? "1" : "0";
    ed.railSticker.dataset.on = tool === "sticker" ? "1" : "0";
    ed.railUndo.style.display = tool === "draw" ? "" : "none";
    ed.sizesEl.dataset.show = tool === "draw" ? "1" : "0";
    ed.colorbar.dataset.show = (tool === "draw" || ed.editingText) ? "1" : "0";
    ed.drawCanvas.style.pointerEvents = tool === "draw" ? "auto" : "none";
  }

  // ---- text ------------------------------------------------------------------------------------------
  function onTextToolTap(ctx, c) {
    const ed = c.editor;
    if (ed.editingText) { cycleTextStyle(ctx, c); return; }
    startNewTextItem(ctx, c);
  }
  function startNewTextItem(ctx, c, x, y) {
    const ed = c.editor;
    if (ed.editingText) return; // already composing one - tapping T again cycles its style instead
    setTool(ctx, c, "text");
    const item = {
      id: "t" + (++ed.itemSeq), type: "text", text: "", style: 0, color: null,
      x: x != null ? x : ed.viewport.w / 2, y: y != null ? y : ed.viewport.h * 0.42, rotation: 0, scale: 1, el: null,
    };
    ed.items.push(item);
    openTextInputFor(ctx, c, item);
  }
  function openTextInputFor(ctx, c, item) {
    const ed = c.editor;
    ed.editingText = item;
    ed.tool = "text";
    ed.textWrap.dataset.open = "1";
    ed.textInput.textContent = item.text || "";
    paintTextInputStyle(ed, item);
    ed.colorFrac = item.colorFrac != null ? item.colorFrac : 0.5;
    setColorThumb(ed, item.color || colorAtFraction(EDITOR_COLOR_STOPS, ed.colorFrac), ed.colorFrac);
    ed.colorbar.dataset.show = "1";
    ed.textWrap.style.top = clamp((item.style === 0 ? item.y : item.y) - 40, 60, Math.max(60, ed.viewport.h - 160)) + "px";
    if (item.el) item.el.style.visibility = "hidden";
    requestAnimationFrame(() => { try { ed.textInput.focus(); } catch (e) {} });
  }
  function paintTextInputStyle(ed, item) {
    ed.textInput.dataset.style = item.style; ed.textWrap.dataset.style = item.style;
    ed.textInput.style.color = textColorFor(item);
    ed.textInput.style.background = bgColorFor(item);
  }
  function cycleTextStyle(ctx, c) {
    const ed = c.editor;
    const item = ed.editingText;
    if (!item) return;
    item.style = (item.style + 1) % 4;
    paintTextInputStyle(ed, item);
  }
  function commitTextEditing(ctx, c) {
    const ed = c.editor;
    const item = ed.editingText;
    if (!item) return;
    const text = (ed.textInput.innerText || ed.textInput.textContent || "").replace(/ /g, " ").replace(/\n+$/, "").trim();
    ed.textWrap.dataset.open = "0";
    ed.editingText = null;
    if (!text) {
      ed.items = ed.items.filter((x) => x !== item);
      if (item.el) item.el.remove();
      setTool(ctx, c, null);
      return;
    }
    item.text = text; item.color = ed.color; item.colorFrac = ed.colorFrac;
    renderTextItemEl(ctx, c, item);
    setTool(ctx, c, null);
  }
  function renderTextItemEl(ctx, c, item) {
    const ed = c.editor;
    if (!item.el) {
      const wrap = el("div", "gh-editor-item gh-editor-item-text");
      const inner = el("div", "gh-editor-item-text-inner");
      wrap.appendChild(inner);
      ed.itemsLayer.appendChild(wrap);
      item.el = wrap; item.innerEl = inner;
      attachItemGestures(ctx, c, item);
    }
    item.el.style.visibility = "";
    item.el.dataset.style = item.style;
    item.innerEl.textContent = item.text;
    item.innerEl.style.color = textColorFor(item);
    item.innerEl.style.background = bgColorFor(item);
    positionItemEl(item);
  }

  // ---- drawing -----------------------------------------------------------------------------------------
  function toggleDrawTool(ctx, c) {
    const ed = c.editor;
    commitPendingEdits(ctx, c);
    setTool(ctx, c, ed.tool === "draw" ? null : "draw");
  }
  function sizeDrawCanvas(ed, w, h) {
    const dpr = window.devicePixelRatio || 1;
    ed.drawCanvas.width = Math.max(1, Math.round(w * dpr));
    ed.drawCanvas.height = Math.max(1, Math.round(h * dpr));
    ed.drawCanvas.style.width = w + "px"; ed.drawCanvas.style.height = h + "px";
    ed.drawCtx = ed.drawCanvas.getContext("2d");
    ed.drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawDrawCanvas(ed);
  }
  function strokePath(cx, stroke) {
    const pts = stroke.pts;
    cx.strokeStyle = stroke.color; cx.lineWidth = stroke.size; cx.lineCap = "round"; cx.lineJoin = "round";
    if (pts.length < 2) { cx.beginPath(); cx.fillStyle = stroke.color; cx.arc(pts[0].x, pts[0].y, stroke.size / 2, 0, Math.PI * 2); cx.fill(); return; }
    cx.beginPath();
    cx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2; cx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my); }
    cx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    cx.stroke();
  }
  function redrawDrawCanvas(ed) {
    if (!ed.drawCtx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = ed.drawCanvas.width / dpr, h = ed.drawCanvas.height / dpr;
    ed.drawCtx.clearRect(0, 0, w, h);
    for (const s of ed.strokes) strokePath(ed.drawCtx, s);
    if (ed.curStroke) strokePath(ed.drawCtx, ed.curStroke);
  }
  function undoStroke(ctx, c) {
    const ed = c.editor;
    if (!ed.strokes.length) return;
    ed.strokes.pop();
    redrawDrawCanvas(ed);
  }
  function initDrawCanvas(ctx, c) {
    const ed = c.editor;
    const canvas = ed.drawCanvas;
    const localPt = (t) => toLocal(canvas, t.clientX, t.clientY);
    canvas.addEventListener("touchstart", (e) => {
      if (ed.tool !== "draw" || !e.touches || e.touches.length !== 1) return;
      e.preventDefault();
      ed.curStroke = { color: ed.color || colorAtFraction(EDITOR_COLOR_STOPS, ed.colorFrac), size: BRUSH_SIZES[ed.sizeIdx], pts: [localPt(e.touches[0])] };
    }, { passive: false });
    canvas.addEventListener("touchmove", (e) => {
      if (!ed.curStroke || !e.touches || e.touches.length !== 1) return;
      e.preventDefault();
      ed.curStroke.pts.push(localPt(e.touches[0]));
      redrawDrawCanvas(ed);
    }, { passive: false });
    const endStroke = () => { if (ed.curStroke && ed.curStroke.pts.length) ed.strokes.push(ed.curStroke); ed.curStroke = null; };
    canvas.addEventListener("touchend", endStroke, { passive: true });
    canvas.addEventListener("touchcancel", endStroke, { passive: true });
    // mouse fallback so this is drivable on a mouse-only dev rig too
    let mdown = false;
    canvas.addEventListener("mousedown", (e) => { if (ed.tool !== "draw") return; mdown = true; ed.curStroke = { color: ed.color || colorAtFraction(EDITOR_COLOR_STOPS, ed.colorFrac), size: BRUSH_SIZES[ed.sizeIdx], pts: [localPt(e)] }; });
    canvas.addEventListener("mousemove", (e) => { if (!mdown || !ed.curStroke) return; ed.curStroke.pts.push(localPt(e)); redrawDrawCanvas(ed); });
    window.addEventListener("mouseup", () => { if (mdown) { mdown = false; endStroke(); } });
  }

  // ---- color + size pickers -----------------------------------------------------------------------------
  function setColorThumb(ed, color, frac) {
    ed.colorthumb.style.background = color;
    if (frac != null) ed.colorthumb.style.top = (frac * 100) + "%";
  }
  function applyColorToActive(ctx, c) {
    const ed = c.editor;
    if (ed.editingText) paintTextInputStyle(ed, { style: ed.editingText.style, color: ed.color });
  }
  function initColorbar(ctx, c) {
    const ed = c.editor;
    setColorThumb(ed, colorAtFraction(EDITOR_COLOR_STOPS, ed.colorFrac), ed.colorFrac);
    const move = (clientY) => {
      const r = ed.colorbar.getBoundingClientRect();
      const frac = clamp((clientY - r.top) / Math.max(1, r.height), 0, 1);
      ed.colorFrac = frac;
      ed.color = colorAtFraction(EDITOR_COLOR_STOPS, frac);
      setColorThumb(ed, ed.color, frac);
      applyColorToActive(ctx, c);
    };
    ed.colorbar.addEventListener("touchstart", (e) => { e.preventDefault(); haptic("light"); move(e.touches[0].clientY); }, { passive: false });
    ed.colorbar.addEventListener("touchmove", (e) => { e.preventDefault(); move(e.touches[0].clientY); }, { passive: false });
    ed.colorbar.addEventListener("mousedown", (e) => { haptic("light"); move(e.clientY); const mv = (ev) => move(ev.clientY); const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); }; window.addEventListener("mousemove", mv); window.addEventListener("mouseup", up); });
  }
  function paintSizeButtons(ed) { for (const b of ed.sizesEl.querySelectorAll(".gh-editor-size")) b.dataset.on = Number(b.dataset.size) === ed.sizeIdx ? "1" : "0"; }
  function initSizePicker(ctx, c) {
    const ed = c.editor;
    for (const b of ed.sizesEl.querySelectorAll(".gh-editor-size")) b.addEventListener("click", () => { haptic("light"); ed.sizeIdx = Number(b.dataset.size); paintSizeButtons(ed); });
    paintSizeButtons(ed);
  }
  function initTextInput(ctx, c) {
    const ed = c.editor;
    ed.textInput.addEventListener("blur", () => commitTextEditing(ctx, c));
  }

  // ---- stickers (emoji grid + the app's own Bitmoji catalog/render host, reused read-only) --------------
  function ensureStickerSheet(ctx, c) {
    const ed = c.editor;
    if (ed.stickerSheetObj) return ed.stickerSheetObj;
    const backdrop = el("div", "gh-backdrop gh-editor-sticker-backdrop");
    const sheet = el("div", "gh-sheet gh-gif-sheet gh-editor-sticker-sheet");
    sheet.style.display = "none";
    sheet.innerHTML = `
      <div class="gh-sheet-grip"></div>
      <div class="gh-gif-tabs">
        <button class="gh-gif-tab" data-tab="emoji">Emoji</button>
        <button class="gh-gif-tab" data-tab="bitmoji">Bitmoji</button>
      </div>
      <div class="gh-gif-body gh-sticker-grid gh-scroll"></div>
    `;
    c.el.append(backdrop, sheet);
    const s = { backdrop, sheet, body: sheet.querySelector(".gh-gif-body"), tabs: {}, tab: "emoji" };
    backdrop.addEventListener("click", () => { closeSheetGeneric(backdrop, sheet); setTool(ctx, c, null); });
    for (const b of sheet.querySelectorAll(".gh-gif-tab")) { s.tabs[b.dataset.tab] = b; b.addEventListener("click", () => { haptic("light"); s.tab = b.dataset.tab; renderEditorStickers(ctx, c, s); }); }
    ed.stickerSheetObj = s;
    return s;
  }
  function openStickerPicker(ctx, c) {
    const ed = c.editor;
    commitPendingEdits(ctx, c);
    setTool(ctx, c, "sticker");
    const s = ensureStickerSheet(ctx, c);
    s.tab = "emoji";
    openSheetGeneric(s.backdrop, s.sheet);
    renderEditorStickers(ctx, c, s);
  }
  function renderEditorStickers(ctx, c, s) {
    for (const [name, b] of Object.entries(s.tabs)) b.dataset.on = s.tab === name ? "1" : "0";
    s.body.innerHTML = "";
    if (s.tab === "emoji") {
      for (const em of EMOJI_GRID) {
        const tile = el("button", "gh-sticker-tile gh-press");
        tile.textContent = em;
        tile.addEventListener("click", () => { haptic("light"); placeEmojiSticker(ctx, c, em); closeSheetGeneric(s.backdrop, s.sheet); setTool(ctx, c, null); });
        s.body.appendChild(tile);
      }
    } else {
      renderEditorBitmoji(ctx, c, s);
    }
  }
  async function renderEditorBitmoji(ctx, c, s) {
    const p = stickerPeople(ctx);
    if (!p.me) { s.body.appendChild(Object.assign(el("div", "gh-gif-empty"), { textContent: "Your Bitmoji hasn't loaded yet" })); return; }
    s.body.appendChild(el("div", "gh-spinner"));
    let cat;
    try { cat = await loadStickerCatalog(); } catch (e) { s.body.innerHTML = ""; s.body.appendChild(Object.assign(el("div", "gh-gif-empty"), { textContent: "Couldn't load stickers" })); return; }
    if (s.tab !== "bitmoji") return; // a tab switch happened while this was loading
    s.body.innerHTML = "";
    for (const x of cat.solo.slice(0, 60)) {
      const comic = x[0];
      const tile = el("button", "gh-sticker-tile gh-press");
      const img = el("img"); img.loading = "lazy"; img.alt = "";
      img.src = stickerUrl(comic, p.me, null);
      img.addEventListener("error", () => tile.remove(), { once: true });
      tile.appendChild(img);
      tile.addEventListener("click", () => { haptic("light"); placeBitmojiSticker(ctx, c, comic, p.me); closeSheetGeneric(s.backdrop, s.sheet); setTool(ctx, c, null); });
      s.body.appendChild(tile);
    }
  }
  function placeEmojiSticker(ctx, c, emoji) {
    const ed = c.editor;
    const item = { id: "s" + (++ed.itemSeq), type: "sticker", kind: "emoji", emoji, x: ed.viewport.w / 2, y: ed.viewport.h / 2, rotation: 0, scale: 1 };
    ed.items.push(item);
    renderStickerItemEl(ctx, c, item);
  }
  async function placeBitmojiSticker(ctx, c, comic, meAvatarId) {
    const ed = c.editor;
    const url = stickerUrl(comic, meAvatarId, null);
    const item = { id: "s" + (++ed.itemSeq), type: "sticker", kind: "bitmoji", x: ed.viewport.w / 2, y: ed.viewport.h / 2, rotation: 0, scale: 1, img: null };
    ed.items.push(item);
    renderStickerItemEl(ctx, c, item, url);
    // the on-screen <img> above uses the CDN URL directly (fine for display); compositing into a canvas
    // needs an untainted source, so fetch through the app's native fetch bridge (same trick gmBytes already
    // uses for GIFs/the chat sticker catalog) and decode a same-origin data: URL for the real pixels.
    try {
      const bytes = await gmBytes(url);
      const dataUrl = bytesToDataUrl(bytes, "image/webp");
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
      item.img = img;
    } catch (e) { gtrail("editor sticker fetch failed " + (e && e.message || e)); }
  }
  function renderStickerItemEl(ctx, c, item, imgUrl) {
    const ed = c.editor;
    const wrap = el("div", "gh-editor-item gh-editor-item-sticker");
    if (item.kind === "emoji") wrap.textContent = item.emoji;
    else { const img = el("img"); img.src = imgUrl; img.alt = ""; wrap.appendChild(img); }
    ed.itemsLayer.appendChild(wrap);
    item.el = wrap;
    positionItemEl(item);
    attachItemGestures(ctx, c, item);
  }

  // ---- shared item interaction: drag (single touch), pinch+rotate (two touches), tap, trash ------------
  function positionItemEl(item) {
    if (item.type === "text" && item.style === 0) {
      item.el.style.left = "0"; item.el.style.right = "0"; item.el.style.top = item.y + "px"; item.el.style.transform = "translateY(-50%)";
    } else {
      item.el.style.left = "0"; item.el.style.top = "0"; item.el.style.right = "";
      item.el.style.transform = `translate(${item.x}px, ${item.y}px) translate(-50%,-50%) rotate(${item.rotation}rad) scale(${item.scale})`;
    }
  }
  function bringToFront(ed, item) { ed.itemsLayer.appendChild(item.el); }
  function showTrash(c) { c.editor.trash.dataset.show = "1"; }
  function hideTrash(ctx, c) { c.editor.trash.dataset.show = "0"; c.editor.trash.classList.remove("gh-editor-trash-hover"); c.editor.trashOver = false; }
  function updateTrashHover(c, item) {
    const ed = c.editor;
    const tr = ed.trash.getBoundingClientRect(), rr = c.review.getBoundingClientRect(), k = pageScaleOf(c.review);
    const tx = (tr.left - rr.left + tr.width / 2) / k, ty = (tr.top - rr.top + tr.height / 2) / k;
    const over = Math.hypot(item.x - tx, item.y - ty) < 55;
    if (over && !ed.trashOver) haptic("medium");
    ed.trashOver = over;
    ed.trash.classList.toggle("gh-editor-trash-hover", over);
  }
  function deleteItem(ctx, c, item) {
    const ed = c.editor;
    if (item.el) item.el.remove();
    ed.items = ed.items.filter((x) => x !== item);
    haptic("medium");
  }
  function attachItemGestures(ctx, c, item) {
    const ed = c.editor;
    const elx = item.el;
    elx.style.touchAction = "none";
    const touches = new Map();
    let mode = null, start = null, downTime = 0, moved = false;
    const isBar = () => item.type === "text" && item.style === 0;
    const pt = (t) => toLocal(c.review, t.clientX, t.clientY);
    function onStart(e) {
      if (ed.tool === "draw" || ed.editingText) return;
      e.stopPropagation();
      for (const t of e.changedTouches) touches.set(t.identifier, pt(t));
      bringToFront(ed, item);
      if (isBar() || touches.size === 1) {
        downTime = nowMs(); moved = false;
        start = { x: item.x, y: item.y, touch: [...touches.values()][touches.size - 1] };
        mode = "drag";
        if (!isBar()) showTrash(c);
      }
      if (!isBar() && touches.size >= 2) {
        const pts = [...touches.values()];
        start = { scale: item.scale, rotation: item.rotation, d0: dist(pts[0], pts[1]), a0: angle(pts[0], pts[1]) };
        mode = "pinch";
        hideTrash(ctx, c);
      }
      e.preventDefault();
    }
    function onMove(e) {
      if (!mode) return;
      for (const t of e.changedTouches) if (touches.has(t.identifier)) touches.set(t.identifier, pt(t));
      if (mode === "drag") {
        const cur = [...touches.values()][0];
        const dx = cur.x - start.touch.x, dy = cur.y - start.touch.y;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
        if (isBar()) { item.y = clamp(start.y + dy, 40, ed.viewport.h - 40); }
        else { item.x = start.x + dx; item.y = start.y + dy; updateTrashHover(c, item); }
        positionItemEl(item);
      } else if (mode === "pinch" && touches.size >= 2) {
        const pts = [...touches.values()];
        const d1 = dist(pts[0], pts[1]), a1 = angle(pts[0], pts[1]);
        item.scale = clamp(start.scale * (d1 / Math.max(1, start.d0)), 0.3, 6);
        item.rotation = start.rotation + (a1 - start.a0);
        moved = true;
        positionItemEl(item);
      }
      e.preventDefault();
    }
    function onEnd(e) {
      for (const t of e.changedTouches) touches.delete(t.identifier);
      if (touches.size === 0) {
        if (!isBar() && ed.trashOver) { deleteItem(ctx, c, item); hideTrash(ctx, c); mode = null; return; }
        hideTrash(ctx, c);
        if (!moved && nowMs() - downTime < 350 && item.type === "text") openTextInputFor(ctx, c, item);
        mode = null;
      } else if (!isBar() && touches.size === 1) {
        start = { x: item.x, y: item.y, touch: [...touches.values()][0] };
        mode = "drag";
      }
    }
    elx.addEventListener("touchstart", onStart, { passive: false });
    elx.addEventListener("touchmove", onMove, { passive: false });
    elx.addEventListener("touchend", onEnd, { passive: true });
    elx.addEventListener("touchcancel", onEnd, { passive: true });
    // mouse fallback (dev rig)
    elx.addEventListener("mousedown", (e) => { if (ed.tool === "draw" || ed.editingText) return; e.stopPropagation(); downTime = nowMs(); moved = false; bringToFront(ed, item); start = { x: item.x, y: item.y, mx: e.clientX, my: e.clientY }; mode = "drag"; if (!isBar()) showTrash(c); window.addEventListener("mouseup", onMouseUp, { once: true }); });
    elx.addEventListener("mousemove", (e) => { if (mode !== "drag" || !e.buttons) return; const k = pageScaleOf(c.review), dx = (e.clientX - start.mx) / k, dy = (e.clientY - start.my) / k; if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true; if (isBar()) item.y = clamp(start.y + dy, 40, ed.viewport.h - 40); else { item.x = start.x + dx; item.y = start.y + dy; updateTrashHover(c, item); } positionItemEl(item); });
    // added per drag (once), not permanently: a window listener per sticker/text kept every item alive forever
    function onMouseUp() {
      if (mode !== "drag") return;
      if (!isBar() && ed.trashOver) { deleteItem(ctx, c, item); hideTrash(ctx, c); mode = null; return; }
      hideTrash(ctx, c);
      if (!moved && item.type === "text") openTextInputFor(ctx, c, item);
      mode = null;
    }
  }

  // ---- final composite: everything drawn onto the media's real pixel size ------------------------------
  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }
  function paintTextItemFinal(octx, item, t, vw) {
    if (!item.text) return;
    const big = item.style === 1 || item.style === 3;
    const fontPx = Math.max(6, (TEXT_STYLE_PX[item.style] || TEXT_BASE_PX) * item.scale * t.scale);
    const lines = item.text.split("\n");
    octx.save();
    octx.textBaseline = "middle";
    octx.font = `${big ? 800 : item.style === 0 ? 500 : 700} ${fontPx}px -apple-system, "SF Pro Text", sans-serif`;
    if (item.style === 0) {
      const my = (item.y - t.oy) / t.scale;
      const mLeft = (0 - t.ox) / t.scale, mRight = (vw - t.ox) / t.scale;
      const lineH = fontPx * 1.3, padY = fontPx * 0.45;
      const totalH = lines.length * lineH + padY * 2;
      octx.fillStyle = bgColorFor(item) || "rgba(0,0,0,0.55)";
      octx.fillRect(mLeft, my - totalH / 2, mRight - mLeft, totalH);
      octx.fillStyle = textColorFor(item);
      octx.textAlign = "center";
      let ly = my - totalH / 2 + padY + lineH / 2;
      for (const line of lines) { octx.fillText(line, (mLeft + mRight) / 2, ly); ly += lineH; }
    } else {
      const p = viewportToMedia(t, item.x, item.y);
      octx.translate(p.x, p.y);
      octx.rotate(item.rotation);
      const lineH = fontPx * 1.2;
      const totalH = lines.length * lineH;
      octx.textAlign = item.style === 3 ? "left" : "center";
      let maxW = 0; for (const line of lines) maxW = Math.max(maxW, octx.measureText(line).width);
      if (item.style === 2) {
        const padX = fontPx * 0.55, padY = fontPx * 0.35;
        octx.fillStyle = bgColorFor(item) || "#ffffff";
        roundRectPath(octx, -(maxW + padX * 2) / 2, -(totalH + padY * 2) / 2, maxW + padX * 2, totalH + padY * 2, (totalH + padY * 2) / 2);
        octx.fill();
      }
      octx.fillStyle = textColorFor(item);
      const lx = item.style === 3 ? -maxW / 2 : 0;
      let ly = -totalH / 2 + lineH / 2;
      for (const line of lines) { octx.fillText(line, lx, ly); ly += lineH; }
    }
    octx.restore();
  }
  function paintStickerItemFinal(octx, item, t) {
    const p = viewportToMedia(t, item.x, item.y);
    octx.save();
    octx.translate(p.x, p.y);
    octx.rotate(item.rotation);
    const baseSize = 110 * item.scale * t.scale;
    if (item.kind === "emoji") {
      octx.font = `${baseSize * 0.82}px -apple-system, sans-serif`;
      octx.textAlign = "center"; octx.textBaseline = "middle";
      octx.fillText(item.emoji, 0, baseSize * 0.03);
    } else if (item.img) {
      const ar = (item.img.naturalWidth / item.img.naturalHeight) || 1;
      const w = ar >= 1 ? baseSize : baseSize * ar, h = ar >= 1 ? baseSize / ar : baseSize;
      octx.drawImage(item.img, -w / 2, -h / 2, w, h);
    }
    octx.restore();
  }
  function paintEditorOverlay(ed, octx, mediaW, mediaH) {
    const vw = ed.viewport.w || 1, vh = ed.viewport.h || 1;
    const t = coverTransform(vw, vh, mediaW, mediaH);
    octx.clearRect(0, 0, mediaW, mediaH);
    for (const s of ed.strokes) {
      const pts = s.pts.map((p) => viewportToMedia(t, p.x, p.y));
      strokePath(octx, { color: s.color, size: Math.max(1, s.size * t.scale), pts });
    }
    for (const item of ed.items) {
      if (item.type === "text") paintTextItemFinal(octx, item, t, vw);
      else if (item.type === "sticker") paintStickerItemFinal(octx, item, t);
    }
  }
  // { blob, overlay?, width, height } - blob is what to send/save as the media itself; overlay (video only,
  // and only when there are edits) is a transparent PNG at the video's own dimensions for bridge.sendSnap's
  // overlayMedia (see BRIDGE_NOTES.md). A photo's edits are always baked straight into the returned JPEG -
  // no separate overlay - since a flat raster is exactly what sendMedia/sendSnap already expect for images.
  async function renderEditorOutput(ctx, c) {
    const cap = c.captured, ed = c.editor;
    if (!ed || !ed.hasEdits()) return { blob: cap.blob };
    const w = Math.max(1, Math.round(cap.width || 1080)), h = Math.max(1, Math.round(cap.height || 1920));
    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.width = w; overlayCanvas.height = h;
    const octx = overlayCanvas.getContext("2d");
    paintEditorOverlay(ed, octx, w, h);
    if (cap.kind === "video") {
      const overlay = await new Promise((res) => overlayCanvas.toBlob(res, "image/png"));
      return { blob: cap.blob, overlay, width: w, height: h };
    }
    const photoImg = await loadImageFromBlob(cap.blob);
    const finalCanvas = document.createElement("canvas");
    finalCanvas.width = w; finalCanvas.height = h;
    const fctx = finalCanvas.getContext("2d");
    fctx.drawImage(photoImg, 0, 0, w, h);
    fctx.drawImage(overlayCanvas, 0, 0);
    const blob = await new Promise((res) => finalCanvas.toBlob(res, "image/jpeg", 0.92));
    return { blob, width: w, height: h };
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
    // dir: which way the chat leaves (+1 = off to the right, the usual back swipe; -1 = off to the left). The home
    // screen's parallax comes from the opposite side, so a leftward exit feels like pushing the chat away.
    let dir = 1;
    function setProgress(p, animate) {
      p = clamp(p, 0, 1);
      if (animate) { conv.classList.add("gh-anim"); home.classList.add("gh-anim"); shade.classList.add("gh-anim"); }
      else { conv.classList.remove("gh-anim"); home.classList.remove("gh-anim"); shade.classList.remove("gh-anim"); }
      conv.style.transform = `translate3d(${dir * (1 - p) * 100}%,0,0)`;
      home.style.transform = `translate3d(${-dir * 30 * p}%,0,0)`;
      shade.style.opacity = String(0.15 * p);
      ctx.state.navProgress = p;
    }

    function begin(kind, e, wrapRowId) {
      const t = e.touches[0];
      g = { kind, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0, locked: null, p0: ctx.state.navProgress, rowId: wrapRowId, samples: [{ x: t.clientX, t: nowMs() }] };
    }
    function move(e) {
      // Every touchmove reaches this twice while its target is still in the DOM: once bubbling through
      // `stack`'s own listener below, once through the same-target rebind further down (added for the
      // opposite case - iOS keeps delivering events to a target that WAS removed mid-gesture, which
      // wouldn't otherwise bubble anywhere). Tagging the event dedupes the common connected-target case:
      // it used to run this whole function's work twice per real finger movement, sampling the same
      // (x, t) point into `g.samples` twice - quietly biasing the release-velocity/flick math by making
      // the ring buffer's small window cover less real time than it looked like it did.
      if (e.__ghostNavMoveHandled) return;
      e.__ghostNavMoveHandled = true;
      if (!g || !e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      g.dx = t.clientX - g.x0; g.dy = t.clientY - g.y0;
      g.samples.push({ x: t.clientX, t: nowMs() }); if (g.samples.length > 10) g.samples.shift();
      if (!g.locked) {
        if (Math.abs(g.dx) < 8 && Math.abs(g.dy) < 8) return;
        g.locked = Math.abs(g.dx) > Math.abs(g.dy) * 1.2 ? "x" : "y";
        if (g.locked !== "x") { g = null; return; }
        if (g.kind === "close") {
          if (g.onMessage && g.dx > 0) { g = null; return; } // a rightward swipe on a message is reply (initMessageGestures)
          dir = g.dx < 0 ? -1 : 1; // leaving: follow whichever way the finger goes
        } else dir = 1;
        // swiping a row open: show THAT person's chat under your finger (it still showed the last chat you had open)
        if (g.kind === "open" && g.rowId) peekConversation(ctx, g.rowId);
      }
      e.preventDefault();
      const w = widthPx();
      const delta = g.dx / w;
      // Opening (progress 0 -> 1): dragging LEFT (delta negative) pulls the conversation in, like a row
      // sliding in from the right. Closing (progress 1 -> 0): dragging RIGHT (delta positive) reveals home
      // underneath, like the standard iOS edge-swipe-back — progress must DECREASE as delta increases.
      const p = g.kind === "open" ? clamp(g.p0 + Math.max(0, -delta) * 1.6, 0, 1) : clamp(g.p0 - delta * dir, 0, 1);
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
        const commit = ctx.state.navProgress < (1 - TRIGGER) || v * dir > FLICK_V; // dragged far enough, or a fast flick that way
        if (commit) {
          haptic("light");
          setProgress(0, true);
          // after a leftward exit the chat sits off to the LEFT; put it back on the right (off screen, no animation)
          // so the next chat slides in from the right as usual
          if (dir < 0) setTimeout(() => { if (ctx.state.navProgress === 0) { dir = 1; setProgress(0, false); } }, 380);
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
      if (!e.touches || e.touches.length !== 1) { g = null; return; }
      const target = e.target;
      const onConv = ctx.state.navProgress > 0.5;
      if (!onConv) {
        const row = target.closest && target.closest(".gh-row");
        if (row && !target.closest("input, button")) begin("open", e, row.dataset.id);
        else g = null;
      } else {
        const x = e.touches[0].clientX;
        // swipe right from anywhere in the chat to leave it (the edge, the header, the messages - not inside inputs,
        // voice-note waveforms or open sheets); a leftward swipe on a message is reply instead
        const free = !target.closest("input, textarea, button, .gh-audio-wave, .gh-sheet, .gh-call, .gh-camera, .gh-settings, .gh-viewer");
        if ((x <= EDGE_ZONE && !target.closest("input, textarea, button")) || free) {
          begin("close", e, null);
          g.onMessage = !!(target.closest && target.closest(".gh-msg-wrap"));
        }
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
