// Ghost data bridge - PAGE world, injected at document start, BEFORE Snapchat's own <script> tags run.
//
// Implements ghost/API.md by reaching into Snapchat Web's own webpack module graph and its zustand-style
// app store, then normalising whatever it finds into the API.md types. See ghost/BRIDGE_NOTES.md for, per
// method: which store fields / bundle functions this reads, a confidence rating, search strings to
// relocate the same logic in a future bundle (minified names below WILL be different next release - only
// literal strings like "sendTextMessage" or "getConversationManager" are expected to survive), and what
// the first device test must check.
//
// Hard rule for this whole file: never let a Snapchat internals surprise take the page down. Every lookup
// is try/catch'd; every failure becomes an `error` event instead of a thrown exception; unknown shapes
// become `kind: "unknown"` instead of being dropped.
(() => {
  "use strict";

  // ------------------------------------------------------------------------------------------------
  // 0. small utilities
  // ------------------------------------------------------------------------------------------------

  const VERSION = "0.1.0";

  function post(msg) {
    try { window.postMessage(msg, "*"); } catch { /* window itself gone (navigating away): nothing to do */ }
  }

  // Every `error` event doubles as the "trail" hook the task asked for: both real failures AND
  // notable milestones (store hooked, store found, store lost) go through here, so the first device
  // test can grep trail.txt / the console for "[ghost]" and see the whole story without us inventing a
  // second event type API.md doesn't define.
  // "log" = progress notes for the phone's log; "error" = something failed. The UI writes both to trail.txt and never
  // shows them as pop-ups (an internal hiccup isn't something the user can act on).
  function trail(where, message, type = "log") {
    try { console.log("[ghost]", where, message); } catch { /* ignore */ }
    const text = message && message.message ? message.message + (message.stack ? " | " + String(message.stack).split("\n")[0] : "") : String(message);
    post({ ghost: "event", type, data: { where, message: text } });
  }

  function safe(where, fn, fallback) {
    try { return fn(); } catch (e) { trail(where, e, "error"); return fallback; }
  }

  function throttle(fn, ms) {
    let timer = null, pending = false;
    return (...args) => {
      if (timer) { pending = true; return; }
      fn(...args);
      timer = setTimeout(() => { timer = null; if (pending) { pending = false; fn(...args); } }, ms);
    };
  }

  // ------------------------------------------------------------------------------------------------
  // 1. capture __webpack_require__ before Snapchat's runtime finishes wiring itself up.
  //
  // Snapchat Web's webpack runtime (currently .../dw/964aa5dd232a937e3846.js) does, at the top level:
  //   var d = globalThis.webpackChunk_snapchat_web_calling_app ||= []
  //   d.forEach(H.bind(null, 0))
  //   d.push = H.bind(null, d.push.bind(d))
  // where H([chunkIds, moduleMap, entryFn], ...) merges moduleMap into the require function's module
  // table and, if entryFn is present, calls entryFn(__webpack_require__). Every later `.push([...])`
  // (from the main bundle, or any lazy-loaded chunk) goes through the SAME reassigned `.push`.
  //
  // We can't intercept a plain function reassignment after the fact, so instead we pre-create the
  // chunk array with an ACCESSOR property named "push": reading it returns whatever push implementation
  // is currently installed (native Array.prototype.push until the runtime installs its own), and WRITING
  // to it (which is exactly what "d.push = H.bind(...)" does) is captured into a variable instead of
  // becoming an own data property. The moment the runtime installs its handler, we push one throwaway
  // chunk of our own - [[uniqueId], {}, (req) => { capture req }] - through that same accessor, so it
  // goes through the runtime's real handler and its entryFn(__webpack_require__) callback hands us the
  // require function every other module in the app shares. This is the same trick BetterDiscord / 7TV
  // use against Discord's near-identical webpack runtime; nothing here depends on minified names.
  const CHUNK_GLOBAL = "webpackChunk_snapchat_web_calling_app";

  let webpackRequire = null;

  function hookChunkArray() {
    const seed = Array.isArray(globalThis[CHUNK_GLOBAL]) ? globalThis[CHUNK_GLOBAL].slice() : [];
    const arr = [];
    for (const entry of seed) Array.prototype.push.call(arr, entry);

    let installedPush = null; // what the webpack runtime assigns to `.push`

    Object.defineProperty(arr, "push", {
      configurable: true,
      get() {
        return installedPush || Array.prototype.push.bind(arr);
      },
      set(fn) {
        installedPush = fn;
        if (!webpackRequire) {
          // Runs synchronously, inside this same setter call, so it happens the instant the runtime
          // finishes installing itself - before the main bundle's own (much bigger) chunk push, and
          // long before anything the main bundle does could depend on timing here.
          try {
            const probeId = Symbol("ghost-webpack-probe");
            // Must go THROUGH the runtime's own handler (installedPush), not native Array.prototype.push:
            // a plain push would just leave the chunk sitting inertly in the array - nothing would ever
            // call our entryFn, and webpackRequire would stay null forever.
            installedPush([[probeId], {}, (req) => { webpackRequire = req; }]);
            if (!webpackRequire) throw new Error("runtime did not hand back a require function");
            trail("webpack-hook", "captured __webpack_require__");
          } catch (e) {
            trail("webpack-hook", e);
          }
        }
      },
    });

    globalThis[CHUNK_GLOBAL] = arr;
  }

  safe("webpack-hook", hookChunkArray);

  // ------------------------------------------------------------------------------------------------
  // 2. find the app store by shape, not by (minified, per-build) name.
  //
  // Snapchat Web's app state is a zustand vanilla store: an object (or a callable "hook" function with
  // the same object assigned onto it - zustand's `create()` does `Object.assign(hookFn, vanillaStore)`)
  // exposing { getState, setState, subscribe }. Verified in the current bundle: the vanilla `createStore`
  // factory literally builds `{setState:i,getState:r,getInitialState:...,subscribe:e=>(n.add(e),...),
  // destroy:...}` (main.js, search "getInitialState:()=>a,subscribe:e=>(n.add(e)"). The ONE instance we
  // want is the root store, identified the way API.md itself describes it: `getState()` returns an
  // object with a `messaging` key (conversations, sendTextMessage, ...).
  //
  // Brute-forcing every module the app has loaded is how BetterDiscord/Vencord/7TV find Discord's redux
  // store, but this bundle doesn't expose a module CACHE on __webpack_require__ (no `.c`, only `.m` = the
  // id -> factory map, unlike Discord's webpack config) - so "already required" vs "never touched" isn't
  // visible to us. To avoid forcing modules the app itself never needed (which could run code with real
  // side effects), each new module id is pre-filtered by its own (still-minified, but literal) source
  // text for "getState" AND "subscribe" before we ever call it. That is cheap (a .toString() and two
  // .includes()) and - because those two words are also how the store LOOKS when read, not just how it's
  // defined - shrinks "every module in a 9MB bundle" down to a couple of dozen candidates: the zustand
  // library helper itself (harmless to require - it only exports factory functions), and app modules that
  // read `.getState()` / call `.subscribe(...)` on the store, which necessarily import it.
  let store = null;
  let storeModuleId = null;
  const scannedModuleIds = new Set();

  function looksLikeStore(candidate) {
    return !!candidate
      && typeof candidate.getState === "function"
      && typeof candidate.subscribe === "function";
  }

  function looksLikeRootState(state) {
    return !!state && typeof state === "object" && !!state.messaging && typeof state.messaging === "object";
  }

  // A module's exports can BE the store, have it as `.default`, or have it under any other named export
  // (verified in the current bundle: several call sites import the store module and read `.s.getState()`
  // - "s" is just this build's mangled export name for it, not something to hardcode).
  function* storeCandidatesFromExports(exp) {
    if (looksLikeStore(exp)) yield exp;
    if (exp && typeof exp === "object") {
      for (const key of Object.keys(exp)) {
        let value;
        try { value = exp[key]; } catch { continue; }
        if (looksLikeStore(value)) yield value;
      }
    }
  }

  function scanForStore() {
    if (store || !webpackRequire || !webpackRequire.m) return;
    const moduleFactories = webpackRequire.m;
    for (const id of Object.keys(moduleFactories)) {
      if (store) return;
      if (scannedModuleIds.has(id)) continue;
      scannedModuleIds.add(id);
      const factory = moduleFactories[id];
      if (typeof factory !== "function") continue;
      let src;
      try { src = Function.prototype.toString.call(factory); } catch { continue; }
      if (!src.includes("getState") || !src.includes("subscribe")) continue;
      let exports;
      try { exports = webpackRequire(id); } catch (e) { trail("store-scan", `module ${id} threw: ${e && e.message || e}`); continue; }
      for (const candidate of storeCandidatesFromExports(exports)) {
        let state;
        try { state = candidate.getState(); } catch { continue; }
        if (looksLikeRootState(state)) {
          store = candidate;
          storeModuleId = id;
          trail("store-scan", `found store in module ${id}`);
          onStoreFound();
          return;
        }
      }
    }
  }

  function state() {
    return store ? safe("state", () => store.getState(), null) : null;
  }

  function messaging() {
    return (state() || {}).messaging || {};
  }

  // Keeps looking as more chunks arrive (the store might live in a lazily-loaded chunk that hasn't
  // pushed yet when document-start-injected code first runs its interval), for up to ~20s, then gives up
  // loudly instead of polling forever in the background of every page load.
  let scanAttempts = 0;
  const scanTimer = setInterval(() => {
    scanAttempts++;
    safe("store-scan", scanForStore);
    if (store || scanAttempts > 100) {
      clearInterval(scanTimer);
      if (!store) trail("store-scan", "gave up after 20s, store not found");
    }
  }, 200);

  // ------------------------------------------------------------------------------------------------
  // 3. normalisers: bundle shapes -> API.md types. Everything here is defensive duck-typing across the
  // few field-name variants actually seen while reading the bundle (see BRIDGE_NOTES.md), never a throw.
  // ------------------------------------------------------------------------------------------------

  // Verified bitmoji URL builder (main.js, search "images.bitmoji.com/3d/avatar"): given the two ids every
  // friend/user-shaped object in this bundle carries (either as bitmojiAvatarId/bitmojiSelfieId on
  // `publisherData`-style objects, or as the shorter avatarId/selfieId on friendship-proto objects), the
  // public, no-auth-needed render URL is `https://images.bitmoji.com/3d/avatar/{avatarId}-{selfieId}-v1.webp`.
  function bitmojiUrl(avatarId, selfieId) {
    if (!avatarId || !selfieId) return undefined;
    return `https://images.bitmoji.com/3d/avatar/${avatarId}-${selfieId}-v1.webp?transparent=1`;
  }

  function firstString(...vals) {
    for (const v of vals) if (typeof v === "string" && v) return v;
    return undefined;
  }

  // Turns anything shaped like Snapchat's own user/friend/participant records into a User (API.md).
  // Verified field names, all read directly off whatever object is handed in (never assumed to be at a
  // fixed path): userId/id, userName/username/mutable_username, displayName, bitmojiAvatarId/avatarId,
  // bitmojiSelfieId/selfieId. Anything else present is ignored, never dropped from the raw object itself.
  function toUser(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = firstString(raw.userId, raw.id, raw.participantId, raw.friendUserId);
    if (!id) return null;
    const username = firstString(raw.userName, raw.username, raw.mutable_username);
    const name = firstString(raw.displayName, username, raw.name) || username || id;
    const avatarId = firstString(raw.bitmojiAvatarId, raw.avatarId);
    const selfieId = firstString(raw.bitmojiSelfieId, raw.selfieId);
    return {
      id,
      name,
      username,
      avatarUrl: undefined, // no separate non-bitmoji avatar CDN found while reading the bundle
      bitmojiUrl: bitmojiUrl(avatarId, selfieId),
      color: undefined,
    };
  }

  // message.content is a protobuf `oneof`, decoded as { $case: "<name>", <name>: {...} }. Verified $case
  // values (main.js, search '$case===?"' near message rendering): "text", "chatMedia"/"externalMedia"/
  // "externalMediaMessageContent" (chat media), "snap"/"snapMessageContent"/"snapdoc" (a Snap),
  // "note"/"voiceNote" (audio note), "sticker", "creativeToolItem" (incl. Giphy GIFs - see gifs-find.js,
  // which finds the same content bytes from the DOM side for the "Not Supported on Web" card),
  // "statusMessage" (system line). Never seen here => "unknown", with whatever text can still be read.
  const CASE_TO_KIND = {
    text: "text",
    chatMedia: "chat-media",
    externalMedia: "chat-media",
    externalMediaMessageContent: "chat-media",
    snap: "snap",
    snapMessageContent: "snap",
    snapdoc: "snap",
    note: "audio",
    voiceNote: "audio",
    sticker: "sticker",
    statusMessage: "system",
  };

  function messageKindAndText(content) {
    const kase = content && content.$case;
    if (!kase) return { kind: "unknown", text: undefined };
    if (kase === "creativeToolItem") {
      const item = content.creativeToolItem;
      const isGiphy = !!(item && (item.giphy || (item.entity && /giphy/i.test(String(item.entity.$case || "")))));
      return { kind: isGiphy ? "gif" : "unknown", text: undefined };
    }
    const kind = CASE_TO_KIND[kase] || "unknown";
    let text;
    if (kind === "text") text = safe("message-text", () => content.text && content.text.text, undefined);
    if (kind === "system") text = safe("message-text", () => JSON.stringify(content.statusMessage).slice(0, 500), undefined);
    return { kind, text };
  }

  function toMessage(conversationId, id, raw) {
    if (!raw) return null;
    // `raw` is whatever `messaging.conversations[key].messages` (a Map) stores per id - verified shape
    // from the reactToMessage/updateMessage call sites: { descriptor: {conversationId, messageId, ...},
    // metadata: {reactions: [{userId, reaction}], ...}, messageContent: {contentType, ...}, content: {...} }
    // Exact nesting differs a little between call sites (some read raw.content directly, some
    // raw.messageContent.content) so both are tried.
    const content = raw.content || (raw.messageContent && raw.messageContent.content) || raw.message?.messageContent?.content;
    const { kind, text } = messageKindAndText(content);
    const senderId = firstString(raw.senderUserId, raw.senderId, raw.descriptor && raw.descriptor.senderUserId);
    const reactions = safe("message-reactions", () => (raw.metadata && raw.metadata.reactions || []).map((r) => ({
      emoji: safe("reaction-emoji", () => r.reaction && r.reaction.reactionContent, undefined),
      from: toUser({ userId: r.userId }) || { id: r.userId, name: r.userId },
    })), []);
    return {
      id: firstString(id, raw.messageId, raw.descriptor && raw.descriptor.messageId) || String(id),
      conversationId,
      from: (senderId && toUser({ userId: senderId })) || { id: senderId || "unknown", name: senderId || "unknown" },
      ts: Number(raw.timestamp || raw.createdTimestamp || raw.serverTimestamp || 0) || Date.now(),
      kind,
      text,
      media: undefined, // filled in by openConversation/openSnap once we can confirm a real media URL shape
      replyTo: raw.quotedMessageId ? { messageId: raw.quotedMessageId } : undefined,
      reactions: reactions.length ? reactions : undefined,
      saved: raw.savePolicy != null ? raw.savePolicy !== 0 : undefined,
      opened: raw.opened,
      pending: !!raw.pending,
      failed: !!raw.failed,
    };
  }

  // Friends/people: state.user.publicUsers is a Map userId -> { user_id, username, display_name, mutable_username,
  // bitmoji_avatar_id, bitmoji_selfie_id? } (main.js: "publicUsers:new Map", readers `.get(userId)`, and the
  // search/friend-picker code reading e.display_name / e.mutable_username). Device run 1 showed every
  // conversation as "Conversation": the old code looked for names inside messaging.conversations, which has none.
  function publicUser(id) {
    const s = state();
    const map = s && s.user && s.user.publicUsers;
    if (!id || !map) return null;
    const raw = typeof map.get === "function" ? map.get(id) : map[id];
    if (!raw) return null;
    const name = firstString(raw.display_name, raw.displayName, raw.display, raw.mutable_username, raw.username);
    return {
      id,
      name: name || id,
      username: firstString(raw.mutable_username, raw.username),
      avatarUrl: undefined,
      bitmojiUrl: bitmojiUrl(firstString(raw.bitmoji_avatar_id, raw.bitmojiAvatarId), firstString(raw.bitmoji_selfie_id, raw.bitmojiSelfieId)),
    };
  }
  const idOf = (p) => (typeof p === "string" ? p : p && firstString(p.id, p.userId, p.user_id, p.participantId, p.str)) || undefined;
  let meIdCache = null;
  function meId() {
    if (meIdCache) return meIdCache;
    const s = state();
    const direct = s && s.auth && firstString(s.auth.userId, s.auth.user_id, s.auth.currentUserId);
    if (direct) return (meIdCache = direct);
    const counts = new Map();
    const feed = messaging().feed || {};
    const keys = Object.keys(feed);
    for (const k of keys) for (const p of (feed[k] && feed[k].participants) || []) { const id = idOf(p); if (id) counts.set(id, (counts.get(id) || 0) + 1); }
    let best = null, bestN = 0;
    for (const [id, n] of counts) if (n > bestN) { best = id; bestN = n; }
    if (best && keys.length >= 3 && bestN >= keys.length * 0.8) meIdCache = best; // you're in every chat of yours
    return best;
  }
  function personFor(id) { return publicUser(id) || (id ? { id, name: "Unknown", username: undefined } : null); }
  function newestTimestamp(obj, depth) {
    let best = 0;
    if (!obj || typeof obj !== "object" || depth < 0) return best;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "number" && /time|Ts$|Ms$|stamp/i.test(k) && v > 1e12 && v < 4e12 && v > best) best = v;
      else if (typeof v === "string" && /time|stamp/i.test(k) && /^\d{13}$/.test(v) && +v > best) best = +v;
      else if (v && typeof v === "object" && !(v instanceof Map)) best = Math.max(best, newestTimestamp(v, depth - 1));
    }
    return best;
  }

  function conversationTitleAndParticipants(entry) {
    const conv = entry && entry.conversation;
    const rawParticipants = (conv && (conv.participants || conv.participantUsers)) || [];
    const participants = safe("conv-participants", () => rawParticipants
      .map((p) => (typeof p === "string" ? toUser({ userId: p }) : toUser(p)))
      .filter(Boolean), []);
    const isGroup = !!(conv && (conv.conversationType === 1 || /GROUP/i.test(String(conv.conversationType || ""))));
    const title = firstString(conv && conv.conversationTitle, participants.length === 1 ? participants[0].name : undefined)
      || (participants.length ? participants.map((p) => p.name).join(", ") : "Conversation");
    return { title, isGroup, participants };
  }

  function toConversation(key, entry) {
    const feed = (messaging().feed || {})[key];
    if (feed) return safe("feed-conversation", () => fromFeed(key, feed, entry), null);
    if (!entry) return null;
    const { title, isGroup, participants } = conversationTitleAndParticipants(entry);
    let lastMessage = null;
    safe("conv-preview", () => {
      const msgs = entry.messages;
      if (msgs && typeof msgs.values === "function") {
        for (const m of msgs.values()) lastMessage = m; // Map preserves insertion order; last wins
      }
    });
    const preview = safe("conv-preview-shape", () => {
      if (!lastMessage) return { kind: "none", fromMe: false };
      const norm = toMessage(key, undefined, lastMessage);
      return { kind: norm ? norm.kind : "none", text: norm && norm.text, fromMe: false, status: undefined };
    }, { kind: "none", fromMe: false });
    return {
      id: key,
      title,
      isGroup,
      participants,
      avatarUrl: undefined,
      lastActivityTs: Number(entry.conversation && entry.conversation.lastInteraction) || Date.now(),
      preview,
      unreadCount: 0, // no per-conversation unread counter located in `messaging` while reading the bundle - see BRIDGE_NOTES
      hasUnreadSnap: false,
      streak: undefined,
      muted: undefined,
      pinned: undefined,
    };
  }

  // A feed entry (state.messaging.feed[conversationId]) is what Snapchat's own chat list renders; fields read by the
  // bundle: conversationId, participants, conversationType, conversationTitle, streakMetadata {count,
  // expirationTimestampMs}, displayInfo { feedItem {snap|chat|call|...}, feedItemCreatorId, viewed,
  // lastSenderUserIds, isLocked }.
  function fromFeed(key, feed, entry) {
    const me = meId();
    const ids = ((feed.participants) || []).map(idOf).filter(Boolean);
    const others = ids.filter((id) => id !== me);
    const participants = others.map(personFor).filter(Boolean);
    const isGroup = others.length > 1 || feed.conversationType === 1;
    const title = firstString(feed.conversationTitle) || participants.map((p) => p.name).join(", ") || "Conversation";
    const info = feed.displayInfo || {};
    const item = info.feedItem || {};
    const creator = idOf(info.feedItemCreatorId);
    const fromMe = !!(creator && me && creator === me);
    const kindCase = item.$case || ["snap", "chat", "call", "chatMedia", "note"].find((k) => item[k]) || "none";
    const kind = { snap: "snap", chat: "text", call: "call", chatMedia: "chat-media", note: "audio" }[kindCase] || "none";
    const unread = info.viewed === false && !fromMe;
    const streak = feed.streakMetadata && feed.streakMetadata.count ? {
      count: Number(feed.streakMetadata.count) || 0,
      expiring: !!(feed.streakMetadata.expirationTimestampMs && Number(feed.streakMetadata.expirationTimestampMs) - Date.now() < 4 * 3600e3),
    } : undefined;
    let text;
    if (kind === "text" && entry && entry.messages && typeof entry.messages.values === "function") {
      let last = null; for (const m of entry.messages.values()) last = m;
      const norm = last && toMessage(key, undefined, last);
      if (norm && norm.kind === "text") text = norm.text;
    }
    return {
      id: key,
      title,
      isGroup,
      participants,
      avatarUrl: undefined,
      lastActivityTs: newestTimestamp(feed, 3) || 0,
      preview: { kind, text, fromMe, status: info.viewed ? (fromMe ? "opened" : "viewed") : (fromMe ? "delivered" : "received") },
      unreadCount: unread ? 1 : 0,
      hasUnreadSnap: unread && kind === "snap",
      streak,
      muted: undefined,
      pinned: undefined,
    };
  }
  const allConversationIds = () => {
    const m = messaging();
    const ids = new Set(Object.keys(m.feed || {}));
    for (const k of Object.keys(m.conversations || {})) ids.add(k);
    return [...ids];
  };

  // ------------------------------------------------------------------------------------------------
  // 4. events: `ready` once, `conversations` on every store change (throttled ~150ms per API.md).
  // ------------------------------------------------------------------------------------------------

  let unsubscribeStore = null;
  const openConversations = new Set(); // conversation ids the UI currently wants `messages` events for

  const emitConversations = throttle(() => {
    const convs = safe("conversations", () => {
      const map = messaging().conversations || {};
      return allConversationIds().map((k) => toConversation(k, map[k])).filter(Boolean).sort((a, b) => b.lastActivityTs - a.lastActivityTs);
    }, []);
    post({ ghost: "event", type: "conversations", data: { conversations: convs } });
  }, 150);

  const emitMessagesFor = throttle((conversationId) => {
    safe("messages-event", () => {
      const entry = (messaging().conversations || {})[conversationId];
      if (!entry) return;
      const msgs = entry.messages;
      const list = [];
      if (msgs && typeof msgs.entries === "function") {
        for (const [id, m] of msgs.entries()) { const n = toMessage(conversationId, id, m); if (n) list.push(n); }
      }
      list.sort((a, b) => a.ts - b.ts);
      post({ ghost: "event", type: "messages", data: { conversationId, messages: list, hasMore: !!entry.hasMoreMessages } });
    });
  }, 150);

  function meUser() {
    const id = meId();
    if (id) return personFor(id);
    // Best-effort / low confidence: no single "current user profile" slice was pinned down while reading
    // the bundle (see BRIDGE_NOTES.md). Heuristic: scan top-level state slices for the first flat object
    // that looks like a User by itself (not a map of them) - typically a "profile"/"identity"/"user"-ish
    // slice holding the signed-in account's own record.
    const s = state();
    if (!s) return null;
    for (const key of Object.keys(s)) {
      const val = s[key];
      if (!val || typeof val !== "object" || Array.isArray(val)) continue;
      const u = safe("me-guess", () => toUser(val), null);
      if (u && (val.userId || val.id)) return u;
    }
    return null;
  }

  function onStoreFound() {
    unsubscribeStore = safe("subscribe", () => store.subscribe(() => {
      emitConversations();
      for (const id of openConversations) emitMessagesFor(id);
    }), null);
    emitConversations();
    post({ ghost: "event", type: "ready", data: { loggedIn: loggedIn(), me: meUser() } });
  }

  function loggedIn() {
    const s = state();
    if (!s) return false;
    return !!safe("loggedIn", () => (s.auth && s.auth.hasEverLoggedIn) || !!messaging().client, false);
  }

  // ------------------------------------------------------------------------------------------------
  // 5. methods (UI -> bridge). One function per API.md method; every store action is called by its
  // REAL (verified) name, never a guess - see BRIDGE_NOTES.md for the exact bundle evidence per method.
  // ------------------------------------------------------------------------------------------------

  function requireStore() {
    if (!store) throw new Error("store not found yet");
    return store;
  }

  function conversationEntry(conversationId) {
    return (messaging().conversations || {})[conversationId];
  }

  const methods = {
    status() {
      return { loggedIn: loggedIn(), me: meUser(), storeFound: !!store, version: VERSION };
    },

    listConversations() {
      requireStore();
      const map = messaging().conversations || {};
      return allConversationIds().map((k) => toConversation(k, map[k])).filter(Boolean).sort((a, b) => b.lastActivityTs - a.lastActivityTs);
    },

    async openConversation(conversationId) {
      requireStore();
      openConversations.add(conversationId);
      const m = messaging();
      // enterConversation is what Snapchat's own chat pane calls on mount (main.js, search
      // "enterConversation:async"); it internally re-derives the conversation id itself
      // ((0,ar.QA)(n)), fetches messages if needed, and is also what clears the unread state the same
      // way opening a chat in the real UI does.
      // Snapchat's chat pane: `useEffect(() => { enterConversation(conversationId, conversationType) })` - the second
      // argument is the conversation TYPE (device run 1 passed a string here and every open threw).
      const type = safe("conv-type", () => ((messaging().feed || {})[conversationId] || {}).conversationType, undefined);
      if (typeof m.enterConversation === "function") await m.enterConversation(conversationId, type);
      const entry = conversationEntry(conversationId);
      // ...and it reports the newest message as seen via displayedMessages(conversationId, messageId) = read receipt,
      // exactly once per open like the real chat screen (only for the chat you actually opened)
      safe("displayed", () => {
        let lastId; if (entry && entry.messages && typeof entry.messages.keys === "function") for (const k of entry.messages.keys()) lastId = k;
        if (lastId !== undefined && typeof m.displayedMessages === "function") Promise.resolve(m.displayedMessages(conversationId, lastId)).catch((e) => trail("displayed", e, "error"));
      });
      const list = [];
      if (entry && entry.messages && typeof entry.messages.entries === "function") {
        for (const [id, msg] of entry.messages.entries()) { const n = toMessage(conversationId, id, msg); if (n) list.push(n); }
      }
      list.sort((a, b) => a.ts - b.ts);
      return { messages: list, hasMore: !!(entry && entry.hasMoreMessages) };
    },

    async closeConversation(conversationId) {
      requireStore();
      openConversations.delete(conversationId);
      const m = messaging();
      if (typeof m.exitConversation === "function") await m.exitConversation(conversationId);
      return true;
    },

    async loadOlder(conversationId) {
      requireStore();
      const m = messaging();
      if (typeof m.paginateMessages === "function") await m.paginateMessages(conversationId);
      const entry = conversationEntry(conversationId);
      const list = [];
      if (entry && entry.messages && typeof entry.messages.entries === "function") {
        for (const [id, msg] of entry.messages.entries()) { const n = toMessage(conversationId, id, msg); if (n) list.push(n); }
      }
      list.sort((a, b) => a.ts - b.ts);
      return { messages: list, hasMore: !!(entry && entry.hasMoreMessages) };
    },

    async sendText(conversationId, text, opts) {
      requireStore();
      const m = messaging();
      if (typeof m.sendTextMessage !== "function") throw new Error("sendTextMessage action missing");
      const replyOpts = opts && opts.replyToMessageId ? { messageId: opts.replyToMessageId } : undefined;
      await (replyOpts ? m.sendTextMessage(conversationId, text, replyOpts) : m.sendTextMessage(conversationId, text));
      return {};
    },

    async sendMedia(conversationId, blob, opts) {
      requireStore();
      const m = messaging();
      if (typeof m.sendMediaMessage !== "function") throw new Error("sendMediaMessage action missing");
      // Verified (main.js, search "sendMediaMessage:async(e,n)"): takes the destinations object and a
      // plain array of File/Blob - it runs them through Snapchat's own validation/optimisation pipeline
      // itself, so this is the ONE send path here we're confident stays fully native-looking on the
      // recipient's side without any extra wrapping from us.
      const file = blob instanceof File ? blob : new File([blob], `ghost.${(opts && opts.kind) || "bin"}`, { type: blob.type });
      await m.sendMediaMessage({ conversations: [conversationId], stories: [] }, [file]);
      return {};
    },

    async sendSnap(conversationIds, blob, opts) {
      requireStore();
      const m = messaging();
      if (typeof m.sendSnap !== "function") throw new Error("sendSnap action missing");
      // LOW CONFIDENCE - see BRIDGE_NOTES.md "sendSnap". The real `capturedSnap` snapshot Snapchat's own
      // camera passes here is a structured object (mediaType, optional overlayMedia/hasAudio/loopPlayback,
      // and an already-processed local media reference), not a bare Blob - camhook.js/recorder.js produce
      // that shape from a live camera session. We approximate the minimum shape actually read inside
      // `sendSnap` (mediaType, and the blob itself under `data`, matching how audio notes are built via
      // the sibling `createLocalMediaReference`-style helper a few lines away) rather than inventing an
      // unverified full shape. First device test MUST confirm this either sends a normal-looking snap or
      // fails loudly (caught below) rather than sending something malformed.
      const kind = (opts && opts.kind) || (blob.type && blob.type.startsWith("video") ? "video" : "image");
      const capturedSnap = {
        mediaType: kind === "video" ? "Video" : "Image",
        data: blob,
        hasAudio: kind === "video",
        loopPlayback: false,
        overlayMedia: undefined,
        durationSec: (opts && opts.durationSec) || undefined,
      };
      const destinations = { conversations: conversationIds, stories: [] };
      await new Promise((resolve, reject) => {
        m.sendSnap(
          destinations,
          capturedSnap,
          "GHOST",
          () => resolve(),
          () => resolve(), // onQueued
          (err) => reject(err instanceof Error ? err : new Error(String(err || "sendSnap failed"))),
          "GHOST",
        );
      });
      return true;
    },

    async react(conversationId, messageId, emoji) {
      requireStore();
      const m = messaging();
      const entry = conversationEntry(conversationId);
      const rawMessage = entry && entry.messages && typeof entry.messages.get === "function" && entry.messages.get(messageId);
      if (emoji == null) {
        if (typeof m.removeReaction !== "function") throw new Error("removeReaction action missing");
        await m.removeReaction(rawMessage || { descriptor: { conversationId, messageId } });
      } else {
        if (typeof m.reactToMessage !== "function") throw new Error("reactToMessage action missing");
        // Verified (main.js, search "reactToMessage:async(n,i,r)"): takes the FULL message object (reads
        // n.descriptor.conversationId / n.descriptor.messageId / n.metadata.reactions itself), not bare
        // ids - so a message we haven't seen yet (not in our local cache) can't be reacted to.
        if (!rawMessage) throw new Error("message not loaded locally, open the conversation first");
        await m.reactToMessage(rawMessage, emoji, "GHOST");
      }
      return true;
    },

    async saveMessage(conversationId, messageId, saved) {
      requireStore();
      const m = messaging();
      if (typeof m.updateMessage !== "function") throw new Error("updateMessage action missing");
      // Verified enum (main.js, search "e.UNKNOWN=0]", the block containing "e.SAVE=3","e.UNSAVE=4"):
      // a stable-looking protobuf MessageUpdateAction enum: UNKNOWN 0, READ 1, RELEASE 2, SAVE 3,
      // UNSAVE 4, ERASE 5, ... Hardcoded here (not read off the bundle) because it's the app's OWN
      // action, not Snapchat's - if this ever renumbers, saveMessage will silently do the wrong thing,
      // which is exactly why BRIDGE_NOTES.md flags this as a "must re-check by string search" item.
      const SAVE = 3, UNSAVE = 4;
      await m.updateMessage(conversationId, messageId, saved ? SAVE : UNSAVE);
      return true;
    },

    async openSnap(conversationId, messageId) {
      requireStore();
      const m = messaging();
      // Verified (main.js, search "getSnapManager().onSnapInteraction"): opening/replaying a snap in
      // Snapchat's own lightbox calls onSnapInteraction(VIEWING_INITIATED, ...) then (VIEWING_FINISHED,
      // ...) through these same store actions - this is the actual "mark viewed" mechanism, not a
      // separate flag we set ourselves.
      if (typeof m.startedViewingSnap === "function") await m.startedViewingSnap(conversationId, messageId);
      if (typeof m.finishedViewingSnap === "function") await m.finishedViewingSnap(conversationId, messageId);
      const entry = conversationEntry(conversationId);
      const raw = entry && entry.messages && typeof entry.messages.get === "function" && entry.messages.get(messageId);
      // No verified path from a message object to a fetchable snap media URL/blob while reading the
      // bundle (the real UI decrypts/streams it through the snap manager's own binary path) - reported
      // as an empty media list rather than guessed at. See BRIDGE_NOTES.md "openSnap".
      void raw;
      return { media: [] };
    },

    listStories() {
      // LOW CONFIDENCE / best-effort: no dedicated story manager or store slice was located while
      // reading the bundle (getStoryManager()/getSpotlightManager() etc. don't exist here - only
      // getConversationManager/getFeedManager/getSnapManager do). Returns [] rather than guessing at a
      // shape. See BRIDGE_NOTES.md "listStories".
      requireStore();
      return [];
    },

    async openStory() {
      requireStore();
      return { items: [] };
    },

    async newConversation(userIds) {
      requireStore();
      const m = messaging();
      if (typeof m.createConversationForUsers !== "function") throw new Error("createConversationForUsers action missing");
      const result = await m.createConversationForUsers(userIds, undefined, "GHOST");
      const conversationId = safe("new-conv-id", () => result && (result.conversationId || (result.conversation && result.conversation.conversationId)), undefined);
      return { conversationId: conversationId || null };
    },

    searchFriends() {
      // LOW CONFIDENCE / best-effort: no dedicated "friends list" slice or search action was pinned down
      // (only per-conversation participant lists and per-message sender ids were verified). Returns []
      // rather than guessing. See BRIDGE_NOTES.md "searchFriends".
      requireStore();
      return [];
    },

    debugShape() {
      const s = state();
      return shapeOf(s, 3);
    },
  };

  // One sample of each record we rely on, as structure only: strings become "str(<length>)", numbers stay (ids and
  // timestamps, not content). Lets the next round wire names/messages/snaps exactly from the phone's log.
  function redacted(value, depth) {
    if (value == null) return value === null ? null : "undefined";
    const t = typeof value;
    if (t === "string") return "str(" + value.length + ")";
    if (t === "number" || t === "boolean") return value;
    if (t === "function") return "fn";
    if (t === "bigint") return "bigint";
    if (value instanceof Uint8Array) return "bytes(" + value.length + ")";
    if (value instanceof Map) { const e = value.entries().next().value; return { __map: value.size, first: e ? [redacted(e[0], 0), depth > 0 ? redacted(e[1], depth - 1) : "…"] : null }; }
    if (value instanceof Set) return "Set(" + value.size + ")";
    if (Array.isArray(value)) return { __array: value.length, first: value.length && depth > 0 ? redacted(value[0], depth - 1) : undefined };
    if (depth <= 0) return "{" + Object.keys(value).slice(0, 12).join(",") + "}";
    const out = {}; let n = 0;
    for (const k of Object.keys(value)) { if (++n > 40) { out["…"] = Object.keys(value).length; break; } out[k] = safe("redact", () => redacted(value[k], depth - 1), "?"); }
    return out;
  }
  methods.debugSample = () => {
    const s = state() || {}, m = s.messaging || {};
    const firstVal = (o) => (o && typeof o === "object" ? o[Object.keys(o)[0]] : undefined);
    const users = s.user && s.user.publicUsers;
    return {
      topKeys: Object.keys(s),
      authKeys: s.auth ? Object.keys(s.auth) : null,
      userKeys: s.user ? Object.keys(s.user) : null,
      meGuess: meId() ? "found" : "none",
      feedEntry: redacted(firstVal(m.feed), 5),
      conversationEntry: redacted(firstVal(m.conversations), 5),
      publicUser: users && typeof users.values === "function" ? redacted(users.values().next().value, 3) : redacted(users, 1),
    };
  };

  // Keys/types only, recursively, capped in depth and breadth so this stays small and NEVER includes
  // message/user text content - only what kind of thing lives where.
  function shapeOf(value, depth) {
    if (value == null) return value === null ? "null" : "undefined";
    const t = typeof value;
    if (t !== "object") return t;
    if (value instanceof Map) return `Map(${value.size})`;
    if (value instanceof Set) return `Set(${value.size})`;
    if (Array.isArray(value)) return depth > 0 && value.length ? [shapeOf(value[0], depth - 1)] : `Array(${value.length})`;
    if (depth <= 0) return "object";
    const out = {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (++count > 60) { out["…"] = "(truncated)"; break; }
      out[key] = safe("shape", () => shapeOf(value[key], depth - 1), "unreadable");
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // 6. wire up postMessage request/response per API.md.
  // ------------------------------------------------------------------------------------------------

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.ghost !== "req") return;
    const { id, method, args } = msg;
    const fn = methods[method];
    if (typeof fn !== "function") {
      post({ ghost: "res", id, ok: false, error: `unknown method ${method}` });
      return;
    }
    Promise.resolve()
      .then(() => fn(...(Array.isArray(args) ? args : [])))
      .then((result) => post({ ghost: "res", id, ok: true, result }))
      .catch((err) => {
        trail(`method:${method}`, err);
        post({ ghost: "res", id, ok: false, error: String((err && err.message) || err) });
      });
  });

  trail("init", `bridge.js loaded (v${VERSION})`);
})();
