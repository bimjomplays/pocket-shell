// Ghost TikTok tab: runs inside the hidden TikTok web view (ios/Sources/TikTokFeed.swift), never in Snapchat's page.
// TikTok's own website fetches the For You feed (/api/recommend/item_list/, /api/preload/item_list/ - signed by its
// own code); this script only listens to those answers and hands a compact copy of each video to Ghost's player.
// It also keeps TikTok's page quiet: its videos never load or play (Ghost plays them), app banners are dismissed.
// Ghost asks for more with window.__ghostTTMore() (scrolls TikTok's feed, which makes it fetch the next page).
(function () {
  "use strict";
  if (window.__ghostTT) return;
  window.__ghostTT = true;
  const post = (msg) => { try { window.webkit.messageHandlers.ghosttt.postMessage(msg); } catch (e) {} };
  const FEED_RE = /\/api\/(recommend|preload)\/item_list\//;
  const pick = (a) => (Array.isArray(a) ? a.find((x) => typeof x === "string" && x) : typeof a === "string" ? a : "") || "";

  // one TikTok item -> what Ghost's player needs (photo posts and ads are skipped for now)
  function compact(it) {
    if (!it || !it.id || !it.video || it.isAd || it.imagePost) return null;
    const v = it.video;
    // prefer an H.264 file (plays everywhere); playAddr is H.264 on the mobile site, bitrateInfo may add HEVC
    let play = pick(v.playAddr) || pick(v.PlayAddrStruct && v.PlayAddrStruct.UrlList);
    let size = 0;
    const brs = Array.isArray(v.bitrateInfo) ? v.bitrateInfo : [];
    const h264 = brs.filter((b) => b && /h264|avc/i.test(b.CodecType || "") && b.PlayAddr && b.PlayAddr.UrlList && b.PlayAddr.UrlList.length)
      .sort((a, b) => (a.Bitrate || 0) - (b.Bitrate || 0));
    // a mid rung: sharp enough at phone size, small enough for memory (720p-ish)
    const mid = h264.find((b) => (b.PlayAddr.Height || 0) >= 700) || h264[h264.length - 1];
    if (mid) { play = mid.PlayAddr.UrlList[0]; size = mid.PlayAddr.DataSize || 0; }
    if (!play) return null;
    const a = it.author || {};
    const st = it.statsV2 || it.stats || {};
    return {
      id: String(it.id),
      desc: String(it.desc || "").slice(0, 400),
      play, size,
      cover: pick(v.cover) || pick(v.originCover) || "",
      duration: Number(v.duration) || 0,
      w: Number(v.width) || 0, h: Number(v.height) || 0,
      author: { id: String(a.id || ""), uniqueId: String(a.uniqueId || ""), nickname: String(a.nickname || ""), avatar: pick(a.avatarThumb) || pick(a.avatarMedium) || "", verified: !!a.verified },
      music: it.music ? String(it.music.title || "") + (it.music.authorName ? " - " + it.music.authorName : "") : "",
      stats: { likes: String(st.diggCount || 0), comments: String(st.commentCount || 0), shares: String(st.shareCount || 0) },
    };
  }
  const seen = new Set();
  function onFeed(text, url) {
    let d; try { d = JSON.parse(text); } catch (e) { return; }
    const list = (d && d.itemList) || [];
    const items = [];
    for (const it of list) { const c = compact(it); if (c && !seen.has(c.id)) { seen.add(c.id); items.push(c); } }
    post({ type: "items", items, hasMore: d.hasMore !== false, source: /preload/.test(url) ? "preload" : "recommend" });
  }

  // listen to TikTok's own requests (both fetch and XHR; the site has used each)
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = "";
    try { url = typeof input === "string" ? input : input instanceof URL ? input.href : (input && input.url) || ""; } catch (e) {}
    if (!FEED_RE.test(url)) return origFetch.apply(this, arguments);
    // TikTok aborts its feed request right after reading it, which also killed a clone() we were still reading
    // (seen 2026-09-29: "The user aborted a request"). Read the answer once here, without its abort signal, and hand
    // TikTok an identical Response.
    const quiet = new AbortController().signal;
    const req = input instanceof Request ? new Request(input, { signal: quiet }) : input;
    return origFetch.call(this, req, Object.assign({}, init || {}, { signal: quiet })).then((r) => r.text().then((t) => {
      try { onFeed(t, url); } catch (e) {}
      return new Response(t, { status: r.status, statusText: r.statusText, headers: r.headers });
    }));
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__ghURL = String(url || ""); return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (FEED_RE.test(this.__ghURL || "")) {
      this.addEventListener("load", () => { try { const t = this.responseType === "" || this.responseType === "text" ? this.responseText : this.responseType === "json" ? JSON.stringify(this.response) : ""; if (t) onFeed(t, this.__ghURL); } catch (e) {} });
    }
    return XS.apply(this, arguments);
  };

  // TikTok's own videos: never fetch or play them in this hidden page (Ghost plays its own copy)
  // TikTok's player waits for its video to be ready before it lets the feed move on, so each element pretends to
  // have loaded (events + readyState) without downloading anything.
  try {
    const MP = HTMLMediaElement.prototype;
    const fake = (m) => {
      if (m.__ghFaked) return; m.__ghFaked = true;
      setTimeout(() => { for (const t of ["loadstart", "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough"]) { try { m.dispatchEvent(new Event(t)); } catch (e) {} } }, 30);
    };
    MP.play = function () { this.__ghPaused = false; try { this.dispatchEvent(new Event("play")); this.dispatchEvent(new Event("playing")); } catch (e) {} return Promise.resolve(); };
    MP.pause = function () { this.__ghPaused = true; try { this.dispatchEvent(new Event("pause")); } catch (e) {} };
    MP.load = function () { this.__ghFaked = false; fake(this); };
    const def = (name, get) => { try { Object.defineProperty(MP, name, { configurable: true, get }); } catch (e) {} };
    def("readyState", function () { return this.__ghSrc ? 4 : 0; });
    def("duration", function () { return this.__ghSrc ? 15 : NaN; });
    def("paused", function () { return this.__ghPaused !== false; });
    def("networkState", function () { return 1; });
    Object.defineProperty(MP, "src", { configurable: true, get() { return this.__ghSrc || ""; }, set(v) { this.__ghSrc = String(v || ""); this.__ghFaked = false; if (this.__ghSrc) fake(this); } });
    Object.defineProperty(MP, "currentSrc", { configurable: true, get() { return this.__ghSrc || ""; } });
    const SA = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (n, v) {
      if ((this instanceof HTMLMediaElement || this instanceof HTMLSourceElement) && String(n).toLowerCase() === "src") {
        const m = this instanceof HTMLSourceElement ? this.parentElement : this;
        if (m) { m.__ghSrc = String(v || ""); m.__ghFaked = false; if (m instanceof HTMLMediaElement && m.__ghSrc) fake(m); }
        return;
      }
      return SA.apply(this, arguments);
    };
  } catch (e) {}

  // "Open app" / cookie / login walls: close them so the feed keeps scrolling
  const CLOSE_TEXT = /^(not now|maybe later|decline optional cookies|got it)$/i;
  function sweep() {
    for (const b of document.querySelectorAll('button, [role="button"], div[class*="close" i]')) {
      const t = (b.textContent || "").trim();
      if (t && t.length < 40 && CLOSE_TEXT.test(t)) { try { b.click(); } catch (e) {} }
    }
  }
  setInterval(sweep, 1500);

  // Ghost asks for more: swipe TikTok's own feed forward (its mobile feed is a touch-driven slider, not a scroll box;
  // a synthetic swipe moves it - checked in WebKit 2026-09-29), and TikTok fetches the next page as it nears the end.
  // Also scrolls/keys for the desktop layout. Native reloads the page if nothing new arrives (TikTokFeed.swift).
  function swipeOnce() {
    const x = innerWidth / 2;
    const target = document.querySelector('[data-e2e="video-slide-active"]') || document.elementFromPoint(x, innerHeight / 2) || document.body;
    const fire = (type, y) => {
      const t = { identifier: 7, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, radiusX: 1, radiusY: 1, force: 1 };
      let ev;
      try { ev = new TouchEvent("touch" + type, { bubbles: true, cancelable: true, touches: type === "end" ? [] : [new Touch(t)], changedTouches: [new Touch(t)] }); }
      catch (e) {
        ev = new Event("touch" + type, { bubbles: true, cancelable: true });
        const list = type === "end" ? [] : [t];
        Object.defineProperty(ev, "touches", { value: list }); Object.defineProperty(ev, "targetTouches", { value: list }); Object.defineProperty(ev, "changedTouches", { value: [t] });
      }
      target.dispatchEvent(ev);
    };
    const y0 = innerHeight * 0.75, y1 = innerHeight * 0.2;
    fire("start", y0);
    let y = y0; const tick = () => { y -= (y0 - y1) / 10; if (y > y1) { fire("move", y); setTimeout(tick, 16); } else fire("end", y1); };
    setTimeout(tick, 16);
  }
  window.__ghostTTMore = function (n) {
    sweep();
    const count = Math.max(1, Math.min(6, Number(n) || 3));
    for (let i = 0; i < count; i++) setTimeout(() => {
      swipeOnce();
      window.scrollBy(0, innerHeight);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true }));
    }, i * 900);
    return count;
  };

  // signed-in state for Ghost's Settings (TikTok marks the logged-in user in its page data)
  function reportUser() {
    let user = null;
    try {
      const s = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      const d = s && JSON.parse(s.textContent);
      const u = d && d.__DEFAULT_SCOPE__ && d.__DEFAULT_SCOPE__["webapp.app-context"] && d.__DEFAULT_SCOPE__["webapp.app-context"].user;
      if (u && u.uniqueId) user = { uniqueId: String(u.uniqueId), nickname: String(u.nickName || u.nickname || "") };
    } catch (e) {}
    post({ type: "page", user, url: location.href });
  }
  document.addEventListener("DOMContentLoaded", reportUser);
})();
