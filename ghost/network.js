// Ghost network core: a Ghost identity, the private line between two Ghost apps, visible invite codes and
// Ghost profiles. No DOM in here: ui.js's "Ghost network" section draws it and hands in the platform pieces.
// Plan and decisions: ghost/ACCOUNTS_PLAN.md.
//
// Built into ios/Resources/ghost-ui.js right before ui.js (same script, so ui.js sees GhostNetCore). Also runs in
// Node (ghost/tests/network.test.cjs) - only WebCrypto, TextEncoder and JSON are used.
//
// Wire format (all over ntfy.sh, which only ever sees ciphertext):
//   - Ghost ID  = base32(SHA-256(ECDH public || ECDSA public))[0..26]; inbox topic = "gh-in-" + base32(SHA-256("ghost-inbox|" + id)).
//   - Envelope  = {g:1, f:fromId, t:toId, e:ephemeral ECDH key, i:iv, c:AES-GCM ciphertext, s:ECDSA signature}; the key is
//     HKDF-SHA256(ECDH(ephemeral, recipient)); the signature covers "ghost-net-v1|f>t|" + e + i + c. Inside: {type, ts, n, ...}.
//   - v2 (build 81): {g:2, e, i, c, s} with {f, t, o:{type, ...}} INSIDE the ciphertext, posted to the recipient's private
//     inbox ("gh-pi-" + random, told only to connected friends in accept/welcome/profile/sync as `pi`). ntfy then sees
//     neither who sends nor who receives. The public inbox (derived from the Ghost ID) only carries accept/welcome/declined
//     and messages to/from builds 79-80, which don't know `pi` (they ignore unknown fields and message types).
//   - Invite    = the visible chat text "ghost:connect XXXX-XXXX-XXXX" (60 random bits). The inviter posts its signed card
//     (Ghost ID + public keys + Snapchat user id), AES-GCM encrypted with a key from the code, to a rendezvous topic derived
//     from the code. The friend's Ghost reads it, checks the card belongs to whoever sent the chat message, and sends an
//     "accept" (its own card + an HMAC proof of the code) to the inviter's inbox. The inviter checks the proof, that the
//     acceptor's Snapchat id is the person the invite was sent to, and that the code is unused and < 24 h old; then both
//     are connected ("welcome" back). Codes work once.
//   - Chat extras (1.10): pins, polls, votes and stickers in a 1:1 chat between two connected Ghosts are SHARED STATE:
//     items {k, v, by, d} (last writer wins by v, then by id; d null = removed, kept as a tombstone), sent as {type:"xs",
//     items} when they change, and every sync carries {xc, xm} = how many items (and the newest v) I hold that the friend
//     wrote; a mismatch makes the friend send all of its items again. So nothing depends on ntfy.sh's 12 h storage.
//     Sticker pictures go as encrypted attachments (like profile pictures); a Ghost that can't fetch one (ntfy.sh keeps
//     files 3 h) asks with {type:"xneed", k} and the author uploads it again.
const GhostNetCore = (() => {
  "use strict";
  const subtle = crypto.subtle;
  const te = new TextEncoder(), td = new TextDecoder();
  const NTFY = "https://ntfy.sh";
  const B32 = "abcdefghijkmnpqrstuvwxyz23456789"; // lowercase so it's a valid ntfy topic
  const CODE_ALPHA = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I - read aloud and typed safely
  const INVITE_TTL = 24 * 3600e3;
  const RV_REPOST = 10 * 3600e3; // ntfy.sh keeps messages 12 h: repost the rendezvous card before it drops out
  const PIC_REUPLOAD = 150 * 60e3; // ntfy.sh keeps attachments 3 h
  const SYNC_EVERY = 6 * 3600e3;
  const MAX_ENVELOPE = 3900; // ntfy turns messages over 4096 bytes into attachments
  const SYNC_FORCED = 3600e3; // a forced sync (every time Ghost comes to the front) still only runs hourly per friend: ntfy.sh allows 250 messages a day
  const GONE_KEEP = 7 * 24 * 3600e3; // how long a disconnected friend is remembered, to answer their Ghost with "bye"
  const PI_RE = /^gh-pi-[a-z2-9]{26}$/;
  const MAX_PIC = 3 * 1024 * 1024;
  const LIMITS = { name: 40, bio: 300, status: 60 };
  // Shared items (games; later anything two Ghosts keep in sync): small JSON state, versioned, re-sent until the friend
  // confirms it, so ntfy.sh's 12 h message life never loses the latest version. key = "<kind>:<random id>".
  const ITEM_KEY_RE = /^[a-z]{2,12}:[A-Za-z0-9_-]{6,40}$/;
  const ITEM_KIND_RE = /^[a-z]{2,12}$/;
  const ITEM_PER_FRIEND = 40;         // items kept per friend (oldest go first), so a friend's Ghost can't fill storage
  const ITEM_MAX = 3200;              // JSON chars of an item's data (a sealed message must stay under 6000)
  const ITEM_RESEND = 10 * 60e3;      // an unconfirmed item goes again after this long (a minute when forced)
  const ACCENTS = ["blue", "purple", "pink", "red", "orange", "yellow", "green", "teal"];
  const INVITE_RE = /^\s*ghost:connect\s+([2-9A-HJ-NP-Z]{4})-([2-9A-HJ-NP-Z]{4})-([2-9A-HJ-NP-Z]{4})\s*$/i;

  // ---- bytes -------------------------------------------------------------------------------------------
  const u8 = (x) => x instanceof Uint8Array ? x : new Uint8Array(x);
  function concat(...parts) {
    const all = parts.map((p) => typeof p === "string" ? te.encode(p) : u8(p));
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }
  function b64(bytes) {
    const b = u8(bytes); let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(String(str || "")); const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function b32(bytes) {
    const b = u8(bytes); let bits = 0, val = 0, out = "";
    for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  }
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const sha256 = async (x) => u8(await subtle.digest("SHA-256", typeof x === "string" ? te.encode(x) : x));
  const nonce = () => b64(rand(12));

  // ---- keys --------------------------------------------------------------------------------------------
  const EC = { name: "ECDH", namedCurve: "P-256" }, DSA = { name: "ECDSA", namedCurve: "P-256" }, SIG = { name: "ECDSA", hash: "SHA-256" };
  const pubJwk = (j) => ({ kty: "EC", crv: "P-256", x: j.x, y: j.y });
  function validJwk(j) { return !!(j && typeof j.x === "string" && typeof j.y === "string" && j.x.length <= 64 && j.y.length <= 64); }
  const importEcdhPub = (j) => subtle.importKey("jwk", pubJwk(j), EC, true, []);
  const importDsaPub = (j) => subtle.importKey("jwk", pubJwk(j), DSA, true, ["verify"]);
  async function rawOf(key) { return u8(await subtle.exportKey("raw", key)); }
  async function idFor(xJwk, sJwk) {
    const [x, s] = await Promise.all([importEcdhPub(xJwk).then(rawOf), importDsaPub(sJwk).then(rawOf)]);
    return b32(await sha256(concat(x, s))).slice(0, 26);
  }
  const inboxOf = async (id) => "gh-in-" + b32(await sha256("ghost-inbox|" + id)).slice(0, 26);
  async function newKeyFile(now) {
    const x = await subtle.generateKey(EC, true, ["deriveBits"]);
    const s = await subtle.generateKey(DSA, true, ["sign", "verify"]);
    return JSON.stringify({ v: 1, created: now, x: await subtle.exportKey("jwk", x.privateKey), s: await subtle.exportKey("jwk", s.privateKey) });
  }
  async function loadIdentity(text) {
    const k = JSON.parse(text);
    if (!k || k.v !== 1 || !validJwk(k.x) || !validJwk(k.s) || !k.x.d || !k.s.d) throw new Error("bad key file");
    const xPriv = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.x.x, y: k.x.y, d: k.x.d }, EC, false, ["deriveBits"]);
    const sPriv = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.s.x, y: k.s.y, d: k.s.d }, DSA, false, ["sign"]);
    const x = pubJwk(k.x), s = pubJwk(k.s);
    const id = await idFor(x, s);
    return { id, x, s, xPriv, sPriv, inbox: await inboxOf(id), created: k.created || 0 };
  }
  async function hkdfKey(secret, salt, info) {
    const base = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // ---- cards (signed "this is my Ghost") ---------------------------------------------------------------
  async function makeCard(me, snap, now) {
    const c = JSON.stringify({ id: me.id, x: me.x, s: me.s, snap: String(snap || ""), ts: now });
    const sig = u8(await subtle.sign(SIG, me.sPriv, te.encode("ghost-card-v1|" + c)));
    return { c, s: b64(sig) };
  }
  async function readCard(card) {
    if (!card || typeof card.c !== "string" || typeof card.s !== "string" || card.c.length > 1500) throw new Error("bad card");
    const c = JSON.parse(card.c);
    if (!c || typeof c.id !== "string" || !validJwk(c.x) || !validJwk(c.s) || typeof c.snap !== "string" || !c.snap) throw new Error("bad card");
    const key = await importDsaPub(c.s);
    if (!(await subtle.verify(SIG, key, unb64(card.s), te.encode("ghost-card-v1|" + card.c)))) throw new Error("card signature");
    if ((await idFor(c.x, c.s)) !== c.id) throw new Error("card id");
    return { id: c.id, x: pubJwk(c.x), s: pubJwk(c.s), snap: c.snap, ts: Number(c.ts) || 0 };
  }

  // ---- envelopes ----------------------------------------------------------------------------------------
  async function seal(me, peer, obj) {
    const eph = await subtle.generateKey(EC, true, ["deriveBits"]);
    const e = await rawOf(eph.publicKey);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await importEcdhPub(peer.x) }, eph.privateKey, 256));
    const key = await hkdfKey(shared, e, "ghost-net-v1|" + peer.id);
    const iv = rand(12), route = me.id + ">" + peer.id;
    const c = u8(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(route) }, key, te.encode(JSON.stringify(obj))));
    const s = u8(await subtle.sign(SIG, me.sPriv, concat("ghost-net-v1|" + route + "|", e, iv, c)));
    const text = JSON.stringify({ g: 1, f: me.id, t: peer.id, e: b64(e), i: b64(iv), c: b64(c), s: b64(s) });
    if (text.length > MAX_ENVELOPE) throw new Error("message too big");
    return text;
  }
  // senderKey(id) -> the sender's signing JWK if we know them; an "accept" carries its own card instead
  async function unseal(me, text, senderKey) {
    const env = JSON.parse(text);
    if (!env || env.g !== 1 || env.t !== me.id || typeof env.f !== "string") return null;
    const e = unb64(env.e), iv = unb64(env.i), c = unb64(env.c);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("raw", e, EC, true, []) }, me.xPriv, 256));
    const key = await hkdfKey(shared, e, "ghost-net-v1|" + me.id);
    const route = env.f + ">" + me.id;
    const obj = JSON.parse(td.decode(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: te.encode(route) }, key, c)));
    if (!obj || typeof obj.type !== "string") return null;
    let sKey = senderKey(env.f), card = null;
    if (obj.type === "accept") { card = await readCard(obj.card); if (card.id !== env.f) return null; sKey = sKey || card.s; }
    if (!sKey) return null;
    if (!(await subtle.verify(SIG, await importDsaPub(sKey), unb64(env.s), concat("ghost-net-v1|" + route + "|", e, iv, c)))) return null;
    return { from: env.f, obj, card };
  }
  // v2: sender and recipient inside the ciphertext
  async function seal2(me, peer, obj) {
    const eph = await subtle.generateKey(EC, true, ["deriveBits"]);
    const e = await rawOf(eph.publicKey);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await importEcdhPub(peer.x) }, eph.privateKey, 256));
    const key = await hkdfKey(shared, e, "ghost-net-v2|" + peer.id);
    const iv = rand(12);
    const c = u8(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode("ghost-net-v2") }, key, te.encode(JSON.stringify({ f: me.id, t: peer.id, o: obj }))));
    const s = u8(await subtle.sign(SIG, me.sPriv, concat("ghost-net-v2|", e, iv, c)));
    const text = JSON.stringify({ g: 2, e: b64(e), i: b64(iv), c: b64(c), s: b64(s) });
    if (text.length > MAX_ENVELOPE) throw new Error("message too big");
    return text;
  }
  async function unseal2(me, text, senderKey) {
    const env = JSON.parse(text);
    // junk is dropped before any key work
    if (!env || env.g !== 2 || typeof env.e !== "string" || env.e.length > 100 || typeof env.i !== "string" || env.i.length > 24 || typeof env.c !== "string" || typeof env.s !== "string" || env.s.length > 120) return null;
    const e = unb64(env.e), iv = unb64(env.i), c = unb64(env.c);
    const shared = u8(await subtle.deriveBits({ name: "ECDH", public: await subtle.importKey("raw", e, EC, true, []) }, me.xPriv, 256));
    const key = await hkdfKey(shared, e, "ghost-net-v2|" + me.id);
    const inner = JSON.parse(td.decode(await subtle.decrypt({ name: "AES-GCM", iv, additionalData: te.encode("ghost-net-v2") }, key, c)));
    if (!inner || inner.t !== me.id || typeof inner.f !== "string" || !inner.o || typeof inner.o.type !== "string") return null;
    const obj = inner.o;
    let sKey = senderKey(inner.f), card = null;
    if (obj.type === "accept") { card = await readCard(obj.card); if (card.id !== inner.f) return null; sKey = sKey || card.s; }
    if (!sKey) return null;
    if (!(await subtle.verify(SIG, await importDsaPub(sKey), unb64(env.s), concat("ghost-net-v2|", e, iv, c)))) return null;
    return { from: inner.f, obj, card };
  }

  // ---- invite codes -------------------------------------------------------------------------------------
  function newCode() {
    const r = rand(12); let s = "";
    for (let i = 0; i < 12; i++) { s += CODE_ALPHA[r[i] & 31]; if (i === 3 || i === 7) s += "-"; }
    return s;
  }
  function parseInvite(text) {
    const m = INVITE_RE.exec(String(text || ""));
    return m ? (m[1] + "-" + m[2] + "-" + m[3]).toUpperCase() : null;
  }
  const inviteText = (code) => "ghost:connect " + code;
  const rvTopic = async (code) => "gh-rv-" + b32(await sha256("ghost-rv|" + code)).slice(0, 26);
  const rvKey = async (code) => hkdfKey(await sha256("ghost-code|" + code), te.encode("ghost-rv"), "ghost-rv-v1");
  async function proof(code, purpose, id) {
    const k = await subtle.importKey("raw", await sha256("ghost-proof|" + code), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return b64(await subtle.sign("HMAC", k, te.encode(purpose + "|" + id)));
  }

  // ---- the network --------------------------------------------------------------------------------------
  // deps: gnet(args) -> {status, body(base64)} | null   (native "gnet": ntfy.sh only)
  //       keysGet() -> string|null, keysSet(string), keysDelete()
  //       farewellKeys: {get, set, del} - a second Keychain slot for the old keys, only while "bye"s owed after Leave
  //       load() -> state|null, save(state)
  //       picGet(key) -> Blob|null, picPut(key, Blob), picDel(key)
  //       me() -> {id, name} (the Snapchat account), now() -> ms, onChange(what, detail), log(text)
  function create(deps) {
    const now = () => (deps.now ? deps.now() : Date.now());
    const log = (t) => { try { deps.log && deps.log(t); } catch (e) {} };
    let st = null, ident = null, identP = null, busy = null, leaving = false, slowUntil = 0;
    const blank = () => ({ v: 1, on: true, friends: {}, invites: {}, joined: {}, since: {}, seen: [], share: "all", shareWith: [],
      profile: { v: 0, name: "", bio: "", accent: "", pic: false, banner: false }, uploads: {},
      status: { v: 0, text: "", until: 0 }, gone: {}, pi: "", items: {} });
    async function state() {
      if (st) return st;
      let s = null; try { s = await deps.load(); } catch (e) {}
      st = Object.assign(blank(), s && s.v === 1 ? s : {});
      if (!PI_RE.test(st.pi || "")) { st.pi = "gh-pi-" + b32(rand(17)).slice(0, 26); await save(); } // my private inbox
      return st;
    }
    const save = () => deps.save(JSON.parse(JSON.stringify(st)));
    const changed = (what, detail) => { try { deps.onChange && deps.onChange(what, detail); } catch (e) { log("onChange " + e.message); } };

    async function identity(create) {
      if (ident) return ident;
      if (identP) return identP;
      identP = (async () => {
        // a Keychain error is not "no keys": making new ones would silently replace your Ghost ID
        let text = null; try { text = await deps.keysGet(); } catch (e) { log("keys: " + (e && e.message || e)); throw new Error("Couldn't read your Ghost keys. Try again in a moment."); }
        if (text) { try { ident = await loadIdentity(text); return ident; } catch (e) { log("keys unreadable: " + e.message); throw new Error("Your Ghost keys are unreadable"); } }
        if (!create) return null;
        text = await newKeyFile(now());
        await deps.keysSet(text);
        ident = await loadIdentity(text);
        log("new Ghost identity " + ident.id);
        return ident;
      })().finally(() => { identP = null; });
      return identP;
    }

    // ---- ntfy.sh ----
    async function net(args) {
      if (now() < slowUntil) throw new Error("ntfy busy");
      const r = await deps.gnet(args);
      if (!r || typeof r.status !== "number") throw new Error("Ghost network isn't reachable");
      if (r.status === 429) { slowUntil = now() + 10 * 60e3; throw new Error("ntfy 429"); } // over ntfy.sh's limits: wait
      if (r.status < 200 || r.status >= 300) throw new Error("ntfy " + r.status);
      return unb64(r.body || "");
    }
    const post = (topic, text) => net({ url: NTFY + "/" + topic, method: "POST", body: b64(te.encode(text)), headers: { Firebase: "no" } });
    async function poll(topic, since) {
      const body = td.decode(await net({ url: NTFY + "/" + topic + "/json?poll=1&since=" + encodeURIComponent(since || "all") }));
      const out = [];
      for (const line of body.split("\n")) { if (!line.trim()) continue; try { const m = JSON.parse(line); if (m && m.event === "message") out.push(m); } catch (e) {} }
      return out;
    }
    async function upload(bytes) {
      const topic = "gh-f-" + b32(rand(16)).slice(0, 26);
      const res = JSON.parse(td.decode(await net({ url: NTFY + "/" + topic, method: "PUT", body: b64(bytes), headers: { Filename: "g.bin", Firebase: "no" } })));
      const url = res && res.attachment && res.attachment.url;
      if (typeof url !== "string" || !url.startsWith(NTFY + "/file/")) throw new Error("upload failed");
      return url;
    }
    async function download(url) {
      if (typeof url !== "string" || !url.startsWith(NTFY + "/file/")) throw new Error("bad picture link");
      return net({ url });
    }

    // ---- pictures: encrypted once per profile version with a fresh key, sent inside each friend's sealed profile ----
    async function uploadPic(kind) {
      const up = st.uploads[kind];
      if (up && now() - up.at < PIC_REUPLOAD) return up.ref; // (dropped whenever the picture itself changes)
      const blob = await deps.picGet("me:" + kind);
      if (!blob) return null;
      const bytes = u8(await blob.arrayBuffer());
      const keyBytes = rand(32), iv = rand(12);
      const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const ct = u8(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
      const ref = { u: await upload(ct), k: b64(keyBytes), i: b64(iv), t: blob.type || "image/jpeg" };
      st.uploads[kind] = { at: now(), ref };
      await save();
      return ref;
    }
    async function fetchPic(ref) {
      if (!ref || typeof ref.k !== "string" || typeof ref.i !== "string") throw new Error("bad picture");
      const ct = await download(ref.u);
      if (ct.length > MAX_PIC) throw new Error("picture too big");
      const key = await subtle.importKey("raw", unb64(ref.k), "AES-GCM", false, ["decrypt"]);
      const bytes = u8(await subtle.decrypt({ name: "AES-GCM", iv: unb64(ref.i) }, key, ct));
      const type = /^image\/(jpeg|png|webp)$/.test(ref.t) ? ref.t : "image/jpeg";
      return new Blob([bytes], { type });
    }

    // ---- sending ----
    async function send(friend, obj) {
      const me = await identity(false);
      if (!me) throw new Error("no Ghost identity");
      await sendAs(me, friend, obj);
    }
    async function sendAs(me, friend, obj) {
      const body = Object.assign({ ts: now(), n: nonce() }, obj);
      if (friend.cap >= 2 && PI_RE.test(friend.pi || "")) await post(friend.pi, await seal2(me, friend, body));
      else await post(friend.inbox, await seal(me, friend, body));
    }
    // make room for one more item shared with this friend (drops their oldest)
    function itemRoom(fid) {
      const theirs = Object.values(st.items || {}).filter((i) => i.with === fid).sort((a, b) => (a.at || 0) - (b.at || 0));
      while (theirs.length >= ITEM_PER_FRIEND) delete st.items[theirs.shift().key];
    }
    const itemMsg = (it) => ({ type: "item", key: it.key, kind: it.kind, v: it.v, data: it.data });
    // what every message that sets up or keeps a connection carries: where to reach me privately
    const piInfo = () => ({ pi: st.pi, cap: 2 });
    function learnPi(f, obj) { if (f && obj && obj.cap >= 2 && PI_RE.test(obj.pi || "") && (f.pi !== obj.pi || f.cap !== 2)) { f.pi = obj.pi; f.cap = 2; return true; } return false; }
    const canShare = (f) => st.share === "all" || (st.shareWith || []).includes(f.id);
    async function sendProfile(f) {
      if (!canShare(f)) { await send(f, Object.assign({ type: "profile", v: st.profile.v, private: true }, piInfo())); f.sentV = st.profile.v; return; }
      const p = st.profile;
      // a picture that didn't upload is NOT sent as "no picture" (their Ghost would delete yours): the whole profile
      // waits and goes again at the next sync
      const [pic, banner] = await Promise.all([p.pic ? uploadPic("pic") : null, p.banner ? uploadPic("banner") : null]);
      if ((p.pic && !pic) || (p.banner && !banner)) throw new Error("picture missing");
      await send(f, Object.assign({ type: "profile", v: p.v, name: p.name, bio: p.bio, accent: p.accent, pic, banner }, piInfo()));
      f.sentV = p.v;
    }
    // the status line travels on its own (a new status never re-sends pictures). Friends you don't share with get an
    // empty one, so a status they saw earlier goes away.
    const statusLive = () => !!(st.status && st.status.text && (!st.status.until || st.status.until > now()));
    async function sendStatus(f) {
      const s = st.status || blank().status;
      const show = canShare(f) && statusLive();
      await send(f, { type: "status", sv: s.v, text: show ? s.text : "", until: show ? s.until : 0 });
      f.sentSV = s.v;
    }
    async function pushStatusToAll() {
      for (const f of Object.values(st.friends)) {
        if (f.state !== "connected" || f.sentSV === st.status.v || !(f.cap >= 2)) continue; // (builds 79-80 ignore it anyway: save ntfy's daily budget)
        try { await sendStatus(f); } catch (e) { log("status to " + f.id + ": " + e.message); }
      }
      await save();
    }
    // after connecting: the profile, and the status if there is one
    async function sendAll(f) {
      await sendProfile(f);
      try { const me = await identity(false); if (me) await xsend(f, xmine(f.id, me.id)); } catch (e) { log("extras: " + e.message); }
      if (st.status && st.status.v && statusLive() && f.cap >= 2) { try { await sendStatus(f); } catch (e) { log("status: " + e.message); } }
    }
    async function pushProfileToAll() {
      for (const f of Object.values(st.friends)) {
        if (f.state !== "connected" || f.sentV === st.profile.v) continue;
        try { await sendProfile(f); } catch (e) { log("profile to " + f.id + ": " + e.message); }
      }
      await save();
    }

    // ---- chat extras (pins, polls, votes, stickers) ----
    const XKEY_RE = /^(pin:[A-Za-z0-9_.-]{1,96}|poll:[a-z0-9]{8,24}|vote:[a-z0-9]{8,24}:[a-z2-9]{26}|stk:[A-Za-z0-9_.-]{1,96}:[a-z0-9]{8,24})$/;
    const XMAX_ITEM = 1500, XCHUNK = 1700, XMAX_ITEMS = 3000;
    const num = (x, lo, hi) => typeof x === "number" && isFinite(x) && x >= lo && x <= hi;
    const txt = (x, n) => typeof x === "string" && x.length <= n;
    function xbox(fid) { st.extras = st.extras || {}; return st.extras[fid] || (st.extras[fid] = { items: {} }); }
    function refOk(r) { return !!(r && typeof r === "object" && typeof r.u === "string" && r.u.startsWith(NTFY + "/file/") && r.u.length < 200 && txt(r.k, 64) && txt(r.i, 32) && txt(r.t, 20)); }
    // what each kind of item may hold (anything else is refused, so a friend's Ghost can't smuggle odd data in)
    function dataOk(k, d) {
      if (d === null) return true;
      if (!d || typeof d !== "object" || Array.isArray(d) || JSON.stringify(d).length > XMAX_ITEM) return false;
      const kind = k.slice(0, k.indexOf(":"));
      if (kind === "pin") return num(d.t, 0, 1e14) && txt(d.p, 160) && txt(d.f || "", 80) && txt(d.kd || "", 20);
      if (kind === "poll") return txt(d.q, 300) && d.q.trim().length > 0 && Array.isArray(d.o) && d.o.length >= 2 && d.o.length <= 10 && d.o.every((o) => txt(o, 120))
        && typeof d.m === "boolean" && typeof d.x === "boolean" && num(d.c || 0, 0, 1e14) && num(d.at, 0, 1e14) && txt(d.cr, 40);
      if (kind === "vote") return Array.isArray(d.s) && d.s.length <= 10 && d.s.every((i) => Number.isInteger(i) && i >= 0 && i < 10);
      if (kind === "stk") return ["e", "b", "i"].includes(d.kd) && txt(d.r || "", 64) && txt(d.a || "", 64) && (d.kd !== "i" || refOk(d.ref))
        && num(d.x, -1, 2) && num(d.y, -1, 2) && num(d.s, 0.2, 4) && num(d.rot, -7, 7);
      return false;
    }
    function xvalid(it) { return !!(it && typeof it === "object" && typeof it.k === "string" && XKEY_RE.test(it.k) && num(it.v, 1, now() + 10 * 60e3) && txt(it.by, 40) && dataOk(it.k, it.d === undefined ? null : it.d)); }
    const xnewer = (a, b) => !b || a.v > b.v || (a.v === b.v && String(a.by) > String(b.by));
    // one item into the chat's state; who may write what: votes only their voter, a poll only its creator, a sticker
    // only whoever placed it; pins either of you
    function xapply(fid, it) {
      if (!xvalid(it)) return false;
      const box = xbox(fid), cur = box.items[it.k];
      if (!cur && Object.keys(box.items).length >= XMAX_ITEMS) {
        // full: make room by forgetting the oldest removed item (a tombstone); only live items refuse new ones
        let old = null;
        for (const i of Object.values(box.items)) if (!i.d && (!old || i.v < old.v)) old = i;
        if (!old) return false;
        delete box.items[old.k];
      }
      if (it.k.startsWith("vote:") && it.k.split(":")[2] !== it.by) return false;
      if (it.k.startsWith("poll:") && ((cur && cur.d && cur.d.cr && cur.d.cr !== it.by) || (it.d && it.d.cr !== it.by) || (cur && !cur.d && cur.by !== it.by))) return false;
      if (it.k.startsWith("stk:") && cur && cur.by !== it.by) return false;
      if (!xnewer(it, cur)) return false;
      box.items[it.k] = { k: it.k, v: it.v, by: it.by, d: it.d == null ? null : it.d };
      return true;
    }
    const xsyncInfo = (f) => { const h = xsummary(f.id, f.id); return { xc: h.c, xm: h.m }; };
    const xmine = (fid, myId) => Object.values(xbox(fid).items).filter((i) => i.by === myId);
    function xsummary(fid, who) { let c = 0, m = 0; for (const i of Object.values(xbox(fid).items)) if (i.by === who) { c++; if (i.v > m) m = i.v; } return { c, m }; }
    async function xsend(f, items) {
      if (!items.length || f.state !== "connected") return;
      let chunk = [], size = 0;
      const flush = async () => { if (chunk.length) await send(f, { type: "xs", items: chunk }); chunk = []; size = 0; };
      for (const it of items.slice().sort((a, b) => a.v - b.v)) {
        const n = JSON.stringify(it).length;
        if (size + n > XCHUNK) await flush();
        chunk.push(it); size += n;
      }
      await flush();
    }

    // ---- receiving ----
    // every message nonce is kept for as long as its timestamp is accepted (48 h + drift), not a fixed count: busy
    // friends used to push old nonces out of a 500-entry list while their messages could still be replayed
    function remember(n, ts) {
      if (typeof n !== "string" || n.length > 40) return false;
      if (!st.seenAt || typeof st.seenAt !== "object") st.seenAt = {};
      if (st.seenAt[n] || (st.seen || []).includes(n)) return false;
      st.seenAt[n] = ts;
      const keys = Object.keys(st.seenAt);
      if (keys.length > 3000) { const cut = now() - 50 * 3600e3; for (const k of keys) if (st.seenAt[k] < cut) delete st.seenAt[k]; }
      return true;
    }
    async function dropFriend(id) {
      const f = st.friends[id];
      if (!f) return;
      delete st.friends[id];
      for (const [k, it] of Object.entries(st.items || {})) if (it.with === id) delete st.items[k];
      if (st.extras) delete st.extras[id]; // (their pins, polls and stickers go with them)
      await Promise.all([deps.picDel(id + ":pic"), deps.picDel(id + ":banner")].map((p) => Promise.resolve(p).catch(() => {})));
      return f;
    }
    // a friend you disconnected from is remembered for a week (keys + inboxes only), so a "bye" that didn't get through
    // is sent again, and anything their Ghost still sends is answered with another "bye"
    function tombstone(f, sent) { st.gone[f.id] = { id: f.id, x: f.x, s: f.s, inbox: f.inbox, pi: f.pi, cap: f.cap, snap: f.snap, at: now(), sent: !!sent }; }
    async function sayBye(g) {
      g.lastBye = now();
      try { await send(g, { type: "bye" }); g.sent = true; } catch (e) { log("bye: " + e.message); }
    }
    async function farewells() {
      const fw = st.farewell;
      if (!fw) return;
      const done = async () => { delete st.farewell; await save(); try { await deps.farewellKeys.del(); } catch (e) {} };
      if (now() > fw.until || !fw.to || !fw.to.length || !deps.farewellKeys) return done();
      let me = null;
      try { const t = await deps.farewellKeys.get(); if (!t) return done(); me = await loadIdentity(t); } catch (e) { log("farewell keys: " + e.message); return; }
      for (const f of fw.to.slice()) {
        try { await sendAs(me, f, { type: "bye" }); fw.to = fw.to.filter((x) => x !== f); } catch (e) { log("farewell: " + e.message); break; }
      }
      if (!fw.to.length) return done();
      await save();
    }
    function friendBySnap(snap) { return Object.values(st.friends).find((f) => f.snap === snap) || null; }
    const senderKey = (id) => (st.friends[id] && st.friends[id].s) || (st.gone[id] && st.gone[id].s) || null;
    async function handle(msg) {
      const me = await identity(false);
      if (!me || typeof msg.message !== "string" || msg.message[0] !== "{" || msg.message.length > 6000) return;
      let got = null;
      try { got = msg.message.startsWith('{"g":2') ? await unseal2(me, msg.message, senderKey) : await unseal(me, msg.message, senderKey); }
      catch (e) { log("unreadable message: " + e.message); return; }
      if (!got) return;
      const { from, obj } = got;
      if (typeof obj.ts !== "number" || obj.ts < now() - 48 * 3600e3 || obj.ts > now() + 3600e3 || !remember(obj.n, obj.ts)) return;
      const f = st.friends[from];
      if (!f && st.gone[from] && obj.type !== "accept") { // someone you disconnected from: they didn't get the bye
        const g = st.gone[from];
        if (obj.type === "bye") { delete st.gone[from]; await save(); return; }
        if (now() - (g.lastBye || 0) > 10 * 60e3) { await sayBye(g); await save(); }
        return;
      }
      if (f && f.since && obj.ts < f.since - 10 * 60e3 && obj.type !== "welcome") return; // older than this connection (replayed; 10 min for clock drift)
      if (f && f.state === "connected") f.heard = now(); // "Last heard from" on their profile
      if (f && learnPi(f, obj)) await save();
      switch (obj.type) {
        case "accept": return onAccept(got);
        case "welcome": {
          if (!f || f.state !== "connecting" || !f.code || obj.p !== await proof(f.code, "welcome", from)) return;
          f.state = "connected"; f.since = now(); f.heard = now(); delete f.code;
          delete st.gone[from];
          for (const j of Object.values(st.joined)) if (j.id === from && j.state === "connecting") j.state = "connected";
          await save(); changed("friends", { id: from, snap: f.snap });
          try { await sendAll(f); await save(); } catch (e) { log("profile after welcome: " + e.message); }
          return;
        }
        case "profile": return f ? onProfile(f, obj) : undefined;
        case "xs": {
          if (!f || f.state !== "connected" || !Array.isArray(obj.items)) return;
          let n = 0;
          for (const it of obj.items.slice(0, 60)) if (it && it.by === from && xapply(f.id, it)) n++;
          if (n) { await save(); changed("extras", { id: f.id, snap: f.snap }); }
          return;
        }
        // their Ghost couldn't fetch a sticker picture I placed (ntfy.sh keeps files 3 h): upload it again
        case "xneed": {
          if (!f || f.state !== "connected" || typeof obj.k !== "string") return;
          const me = await identity(false), it = me && xbox(f.id).items[obj.k];
          if (!it || it.by !== me.id || !it.d || it.d.kd !== "i" || !deps.stickerBlob) return;
          f.xneed = f.xneed || {};
          if (now() - (f.xneed[obj.k] || 0) < 20 * 60e3) return;
          f.xneed[obj.k] = now();
          try {
            const blob = await deps.stickerBlob(obj.k.split(":")[2]);
            if (!blob) return;
            const d = Object.assign({}, it.d, { ref: await api.putPicture(blob) });
            const nit = { k: it.k, v: Math.max(now(), it.v + 1), by: me.id, d };
            if (xapply(f.id, nit)) { await save(); await xsend(f, [nit]); }
          } catch (e) { log("xneed: " + e.message); }
          return;
        }
        case "sync": {
          if (!f || f.state !== "connected") return;
          if (obj.have !== st.profile.v) { try { await sendProfile(f); } catch (e) { log("sync reply: " + e.message); } }
          // (builds before 81 send no status numbers: they get no status)
          if (typeof obj.shave === "number" && obj.shave !== st.status.v) { try { await sendStatus(f); } catch (e) { log("sync status: " + e.message); } }
          // chat extras: they hold a different set of what I wrote than I do -> send all of mine again (1.10+ only)
          if (typeof obj.xc === "number") {
            const me = await identity(false), mine = me ? xsummary(f.id, me.id) : null;
            if (mine && (mine.c !== obj.xc || mine.m !== obj.xm) && now() - (f.xResent || 0) > 10 * 60e3) {
              f.xResent = now();
              try { await xsend(f, xmine(f.id, me.id)); } catch (e) { log("extras resend: " + e.message); }
            }
          }
          const behind = (typeof obj.mine === "number" && obj.mine > (f.haveV || 0)) || (typeof obj.sv === "number" && obj.sv > (f.statusV || 0));
          if (behind && !obj.reply) { try { await send(f, Object.assign(Object.assign({ type: "sync", have: f.haveV || 0, mine: st.profile.v, shave: f.statusV || 0, sv: st.status.v, reply: true }, xsyncInfo(f)), piInfo())); } catch (e) {} }
          await save();
          return;
        }
        case "status": {
          if (!f || f.state !== "connected" || typeof obj.sv !== "number" || obj.sv <= (f.statusV || 0)) return;
          const text = String(obj.text == null ? "" : obj.text).replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, " ").trim().slice(0, LIMITS.status);
          const until = Number(obj.until) || 0;
          f.status = text ? { text, until } : null; f.statusV = obj.sv;
          await save(); changed("profile", { id: f.id, snap: f.snap });
          return;
        }
        // their Ghost couldn't download my pictures (ntfy.sh keeps files 3 h): upload fresh ones and send again
        case "needpics": {
          if (!f || f.state !== "connected" || now() - (f.picsAsked || 0) < 20 * 60e3) return;
          f.picsAsked = now();
          delete st.uploads.pic; delete st.uploads.banner;
          try { await sendProfile(f); } catch (e) { log("needpics: " + e.message); f.sentV = -1; }
          await save();
          return;
        }
        // you accepted an invite they had already cancelled
        case "declined": {
          if (!f || f.state !== "connecting" || !f.code || obj.p !== await proof(f.code, "declined", from)) return;
          const code = f.code;
          await dropFriend(from);
          if (st.joined[code]) st.joined[code].state = "cancelled";
          await save(); changed("friends", { id: from, snap: f.snap, removed: true });
          return;
        }
        // a shared item (a game...) from a connected friend: the higher version wins; the same version with other data
        // goes to the Ghost with the larger id (both sides end up with the same copy). Always answered, so the sender
        // stops re-sending: "itemack" when we have theirs, our own copy when ours is newer.
        case "item": {
          if (!f || f.state !== "connected") return;
          if (!ITEM_KEY_RE.test(obj.key || "") || !ITEM_KIND_RE.test(obj.kind || "") || !Number.isInteger(obj.v) || obj.v < 1 || obj.v > 1e6) return;
          let js = ""; try { js = JSON.stringify(obj.data); } catch (e) { return; }
          if (!js || js.length > ITEM_MAX || obj.key.split(":")[0] !== obj.kind) return;
          if (!st.items) st.items = {};
          const cur = st.items[obj.key];
          if (cur && cur.with !== from) return; // an id another friend's item already uses
          const take = !cur || obj.v > cur.v || (obj.v === cur.v && JSON.stringify(cur.data) !== js && from > me.id);
          // the app checks a new version against its rules (games replay the moves); refused = kept out, but confirmed
          // so their Ghost stops re-sending it. (A same-version clash is settled by id only: nothing to replay from.)
          if (take && (!cur || obj.v > cur.v) && deps.itemCheck) {
            let ok = false;
            try { ok = deps.itemCheck(obj.kind, cur ? { v: cur.v, data: cur.data } : null, { v: obj.v, data: JSON.parse(js) }) !== false; } catch (e) { ok = false; }
            if (!ok) { log("item refused " + obj.key.slice(0, 12) + " v" + obj.v); try { await send(f, { type: "itemack", key: obj.key, v: obj.v }); } catch (e) {} return; }
          }
          if (take && !cur) itemRoom(from);
          if (take) {
            const prev = cur ? { v: cur.v, data: cur.data } : null;
            st.items[obj.key] = { key: obj.key, kind: obj.kind, with: from, v: obj.v, data: JSON.parse(js), at: now(), by: from, acked: obj.v, sentAt: now() };
            await save(); changed("item", { key: obj.key, kind: obj.kind, with: from, snap: f.snap, prev });
          }
          const mine = st.items[obj.key];
          try {
            if (mine.v > obj.v || (mine.v === obj.v && !take && JSON.stringify(mine.data) !== js)) { await send(f, itemMsg(mine)); mine.sentAt = now(); await save(); }
            else await send(f, { type: "itemack", key: obj.key, v: mine.v });
          } catch (e) { log("item reply: " + e.message); }
          return;
        }
        case "itemack": {
          const it = st.items && st.items[obj.key];
          if (!f || !it || it.with !== from || obj.v !== it.v || it.acked === it.v) return;
          it.acked = it.v; await save();
          return;
        }
        case "bye": {
          if (!f) return;
          await dropFriend(from);
          for (const j of Object.values(st.joined)) if (j.id === from) j.state = "ended";
          st.shareWith = (st.shareWith || []).filter((x) => x !== from);
          await save(); changed("friends", { id: from, snap: f.snap, removed: true });
          return;
        }
      }
    }
    async function onAccept({ from, obj, card }) {
      if (!card || typeof obj.p !== "string") return;
      let hit = null;
      for (const inv of Object.values(st.invites)) {
        if (now() - inv.created > (inv.used ? 3 * INVITE_TTL : INVITE_TTL)) continue;
        if (obj.p === await proof(inv.code, "accept", from)) { hit = inv; break; }
      }
      if (!hit) { log("accept without a live invite from " + from); return; }
      const welcome = async (fr) => send(fr, Object.assign({ type: "welcome", p: await proof(hit.code, "welcome", (await identity(false)).id) }, piInfo()));
      if (hit.cancelled) { // tell their Ghost, so it stops saying "Connecting…" (only if it's the person it was for)
        if (card.snap === hit.to && !hit.declined) {
          hit.declined = true; await save();
          try { await send({ id: from, x: card.x, inbox: await inboxOf(from) }, { type: "declined", p: await proof(hit.code, "declined", (await identity(false)).id) }); } catch (e) { log("declined: " + e.message); }
        }
        return;
      }
      if (hit.used) { // codes work once; the same Ghost asking again only means our welcome never reached it
        const again = hit.id === from && st.friends[from];
        if (again) { learnPi(again, obj); try { await welcome(again); again.sentV = -1; await sendAll(again); await save(); } catch (e) { log("welcome again: " + e.message); } }
        return;
      }
      if (card.snap !== hit.to) { hit.wrong = (hit.wrong || 0) + 1; await save(); log("invite " + hit.code + " accepted by the wrong person"); changed("invites", { code: hit.code }); return; }
      const cur = st.friends[from];
      if (cur && cur.state === "connected" && cur.snap === card.snap) {
        // already connected (you both sent invites): keep what you have, just answer
        hit.used = true; hit.id = from; learnPi(cur, obj); await save();
        try { await welcome(cur); } catch (e) { log("welcome (already connected): " + e.message); }
        return;
      }
      const old = friendBySnap(card.snap);
      if (old && old.id !== from) await dropFriend(old.id); // they reinstalled: new keys
      delete st.gone[from];
      st.friends[from] = { id: from, x: card.x, s: card.s, snap: card.snap, inbox: await inboxOf(from), state: "connected", since: now(), heard: now(), haveV: 0, sentV: -1, keyChanged: old && old.id !== from ? now() : 0 };
      learnPi(st.friends[from], obj);
      hit.used = true; hit.id = from;
      await save();
      changed("friends", { id: from, snap: card.snap, keyChanged: !!(old && old.id !== from) });
      const fr = st.friends[from];
      try { await welcome(fr); await sendAll(fr); await save(); }
      catch (e) { log("welcome: " + e.message); }
    }
    async function onProfile(f, obj) {
      if (typeof obj.v !== "number" || obj.v <= (f.haveV || 0)) return;
      const live = () => st.friends[f.id] === f; // (disconnected or left while a picture was downloading)
      if (obj.private) {
        f.profile = null; f.haveV = obj.v; f.picRefs = {};
        await Promise.all([deps.picDel(f.id + ":pic"), deps.picDel(f.id + ":banner")].map((p) => Promise.resolve(p).catch(() => {})));
        await save(); changed("profile", { id: f.id, snap: f.snap });
        return;
      }
      const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, " ").trim().slice(0, n);
      let complete = true;
      const pics = {};
      f.picRefs = f.picRefs || {};
      for (const kind of ["pic", "banner"]) {
        if (!obj[kind]) { pics[kind] = false; delete f.picRefs[kind]; await Promise.resolve(deps.picDel(f.id + ":" + kind)).catch(() => {}); continue; }
        // same upload as last time (only their name/bio changed): keep the copy we have
        if (f.profile && f.profile[kind] && obj[kind].u && f.picRefs[kind] === obj[kind].u) { pics[kind] = true; continue; }
        try {
          const blob = await fetchPic(obj[kind]);
          if (!live()) return;
          await deps.picPut(f.id + ":" + kind, blob); pics[kind] = true; f.picRefs[kind] = obj[kind].u;
          if (!live()) { await Promise.resolve(deps.picDel(f.id + ":" + kind)).catch(() => {}); return; }
        }
        catch (e) { complete = false; pics[kind] = !!(f.profile && f.profile[kind]); log(kind + " from " + f.id + ": " + e.message); }
      }
      if (!live()) return;
      f.profile = { name: clean(obj.name, LIMITS.name), bio: clean(obj.bio, LIMITS.bio), accent: ACCENTS.includes(obj.accent) ? obj.accent : "", pic: pics.pic, banner: pics.banner };
      if (complete) f.haveV = obj.v; // a picture that expired on ntfy.sh is asked for again at the next sync
      else if (f.cap >= 2 && now() - (f.needAsked || 0) > 30 * 60e3) { // ...and right away, from builds that understand it
        f.needAsked = now();
        try { await send(f, { type: "needpics" }); } catch (e) { log("needpics ask: " + e.message); }
      }
      await save(); changed("profile", { id: f.id, snap: f.snap });
    }

    // ---- public API ----
    const api = {
      parseInvite, inviteText, INVITE_TTL, LIMITS, ACCENTS,
      async init() { await state(); if (st.on) await identity(false); return api; },
      get ready() { return !!st; },
      isOn() { return !!(st && st.on); },
      myId() { return ident ? ident.id : null; },
      async myIdentity() { await state(); const me = await identity(true); return { id: me.id, inbox: me.inbox }; },
      friends() { return st ? Object.values(st.friends) : []; },
      friendBySnap(snap) { return st && snap ? friendBySnap(snap) : null; },
      connected(snap) { const f = api.friendBySnap(snap); return !!(f && f.state === "connected"); },
      // anything to check the inbox for: friends, or an invite still in play
      hasWork() {
        if (!st || !st.on) return false;
        if (Object.keys(st.friends).length || st.farewell || Object.values(st.gone).some((g) => !g.sent)) return true;
        return Object.values(st.invites).some((i) => !i.used && !i.cancelled && now() - i.created < INVITE_TTL);
      },
      profile() { return st ? Object.assign({}, st.profile) : blank().profile; },
      // ---- shared items (see ITEM_KEY_RE) ----
      items(kind) { return st ? Object.values(st.items || {}).filter((it) => !kind || it.kind === kind).map((it) => JSON.parse(JSON.stringify(it))) : []; },
      item(key) { const it = st && st.items && st.items[key]; return it ? JSON.parse(JSON.stringify(it)) : null; },
      newItemKey(kind) { return kind + ":" + b32(rand(10)).slice(0, 16).toLowerCase(); },
      // store a new version and send it; v must be higher than the stored one. Resolves once stored (sending may fail:
      // sync() re-sends until the friend confirms).
      async putItem({ key, kind, with: withId, v, data }) {
        await state();
        const f = st.friends[withId];
        if (!f || f.state !== "connected") throw new Error("not connected on Ghost");
        if (!ITEM_KEY_RE.test(key || "") || key.split(":")[0] !== kind || !ITEM_KIND_RE.test(kind || "")) throw new Error("bad item key");
        const js = JSON.stringify(data);
        if (!js || js.length > ITEM_MAX) throw new Error("item too big");
        if (!st.items) st.items = {};
        const cur = st.items[key];
        if (cur && cur.with !== withId) throw new Error("item belongs to another friend");
        if (!Number.isInteger(v) || v < 1 || (cur && v <= cur.v)) throw new Error("stale version");
        const me = await identity(false);
        if (!cur) itemRoom(withId);
        const it = { key, kind, with: withId, v, data: JSON.parse(js), at: now(), by: me ? me.id : "", acked: 0, sentAt: 0 };
        st.items[key] = it;
        await save(); changed("item", { key, kind, with: withId, snap: f.snap, local: true, prev: cur ? { v: cur.v, data: cur.data } : null });
        try { await send(f, itemMsg(it)); it.sentAt = now(); await save(); } catch (e) { log("item send: " + e.message); }
        return JSON.parse(JSON.stringify(it));
      },
      async dropItem(key) { await state(); if (st.items && st.items[key]) { delete st.items[key]; await save(); } },
      // chat extras with a connected friend (by their Snapchat id): [{k, v, by, d}] incl. tombstones; mine() = my Ghost ID
      extras(snap) {
        const f = st && snap ? friendBySnap(snap) : null;
        if (!f || f.state !== "connected") return null;
        return { friendId: f.id, myId: ident ? ident.id : null, items: Object.values(xbox(f.id).items).map((i) => Object.assign({}, i)) };
      },
      async setExtra(snap, k, d) {
        await state();
        const f = friendBySnap(snap), me = await identity(false);
        if (!f || f.state !== "connected" || !me) throw new Error("Not connected on Ghost");
        const cur = xbox(f.id).items[k];
        const it = { k, v: Math.max(now(), cur ? cur.v + 1 : 0), by: me.id, d: d == null ? null : d };
        if (!xapply(f.id, it)) throw new Error("Couldn't change that");
        await save(); changed("extras", { id: f.id, snap: f.snap });
        try { await xsend(f, [it]); } catch (e) { log("extras send: " + e.message); } // (sync sends it again if this didn't get out)
        return it;
      },
      // a sticker picture: encrypted with a fresh key and uploaded (ntfy.sh keeps it 3 h; xneed re-uploads)
      async putPicture(blob) {
        if (!blob || blob.size > MAX_PIC) throw new Error("picture too big");
        const bytes = u8(await blob.arrayBuffer());
        const keyBytes = rand(32), iv = rand(12);
        const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
        const ct = u8(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
        return { u: await upload(ct), k: b64(keyBytes), i: b64(iv), t: /^image\/(png|webp|jpeg)$/.test(blob.type) ? blob.type : "image/png" };
      },
      async getPicture(ref) { return fetchPic(ref); },
      async askPicture(snap, k) {
        const f = st && friendBySnap(snap);
        if (!f || f.state !== "connected") return;
        f.xasked = f.xasked || {};
        if (now() - (f.xasked[k] || 0) < 20 * 60e3) return;
        f.xasked[k] = now();
        try { await send(f, { type: "xneed", k }); await save(); } catch (e) { log("xneed ask: " + e.message); }
      },
      share() { return { mode: st.share, with: (st.shareWith || []).slice() }; },
      inviteFor(convId) { // the newest live invite you sent in this chat
        if (!st) return null;
        return Object.values(st.invites).filter((i) => i.conv === convId && !i.used && !i.cancelled && now() - i.created < INVITE_TTL).sort((a, b) => b.created - a.created)[0] || null;
      },
      // what a "ghost:connect" message should show. fromMe: your own invite. sender: the Snapchat id who sent it.
      inviteState(code, fromMe, sender, ts) {
        if (!st) return "off";
        if (!st.on) return "off";
        if (fromMe) {
          const inv = st.invites[code];
          if (!inv) return "unknown"; // sent from another device / an older install
          if (inv.cancelled) return "cancelled";
          if (inv.used) return st.friends[inv.id] && st.friends[inv.id].state === "connected" ? "connected" : "ended";
          return now() - inv.created > INVITE_TTL ? "expired" : "waiting";
        }
        const j = st.joined[code];
        if (j && j.state === "ended") return "ended"; // you were connected through this invite, then disconnected
        if (j && j.state === "cancelled") return "cancelled"; // they cancelled it before your Ghost reached theirs
        if (j && j.state === "connected" && st.friends[j.id]) return "connected";
        const known = friendBySnap(sender);
        if (known && known.state === "connected" && (!j || j.id === known.id)) return "connected";
        if (j && j.state === "connecting" && st.friends[j.id]) return now() - (ts || j.at) > INVITE_TTL ? "failed" : "connecting";
        if (now() - (ts || 0) > INVITE_TTL) return "expired";
        return "connect";
      },
      // a friend's Ghost came back with new keys (reinstall, or a new phone): shown until you've seen it
      async ackKeyChange(id) { await state(); if (st.friends[id]) { st.friends[id].keyChanged = 0; await save(); } },
      async setOn(on) {
        await state(); st.on = !!on; await save();
        if (on) await identity(false);
        changed("on", { on: st.on });
      },
      // Chat options > Connect on Ghost: returns the visible text to send in that chat
      async createInvite(convId, toSnap) {
        await state();
        if (!st.on) throw new Error("Ghost Network is off");
        if (!toSnap) throw new Error("only 1:1 chats");
        if (!(deps.me() && deps.me().id)) throw new Error("not signed in yet");
        const me = await identity(true);
        const code = newCode();
        const card = await makeCard(me, deps.me() && deps.me().id, now());
        const key = await rvKey(code), iv = rand(12);
        const ct = u8(await subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(card))));
        await post(await rvTopic(code), JSON.stringify({ g: 1, rv: 1, i: b64(iv), c: b64(ct) }));
        st.invites[code] = { code, conv: convId, to: toSnap, created: now(), posted: now(), used: false };
        await save(); changed("invites", { code });
        return inviteText(code);
      },
      // the Connect button on a friend's invite
      async accept(code, sender, convId) {
        await state();
        if (!st.on) throw new Error("Turn on Ghost Network in Settings > Privacy first");
        const me = await identity(true);
        const key = await rvKey(code);
        let card = null;
        const ids = new Set();
        for (const m of await poll(await rvTopic(code), "all")) {
          try {
            const o = JSON.parse(m.message);
            if (!o || o.rv !== 1) continue;
            const c = await readCard(JSON.parse(td.decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(o.i) }, key, unb64(o.c)))));
            if (c.snap !== sender) { log("rendezvous card isn't from the sender"); continue; }
            ids.add(c.id); card = card || c; // (the inviter reposts its card every 10 h: same Ghost, same id)
          } catch (e) {}
        }
        // two different Ghosts both claiming to be the sender: someone else has the code. Don't guess.
        if (ids.size > 1) { log("invite " + code + ": " + ids.size + " different Ghosts answered"); throw new Error("Two different Ghosts answered this invite, so it isn't safe. Ask them to send a new one."); }
        if (!card) throw new Error("Couldn't find their Ghost. Ask them to open Ghost, or to send a new invite.");
        if (card.id === me.id) throw new Error("That's your own invite");
        const old = friendBySnap(card.snap);
        if (old && old.id !== card.id) await dropFriend(old.id);
        const f = st.friends[card.id] && st.friends[card.id].state === "connected" ? st.friends[card.id]
          : { id: card.id, x: card.x, s: card.s, snap: card.snap, inbox: await inboxOf(card.id), state: "connecting", code, since: now(), haveV: 0, sentV: -1, keyChanged: old && old.id !== card.id ? now() : 0 };
        st.friends[card.id] = f;
        st.joined[code] = { id: card.id, state: f.state, at: now(), conv: convId };
        const myCard = await makeCard(me, deps.me() && deps.me().id, now());
        await send(f, Object.assign({ type: "accept", p: await proof(code, "accept", me.id), card: myCard }, piInfo()));
        await save(); changed("friends", { id: card.id, snap: card.snap });
        return f.state;
      },
      // one round: read the inbox, repost rendezvous cards about to expire, resend accepts that are still waiting
      async poll() {
        await state();
        if (!st.on || leaving) return 0;
        if (busy) return busy;
        busy = (async () => {
          await farewells();
          const me = await identity(false);
          if (!me) return 0;
          let n = 0;
          // the private inbox (connected friends on build 81+) and the public one (invites, older builds)
          for (const topic of [st.pi, me.inbox]) {
            let msgs = [];
            try { msgs = await poll(topic, st.since[topic]); } catch (e) { if (topic === me.inbox) throw e; log("poll pi: " + e.message); continue; }
            for (const m of msgs.slice(0, 300)) {
              if (leaving) return n;
              st.since[topic] = m.id; n++;
              try { await handle(m); } catch (e) { log("handle: " + e.message); }
            }
          }
          for (const inv of Object.values(st.invites)) {
            if (inv.used || inv.cancelled || now() - inv.created > INVITE_TTL) { if (now() - inv.created > 3 * INVITE_TTL) delete st.invites[inv.code]; continue; }
            if (now() - (inv.posted || 0) > RV_REPOST) {
              try {
                const card = await makeCard(me, deps.me() && deps.me().id, now());
                const key = await rvKey(inv.code), iv = rand(12);
                const ct = u8(await subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(card))));
                await post(await rvTopic(inv.code), JSON.stringify({ g: 1, rv: 1, i: b64(iv), c: b64(ct) }));
                inv.posted = now();
              } catch (e) { log("repost invite: " + e.message); }
            }
          }
          await save();
          return n;
        })().finally(() => { busy = null; });
        return busy;
      },
      // on launch: tell each friend which profile version we have, so missing profiles/pictures are resent
      async sync(force) {
        await state();
        if (!st.on || !(await identity(false))) return;
        for (const f of Object.values(st.friends)) {
          try {
            if (f.state === "connecting") {
              const j = Object.entries(st.joined).find(([, x]) => x.id === f.id && x.state === "connecting");
              if (j && f.code && now() - j[1].at < INVITE_TTL && now() - (f.lastSync || 0) > SYNC_FORCED) {
                const me = await identity(false);
                await send(f, Object.assign({ type: "accept", p: await proof(f.code, "accept", me.id), card: await makeCard(me, deps.me() && deps.me().id, now()) }, piInfo()));
                f.lastSync = now();
              }
              continue;
            }
            // a profile or status that didn't get out earlier (network down, a picture upload failed)
            if (f.sentV !== st.profile.v && now() - (f.retryAt || 0) > 10 * 60e3) { f.retryAt = now(); try { await sendProfile(f); } catch (e) { log("profile retry " + f.id + ": " + e.message); } }
            if (st.status.v && f.sentSV !== st.status.v && f.cap >= 2) { try { await sendStatus(f); } catch (e) { log("status retry: " + e.message); } }
            // shared items the friend hasn't confirmed yet (a move they may have missed while offline for days)
            for (const it of Object.values(st.items || {})) {
              if (it.with !== f.id || it.acked === it.v || now() - (it.sentAt || 0) < (force ? 60e3 : ITEM_RESEND)) continue;
              try { await send(f, itemMsg(it)); it.sentAt = now(); } catch (e) { log("item resend: " + e.message); break; }
            }
            if (now() - (f.lastSync || 0) < (force ? SYNC_FORCED : SYNC_EVERY)) continue;
            await send(f, Object.assign({ type: "sync", have: f.haveV || 0, mine: st.profile.v, shave: f.statusV || 0, sv: st.status.v }, piInfo(), xsyncInfo(f)));
            f.lastSync = now();
          } catch (e) { log("sync " + f.id + ": " + e.message); }
        }
        // goodbyes that didn't get through; forget disconnected friends after a week
        for (const g of Object.values(st.gone)) {
          if (now() - g.at > GONE_KEEP) { delete st.gone[g.id]; continue; }
          if (!g.sent && now() - (g.lastBye || 0) > SYNC_FORCED) await sayBye(g);
        }
        await save();
      },
      // My Ghost Profile. pic/banner: a Blob to set, null to remove, undefined to keep.
      async setProfile(patch) {
        await state();
        await identity(true);
        const p = st.profile;
        if (patch.name !== undefined) p.name = String(patch.name || "").trim().slice(0, LIMITS.name);
        if (patch.bio !== undefined) p.bio = String(patch.bio || "").trim().slice(0, LIMITS.bio);
        if (patch.accent !== undefined) p.accent = ACCENTS.includes(patch.accent) ? patch.accent : "";
        for (const kind of ["pic", "banner"]) {
          if (patch[kind] === undefined) continue;
          if (patch[kind]) { await deps.picPut("me:" + kind, patch[kind]); p[kind] = true; }
          else { await Promise.resolve(deps.picDel("me:" + kind)).catch(() => {}); p[kind] = false; }
          delete st.uploads[kind];
        }
        p.v = (p.v || 0) + 1;
        await save(); changed("me", {});
        await pushProfileToAll();
      },
      async setShare(mode, list) {
        await state();
        st.share = mode === "chosen" ? "chosen" : "all";
        if (Array.isArray(list)) st.shareWith = list.filter((id) => st.friends[id]);
        st.profile.v = (st.profile.v || 0) + 1; // everyone re-checks what they may see
        st.status.v = (st.status.v || 0) + 1;
        await save(); changed("me", {});
        await pushProfileToAll();
        await pushStatusToAll();
      },
      // the status line: text ("" clears it) and when it clears itself (0 = never)
      status() { const s = st ? st.status : null; return s && s.text && (!s.until || s.until > now()) ? { text: s.text, until: s.until || 0 } : null; },
      async setStatus(text, until) {
        await state();
        await identity(true);
        text = String(text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, LIMITS.status);
        st.status = { v: (st.status.v || 0) + 1, text, until: text ? Math.max(0, Number(until) || 0) : 0 };
        await save(); changed("me", {});
        await pushStatusToAll();
      },
      // a connected friend's status, while it lasts
      friendStatus(id) { const f = st && st.friends[id]; return f && f.status && f.status.text && (!f.status.until || f.status.until > now()) ? f.status : null; },
      // invites you sent that are still waiting
      pendingInvites() {
        if (!st) return [];
        return Object.values(st.invites).filter((i) => !i.used && !i.cancelled && now() - i.created < INVITE_TTL)
          .sort((a, b) => b.created - a.created).map((i) => ({ code: i.code, conv: i.conv, to: i.to, created: i.created, expires: i.created + INVITE_TTL }));
      },
      // the invite message never made it into the chat: forget it (no "Invite sent · waiting" for 24 h)
      async forgetInvite(code) { await state(); if (st.invites[code] && !st.invites[code].used) { delete st.invites[code]; await save(); changed("invites", { code }); } },
      async cancelInvite(code) {
        await state();
        const inv = st.invites[code];
        if (!inv || inv.used) return false;
        inv.cancelled = true;
        await save(); changed("invites", { code });
        return true;
      },
      // the safety code for a connected friend: the same 12 digits on both phones as long as both keys are the ones
      // you connected with (compare in person or on a call)
      async safetyCode(id) {
        await state();
        const f = st.friends[id], me = await identity(false);
        if (!f || !me) return null;
        const [a, b] = [me.id, f.id].sort();
        const h = await sha256("ghost-safety-v1|" + a + "|" + b);
        let n = 0n; for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
        const digits = String(n % 1000000000000n).padStart(12, "0");
        return digits.slice(0, 4) + " " + digits.slice(4, 8) + " " + digits.slice(8);
      },
      async setVerified(id, on) { await state(); const f = st.friends[id]; if (!f) return; f.verified = on ? now() : 0; await save(); changed("profile", { id, snap: f.snap }); },
      async disconnect(id) {
        await state();
        const f = st.friends[id];
        if (!f) return;
        tombstone(f, false);
        await sayBye(st.gone[id]);
        await dropFriend(id);
        for (const j of Object.values(st.joined)) if (j.id === id) j.state = "ended";
        st.shareWith = (st.shareWith || []).filter((x) => x !== id);
        await save(); changed("friends", { id, snap: f.snap, removed: true });
      },
      // Leave Ghost Network: tell every connected Ghost, then delete the keys and everything received
      // (a "bye" that fails is retried for 3 days with the old keys, kept only for that)
      async leave() {
        await state();
        leaving = true;
        try {
          if (busy) await busy.catch(() => {});
          const keyText = await Promise.resolve(deps.keysGet()).catch(() => null);
          let parked = false; // the old keys stay only in the Keychain's "farewell" slot, only while byes are owed
          const unsent = [];
          const all = Object.values(st.friends).concat(Object.values(st.gone).filter((g) => !g.sent));
          for (const f of all) {
            let ok = false;
            try { await send(f, { type: "bye" }); ok = true; } catch (e) { log("bye: " + e.message); }
            if (!ok) unsent.push({ id: f.id, x: f.x, inbox: f.inbox, pi: f.pi, cap: f.cap });
            if (st.friends[f.id]) await dropFriend(f.id);
          }
          await Promise.all([deps.picDel("me:pic"), deps.picDel("me:banner")].map((p) => Promise.resolve(p).catch(() => {})));
          if (unsent.length && keyText && deps.farewellKeys) { try { await deps.farewellKeys.set(keyText); parked = true; } catch (e) { log("farewell keys: " + e.message); } }
          try { await deps.keysDelete(); } catch (e) {}
          ident = null;
          const on = st.on, joined = st.joined;
          st = blank(); st.on = on;
          st.pi = "gh-pi-" + b32(rand(17)).slice(0, 26);
          // invites you accepted stay "ended" (they can't work any more: the other Ghost knew your old keys)
          for (const [code, j] of Object.entries(joined || {})) st.joined[code] = Object.assign({}, j, { state: "ended" });
          if (unsent.length && parked) st.farewell = { to: unsent, until: now() + 3 * 24 * 3600e3 };
          await save(); changed("left", {});
        } finally { leaving = false; }
      },
    };
    return api;
  }

  return { create, parseInvite, inviteText, _test: { seal, unseal, seal2, unseal2, loadIdentity, newKeyFile, makeCard, readCard, proof, newCode, rvTopic, b32 } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = GhostNetCore;
