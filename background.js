// Giphy access for the content scripts; everything comes back as data: URLs, because Snapchat's CSP only
// allows its own image hosts and reports blocked loads to Snapchat (see gifs-show.js).
// Only talks to Giphy; nothing goes to Snapchat.
//   { giphy: id }              -> { dataUrl }  animated webp, for showing received GIFs
//   { giphyVideo: id }         -> { dataUrl }  mp4 of the same GIF, preferred on iPhone
//   { giphyPreview: id }       -> { dataUrl }  small animated webp, for the picker grid
//   { giphyFile: id }          -> { dataUrl }  real .gif file, for sending
//   { giphySearch: q, offset } -> { results: [{ id, w, h }], next } | { needKey: true } | { error }
//   { giphyKey: "..." }        -> { ok }       saves the user's Giphy API key
const ID = /^[A-Za-z0-9]{1,64}$/;
const cache = new Map(); // url -> Promise<dataUrl>, kept small

function toDataUrl(bytes, type) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

function load(url) {
  if (!cache.has(url)) {
    if (cache.size >= 120) cache.delete(cache.keys().next().value);
    cache.set(url, (async () => {
      const r = await fetch(url, { credentials: "omit" });
      if (!r.ok) throw new Error(`giphy ${r.status}`);
      const type = (r.headers.get("content-type") || "image/webp").split(";")[0];
      return toDataUrl(new Uint8Array(await r.arrayBuffer()), type);
    })().catch((e) => { cache.delete(url); throw e; }));
  }
  return cache.get(url);
}

const media = (id, file) => `https://media.giphy.com/media/${id}/${file}`;

async function search(q, offset) {
  const { giphyKey } = await chrome.storage.local.get("giphyKey");
  if (!giphyKey) return { needKey: true };
  const params = new URLSearchParams({ api_key: giphyKey, limit: "24", offset: String(offset || 0) });
  if (q) params.set("q", q);
  const r = await fetch(`https://api.giphy.com/v1/gifs/${q ? "search" : "trending"}?${params}`, { credentials: "omit" });
  if (r.status === 401 || r.status === 403) return { needKey: true, error: "Giphy rejected that API key" };
  if (!r.ok) return { error: `Giphy error ${r.status}` };
  const j = await r.json();
  const results = (j.data || []).filter((g) => ID.test(g.id)).map((g) => {
    const f = (g.images && g.images.fixed_width) || {};
    return { id: g.id, w: +f.width || 200, h: +f.height || 200 };
  });
  const p = j.pagination || {};
  return { results, next: (p.offset || 0) + (p.count || results.length) };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || typeof msg !== "object") return;
  let job;
  if (typeof msg.giphy === "string" && ID.test(msg.giphy))
    job = load(media(msg.giphy, "giphy.webp")).then((dataUrl) => ({ dataUrl }));
  else if (typeof msg.giphyVideo === "string" && ID.test(msg.giphyVideo))
    // mobile: received GIFs play as mp4 (iOS Safari may not animate webp)
    job = load(media(msg.giphyVideo, "giphy.mp4")).then((dataUrl) => ({ dataUrl }));
  else if (typeof msg.giphyPreview === "string" && ID.test(msg.giphyPreview))
    job = load(media(msg.giphyPreview, "200w.webp")).then((dataUrl) => ({ dataUrl }));
  else if (typeof msg.giphyFile === "string" && ID.test(msg.giphyFile))
    // downsized keeps GIFs under ~2 MB; fall back to the original if a GIF has no downsized version
    job = load(media(msg.giphyFile, "giphy-downsized.gif"))
      .catch(() => load(media(msg.giphyFile, "giphy.gif")))
      .then((dataUrl) => ({ dataUrl }));
  else if (typeof msg.giphySearch === "string")
    job = search(msg.giphySearch.trim().slice(0, 100), msg.offset);
  else if (typeof msg.giphyKey === "string")
    job = chrome.storage.local.set({ giphyKey: msg.giphyKey.trim() }).then(() => ({ ok: true }));
  else return;
  job.then(reply, (e) => reply({ error: String(e && e.message || e) }));
  return true; // reply is async
});
