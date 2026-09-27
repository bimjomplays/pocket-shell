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
    const text = message && message.message ? message.message + (message.stack ? " | " + String(message.stack).split("\n")[0] : "")
      : message && typeof message === "object" ? (message.name || "error") + " " + safeJson(message) : String(message);
    post({ ghost: "event", type, data: { where, message: text } });
  }

  function safeJson(o) {
    try { return JSON.stringify(o, (k, v) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? "u8" : v)).slice(0, 300); } catch (e) { return "?"; }
  }
  function errText(err) {
    if (err && err.message) return err.message;
    if (err && typeof err === "object") return (err.name || "error") + (err.callbackStatus != null ? " status " + err.callbackStatus : "") + " " + safeJson(err);
    return String(err);
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

  // Bitmoji for avatars. With a selfie id (the pose the person picked as their Bitmoji selfie) the head-and-
  // shoulders render is `/3d/render/{selfieId}-{avatarId}-v1.webp?ua=2` (250x250, device-checked 2026-09-27) - what
  // round avatars want. Without one, Snapchat's own full-body builder (main.js, search
  // "images.bitmoji.com/3d/avatar/${t}-${e}"): `/3d/avatar/{sceneId||859643639}-{avatarId}-v1.webp?ua=2`.
  function bitmojiUrl(avatarId, selfieId, sceneId) {
    if (!avatarId) return undefined;
    if (selfieId) return `https://images.bitmoji.com/3d/render/${selfieId}-${avatarId}-v1.webp?ua=2`;
    let scene = sceneId || "859643639";
    if (scene.endsWith("-wc")) scene = scene.slice(0, -3);
    return `https://images.bitmoji.com/3d/avatar/${scene}-${avatarId}-v1.webp?ua=2`;
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
    // userDisplayName: state.friendStories.stories[key].userMetadata's own name field (device sample 2026-09-27).
    const name = firstString(raw.displayName, raw.userDisplayName, username, raw.name) || username || id;
    const avatarId = firstString(raw.bitmoji_avatar_id, raw.bitmojiAvatarId, raw.avatarId);
    const selfieId = firstString(raw.bitmoji_selfie_id, raw.bitmojiSelfieId, raw.selfieId);
    const sceneId = firstString(raw.bitmoji_scene_id, raw.bitmojiSceneId, raw.sceneId);
    return {
      id,
      name,
      username,
      avatarUrl: undefined, // no separate non-bitmoji avatar CDN found while reading the bundle
      bitmojiUrl: bitmojiUrl(avatarId, selfieId, sceneId),
      avatarId,
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

  // Message content is protobuf BYTES (messageContent.content, device sample 2026-09-26). Snapchat decodes it with
  // one helper (main.js: `function p(e){try{return(0,c.Jr)(a.v.decode(e.content))}catch(t){...error("Failed to
  // parse message content proto",t)...}}`), found here by that stable log string, never by minified names.
  let decoder;
  function contentDecoder() {
    if (decoder !== undefined) return decoder;
    decoder = null;
    safe("decoder", () => {
      const factories = webpackRequire && webpackRequire.m;
      if (!factories) return;
      for (const id of Object.keys(factories)) {
        const src = String(factories[id]);
        if (!src.includes("Failed to parse message content proto")) continue;
        const exp = webpackRequire(id);
        for (const k of Object.keys(exp)) {
          const fn = safe("decoder-export", () => exp[k], null);
          if (typeof fn === "function" && String(fn).includes("Failed to parse")) { decoder = fn; trail("decoder", "found in module " + id); return; }
        }
      }
      trail("decoder", "not found", "error");
    });
    return decoder;
  }
  function decodeContent(messageContent) {
    const d = contentDecoder();
    return d && messageContent ? safe("decode", () => d(messageContent), null) : null;
  }

  // The actual media fetch+decrypt+unzip pipeline Snapchat's own chat/snap/story players call once they have a
  // {mediaMetadata, mediaReference} pair (module search, device 2026-09-27: the metric/log strings
  // "media_resolve_missing_source" and "No content object and no localCacheKey" are UNIQUE to this one function -
  // verified live: found in module 46592, export "V"). It does the AES decrypt (mediaMetadata.encryptionInfo),
  // fetches mediaReference.contentObject/resolvedUrl/localCacheKey, and unzips media+overlay bundles, returning
  // dataUrls (blob: URLs whose Blob already carries the RIGHT sniffed MIME type - device-verified below) - so we
  // call it directly instead of reimplementing any crypto/network/unzip ourselves, exactly as the task asked.
  // Snapchat's own helpers for stickers, found by strings inside them (module ids change between Snapchat builds)
  let stickerHelperCache;
  function exportBySource(needle) {
    const factories = webpackRequire && webpackRequire.m;
    if (!factories) return null;
    for (const id of Object.keys(factories)) {
      if (!String(factories[id]).includes(needle)) continue;
      const exp = safe("export-by-source", () => webpackRequire(id), null);
      if (!exp) continue;
      for (const k of Object.keys(exp)) {
        const fn = safe("export-by-source-get", () => exp[k], null);
        if (typeof fn === "function" && String(fn).includes(needle)) return fn;
      }
    }
    return null;
  }
  function stickerHelpers() {
    if (stickerHelperCache) return stickerHelperCache;
    stickerHelperCache = {
      resolveBolt: exportBySource("resolver_does_not_exist"),      // bolt content object -> URL
      importKey: exportBySource("decrypt_media_key_length_error"), // (key, iv) -> {key: CryptoKey, iv}
      download: exportBySource("media_download_total_latency"),    // (bolt, context, key) -> decrypted ArrayBuffer
      unzip: exportBySource("file(/^overlay~/i)"),                  // media~/overlay~ zip -> {mediaArrayBuffer}
    };
    const missing = Object.keys(stickerHelperCache).filter((k) => !stickerHelperCache[k]);
    if (missing.length) trail("sticker-helpers", "missing " + missing.join(","), "error");
    return stickerHelperCache;
  }
  // send ready-made message content (encoded with Snapchat's own codec) the way its text sender does
  async function sendContent(conversationId, content, contentType) {
    const h = sendHelpers();
    const client = messaging().client;
    if (!h.proxy || !client || typeof client.getConversationManager !== "function") throw new Error("sending isn't available");
    const u = crypto.randomUUID();
    const attemptId = { id: Uint8Array.from(u.replace(/-/g, "").match(/../g).map((x) => parseInt(x, 16))), str: u };
    const destinations = { phoneNumbers: [], conversations: [convIdObj(conversationId)], stories: [], massSnaps: [] };
    const message = { content, quotedMessageId: undefined, contentType,
      platformAnalytics: { content: undefined, metricsMessageType: 1 /* STICKER */, metricsMessageMediaType: 5 /* DERIVED_FROM_MESSAGE_TYPE */, reactionSource: 0, attemptId },
      localMediaReferences: [], incidentalAttachments: [], savePolicy: 1 /* LIFETIME */, allowsTranscription: false, botMention: false };
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("send timed out")), 30000);
      client.getConversationManager().sendMessageWithContent(destinations, message, h.proxy({
        onSuccess: () => { clearTimeout(t); resolve(); },
        onError: (e) => { clearTimeout(t); reject(new Error("Snapchat refused it (" + errText(e) + ")")); },
        onQueued: () => {},
      }));
    });
  }
  // Posting to My Story, like Snapchat's quick-post tray (main.js "[Stories Utils]" module): destinations.stories =
  // [toDest(myStory())] - a fixed 16-byte My Story id + {privacyOverride: UNSET} wrapped as encoded storyData.
  let storyPostCache;
  function storyPostHelpers() {
    if (storyPostCache !== undefined) return storyPostCache;
    storyPostCache = null;
    safe("story-post", () => {
      const toDest = exportWhere("[Stories Utils]", (v) => typeof v === "function" && String(v).includes('$case:"myStory"'));
      const myStory = exportWhere("[Stories Utils]", (v) => typeof v === "function" && String(v).includes("privacyOverride") && String(v).includes("storyType"));
      if (toDest && myStory) storyPostCache = { toDest, myStory };
      else trail("story-post", "helpers not found", "error");
    });
    return storyPostCache;
  }
  let sendHelperCache;
  function exportWhere(moduleNeedle, pick) {
    const factories = webpackRequire && webpackRequire.m;
    if (!factories) return null;
    for (const id of Object.keys(factories)) {
      if (!String(factories[id]).includes(moduleNeedle)) continue;
      const exp = safe("export-where", () => webpackRequire(id), null);
      if (!exp) continue;
      for (const k of Object.keys(exp)) { const v = safe("export-where-get", () => exp[k], null); if (safe("export-where-pick", () => pick(v), false)) return v; }
    }
    return null;
  }
  function sendHelpers() {
    if (sendHelperCache) return sendHelperCache;
    sendHelperCache = {
      codec: exportWhere("e.content.sticker,t.uint32(34)", (v) => v && typeof v.encode === "function" && typeof v.decode === "function"), // message content proto
      proxy: exportWhere("Comlink.proxy", (v) => typeof v === "function" && String(v).includes("Object.assign(e,{[")),                  // Comlink.proxy(callbacks)
    };
    if (!sendHelperCache.codec || !sendHelperCache.proxy) trail("send-helpers", "missing " + Object.keys(sendHelperCache).filter((k) => !sendHelperCache[k]).join(","), "error");
    return sendHelperCache;
  }
  // Story view receipts, as Snapchat's own story player sends them (main.js, search 'fus_media_load_start'):
  //   receipts.send(...receipts.build(meIdObj, [{snapId, ownerUserId, shareCount: 0, viewTimeMs, snapExpirationTimeMs,
  //                                               snapCreationTimeMs, wasRewatched}]))    -> the friend sees you viewed it
  //   friendStories.setFriendStorySnapWatchState(posterIdObj, snapId, {...})                 -> the ring turns grey here
  // Both helpers are module-private names, so they're found from the module's own source text.
  let storyReceiptCache;
  function localExport(src, localName) {
    const m = new RegExp("[{,]([\\w$]+):\\(\\)=>" + localName.replace(/\$/g, "\\$") + "[,}]").exec(src);
    return m && m[1];
  }
  function storyReceiptHelpers() {
    if (storyReceiptCache !== undefined) return storyReceiptCache;
    storyReceiptCache = null;
    safe("story-receipts", () => {
      const factories = webpackRequire && webpackRequire.m;
      for (const id of Object.keys(factories || {})) {
        const src = String(factories[id]);
        if (!src.includes("read_receipts_batch_size")) continue;
        const sendName = (/(?:const |,)([\w$]+)=\(0,[\w$]+\.[\w$]+\)\(\{func:async\(\.\.\.e\)=>\{[^]{0,120}read_receipts_batch_size/.exec(src) || [])[1];
        const buildName = (/function ([\w$]+)\(e,t\)\{const n=\(0,[\w$]+\.[\w$]+\)\(e\),i=\[\];for\(const e of t\)i\.push\(\{snapId:e\.snapId,viewerUserId/.exec(src) || [])[1];
        const exp = webpackRequire(id);
        const send = sendName && exp[localExport(src, sendName)], build = buildName && exp[localExport(src, buildName)];
        if (typeof send === "function" && typeof build === "function") { storyReceiptCache = { send, build }; return; }
      }
      trail("story-receipts", "helpers not found", "error");
    });
    return storyReceiptCache;
  }
  // =====================================================================================================
  // Calls. Snapchat Web's own calling engine (main.js, module with "calling_outgoing_call_"): start / join / end /
  // mute / camera are module-private functions, found from the module's source text like the story receipts are.
  //   start(conversation, video, source)  join(conversation, video, source)  end(conversationIdKey)
  //   mute: setAudio(enabled)             camera(sessionRecordId, on)
  // Live state: state.talk.sessions (Map conversationIdKey -> {id, sessionState: {localParticipant: {callState},
  // remoteParticipants: Map}}), media: state.media.remote.videoStreams / audioStreams, state.media.local.
  // Ghost draws the call itself; this side puts the MediaStreams into <video>/<audio> elements inside Ghost's
  // (open) shadow root, because MediaStream objects can't be handed across to Ghost's own script world.
  // =====================================================================================================
  const CALL_STATES = ["none", "outgoing", "incoming", "answered", "incall"];
  let callFnCache;
  function callFns() {
    if (callFnCache !== undefined) return callFnCache;
    callFnCache = null;
    safe("call-fns", () => {
      const factories = webpackRequire && webpackRequire.m;
      for (const id of Object.keys(factories || {})) {
        const src = String(factories[id]);
        if (!src.includes("calling_outgoing_call_") || !src.includes("calling.join_call.from.")) continue;
        const name = (re) => (re.exec(src) || [])[1];
        const names = {
          start: name(/async function ([\w$]+)\(e,t,n\)\{const i=t\?"video":"audio";[\w$]+\(\)\.increment\(\{metricsName:`calling_outgoing_call_/),
          join: name(/async function ([\w$]+)\(e,t,n\)\{const i=t\?"video":"audio";[\w$]+\(\)\.increment\(\{metricsName:`calling\.join_call\.from\./),
          end: name(/function ([\w$]+)\(e\)\{[\w$]+\(e,"endCall"\)/),
          mute: name(/\}function ([\w$]+)\(e\)\{const\[t,n\]=\(0,[\w$]+\.[\w$]+\)\([\w$]+\.M\.getState\(\)\);n\(e\),[\w$]+\(\)\}/),
          camera: name(/function ([\w$]+)\(e,t\)\{[\w$]+\(e,t\),[\w$]+\(\)\}/),
        };
        const exp = webpackRequire(id);
        const fns = {};
        for (const [k, local] of Object.entries(names)) { const key = local && localExport(src, local); fns[k] = key ? exp[key] : null; }
        const missing = Object.keys(fns).filter((k) => typeof fns[k] !== "function");
        if (missing.length) trail("calls", "missing " + missing.join(","), "error");
        callFnCache = fns;
        return;
      }
      trail("calls", "calling module not found", "error");
    });
    return callFnCache;
  }
  function talkSessions() { const t = (state() || {}).talk; return (t && t.sessions instanceof Map) ? t.sessions : new Map(); }
  function sessionFor(conversationId) {
    for (const [k, v] of talkSessions()) if (idOf(k) === conversationId || idOf(v && v.conversationId) === conversationId) return { key: k, rec: v };
    return null;
  }
  function callConversation(conversationId) {
    const entry = conversationEntry(conversationId);
    if (entry && entry.conversation) return entry.conversation;
    const f = (messaging().feed || {})[conversationId];
    if (f) return { conversationId: convIdObj(conversationId), conversationType: f.conversationType, participants: f.participants || [] };
    throw new Error("chat not loaded");
  }
  let callIntentUntil = 0; // start/answer in flight: the session may not be in the store yet, keep the real mic promised
  function wantMic(on) { window.__ghostWantsMic = !!on; if (on) callIntentUntil = Date.now() + 20000; else callIntentUntil = 0; } // camhook.js: calls get the real microphone, not the silent stand-in
  function callsSnapshot() {
    const media = (state() || {}).media || {};
    const local = media.local || {};
    const out = [];
    for (const [k, rec] of talkSessions()) {
      const ss = rec && rec.sessionState;
      if (!ss) continue;
      const lp = ss.localParticipant || {};
      const remote = [];
      const rp = ss.remoteParticipants;
      if (rp && typeof rp.entries === "function") for (const [uid, p] of rp.entries()) {
        const mps = p && p.mediaPublishStatus;
        remote.push({ userId: idOf(uid) || idOf(p && p.snapchatUserId) || String(uid), state: CALL_STATES[p && p.callState] || "none",
          video: !!(mps && mps.video && !mps.video.isPaused), audio: !!(mps && mps.audio && mps.audio.type !== "muted") });
      }
      out.push({ conversationId: idOf(k) || idOf(rec.conversationId), sessionId: rec.id, state: CALL_STATES[lp.callState] || "none",
        isGroup: rec.conversationType === 1, remote, startedAt: rec.createdTimestamp ? Date.now() - (performance.now() - rec.createdTimestamp) : Date.now(),
        micOn: !!(local.audio && local.audio.enabled), cameraOn: !!(local.video && local.video.enabled && local.cameraEnabledPrefs && local.cameraEnabledPrefs.size) });
    }
    return out;
  }
  // Snapchat grabs "the microphone" long before any call, and the app hands that early request a silent
  // stand-in (camhook.js, so music isn't interrupted). ensureAudioForCall() then reuses that silent stream and
  // the other side hears nothing (device 2026-09-27). So: drop a stand-in / dead stream and have Snapchat open
  // the real mic right before the call starts or is answered; release it when the call is over.
  async function ensureRealMic() {
    wantMic(true);
    const L = ((state() || {}).media || {}).local;
    if (!L) return;
    const st = L.audio && L.audio.stream;
    const lazy = window.__dgCam && window.__dgCam.lazyIds;
    const bad = st && st.getAudioTracks().some((t) => (lazy && lazy.has(t.id)) || t.readyState === "ended");
    if (bad && typeof L.disposeAudio === "function") L.disposeAudio();
    if (typeof L.ensureAudioForCall === "function") await L.ensureAudioForCall();
    const now = ((state() || {}).media || {}).local;
    const real = now && now.audio && now.audio.stream && now.audio.stream.getAudioTracks().every((t) => !(lazy && lazy.has(t.id)));
    trail("calls", "mic " + (real ? "real" : "NOT real") + ", enabled " + !!(now && now.audio && now.audio.enabled));
  }
  let hadCall = false;
  let lastCallsSig = "";
  function checkCalls() {
    const calls = callsSnapshot();
    const active = calls.filter((c) => c.state !== "none" || c.remote.some((r) => r.state === "outgoing"));
    if (active.length) { callIntentUntil = 0; hadCall = true; } // the call is real now; it keeps the mic while it lasts
    else if (hadCall && Date.now() > callIntentUntil) { // call over: give the microphone back (iOS stops "recording")
      hadCall = false;
      safe("mic-release", () => { const L = state().media.local; if (L && typeof L.disposeAudio === "function") L.disposeAudio(); });
    }
    else if (Date.now() > callIntentUntil) window.__ghostWantsMic = false;
    const sig = JSON.stringify(active.map((c) => [c.conversationId, c.state, c.micOn, c.cameraOn, c.remote.map((r) => [r.userId, r.state, r.video, r.audio])]));
    if (sig !== lastCallsSig) { lastCallsSig = sig; post({ ghost: "event", type: "calls", data: { calls: active } }); }
    attachCallMedia(active.length > 0);
  }
  // media elements, kept stable by stream key so nothing re-renders mid-call
  function attachCallMedia(on) {
    const host = document.getElementById("ghost-app-root");
    const root = host && host.shadowRoot;
    if (!root) return;
    const remoteBox = root.querySelector(".gh-call-remote"), localBox = root.querySelector(".gh-call-local"), audioBox = root.querySelector(".gh-call-audio");
    if (!remoteBox || !localBox || !audioBox) return;
    const media = (state() || {}).media || {};
    const remote = (on && media.remote) || { videoStreams: {}, audioStreams: {} };
    const sync = (box, streams, tag, extra) => {
      const want = new Map(Object.entries(streams || {}).filter(([, s]) => s && typeof s.getTracks === "function"));
      for (const node of [...box.children]) if (!want.has(node.dataset.key) || want.get(node.dataset.key) !== node.srcObject) { node.srcObject = null; node.remove(); }
      for (const [key, stream] of want) {
        if ([...box.children].some((n) => n.dataset.key === key)) continue;
        const m = document.createElement(tag);
        m.dataset.key = key; m.autoplay = true; m.setAttribute("playsinline", ""); m.playsInline = true;
        if (extra) extra(m);
        m.srcObject = stream;
        box.appendChild(m);
        m.play().catch(() => {});
      }
      box.dataset.count = String(box.children.length);
    };
    sync(remoteBox, remote.videoStreams, "video", (v) => { v.muted = true; v.setAttribute("autopictureinpicture", ""); }); // (sound comes from the audio elements; PiP when Ghost goes to the background)
    sync(audioBox, remote.audioStreams, "audio");
    const lv = on && media.local && media.local.video && media.local.video.stream;
    sync(localBox, lv ? { local: lv } : {}, "video", (v) => { v.muted = true; });
  }

  function uuidObj(str) { return { id: Uint8Array.from(String(str).replace(/-/g, "").match(/../g).map((x) => parseInt(x, 16))), str }; }
  const shareCache = new Map();
  let lastStory = null;
  let storyThumbFnCache;
  function storyThumbFn() {
    if (storyThumbFnCache !== undefined) return storyThumbFnCache;
    storyThumbFnCache = null;
    safe("story-thumb-fn", () => {
      const factories = webpackRequire && webpackRequire.m;
      if (!factories) return;
      for (const id of Object.keys(factories)) {
        if (!String(factories[id]).includes("friend_stories_sync_resolve_thumb_failure")) continue;
        const exp = webpackRequire(id);
        for (const k of Object.keys(exp)) {
          const fn = safe("story-thumb-export", () => exp[k], null);
          if (typeof fn === "function" && String(fn).includes("friend_stories_sync_resolve_thumb_failure")) { storyThumbFnCache = fn; return; }
        }
      }
      trail("story-thumb", "resolver not found", "error");
    });
    return storyThumbFnCache;
  }
  let mediaResolverFn;
  function mediaResolver() {
    if (mediaResolverFn !== undefined) return mediaResolverFn;
    mediaResolverFn = null;
    safe("media-resolver", () => {
      const factories = webpackRequire && webpackRequire.m;
      if (!factories) return;
      for (const id of Object.keys(factories)) {
        const src = String(factories[id]);
        if (!src.includes("media_resolve_missing_source") || !src.includes("No content object and no localCacheKey")) continue;
        const exp = webpackRequire(id);
        for (const k of Object.keys(exp)) {
          const fn = safe("media-resolver-export", () => exp[k], null);
          if (typeof fn === "function") { mediaResolverFn = fn; trail("media-resolver", "found in module " + id + " export " + k); return; }
        }
      }
      trail("media-resolver", "not found", "error");
    });
    return mediaResolverFn;
  }

  // Snapchat's own field-rename from a raw wire mediaReference (messageContent.remoteMediaReferences[].mediaReferences[],
  // device sample 2026-09-26: mediaReferenceKey/contentObject/mediaListId/mediaType) to the {mediaListId,
  // contentObject, localCacheKey, mediaType} shape the resolver above reads (module search "mediaReferenceKey":
  // `function O(e){return d.cP.fromPartial({mediaListId:e.mediaListId.toString(),contentObject:e.contentObject,
  // localCacheKey:e.mediaReferenceKey,mediaType:e.mediaType})}`). Reimplemented here (not called from the bundle)
  // because it's a pure field rename with no crypto/protobuf-default behaviour the resolver actually depends on -
  // device-verified: the resolver only reads resolvedUrl/contentObject/localCacheKey off the object we hand it.
  function mediaReferenceFromRaw(ref) {
    if (!ref) return null;
    return {
      mediaListId: ref.mediaListId != null ? String(ref.mediaListId) : "0",
      contentObject: ref.contentObject,
      localCacheKey: ref.mediaReferenceKey,
      mediaType: ref.mediaType,
    };
  }

  // Mirrors Snapchat's own snapdoc -> mediaInfos builder (module search "snapdoc_media_missing_list_id"): for each
  // playback layer, match its mediaId.mediaListId against this message's remoteMediaReferences entry (by listId,
  // else the first available - same fallback the bundle uses), pairing it with the layer's own encryptionInfo/
  // dimensions/zipped/hasSound. We skip the bundle's own enum translation for `mediaMetadata.type` (protobuf
  // MediaType -> internal MediaType) since - verified by reading the resolver - that field only affects the
  // COSMETIC `mediaLayerType` label it returns, never which bytes get fetched/decrypted; we determine image vs.
  // video vs. audio ourselves from the resolved Blob's sniffed MIME type instead (device-verified below).
  function mediaInfosFromSnapdoc(snapdoc, remoteMediaRef) {
    const refs = ((remoteMediaRef && remoteMediaRef.mediaReferences) || []).map(mediaReferenceFromRaw).filter(Boolean);
    const layers = (snapdoc && snapdoc.playback && snapdoc.playback.playbackLayers) || [];
    const out = [];
    for (const layer of layers) {
      const media = layer && layer.layer && layer.layer.$case === "media" ? layer.layer.media : null;
      if (!media) continue;
      const listId = media.mediaId && media.mediaId.mediaListId != null ? String(media.mediaId.mediaListId) : undefined;
      const ref = (listId !== undefined && refs.find((r) => r.mediaListId === listId)) || refs[0];
      if (!ref) continue;
      out.push({
        mediaMetadata: {
          encryptionInfo: media.encryptionInfoV2 || media.encryptionInfoV1,
          dimensions: media.dimensions,
          hasSound: !!((snapdoc.playback.playbackCharacteristics && snapdoc.playback.playbackCharacteristics.hasSound) || media.hasSound),
          zipped: !!media.zipped,
        },
        mediaReference: ref,
      });
    }
    // Fallback (no playback-layer metadata, or this build's snapdoc shape changed): resolve the plain first
    // reference the same way Snapchat's own single-media path (voice notes / saved snaps, TW.gw) does.
    if (!out.length && refs[0]) out.push({ mediaMetadata: { zipped: false }, mediaReference: refs[0] });
    return out;
  }

  // Runs one or more {mediaMetadata, mediaReference} pairs through the real resolver and normalises the result to
  // MediaRef[] (API.md). `hintType` is used when we already know the kind from the message (voice notes are always
  // audio); otherwise the type is read off the resolved Blob's own MIME (device-verified: the resolver's dataUrl is
  // `URL.createObjectURL(new Blob([bytes], {type: <sniffed from magic bytes>}))`, so a real chat photo/video comes
  // back already correctly labelled "image/..." or "video/..." without us touching any enum).
  async function resolveMediaInfos(mediaInfos, hintType, context) {
    const V = mediaResolver();
    if (!V || !mediaInfos || !mediaInfos.length) return [];
    const out = [];
    for (const mi of mediaInfos) {
      let layers;
      try { layers = await V(mi, context || "ghost"); } catch (e) { trail("load-media", e, "error"); continue; }
      const list = layers || [];
      for (let li = 0; li < list.length; li++) {
        const layer = list[li];
        if (!layer || !layer.dataUrl) continue;
        // a zipped snap comes back as [media, overlay]: the overlay (caption/drawing, a transparent image) belongs ON
        // the media, not after it as a second item
        if (li > 0 && out.length) { out[out.length - 1].overlay = layer.dataUrl; continue; }
        let type = hintType;
        if (!type) {
          try {
            const blob = await fetch(layer.dataUrl).then((r) => r.blob());
            if (blob.type.startsWith("video")) type = "video";
            else if (blob.type.startsWith("image")) type = "image";
            else if (blob.type.startsWith("audio")) type = "audio";
          } catch (e) { trail("sniff-media", e, "error"); }
          if (!type) type = layer.mediaLayerType === "VideoLayer" ? "video" : "image";
        }
        out.push({ type, url: layer.dataUrl, width: layer.width || undefined, height: layer.height || undefined, durationSec: undefined });
      }
    }
    return out;
  }

  const CASE_KIND = { text: "text", snapReply: "text", storyReply: "text", botResponse: "text", chatMedia: "chat-media", externalMedia: "chat-media",
    externalMediaMessageContent: "chat-media", snapdoc: "snap", snap: "snap", snapMessageContent: "snap", tinySnap: "snap", note: "audio", voiceNote: "audio",
    sticker: "sticker", creativeToolItem: "gif", share: "share", storyShare: "share", spotlightShare: "share", url: "text" };
  let gifSampled = false;
  // Snapchat's reaction set (main.js enum with LOVE=1 ... SALUTE=14)
  const REACTION_EMOJI = { 1: "\u2764\uFE0F", 2: "\uD83D\uDE02", 3: "\uD83D\uDD25", 4: "\uD83D\uDC4D", 5: "\uD83D\uDC4E", 6: "\uD83D\uDE22", 7: "\uD83D\uDE2E",
    8: "\u2753", 9: "\uD83D\uDE18", 10: "\uD83D\uDE2D", 11: "\uD83D\uDC80", 12: "\u2757", 13: "\uD83D\uDE21", 14: "\uD83E\uDEE1" };
  // message ids cross to the UI as strings; Snapchat's Map keys are bigints
  function findRaw(map, messageId) {
    if (!map || typeof map.entries !== "function") return undefined;
    const direct = map.get(messageId);
    if (direct) return direct;
    for (const [k, v] of map.entries()) if (String(k) === String(messageId)) return v;
    return undefined;
  }
  function realKey(map, messageId) {
    if (!map || typeof map.keys !== "function") return messageId;
    for (const k of map.keys()) if (String(k) === String(messageId)) return k;
    return messageId;
  }
  // Status lines (calls, screenshots, renames, joins, streaks). Field names from Snapchat's own status-message proto
  // (main.js module with "SCREEN_SHOT"/"CALL" enums): call = {callStatus: STARTED0 ENDED1 LEFT2 JOINED3 MISSED4,
  // callType: AUDIO0 VIDEO1, userId, callDuration}; screenshot = {capturingUser, captureType: SCREEN_SHOT0 RECORD1};
  // rename = {oldName, newName}; group = {statusChanges: [{affectedUser, statusChange: ADDED0 CREATED1 LEFT2}]}.
  function describeStatus(sm, senderId) {
    const me = meId();
    const who = (id) => { const u = idOf(id); return !u ? "Someone" : u === me ? "You" : ((personFor(u) || {}).name || "Someone").split(" ")[0]; };
    const find = (o, pred, depth) => {
      if (!o || typeof o !== "object" || depth < 0) return null;
      if (pred(o)) return o;
      for (const k of Object.keys(o)) { const r = find(o[k], pred, depth - 1); if (r) return r; }
      return null;
    };
    const call = find(sm, (o) => "callStatus" in o && "callType" in o, 5);
    if (call) {
      const kind = toNum(call.callType) === 1 ? "video call" : "voice call";
      const Kind = kind[0].toUpperCase() + kind.slice(1);
      const actor = who(call.userId || senderId);
      const dur = Math.round(toNum(call.callDuration) / 1000); // milliseconds (a 52 s call = 52000; device 2026-09-27)
      const len = dur > 0 ? (dur >= 3600 ? Math.floor(dur / 3600) + " h " + Math.floor((dur % 3600) / 60) + " min" : dur >= 60 ? Math.round(dur / 60) + " min" : dur + " sec") : "";
      switch (toNum(call.callStatus)) {
        case 4: return { kind: "call", text: "Missed " + kind, missed: true };
        case 0: return { kind: "call", text: actor === "You" ? "You started a " + kind : actor + " started a " + kind };
        case 1: return { kind: "call", text: len ? Kind + " · " + len : Kind + " ended" };
        case 2: return { kind: "call", text: actor + " left the call" };
        case 3: return { kind: "call", text: actor + " joined the call" };
      }
      return { kind: "call", text: Kind };
    }
    const cap = find(sm, (o) => "captureType" in o && ("capturingUser" in o || "capturingUserInfo" in o), 5);
    if (cap) return { kind: "system", text: who(cap.capturingUser || senderId) + (toNum(cap.captureType) === 1 ? " screen-recorded!" : " took a screenshot!") };
    const ren = find(sm, (o) => "newName" in o && "oldName" in o, 5);
    if (ren) return { kind: "system", text: who(ren.initiatingUserId || senderId) + (ren.newName ? " named the group \u201c" + ren.newName + "\u201d" : " removed the group name") };
    const grp = find(sm, (o) => Array.isArray(o.statusChanges), 5);
    if (grp && grp.statusChanges.length) {
      const c0 = grp.statusChanges[0];
      const st = toNum(c0.statusChange);
      return { kind: "system", text: st === 1 ? who(grp.initiatingUser || senderId) + " created the group" : st === 2 ? who(c0.affectedUser) + " left the group" : who(grp.initiatingUser || senderId) + " added " + grp.statusChanges.map((x) => who(x.affectedUser)).join(", ") };
    }
    const streak = find(sm, (o) => "streakStatus" in o, 5);
    if (streak) { const st = toNum(streak.streakStatus); return { kind: "system", text: st === 2 ? "\uD83D\uDD25 Streak ended" : st === 3 ? "\uD83D\uDD25 Streak restored" : "\uD83D\uDD25 Streak started" }; }
    const saved = find(sm, (o) => "messageType" in o && "userId" in o && Object.keys(o).length <= 3, 5);
    // {userId, messageType: CHAT 1 / SNAP 2} is Snapchat's "deleted" notice (what it leaves behind after Delete)
    if (saved) return { kind: "system", text: who(saved.userId || senderId) + (toNum(saved.messageType) === 2 ? " deleted a Snap" : " deleted a chat") };
    return { kind: "system", text: "Chat update" };
  }

  function toMessage(conversationId, id, raw) {
    if (!raw) return null;
    const mc = raw.messageContent || {};
    const decoded = decodeContent(mc);
    const c = decoded && decoded.content;
    const kase = c && c.$case;
    let kind = CASE_KIND[kase] || (mc.snapDisplayInfo ? "snap" : "unknown");
    let media;
    let text;
    if (kase === "sticker") {
      // main.js sticker renderer: included Bitmoji stickers have stickerId "comicId:?:avatarId[:friendAvatarId]" and are
      // drawn from https://cf-st.sc-cdn.net/3d/render/<comicId>-<avatarId>[-<friendAvatarId>]-v1.webp?scale=1&ua=2
      // (Snapchat's own host, so the page lets it load); emoji stickers are just the emoji
      const st = c.sticker && c.sticker.sticker;
      if (st && st.$case === "included" && st.included && typeof st.included.stickerId === "string") {
        const p = st.included.stickerId.split(":");
        if (p.length >= 3) media = [{ type: "image", url: "https://cf-st.sc-cdn.net/3d/render/" + [p[0], p[2], p[3]].filter(Boolean).join("-") + "-v1.webp?scale=1&ua=2" }];
      } else if (st && st.$case === "emoji") { kind = "text"; text = st.emoji; }
      // st.$case "custom": a custom sticker whose file is a normal media reference - loaded via loadMedia
    }
    if (kase === "note") {
      // content.note.note = {$case: "audio", audio: {note: {mediaDurationMs, ...}}} (main.js voice-note encoder,
      // search '$case:"note",note:{note:{$case:"audio"'); "video" = video notes, which Snapchat Web can't play either
      const nn = c.note && c.note.note;
      const meta = nn && nn.$case === "audio" && nn.audio && nn.audio.note;
      if (meta) media = [{ type: "audio", durationSec: toNum(meta.mediaDurationMs) / 1000 || undefined }];
      else if (nn && nn.$case === "video") kind = "unknown";
    }
    if (kase === "share" || kase === "storyShare" || kase === "spotlightShare") {
      const sh = c.share && c.share.share;
      const sc = sh && sh.$case;
      text = sc === "spotlightStoryShare" || kase === "spotlightShare" ? "Spotlight" : sc === "story" || kase === "storyShare" ? "Story" : sc === "legacyDiscover" ? "Discover" : "Shared";
    }
    if (kase === "statusMessage") {
      const st = safe("status-text", () => describeStatus(c.statusMessage, idOf(raw.senderId)), { kind: "system", text: "Chat update" });
      kind = st.kind; text = st.text;
    }
    if (kase === "text") text = c.text && c.text.text;
    else if (kase === "snapReply") text = c.snapReply && (c.snapReply.text || (c.snapReply.content && c.snapReply.content.text));
    else if (kase === "storyReply") text = c.storyReply && c.storyReply.text;
    else if (kase === "url") text = c.url && (c.url.url || c.url.text);
    const ent = kase === "creativeToolItem" && c.creativeToolItem && c.creativeToolItem.item && c.creativeToolItem.item.entity && c.creativeToolItem.item.entity.entityOneof;
    if (ent && ent.$case === "bitmojiSticker") {
      // Bitmoji sticker from the phone app (main.js, search 'function T6({bitmojiSticker'): the item's metadata has a
      // ready contentUrl, else the comic render from comicId + avatar ids (same cf-st.sc-cdn.net host as included stickers)
      kind = "sticker";
      const md = c.creativeToolItem.metadata && c.creativeToolItem.metadata.metadataType;
      const bm = md && md.$case === "bitmojiStickerMetadata" ? md.bitmojiStickerMetadata : null;
      const comic = ent.bitmojiSticker && ent.bitmojiSticker.comicId;
      const url = (bm && bm.mediaContent && bm.mediaContent.contentUrl) ||
        (comic && bm && bm.avatarId ? "https://cf-st.sc-cdn.net/3d/render/" + [comic, bm.avatarId, bm.friendAvatarId].filter(Boolean).join("-") + "-v1.webp?scale=1&ua=2" : null);
      if (url) media = [{ type: "image", url }];
    } else if (ent && (ent.$case === "customSticker" || ent.$case === "gfycat")) {
      kind = "sticker"; // file comes via loadMedia (encrypted custom sticker / gfycat bolt object)
    } else if (kase === "creativeToolItem") {
      const it = c.creativeToolItem;
      const json = safe("gif-json", () => JSON.stringify(it, (k, v) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? undefined : v)), "") || "";
      const m = json.match(/giphy[^"]*?\/media\/(?:v1\.[^/"]+\/)?([A-Za-z0-9]{6,64})\//i) || json.match(/"(?:giphyId|gifId|id)"\s*:\s*"([A-Za-z0-9]{10,40})"/);
      kind = /giphy/i.test(json) || m ? "gif" : "sticker";
      if (m) media = [{ type: "image", url: "https://media.giphy.com/media/" + m[1] + "/giphy.webp" }];
      else if (/giphy/i.test(json) && !gifSampled) { gifSampled = true; trail("sample-gif", json.replace(/"[^"]{1,}"/g, (x) => (/giphy|media|url|id/i.test(x) ? x : '"…"')).slice(0, 900)); }
    }
    if (kind === "text" && typeof text !== "string") text = kase ? "" : undefined;
    const md = raw.metadata || {};
    const senderId = idOf(raw.senderId) || idOf(raw.senderUserId);
    const me = meId();
    const reactions = safe("message-reactions", () => (md.reactions || []).map((r) => {
      const rc = r.reaction && r.reaction.reactionContent;
      const emoji = (rc && (rc.emoji || REACTION_EMOJI[toNum(rc.intentionType)])) || "\u2764\uFE0F";
      return { emoji, from: personFor(idOf(r.userId)) || { id: "?", name: "?" } };
    }), []);
    const others = (list) => (list || []).map(idOf).filter((x) => x && x !== senderId);
    return {
      id: String(id !== undefined ? id : raw.descriptor && raw.descriptor.messageId),
      conversationId,
      from: personFor(senderId) || { id: senderId || "unknown", name: "Unknown" },
      ts: toNum(md.createdAt) || Date.now(),
      kind,
      text: text || (kind === "unknown" && kase ? "[" + kase + "]" : text),
      media, // chat photos/videos: download/decrypt goes through Snapchat's media manager - next step
      replyTo: mc.quotedMessage ? safe("quoted", () => {
        const q = mc.quotedMessage.content || mc.quotedMessage;
        const qd = decodeContent(q);
        const qc = qd && qd.content;
        const qtext = qc && (qc.$case === "text" ? qc.text && qc.text.text : qc.$case ? ({ snapdoc: "Snap", chatMedia: "Photo", externalMedia: "Photo", sticker: "Sticker", note: "Voice note", creativeToolItem: "GIF" }[qc.$case] || undefined) : undefined);
        const qfrom = idOf(q.senderId) || idOf(mc.quotedMessage.senderId);
        return { messageId: String(q.messageId != null ? q.messageId : ""), from: qfrom ? personFor(qfrom) : undefined, text: qtext };
      }, { messageId: "" }) : undefined,
      reactions: reactions.length ? reactions : undefined,
      saved: (md.savedBy || []).length > 0,
      // Snapchat's own rule (main.js, search 'viewedByCurrentUser'): a snap YOU received is opened only when
      // YOUR id is in openedBy (the sender is always in it - that's why every received snap said "Opened");
      // one you sent is opened when anyone else is.
      opened: (me && senderId === me) ? others(md.openedBy).length > 0 : (md.openedBy || []).some((u) => idOf(u) === me),
      replayable: md.playableSnapState === 4 || undefined, // PlayableSnapState VIEWEDREPLAYABLE
      saveable: md.isSaveable === false ? false : undefined,
      snapSound: kind === "snap" ? !!(mc.snapDisplayInfo && mc.snapDisplayInfo.hasAudio) : undefined,
      pending: raw.state === 0 || raw.state === 1 ? undefined : undefined,
      failed: false,
      fromMe: !!(me && senderId === me),
    };
  }

  // Friends/people: state.user.publicUsers is a Map userId -> { user_id, username, display_name, mutable_username,
  // bitmoji_avatar_id, bitmoji_selfie_id? } (main.js: "publicUsers:new Map", readers `.get(userId)`, and the
  // search/friend-picker code reading e.display_name / e.mutable_username). Device run 1 showed every
  // conversation as "Conversation": the old code looked for names inside messaging.conversations, which has none.
  let userIndex = null, userIndexSize = -1;
  const extraUsers = new Map();
  const idObjs = new Map(); // uuid string -> Snapchat's {id, str} object, remembered from the feed
  let ensureFails = 0;
  const wantUsers = new Set(); // ids with no record yet: asked for via user.ensureUsers (what Snapchat does for rows)
  // Snapchat's own lookup (main.js module with `e.user.mutualOutgoingAndBlockedFriends`, `e.user.publicUsers` and
  // `e.user.fetchPublicInfo`): `f = id => state => users.get(id)` over friends, public users, requests and me.
  // Friends are NOT all in publicUsers (device: ~50 "Unknown" rows), so this is tried first.
  let userSelector;
  function snapUserSelector() {
    if (userSelector !== undefined) return userSelector;
    userSelector = null;
    safe("user-selector", () => {
      const factories = webpackRequire && webpackRequire.m, s = state();
      if (!factories || !s) return;
      for (const id of Object.keys(factories)) {
        const src = String(factories[id]);
        if (!src.includes("mutualOutgoingAndBlockedFriends") || !src.includes("fetchPublicInfo") || !src.includes("publicUsers")) continue;
        const exp = webpackRequire(id);
        // pick it by its shape, without calling the others (device run 9: calling every export threw):
        // `e=>t=>e?u(t).get(e):void 0`
        for (const k of Object.keys(exp)) {
          const fn = (() => { try { return exp[k]; } catch (e) { return null; } })();
          const src2 = typeof fn === "function" ? String(fn) : "";
          if (src2.length < 80 && /=>\s*\w+\s*=>/.test(src2) && src2.includes(".get(") && src2.includes("void 0")) {
            userSelector = fn; trail("user-selector", "found in module " + id + " export " + k); return;
          }
        }
      }
      trail("user-selector", "not found", "error");
    });
    return userSelector;
  }
  function publicUser(id) {
    const sel = meId() ? snapUserSelector() : null;
    // its Map may be keyed by the uuid string or by Snapchat's {id, str} object: try both
    let viaSnap = sel && safe("sel-get", () => sel(id)(state()), null);
    if (!viaSnap && sel && idObjs.get(id)) viaSnap = safe("sel-get-obj", () => sel(idObjs.get(id))(state()), null);
    if (viaSnap && typeof viaSnap === "object") {
      const name = firstString(viaSnap.display_name, viaSnap.displayName, viaSnap.display, viaSnap.mutable_username, viaSnap.username);
      if (name) return { id, name, username: firstString(viaSnap.mutable_username, viaSnap.username), avatarUrl: undefined, avatarId: firstString(viaSnap.bitmoji_avatar_id, viaSnap.bitmojiAvatarId),
        bitmojiUrl: bitmojiUrl(firstString(viaSnap.bitmoji_avatar_id, viaSnap.bitmojiAvatarId), firstString(viaSnap.bitmoji_selfie_id, viaSnap.bitmojiSelfieId), firstString(viaSnap.bitmoji_scene_id, viaSnap.bitmojiSceneId)) };
    }
    const s = state();
    const map = s && s.user && s.user.publicUsers;
    if (!id || !map) return null;
    let raw = typeof map.get === "function" ? map.get(id) : map[id];
    if (!raw) {
      if (!userIndex || userIndexSize !== (map.size || 0)) {
        userIndex = new Map(); userIndexSize = map.size || 0;
        const vals = typeof map.values === "function" ? map.values() : Object.values(map);
        for (const v of vals) { const k = v && idOf(v.user_id); if (k) userIndex.set(k, v); }
      }
      raw = userIndex.get(id) || extraUsers.get(id);
    }
    if (!raw) { wantUsers.add(id); return null; }
    const name = firstString(raw.display_name, raw.displayName, raw.display, raw.mutable_username, raw.username);
    return {
      id,
      name: name || id,
      username: firstString(raw.mutable_username, raw.username),
      avatarUrl: undefined,
      bitmojiUrl: bitmojiUrl(firstString(raw.bitmoji_avatar_id, raw.bitmojiAvatarId), firstString(raw.bitmoji_selfie_id, raw.bitmojiSelfieId), firstString(raw.bitmoji_scene_id, raw.bitmojiSceneId)),
      avatarId: firstString(raw.bitmoji_avatar_id, raw.bitmojiAvatarId),
    };
  }
  // Every id in Snapchat's state is an object { id: Uint8Array(16), str: "<uuid>" } (device sample 2026-09-26);
  // participants wrap it again as { participantId: {id, str}, color }.
  const idOf = (p) => {
    if (!p) return undefined;
    if (typeof p === "string") return p;
    if (typeof p.str === "string") return p.str;
    return idOf(p.participantId) || idOf(p.userId) || idOf(p.user_id) || (typeof p.id === "string" ? p.id : undefined);
  };
  const toNum = (v) => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
  // Snapchat's own actions want the id OBJECT, not the string: passing the uuid string made every
  // enterConversation/exitConversation throw "undefined is not an object (evaluating 'e[t+0]')" (it reads the bytes).
  function convIdObj(key) {
    const m = messaging();
    const f = (m.feed || {})[key];
    if (f && f.conversationId && typeof f.conversationId === "object") return f.conversationId;
    const c = (m.conversations || {})[key];
    const cid = c && c.conversation && c.conversation.conversationId;
    return cid && typeof cid === "object" ? cid : key;
  }
  let meIdCache = null;
  function meId() {
    if (meIdCache) return meIdCache;
    const s = state();
    const direct = s && s.auth && (idOf(s.auth.userId) || idOf(s.auth.me && (s.auth.me.userId || s.auth.me.user_id)));
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
      const num = typeof v === "bigint" ? Number(v) : v;
      // (not expiry/deadline fields: those are in the future and sorted a stale chat to the top)
      if (typeof num === "number" && /time|Ts$|Ms$|stamp/i.test(k) && !/expir|deadline/i.test(k) && num > 1e12 && num <= Date.now() + 60e3 && num > best) best = num;
      else if (typeof v === "string" && /time|stamp/i.test(k) && /^\d{13}$/.test(v) && +v > best) best = +v;
      else if (v && typeof v === "object" && !(v instanceof Map) && !/expir|deadline|notification/i.test(k)) best = Math.max(best, newestTimestamp(v, depth - 1));
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
    for (const p of feed.participants || []) { const k = idOf(p); if (k && p && typeof p === "object" && p.id) idObjs.set(k, p); }
    const ids = ((feed.participants) || []).map(idOf).filter(Boolean);
    const others = ids.filter((id) => id !== me);
    const participants = others.map(personFor).filter(Boolean);
    const isGroup = others.length > 1 || feed.conversationType === 1;
    const convRec = entry && entry.conversation;
    const title = firstString(feed.conversationTitle, convRec && convRec.title) || participants.map((p) => p.name).join(", ") || "Conversation";
    const info = feed.displayInfo || {};
    const item = info.feedItem || {};
    const creator = idOf(info.feedItemCreatorId);
    const fromMe = !!(creator && me && creator === me);
    const kindCase = item.$case || ["snap", "chat", "call", "chatMedia", "note"].find((k) => item[k]) || "none";
    const kind = { snap: "snap", chat: "text", call: "call", chatMedia: "chat-media", note: "audio" }[kindCase] || "none";
    const unreadChats = toNum(item.chat && item.chat.unreadChatCount);
    const unread = (info.viewed === false && !fromMe) || unreadChats > 0;
    const sm = feed.streakMetadata;
    const streak = sm && toNum(sm.count) > 0 ? {
      count: toNum(sm.count),
      expiring: toNum(sm.expirationTimestampMs) > 0 && toNum(sm.expirationTimestampMs) - Date.now() < 4 * 3600e3,
    } : undefined;
    let text;
    let kind2 = kind;
    if ((kind === "text" || kind === "call" || kind === "none") && entry && entry.messages && typeof entry.messages.values === "function") {
      let last = null; for (const m of entry.messages.values()) last = m;
      const norm = last && toMessage(key, undefined, last);
      if (norm && norm.kind === "text") text = norm.text;
      else if (norm && (norm.kind === "call" || norm.kind === "system")) { kind2 = "call"; text = norm.text; } // e.g. "Missed video call"
    }
    if (kind === "call" && !text) text = "Call";
    // no text loaded yet (Snapchat only has message text for chats that were opened): say what Snapchat's list says
    if (kind === "text" && !text) text = fromMe ? (info.viewed ? "Opened" : "Delivered") : (unread ? "New Chat" : "Received");
    if (kind === "snap" && !text) text = fromMe ? (info.viewed ? "Opened" : "Delivered") : (unread ? "New Snap" : "Received");
    return {
      id: key,
      title,
      isGroup,
      participants,
      avatarUrl: undefined,
      lastActivityTs: toNum(info.displayTimestamp) || toNum(feed.lastEventUpdateTimestamp) || newestTimestamp(feed, 3) || 0,
      preview: { kind: kind2, text, fromMe, status: info.viewed ? (fromMe ? "opened" : "viewed") : (fromMe ? "delivered" : "received") },
      unreadCount: unread ? Math.max(1, unreadChats) : 0,
      hasUnreadSnap: unread && kind === "snap",
      streak,
      muted: undefined,
      pinned: undefined,
    };
  }
  let messageSampled = false;
  function sampleFirstMessageOnce(key) {
    if (messageSampled) return;
    setTimeout(() => safe("sample-message", () => {
      const entry = (messaging().conversations || {})[key];
      const msgs = entry && entry.messages;
      if (!msgs || typeof msgs.values !== "function" || !msgs.size) return;
      messageSampled = true;
      const first = msgs.values().next().value;
      const text = JSON.stringify({ entryKeys: Object.keys(entry), mapKey: redacted(msgs.keys().next().value, 2), message: redacted(first, 6) });
      for (let i = 0, n = 1; i < Math.min(text.length, 16000); i += 380, n++) trail("sample-message part " + n, text.slice(i, i + 380));
    }), 1500);
  }
  // friends whose records aren't loaded yet: ask Snapchat to fetch them (its list does the same for visible rows)
  setInterval(() => {
    if (!wantUsers.size || !store) return;
    const u = (state() || {}).user;
    if (ensureFails >= 1) return;
    const ids = [...wantUsers].slice(0, 64).map((id) => idObjs.get(id) || id); for (const id of [...wantUsers].slice(0, 64)) wantUsers.delete(id);
    if (u && typeof u.ensureUsers === "function") safe("ensureUsers", () => Promise.resolve(u.ensureUsers(ids)).then((recs) => {
      // it returns the records too: keep them, whether or not they land in publicUsers
      for (const r of Array.isArray(recs) ? recs : []) { const k = r && idOf(r.user_id); if (k) { extraUsers.set(k, r); } }
      emitConversations();
    }).catch((e) => { ensureFails++; trail("ensureUsers", e, "error"); }));
  }, 1200);
  let pages = 0;
  setInterval(() => {
    if (!store || pages >= 30) return;
    const m = messaging();
    if (m.hasNoMoreFeedEntries || m.queryingFeed || typeof m.pageFeed !== "function") return;
    pages++;
    safe("pageFeed", () => m.pageFeed());
  }, 900);
  // Only what Snapchat's own chat list shows (the feed). messaging.conversations also holds other cached chats with
  // no feed entry; those came out nameless ("Conversation") and, with no time, sorted to the very top - the blank
  // rows you had to scroll past (device report 2026-09-27).
  const allConversationIds = () => Object.keys(messaging().feed || {});

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

  const lastMsgRef = new Map(); // conversationId -> the messages Map last sent (Snapchat replaces it on every change)
  // Read receipts, the way Snapchat's own chat pane does it (main.js, search "displayedMessages:p}=(0,G.P)(zi"): every time
  // the open chat's messages change, displayedMessages(conversationId, newest-by-orderKey.descriptor.messageId). Ghost
  // used to send it once on open with the last Map key, before new messages had loaded - so friends' messages stayed
  // unread. Only for the chat on screen, and not while Ghost is in the background.
  const lastDisplayed = new Map();
  let readReceiptsOn = true; // Settings > Privacy > Send Read Receipts
  function markDisplayed(conversationId) {
    if (!readReceiptsOn || document.hidden || !openConversations.has(conversationId)) return;
    const entry = conversationEntry(conversationId);
    const msgs = entry && entry.messages;
    if (!msgs || typeof msgs.values !== "function") return;
    let newest = null;
    for (const m of msgs.values()) if (m && m.descriptor && (!newest || toNum(m.orderKey) > toNum(newest.orderKey))) newest = m;
    const id = newest && newest.descriptor.messageId;
    if (id === undefined || id === null || lastDisplayed.get(conversationId) === String(id)) return;
    const m = messaging();
    if (typeof m.displayedMessages !== "function") return;
    lastDisplayed.set(conversationId, String(id));
    Promise.resolve(m.displayedMessages(convIdObj(conversationId), id)).catch((e) => { lastDisplayed.delete(conversationId); trail("displayed", e, "error"); });
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) for (const id of openConversations) safe("displayed", () => markDisplayed(id)); });

  const emitMessagesFor = throttle((conversationId) => {
    safe("messages-event", () => {
      const entry = (messaging().conversations || {})[conversationId];
      if (!entry) return;
      const ref = entry.messages;
      if (lastMsgRef.get(conversationId) === ref && lastMsgRef.get(conversationId + "#more") === !!entry.hasMoreMessages) return;
      lastMsgRef.set(conversationId, ref); lastMsgRef.set(conversationId + "#more", !!entry.hasMoreMessages);
      const msgs = entry.messages;
      const list = [];
      if (msgs && typeof msgs.entries === "function") {
        for (const [id, m] of msgs.entries()) { const n = toMessage(conversationId, id, m); if (n) list.push(n); }
      }
      list.sort((a, b) => a.ts - b.ts);
      post({ ghost: "event", type: "messages", data: { conversationId, messages: list, hasMore: !!entry.hasMoreMessages } });
      markDisplayed(conversationId);
    });
  }, 150);

  // Typing indicator, best-effort / LOW CONFIDENCE: state.presence.activeConversationInfo (a Map, device-verified
  // 2026-09-27) is presumably conversationId-ish-keyed the same way broadcastTypingActivity/onActiveConversationInfoUpdated
  // suggest, but it was EMPTY on the device this pass (no one was actively typing while testing), so the per-entry
  // field names below are duck-typed guesses, never asserted - see BRIDGE_NOTES.md "typing". Emits nothing rather
  // than a wrong shape; a future device test with someone actually typing should confirm/correct the field names.
  const lastTypingRef = new Map();
  function checkTyping() {
    const info = (state() || {}).presence && (state() || {}).presence.activeConversationInfo;
    if (!info || typeof info.entries !== "function") return;
    for (const [key, val] of info.entries()) {
      if (!val || typeof val !== "object") continue;
      const cid = idOf(key) || idOf(val.conversationId);
      if (!cid || !openConversations.has(cid)) continue;
      // main.js (favicon typing hook): `find(info.typingParticipants, p => p.typingState === "typing")?.userId`
      const tp = val.typingParticipants;
      if (!tp || typeof tp !== "object") continue;
      const parts = Array.isArray(tp) ? tp : typeof tp.values === "function" ? [...tp.values()] : Object.values(tp);
      const typingIds = parts.filter((p) => p && p.typingState === "typing").map((p) => idOf(p.userId)).filter(Boolean);
      const sig = cid + ":" + typingIds.slice().sort().join(",");
      if (lastTypingRef.get(cid) === sig) continue;
      lastTypingRef.set(cid, sig);
      post({ ghost: "event", type: "typing", data: { conversationId: cid, userIds: typingIds } });
    }
  }

  // "Show me in chats": Snapchat's own chat pane does, on mount (main.js, search "createPresenceSession:n}"):
  //   const dispose = presence.createPresenceSession(conversationIdObj);  (returns the cleanup)
  //   presence.presenceSession.onUserAction({type: document visible ? "chatVisible" : "chatHidden"})
  // Ghost never mounts that pane, so nobody saw us in a chat. We do the same calls for the ONE chat open in Ghost.
  // presence.js (hooks) already makes the presence service report the phone, not the laptop.
  let presenceConv = null, presenceCleanup = null;
  function endPresence() {
    const s = safe("presence-get", () => state().presence.presenceSession, null);
    if (s && presenceConv && idOf(s.conversationId) === presenceConv) safe("presence-hide", () => s.onUserAction({ type: "chatHidden" }));
    if (typeof presenceCleanup === "function") safe("presence-dispose", () => presenceCleanup());
    presenceConv = null; presenceCleanup = null;
  }

  // Who else is looking at the chat I have open: Snapchat's presence session (only exists while "Show me in chats"
  // has one open - see setPresence) keeps `state` = [{userId, state: {type: "chat_visible"|"chat_hidden"|"peeking"|...,
  // typingState: {state, activityType}, platform}}] (main.js, search 'sessionStateObservable.pipe'). Emitted as a
  // "here" event only when it changes.
  const HERE_TYPES = new Set(["chat_visible", "using_reply_camera", "viewing_chat_media", "in_game", "peeking"]);
  let lastHereSig = "", lastHereConv = null;
  function checkHere() {
    const sess = (state() || {}).presence && state().presence.presenceSession;
    const cid = sess ? idOf(sess.conversationId) : presenceConv;
    const users = [];
    for (const e of (sess && Array.isArray(sess.state) ? sess.state : [])) {
      const st = e && e.state;
      if (!st || !HERE_TYPES.has(st.type)) continue;
      const uid = idOf(e.userId);
      if (!uid || uid === meId()) continue; // our own entry (Ghost is in the session too)
      const ts = st.typingState && st.typingState.state;
      users.push({ id: uid, state: st.type, platform: st.platform, typing: !!(ts && ts !== "none"), voice: !!(st.typingState && st.typingState.activityType === "voice_note") });
    }
    const sig = (cid || "") + ":" + users.map((u) => u.id + u.state + u.typing).join(",");
    if (sig === lastHereSig) return;
    lastHereSig = sig;
    // left the chat (session gone): clear the old one so nobody stays "here" forever
    if (lastHereConv && lastHereConv !== cid) post({ ghost: "event", type: "here", data: { conversationId: lastHereConv, users: [] } });
    lastHereConv = cid || null;
    if (cid) post({ ghost: "event", type: "here", data: { conversationId: cid, users } });
  }

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
    let lastLoggedIn = loggedIn();
    unsubscribeStore = safe("subscribe", () => store.subscribe(() => {
      const now = loggedIn();
      if (now !== lastLoggedIn) { // login finished (or logged out): tell the UI again
        lastLoggedIn = now;
        trail("login", "logged in: " + now);
        post({ ghost: "event", type: "ready", data: { loggedIn: now, me: meUser() } });
      }
      emitConversations();
      for (const id of openConversations) emitMessagesFor(id);
      safe("typing", checkTyping);
      safe("here", checkHere);
      safe("calls", checkCalls);
    }), null);
    emitConversations();
    post({ ghost: "event", type: "ready", data: { loggedIn: loggedIn(), me: meUser() } });
  }

  function loggedIn() {
    const s = state();
    if (!s) return false;
    // Right after the page loads, Snapchat hasn't finished logging in yet (device run 5: `ready` said logged out,
    // the UI hid itself and never came back). Any of these means a signed-in session:
    return !!safe("loggedIn", () => !!(s.auth && s.auth.authToken && s.auth.authToken.token)
      || Object.keys(messaging().feed || {}).length > 0 || !!messaging().client, false);
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
      if (typeof m.enterConversation === "function") await m.enterConversation(convIdObj(conversationId), type);
      sampleFirstMessageOnce(conversationId);
      const entry = conversationEntry(conversationId);
      // ...and it reports the newest message as seen via displayedMessages(conversationId, messageId) = read receipt,
      // exactly once per open like the real chat screen (only for the chat you actually opened)
      lastDisplayed.delete(conversationId);
      safe("displayed", () => markDisplayed(conversationId));
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
      if (typeof m.exitConversation === "function") await m.exitConversation(convIdObj(conversationId));
      return true;
    },

    async loadOlder(conversationId) {
      requireStore();
      const m = messaging();
      if (typeof m.paginateMessages === "function") await m.paginateMessages(convIdObj(conversationId));
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
      // Replies: Snapchat's own composer passes {messageId: quoted.descriptor.messageId (a BIGINT), initiationType,
      // AnalyticsMessageId} (main.js, search 'initiationType:"MESSAGE_ACTION_MENU"'). Our ids cross as strings, and a
      // string messageId made the send fail silently - map it back to the real message first.
      let replyOpts;
      if (opts && opts.replyToMessageId) {
        const entry = conversationEntry(conversationId);
        const quoted = entry && entry.messages && findRaw(entry.messages, opts.replyToMessageId);
        const realId = (quoted && quoted.descriptor && quoted.descriptor.messageId) ?? realKey(entry && entry.messages, opts.replyToMessageId);
        replyOpts = { messageId: typeof realId === "bigint" ? realId : BigInt(String(realId)), initiationType: "MESSAGE_ACTION_MENU",
          AnalyticsMessageId: (quoted && quoted.messageAnalytics && quoted.messageAnalytics.analyticsMessageId) || "" };
      }
      const cid = convIdObj(conversationId);
      // "@myai": Snapchat parses @username mentions out of the text itself, but My AI only answers when the send is
      // flagged as a bot mention - sendTextMessage's 4th argument (main.js 66836 ue: botMention: flag && /(^|\s)@myai(\s|$)/).
      // Without it My AI replied "I was not able to parse your message".
      const botMention = /(^|\s)@myai(\s|$)/i.test(text);
      await m.sendTextMessage(cid, text, replyOpts, botMention);
      return {};
    },

    async sendMedia(conversationId, blob, opts) {
      requireStore();
      const m = messaging();
      if (typeof m.sendMediaMessage !== "function") throw new Error("sendMediaMessage action missing");
      const file = blob instanceof File ? blob : new File([blob], `ghost.${(opts && opts.kind) || "bin"}`, { type: blob.type });
      // Snapchat's composer: `await sendMediaMessage([conversationId], files)` - a plain ARRAY of conversation ids
      // (main.js, search "message_composer_file_sent_count"). It wraps that as {conversations: ...} itself; passing
      // the wrapped object (as before 2026-09-27) made every photo/GIF send fail.
      await m.sendMediaMessage([convIdObj(conversationId)], [file]);
      return {};
    },

    async sendSnap(conversationIds, blob, opts) {
      requireStore();
      const m = messaging();
      if (typeof m.sendSnap !== "function") throw new Error("sendSnap action missing");
      // Exactly what Snapchat's own camera hands sendSnap (main.js):
      //  - the snap: getSnapToSend() (search 'Not ready to send a snap yet') = {media: Blob, dimensions: {width, height},
      //    mediaType: "Image"|"Video", hasAudio, loopPlayback[, videoCodec, overlayMedia]}  (MediaType values are strings)
      //  - sendSnap(destinations, snap, cameraFeature, onStart, onSuccess, onError, source) - callbacks, errors swallowed
      //  - destinations from the send-to page: {conversations: [idObj], stories: [], phoneNumbers: [], massSnaps: []}
      const video = (opts && opts.kind === "video") || (blob.type && blob.type.startsWith("video"));
      const dimensions = { width: Math.round((opts && opts.width) || 1080), height: Math.round((opts && opts.height) || 1920) };
      const capturedSnap = video
        ? { media: blob, dimensions, mediaType: "Video", hasAudio: opts && opts.hasAudio === false ? false : true, loopPlayback: false, overlayMedia: undefined }
        : { media: blob, dimensions, mediaType: "Image", hasAudio: false, loopPlayback: false };
      const ids = (Array.isArray(conversationIds) ? conversationIds : [conversationIds]).filter((x) => x && x !== "__story__").map(convIdObj);
      const stories = [];
      if (opts && opts.myStory) {
        const h = storyPostHelpers();
        if (!h) throw new Error("posting to your story isn't available");
        stories.push(h.toDest(h.myStory(false)));
      }
      const destinations = { conversations: ids, stories, phoneNumbers: [], massSnaps: [] };
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("snap send timed out")), 110000);
        Promise.resolve(m.sendSnap(destinations, capturedSnap, "LandingPage",
          () => {},                                                          // onSnapSendStart
          () => { clearTimeout(t); resolve(); },                             // onSnapSendSuccess
          () => { clearTimeout(t); reject(new Error("Snapchat couldn't send the snap")); }, // onSnapSendError
          "send_to_page")).catch((e) => { clearTimeout(t); reject(e); });
      });
      return true;
    },

    async react(conversationId, messageId, emoji) {
      requireStore();
      const m = messaging();
      const entry = conversationEntry(conversationId);
      const rawMessage = entry && entry.messages && typeof entry.messages.get === "function" && findRaw(entry.messages, messageId);
      if (emoji == null) {
        if (typeof m.removeReaction !== "function") throw new Error("removeReaction action missing");
        await m.removeReaction(rawMessage || { descriptor: { conversationId, messageId } });
      } else {
        if (typeof m.reactToMessage !== "function") throw new Error("reactToMessage action missing");
        // Verified (main.js, search "reactToMessage:async(n,i,r)"): takes the FULL message object (reads
        // n.descriptor.conversationId / n.descriptor.messageId / n.metadata.reactions itself), not bare
        // ids - so a message we haven't seen yet (not in our local cache) can't be reacted to.
        if (!rawMessage) throw new Error("message not loaded locally, open the conversation first");
        // switching reactions: take the old one off first (Snapchat's own bar does remove + add)
        const me = meId();
        const mineNow = ((rawMessage.metadata && rawMessage.metadata.reactions) || []).find((x) => idOf(x.userId) === me);
        if (mineNow && typeof m.removeReaction === "function") await m.removeReaction(rawMessage);
        const fresh = findRaw(entry.messages, messageId) || rawMessage;
        // Snapchat's reaction bar (main.js, search 'reactionSource:yn.hD.ACTION_MENU'): reactToMessage(message,
        // {intentionType: BigInt(n)}, {metricsMessageType: MEDIA 5, metricsMessageMediaType: NO_MEDIA 0, reactionSource:
        // ACTION_MENU 2}). Its reactions are a fixed set (LOVE 1 ... SALUTE 14); any other emoji goes as {emoji}.
        const INTENT = { "\u2764\uFE0F": 1, "\u2764": 1, "\uD83D\uDE02": 2, "\uD83D\uDD25": 3, "\uD83D\uDC4D": 4, "\uD83D\uDC4E": 5, "\uD83D\uDE22": 6, "\uD83D\uDE2E": 7,
          "\u2753": 8, "\uD83D\uDE18": 9, "\uD83D\uDE2D": 10, "\uD83D\uDC80": 11, "\u2757": 12, "\uD83D\uDE21": 13, "\uD83E\uDEE1": 14 };
        const intent = INTENT[emoji];
        const content = intent ? { intentionType: BigInt(intent) } : { emoji };
        await m.reactToMessage(fresh, content, { metricsMessageType: 5, metricsMessageMediaType: 0, reactionSource: 2 });
      }
      return true;
    },

    // Delete for everyone (only your own messages), as Snapchat Web's own "Delete": updateMessage(conv, id, ERASE 5)
    async deleteMessage(conversationId, messageId) {
      requireStore();
      const m = messaging();
      if (typeof m.updateMessage !== "function") throw new Error("updateMessage action missing");
      const entry = conversationEntry(conversationId);
      await m.updateMessage(convIdObj(conversationId), realKey(entry && entry.messages, messageId), 5);
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
      await m.updateMessage(convIdObj(conversationId), realKey(conversationEntry(conversationId) && conversationEntry(conversationId).messages, messageId), saved ? SAVE : UNSAVE);
      return true;
    },

    // Opening a snap, in the same order as Snapchat's own viewer (main.js, search 'lightbox_media_loaded'):
    // snapDownloadStatusChanged(INITIATED) -> fetch + decrypt -> (SUCCEEDED + startedViewingSnap) or FAILED; and
    // finishedViewingSnap only when you close it (closeSnap). Before, both "viewing" calls went out BEFORE the file
    // was fetched, so the snap got marked opened and then couldn't be loaded.
    async openSnap(conversationId, messageId) {
      requireStore();
      const m = messaging();
      const entry = conversationEntry(conversationId);
      const key = realKey(entry && entry.messages, messageId);
      const raw = entry && entry.messages && findRaw(entry.messages, messageId);
      if (!raw) throw new Error("snap not loaded");
      const cid = convIdObj(conversationId);
      const status = (s) => safe("snap-status", () => typeof m.snapDownloadStatusChanged === "function" && Promise.resolve(m.snapDownloadStatusChanged(s, cid, key)).catch(() => {}), null);
      status(0); // INITIATED
      let media = [];
      try {
        const decoded = decodeContent(raw.messageContent);
        const c = decoded && decoded.content;
        const kase = c && c.$case;
        const snapdoc = kase === "snapdoc" ? c.snapdoc : c && c[kase] && c[kase].snapdoc;
        const rmr = raw.messageContent && raw.messageContent.remoteMediaReferences && raw.messageContent.remoteMediaReferences[0];
        if (snapdoc && rmr) media = await resolveMediaInfos(mediaInfosFromSnapdoc(snapdoc, rmr), undefined, "snap");
      } catch (e) { trail("open-snap", e, "error"); }
      if (!media.length) { status(2); throw new Error("couldn't load this snap"); } // FAILED
      status(1); // SUCCEEDED
      if (typeof m.startedViewingSnap === "function") Promise.resolve(m.startedViewingSnap(cid, key)).catch((e) => trail("snap-started", e, "error"));
      return { media };
    },

    async closeSnap(conversationId, messageId) {
      requireStore();
      const m = messaging();
      const entry = conversationEntry(conversationId);
      const raw = entry && entry.messages && findRaw(entry.messages, messageId);
      if (typeof m.finishedViewingSnap === "function") await m.finishedViewingSnap(convIdObj(conversationId), realKey(entry && entry.messages, messageId), raw);
      return true;
    },

    listStories() {
      // state.friendStories.stories (Map friendIdObj -> {snaps, userMetadata, ...}) - device-verified 2026-09-27
      // (debugShape showed this slice; not visible while reading the bundle offline, hence the earlier "not
      // found" note in BRIDGE_NOTES.md). watchState (Map friendIdObj -> {[snapId]: {viewTimestampMs, ...}}) is
      // what Snapchat's own setFriendStorySnapWatchState/playStory write to when a story is actually watched.
      requireStore();
      const fs = (state() || {}).friendStories;
      if (!fs || typeof fs.stories.entries !== "function") return [];
      const out = [];
      safe("list-stories", () => {
        for (const [key, story] of fs.stories.entries()) {
          const snaps = (story && story.snaps) || [];
          if (!snaps.length) continue;
          const uid = idOf(key);
          if (uid && key && typeof key === "object" && key.id) idObjs.set(uid, key);
          const user = safe("story-user", () => (story.userMetadata && toUser(story.userMetadata)) || personFor(uid), null) || { id: uid || "unknown", name: "Unknown" };
          let latestTs = 0;
          for (const sn of snaps) latestTs = Math.max(latestTs, toNum(sn.creationTimestampMs), toNum(sn.sourceCreationTimestamp), toNum(sn.displayTimestampMs));
          const watch = (fs.watchState.get(key)) || {};
          const viewed = snaps.every((sn) => {
            const w = watch[sn.rawSnapId] || watch[sn.snapClientId] || watch[sn.originalSnapId];
            return !!(w && toNum(w.viewTimestampMs) > 0);
          });
          out.push({ user, count: snaps.length, latestTs, viewed });
        }
      });
      return out.sort((a, b) => b.latestTs - a.latestTs);
    },

    async openStory(userId) {
      requireStore();
      const fs = (state() || {}).friendStories;
      if (!fs || typeof fs.stories.get !== "function") return { items: [] };
      let key = idObjs.get(userId) || userId;
      let story = fs.stories.get(key);
      if (!story) { // Map may be keyed by an {id,str} object identity we don't hold yet: scan by uuid string
        for (const k of fs.stories.keys()) if (idOf(k) === userId) { key = k; story = fs.stories.get(k); break; }
      }
      if (!story) return { items: [] };
      let bundle = safe("story-playback", () => fs.playbackData.get(key), null);
      if (!bundle && typeof fs.updatePlaybackData === "function") {
        // Verified (main.js, search "updatePlaybackData:async()=>"): takes NO arguments, builds `playbackData`
        // purely from `stories`+`watchState` already in memory (plus resolving each story's conversationId) -
        // this is NOT a "mark viewed" write (that's setFriendStorySnapWatchState/playStory, untouched here).
        await safe("update-playback", () => fs.updatePlaybackData(), undefined);
        bundle = safe("story-playback", () => fs.playbackData.get(key), null);
      }
      const items = (bundle && bundle.bundle && bundle.bundle.items) || [];
      // all snaps at once (was one after another - slow to open), each tagged with its snap index for replies
      const perItem = await Promise.all(items.map((item) => resolveMediaInfos((item && item.mediaLayers) || [], undefined, "ghost_story").catch(() => [])));
      const media = [];
      perItem.forEach((list, i) => { for (const m of list) { m.item = i; media.push(m); } });
      lastStory = { userId, key, items, conversationId: (bundle && (bundle.conversationId || (bundle.bundle && bundle.bundle.bundleMetadata && bundle.bundle.bundleMetadata.conversationId))) };
      // Opening only fetches the media (Snapchat preloads it for thumbnails too); a snap counts as watched when the
      // viewer actually shows it - see markStoryViewed.
      return { items: media };
    },

    // Bitmoji sticker. Snapchat Web can't send stickers, so this builds the same message the phone app sends for a
    // Bitmoji sticker (device sample 2026-09-27, contentType 6): content.sticker.sticker = {$case: "included", included:
    // {packId: "bitmoji", stickerId: "comicId:1:myAvatarId[:friendAvatarId]", stickerType: 1 (BITMOJI), ...}}, encoded with
    // Snapchat's own message-content codec and sent through the messaging client exactly like its text sender does
    // (main.js 66836: sendMessageWithContent(destinations, {content, contentType, platformAnalytics, ...}, proxied callbacks)).
    async sendSticker(conversationId, sticker) {
      requireStore();
      const h = sendHelpers();
      const client = messaging().client;
      if (!h.codec || !h.proxy || !client || typeof client.getConversationManager !== "function") throw new Error("sticker sending isn't available");
      const comic = String(sticker && sticker.comicId || "");
      const mine = String(sticker && sticker.myAvatarId || "");
      if (!/^\d+$/.test(comic) || !mine) throw new Error("bad sticker");
      const stickerId = [comic, "1", mine, sticker.friendAvatarId || ""].filter(Boolean).join(":");
      const content = h.codec.encode({ content: { $case: "sticker", sticker: { sticker: { $case: "included", included: {
        packId: "bitmoji", stickerId, animated: false, giphySourceUrl: "", stickerType: 1, highResUri: "", isReaction: false } } } }, decorators: undefined }).finish();
      await sendContent(conversationId, content, 6);
      return true;
    },

    async startCall(conversationId, video) {
      requireStore();
      const f = callFns();
      if (!f || !f.start) throw new Error("calling isn't available");
      await ensureRealMic();
      await f.start(callConversation(conversationId), !!video, "CHAT");
      checkCalls();
      return true;
    },
    async answerCall(conversationId, video) {
      requireStore();
      const f = callFns();
      if (!f || !f.join) throw new Error("calling isn't available");
      await ensureRealMic();
      await f.join(callConversation(conversationId), !!video, "incoming_button");
      checkCalls();
      return true;
    },
    endCall(conversationId) {
      requireStore();
      const f = callFns(), s = sessionFor(conversationId);
      if (s && f && f.end) f.end(s.key);
      wantMic(false);
      setTimeout(checkCalls, 300);
      return true;
    },
    setMicOn(on) { const f = callFns(); if (!f || !f.mute) throw new Error("no mute"); f.mute(!!on); checkCalls(); return true; },
    setCameraOn(conversationId, on) {
      const f = callFns(), s = sessionFor(conversationId);
      if (!f || !f.camera || !s) throw new Error("no call");
      f.camera(s.rec.id, !!on); setTimeout(checkCalls, 300);
      return true;
    },
    flipCamera() { const c = window.__dgCam; if (c && typeof c.flip === "function") { c.flip(); return true; } return false; },

    // "typing…" for the other side, like Snapchat's composer: messaging.sendTypingNotification(conversationIdObj)
    async sendTyping(conversationId) {
      requireStore();
      const m = messaging();
      if (typeof m.sendTypingNotification === "function") await m.sendTypingNotification(convIdObj(conversationId));
      return true;
    },

    // Voice note: Snapchat's own voice-note sender (main.js 66836, the "$case:\"note\"...audio" encoder): it measures
    // the clip, uploads it and sends the note - messaging.sendVoiceNote(destinations, blob, locale).
    async sendVoiceNote(conversationId, blob) {
      requireStore();
      const m = messaging();
      if (typeof m.sendVoiceNote !== "function") throw new Error("voice notes aren't available");
      const file = blob instanceof File ? blob : new File([blob], "voice.m4a", { type: blob.type || "audio/mp4" });
      await m.sendVoiceNote({ phoneNumbers: [], conversations: [convIdObj(conversationId)], stories: [], massSnaps: [] }, file, navigator.language || "en-US");
      return true;
    },

    // Shared Spotlight videos / stories. Snapchat's chat card (main.js p6): spotlight.fetchSingleSpotlightSnap(
    // compositeStoryId) -> {snap, decryptedThumbnailURL, engagementStats, attribution}. The video itself is found in that
    // snap (a mediaUrl, or a media reference + key) and handed to Snapchat's own media resolver.
    async shareInfo(conversationId, messageId) {
      requireStore();
      const entry = conversationEntry(conversationId);
      const raw = entry && entry.messages && findRaw(entry.messages, messageId);
      const d = raw && decodeContent(raw.messageContent);
      const sh = d && d.content && d.content.share && d.content.share.share;
      if (!sh) return { kind: "unknown" };
      if (sh.$case === "legacyAd" || sh.$case === "legacyDiscover") {
        // a shared video that carries its own encrypted file (like chat media): cover = the file itself if it's an image
        const media = sh[sh.$case].media;
        return { kind: sh.$case, video: !!(media && media.type !== 0), creator: sh.$case === "legacyAd" ? "Sponsored" : "Discover" };
      }
      if (sh.$case !== "spotlightStoryShare") return { kind: sh.$case };
      const sp = (state() || {}).spotlight;
      if (!sp || typeof sp.fetchSingleSpotlightSnap !== "function") return { kind: "spotlight" };
      const r = await sp.fetchSingleSpotlightSnap(sh.spotlightStoryShare.compositeStoryId, undefined);
      shareCache.set(conversationId + "|" + messageId, r);
      const at = r && r.attribution, ci = r && r.snap && r.snap.creatorInfo;
      return { kind: "spotlight", thumb: r && (r.decryptedThumbnailURL || r.chatDecryptedThumbnailURL), views: r && r.engagementStats ? String(r.engagementStats.viewCount) : undefined,
        creator: (at && (at.displayName || at.username)) || (ci && (ci.displayName || ci.username)) || undefined };
    },
    async loadShare(conversationId, messageId) {
      requireStore();
      const entry = conversationEntry(conversationId);
      const raw = entry && entry.messages && findRaw(entry.messages, messageId);
      const d = raw && decodeContent(raw.messageContent);
      const sh = d && d.content && d.content.share && d.content.share.share;
      if (sh && (sh.$case === "legacyAd" || sh.$case === "legacyDiscover")) { // (main.js m6: O5(media) + gw(remoteMediaReferences))
        const media = sh[sh.$case].media;
        const rmr = raw.messageContent.remoteMediaReferences && raw.messageContent.remoteMediaReferences[0];
        const ref = rmr && mediaReferenceFromRaw(rmr.mediaReferences && rmr.mediaReferences[0]);
        if (!media || !ref) throw new Error("not available");
        const out = await resolveMediaInfos([{ mediaMetadata: { encryptionInfo: media.encryptionInfo, dimensions: media.dimensions, hasSound: media.hasSound, zipped: !!media.zipped }, mediaReference: ref }], undefined, "chat_share");
        if (!out.length) throw new Error("not available");
        return { media: out };
      }
      let r = shareCache.get(conversationId + "|" + messageId);
      if (!r) { await methods.shareInfo(conversationId, messageId); r = shareCache.get(conversationId + "|" + messageId); }
      if (!r || !r.snap) throw new Error("not available");
      // Spotlight videos come with a plain (unencrypted) copy on Snapchat's CDN: play that (device sample 2026-09-27:
      // snap.mediaInfo.unencryptedFlatVideoUrl / boltWatermarkedVideoUrl on cf-st.sc-cdn.net)
      const mi = r.snap.mediaInfo || {};
      const flat = mi.unencryptedFlatVideoUrl || mi.boltWatermarkedVideoUrl;
      if (flat) return { media: [{ type: "video", url: flat, durationSec: mi.duration || undefined }] };
      if (mi.unencryptedImageUrl) return { media: [{ type: "image", url: mi.unencryptedImageUrl }] };
      // every media-looking object in the snap: {mediaUrl} or {mediaReference} with its key
      const found = [];
      const seen = new Set();
      const walk = (o, depth) => {
        if (!o || typeof o !== "object" || depth > 8 || seen.has(o)) return;
        seen.add(o);
        if ((typeof o.mediaUrl === "string" && o.mediaUrl) || (o.mediaReference && typeof o.mediaReference === "object")) found.push(o);
        for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === "object" && !(v instanceof Uint8Array)) walk(v, depth + 1); }
      };
      walk(r.snap, 0);
      for (const m of found) {
        const ref = m.mediaReference ? (m.mediaReference.contentObject || m.mediaReference.mediaReferenceKey ? mediaReferenceFromRaw(m.mediaReference) : m.mediaReference) : { resolvedUrl: m.mediaUrl };
        if (m.mediaUrl && !ref.resolvedUrl) ref.resolvedUrl = m.mediaUrl;
        const info = { mediaMetadata: { encryptionInfo: m.encryptionInfoV2 || m.encryptionInfoV1 || m.encryptionInfo, dimensions: m.dimensions, hasSound: m.hasSound !== false, zipped: !!m.zipped }, mediaReference: ref };
        const media = await resolveMediaInfos([info], undefined, "spotlight").catch(() => []);
        if (media.length) return { media };
      }
      trail("share", "no playable media in spotlight snap (" + found.length + " candidates)", "error");
      throw new Error("not available");
    },

    // Favourite stickers: a sticker someone sent is kept as its exact message content (for Bitmoji/GIF/custom
    // stickers that's a reference to Snapchat's own copy of the image + its key), and sending a favourite sends that
    // same content again - the way Snapchat's own "favourite sticker" works, nothing re-uploaded.
    stickerContent(conversationId, messageId) {
      requireStore();
      const entry = conversationEntry(conversationId);
      const raw = entry && entry.messages && findRaw(entry.messages, messageId);
      const mc = raw && raw.messageContent;
      if (!mc || !(mc.content instanceof Uint8Array)) throw new Error("sticker not loaded");
      if (mc.remoteMediaReferences && mc.remoteMediaReferences.length) throw new Error("this sticker can't be saved"); // (its image is tied to the original message)
      let bin = ""; for (const b of mc.content) bin += String.fromCharCode(b);
      return { content: btoa(bin), contentType: mc.contentType };
    },
    async sendStickerRaw(conversationId, contentB64, contentType) {
      requireStore();
      const bin = atob(String(contentB64));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await sendContent(conversationId, bytes, contentType || 6);
      return true;
    },

    // Swipe-up reply to a friend's story snap: Snapchat's composer does
    // sendStorySnapTextReplyMessage(conversationId, snapDoc, snapId, text) (main.js, search '"friendStorySnap"===O?.type'),
    // with the snap's itemMetadata.snapDoc / snapId from the story playback bundle and the 1:1 chat with the poster.
    async replyToStory(userId, itemIndex, text) {
      requireStore();
      const m = messaging();
      if (typeof m.sendStorySnapTextReplyMessage !== "function") throw new Error("story reply action missing");
      if (!lastStory || lastStory.userId !== userId) await methods.openStory(userId);
      const item = lastStory && lastStory.items[itemIndex || 0];
      const meta = item && item.itemMetadata;
      if (!meta || !meta.snapDoc) throw new Error("story snap not loaded");
      let conv = lastStory.conversationId;
      if (!conv && typeof m.getOneOnOneConversationId === "function") {
        const me = meId();
        const r = await m.getOneOnOneConversationId([convIdObj(me), idObjs.get(userId) || convIdObj(userId)]);
        const hit = r && typeof r.get === "function" && (r.get(idObjs.get(userId)) || [...r.values()][0]);
        conv = hit && hit.conversationId;
      }
      if (!conv) throw new Error("no chat with this friend");
      await m.sendStorySnapTextReplyMessage(typeof conv === "string" ? convIdObj(conv) : conv, meta.snapDoc, meta.snapId, text);
      return true;
    },

    // Thumbnail for the story rail, exactly like Snapchat's own rail (main.js module with
    // "friend_stories_sync_resolve_thumb_failure"): resolve story.thumbnail with context "friend_stories".
    // mark one snap of the story last opened with openStory as watched (called by the viewer when it's shown)
    async markStoryViewed(userId, itemIndex) {
      requireStore();
      if (!lastStory || lastStory.userId !== userId) return { ok: false, reason: "story not open" };
      const item = lastStory.items[itemIndex || 0];
      const meta = item && item.itemMetadata;
      if (!meta || !meta.snapId) return { ok: false, reason: "no snap" };
      const fs = state().friendStories;
      const posterKey = lastStory.key;
      const me = meId();
      const now = Date.now();
      const watch = safe("story-watch-get", () => fs.watchState.get(posterKey), null) || {};
      const rewatch = !!watch[meta.snapId];
      const h = storyReceiptHelpers();
      if (h && me) {
        const receipts = h.build(uuidObj(me), [{ snapId: meta.snapId, ownerUserId: uuidObj(userId), shareCount: 0, viewTimeMs: now,
          snapExpirationTimeMs: Number(meta.expirationTimestampMs), snapCreationTimeMs: Number(meta.creationTimestampMs), wasRewatched: rewatch }]);
        Promise.resolve(h.send(...receipts)).catch((e) => trail("story-receipt", e, "error"));
      }
      // only mark it watched here if the receipt could actually go out (else the ring would lie)
      if (h && me && typeof fs.setFriendStorySnapWatchState === "function") {
        safe("story-watch-set", () => fs.setFriendStorySnapWatchState(posterKey, meta.snapId, {
          snapId: meta.snapId, readReceiptState: { wasSaved: false, wasScreenshotted: false, wasScreenrecorded: false, wasRewatched: rewatch },
          // Snapchat's own conversion (main.js module 74918 "NA": new BigUint64Array(idObj.id.slice().reverse().buffer)
          // -> {lowBits, highBits}), applied to the poster's own id object from the stories Map
          snapOwnerId: (() => { const bytes = (posterKey && posterKey.id instanceof Uint8Array) ? posterKey.id : uuidObj(userId).id; const t = new BigUint64Array(bytes.slice().reverse().buffer); return { lowBits: t[0].toString(), highBits: t[1].toString() }; })(),
          expirationTimestampMs: String(meta.expirationTimestampMs), storyType: 1 /* USER */, viewTimestampMs: String(now) }));
      }
      return { ok: !!h };
    },

    async storyThumb(userId) {
      requireStore();
      const fs = (state() || {}).friendStories;
      if (!fs || typeof fs.stories.get !== "function") return { url: null };
      let story = fs.stories.get(idObjs.get(userId) || userId);
      if (!story) for (const [k, v] of fs.stories.entries()) if (idOf(k) === userId) { story = v; break; }
      const fn = storyThumbFn();
      if (!story || !fn) return { url: null };
      const url = await fn(story);
      return { url: url || null };
    },

    // ---- chat settings + groups, all Snapchat's own actions (main.js messaging slice) ----------------------
    // notifications: ChatNotificationPreference ALL_MESSAGES 0 / SILENT 1 / MENTION_ONLY 2 (groups)
    async setChatNotifications(conversationId, pref) { requireStore(); await messaging().updateChatNotificationSettings(convIdObj(conversationId), pref); return true; },
    // when chats delete: IMMEDIATE 0 ("after viewing") / TWENTYFOURHOURS 1; source CHAT_SETTINGS 0
    async setRetention(conversationId, mode) { requireStore(); await messaging().updateConversationRetentionMode(convIdObj(conversationId), mode, 0); return true; },
    chatSettings(conversationId) {
      requireStore();
      const entry = conversationEntry(conversationId);
      const conv = entry && entry.conversation;
      const feed = (messaging().feed || {})[conversationId] || {};
      const secs = conv && conv.retentionPolicy ? toNum(conv.retentionPolicy.readRetentionTimeSeconds) : undefined;
      const ns = feed.notificationSettings && feed.notificationSettings.chatNotificationPreference;
      return { retention: secs === undefined ? undefined : secs >= 86400 ? 1 : 0, notifications: ns ? toNum(ns.defaultNotificationPreference) : undefined };
    },
    async clearChat(conversationId) { requireStore(); await messaging().clearConversation(convIdObj(conversationId)); return true; },
    async renameGroup(conversationId, title) { requireStore(); const m = messaging(); await m.updateConversationTitle(convIdObj(conversationId), String(title)); if (typeof m.ensureNetworkConversation === "function") await m.ensureNetworkConversation(convIdObj(conversationId)); return true; },
    async addToGroup(conversationId, userIds) { requireStore(); await messaging().inviteParticipants(convIdObj(conversationId), { snapchatters: userIds.map((u) => idObjs.get(u) || uuidObj(u)), phoneNumbers: [] }); return true; },
    async leaveGroup(conversationId) { requireStore(); await messaging().leaveConversation(convIdObj(conversationId)); return true; },
    async createGroup(userIds, title) {
      requireStore();
      const m = messaging();
      const me = meId();
      const id = await m.createConversationSendTo(userIds.slice(), idObjs.get(me) || uuidObj(me), String(title || ""));
      return { conversationId: idOf(id) || null };
    },
    // replay a snap you already opened (only when Snapchat marks it VIEWEDREPLAYABLE = 4)
    async replaySnap(conversationId, messageId) {
      requireStore();
      const entry = conversationEntry(conversationId);
      await messaging().requestedReplaySnapFromConv(convIdObj(conversationId), realKey(entry && entry.messages, messageId));
      return methods.openSnap(conversationId, messageId);
    },

    async newConversation(userIds) {
      requireStore();
      const m = messaging();
      if (typeof m.createConversationForUsers !== "function") throw new Error("createConversationForUsers action missing");
      const result = await m.createConversationForUsers(userIds, undefined, "GHOST");
      const conversationId = safe("new-conv-id", () => result && (result.conversationId || (result.conversation && result.conversation.conversationId)), undefined);
      return { conversationId: conversationId || null };
    },

    searchFriends(query) {
      // state.user.mutuallyConfirmedFriendIds (Array<{id,str}>) - device-verified 2026-09-27 (debugShape showed
      // it directly; BRIDGE_NOTES.md's earlier pass hadn't located it offline). Resolved through the same
      // publicUser()/personFor() path listConversations already uses.
      requireStore();
      const ids = ((state() || {}).user || {}).mutuallyConfirmedFriendIds || [];
      const q = (query || "").trim().toLowerCase();
      const out = [];
      for (const idObj of ids) {
        const id = idOf(idObj);
        if (!id) continue;
        if (idObj && typeof idObj === "object" && idObj.id) idObjs.set(id, idObj);
        const user = personFor(id);
        if (!user || user.name === "Unknown") continue;
        if (!q || (user.name && user.name.toLowerCase().includes(q)) || (user.username && user.username.toLowerCase().includes(q))) out.push(user);
        if (out.length >= 50) break;
      }
      return out;
    },

    // NEW METHOD (not in the original API.md) - the UI must call this when a chat-media/gif/voice-note message
    // bubble scrolls into view (or on demand for a specific message), then render the returned MediaRef[] the
    // same way an already-populated `media` field is rendered. `openConversation`/`loadOlder`/the `messages`
    // event never populate `media` for these kinds themselves (loading every photo/video/voice-note in a long
    // chat eagerly would be slow and would fetch+decrypt media nobody scrolled to) - `text`/reactions/etc. are
    // still delivered eagerly as before.
    setReadReceipts(on) { readReceiptsOn = on !== false; if (readReceiptsOn) for (const id of openConversations) safe("displayed", () => markDisplayed(id)); return true; },

    // setPresence(conversationId) = I'm looking at this chat; setPresence(null) = I left it / the app is hidden.
    async setPresence(conversationId) {
      requireStore();
      const p = (state() || {}).presence;
      if (!p || typeof p.createPresenceSession !== "function") return { ok: false, reason: "no presence slice" };
      if (presenceConv && presenceConv !== conversationId) endPresence();
      if (!conversationId) return { ok: true };
      if (presenceConv !== conversationId) {
        presenceConv = conversationId;
        presenceCleanup = p.createPresenceSession(convIdObj(conversationId));
      }
      for (let i = 0; i < 40; i++) { // the session is created asynchronously (a server round trip)
        if (presenceConv !== conversationId) return { ok: false, reason: "superseded" };
        const s = state().presence.presenceSession;
        if (s && idOf(s.conversationId) === conversationId) { s.onUserAction({ type: "chatVisible" }); return { ok: true }; }
        await new Promise((r) => setTimeout(r, 250));
      }
      trail("presence", "no session after 10s for " + conversationId, "error");
      return { ok: false, reason: "session timeout" };
    },

    async loadMedia(conversationId, messageId) {
      requireStore();
      const entry = conversationEntry(conversationId);
      const raw = entry && entry.messages && findRaw(entry.messages, messageId);
      if (!raw) throw new Error("message not loaded locally, open the conversation first");
      const mc = raw.messageContent || {};
      const decoded = decodeContent(mc);
      const c = decoded && decoded.content;
      const kase = c && c.$case;
      if (kase === "externalMedia" || kase === "chatMedia" || kase === "externalMediaMessageContent") {
        const snapdocs = (c.externalMedia && c.externalMedia.snapdoc) || [];
        const rmrs = mc.remoteMediaReferences || [];
        const media = [];
        for (let i = 0; i < snapdocs.length; i++) {
          const infos = mediaInfosFromSnapdoc(snapdocs[i], rmrs[i]);
          for (const m of await resolveMediaInfos(infos, undefined, "ghost_chat_media")) media.push(m);
        }
        return { media };
      }
      const ent = kase === "creativeToolItem" && c.creativeToolItem && c.creativeToolItem.item && c.creativeToolItem.item.entity && c.creativeToolItem.item.entity.entityOneof;
      if (ent && ent.$case === "customSticker") {
        // exactly Snapchat's I6 (main.js, search 'custom_sticker'): import the AES key+iv, download+decrypt the bolt
        // object, unzip if it's a media~ bundle, show as a blob
        const cs = ent.customSticker, bolt = cs.mediaContent && cs.mediaContent.contentBoltObject;
        const h = stickerHelpers();
        if (!bolt || !h.importKey || !h.download) return { media: [] };
        const enc = new TextEncoder();
        const key = await h.importKey(enc.encode(cs.encKey), enc.encode(cs.encIv));
        const buf = await h.download(bolt, "custom_sticker", key);
        const z = h.unzip ? await h.unzip(buf) : null;
        const url = URL.createObjectURL(new Blob([new Uint8Array(z ? z.mediaArrayBuffer : buf)]));
        return { media: [{ type: "image", url, width: cs.width || undefined, height: cs.height || undefined }] };
      }
      if (ent && ent.$case === "gfycat") {
        const a = ent.gfycat.mediaAssets && ent.gfycat.mediaAssets[0];
        const bolt = a && a.mediaContent && a.mediaContent.contentBoltObject;
        const h = stickerHelpers();
        if (!bolt || !h.resolveBolt) return { media: [] };
        const url = await h.resolveBolt(bolt, "gfycat_stickers");
        return { media: url ? [{ type: "image", url, width: a.width, height: a.height }] : [] };
      }
      if (kase === "sticker" && c.sticker && c.sticker.sticker && c.sticker.sticker.$case === "custom") {
        const cm = c.sticker.sticker.custom;
        const rmr = mc.remoteMediaReferences && mc.remoteMediaReferences[0];
        const ref = rmr && mediaReferenceFromRaw(rmr.mediaReferences && rmr.mediaReferences[0]);
        const meta = cm && cm.sticker;
        if (!ref || !meta) return { media: [] };
        return { media: await resolveMediaInfos([{ mediaMetadata: { encryptionInfo: meta.encryptionInfo, dimensions: meta.dimensions, hasSound: false, zipped: !!meta.zipped }, mediaReference: ref }], "image", "custom_sticker") };
      }
      if (kase === "note" || kase === "voiceNote") {
        // Same as Snapchat's own voice-note player (main.js, search 'Invalid audio note - no media metadata'):
        // {mediaMetadata: O5(content.note.note.audio.note), mediaReference: gw(remoteMediaReferences)}, then the
        // resolver with context "voice_note". (Before 2026-09-27 this read c.note.$case - one level too shallow -
        // so every voice note came back empty and the play button did nothing.)
        const nn = c.note && c.note.note;
        const audioMeta = nn && nn.$case === "audio" && nn.audio && nn.audio.note;
        const rmr = mc.remoteMediaReferences && mc.remoteMediaReferences[0];
        const ref = rmr && mediaReferenceFromRaw(rmr.mediaReferences && rmr.mediaReferences[0]);
        if (!audioMeta || !ref) { trail("voice-note", "no " + (!audioMeta ? "metadata" : "media reference") + " (" + (nn && nn.$case) + ")", "error"); return { media: [] }; }
        const info = { mediaMetadata: { encryptionInfo: audioMeta.encryptionInfo, dimensions: audioMeta.dimensions, hasSound: true, zipped: !!audioMeta.zipped }, mediaReference: ref };
        const media = await resolveMediaInfos([info], "audio", "voice_note");
        const dur = toNum(audioMeta.mediaDurationMs) / 1000;
        for (const m of media) if (dur) m.durationSec = dur;
        return { media };
      }
      return { media: [] };
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
        post({ ghost: "res", id, ok: false, error: errText(err) });
      });
  });

  trail("init", `bridge.js loaded (v${VERSION})`);
})();
