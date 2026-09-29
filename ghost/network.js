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
//   - Invite    = the visible chat text "ghost:connect XXXX-XXXX-XXXX" (60 random bits). The inviter posts its signed card
//     (Ghost ID + public keys + Snapchat user id), AES-GCM encrypted with a key from the code, to a rendezvous topic derived
//     from the code. The friend's Ghost reads it, checks the card belongs to whoever sent the chat message, and sends an
//     "accept" (its own card + an HMAC proof of the code) to the inviter's inbox. The inviter checks the proof, that the
//     acceptor's Snapchat id is the person the invite was sent to, and that the code is unused and < 24 h old; then both
//     are connected ("welcome" back). Codes work once.
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
  const MAX_PIC = 3 * 1024 * 1024;
  const LIMITS = { name: 40, bio: 300 };
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
  //       load() -> state|null, save(state)
  //       picGet(key) -> Blob|null, picPut(key, Blob), picDel(key)
  //       me() -> {id, name} (the Snapchat account), now() -> ms, onChange(what, detail), log(text)
  function create(deps) {
    const now = () => (deps.now ? deps.now() : Date.now());
    const log = (t) => { try { deps.log && deps.log(t); } catch (e) {} };
    let st = null, ident = null, identP = null, busy = null;
    const blank = () => ({ v: 1, on: true, friends: {}, invites: {}, joined: {}, since: {}, seen: [], share: "all", shareWith: [],
      profile: { v: 0, name: "", bio: "", accent: "", pic: false, banner: false }, uploads: {} });
    async function state() {
      if (st) return st;
      let s = null; try { s = await deps.load(); } catch (e) {}
      st = Object.assign(blank(), s && s.v === 1 ? s : {});
      return st;
    }
    const save = () => deps.save(JSON.parse(JSON.stringify(st)));
    const changed = (what, detail) => { try { deps.onChange && deps.onChange(what, detail); } catch (e) { log("onChange " + e.message); } };

    async function identity(create) {
      if (ident) return ident;
      if (identP) return identP;
      identP = (async () => {
        let text = null; try { text = await deps.keysGet(); } catch (e) {}
        if (text) { try { ident = await loadIdentity(text); return ident; } catch (e) { log("keys unreadable: " + e.message); } }
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
      const r = await deps.gnet(args);
      if (!r || typeof r.status !== "number") throw new Error("Ghost network isn't reachable");
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
      if (up && up.v === st.profile.v && now() - up.at < PIC_REUPLOAD) return up.ref;
      const blob = await deps.picGet("me:" + kind);
      if (!blob) return null;
      const bytes = u8(await blob.arrayBuffer());
      const keyBytes = rand(32), iv = rand(12);
      const key = await subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const ct = u8(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
      const ref = { u: await upload(ct), k: b64(keyBytes), i: b64(iv), t: blob.type || "image/jpeg" };
      st.uploads[kind] = { v: st.profile.v, at: now(), ref };
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
      const text = await seal(me, friend, Object.assign({ ts: now(), n: nonce() }, obj));
      await post(friend.inbox, text);
    }
    const canShare = (f) => st.share === "all" || (st.shareWith || []).includes(f.id);
    async function sendProfile(f) {
      if (!canShare(f)) { await send(f, { type: "profile", v: st.profile.v, private: true }); f.sentV = st.profile.v; return; }
      const p = st.profile;
      const [pic, banner] = await Promise.all([p.pic ? uploadPic("pic").catch((e) => { log("pic upload " + e.message); return null; }) : null,
        p.banner ? uploadPic("banner").catch((e) => { log("banner upload " + e.message); return null; }) : null]);
      await send(f, { type: "profile", v: p.v, name: p.name, bio: p.bio, accent: p.accent, pic, banner });
      f.sentV = p.v;
    }
    async function pushProfileToAll() {
      for (const f of Object.values(st.friends)) {
        if (f.state !== "connected" || f.sentV === st.profile.v) continue;
        try { await sendProfile(f); } catch (e) { log("profile to " + f.id + ": " + e.message); }
      }
      await save();
    }

    // ---- receiving ----
    function remember(n) {
      if (typeof n !== "string" || st.seen.includes(n)) return false;
      st.seen.push(n); if (st.seen.length > 500) st.seen.splice(0, st.seen.length - 500);
      return true;
    }
    async function dropFriend(id) {
      const f = st.friends[id];
      if (!f) return;
      delete st.friends[id];
      await Promise.all([deps.picDel(id + ":pic"), deps.picDel(id + ":banner")].map((p) => Promise.resolve(p).catch(() => {})));
      return f;
    }
    function friendBySnap(snap) { return Object.values(st.friends).find((f) => f.snap === snap) || null; }
    async function handle(msg) {
      const me = await identity(false);
      if (!me || typeof msg.message !== "string" || msg.message[0] !== "{") return;
      let got = null;
      try { got = await unseal(me, msg.message, (id) => st.friends[id] && st.friends[id].s); } catch (e) { log("unreadable message: " + e.message); return; }
      if (!got) return;
      const { from, obj } = got;
      if (typeof obj.ts !== "number" || obj.ts < now() - 48 * 3600e3 || obj.ts > now() + 3600e3 || !remember(obj.n)) return;
      const f = st.friends[from];
      if (f && f.since && obj.ts < f.since - 10 * 60e3 && obj.type !== "welcome") return; // older than this connection (replayed; 10 min for clock drift)
      switch (obj.type) {
        case "accept": return onAccept(got);
        case "welcome": {
          if (!f || f.state !== "connecting" || !f.code || obj.p !== await proof(f.code, "welcome", from)) return;
          f.state = "connected"; f.since = now(); delete f.code;
          for (const j of Object.values(st.joined)) if (j.id === from && j.state === "connecting") j.state = "connected";
          await save(); changed("friends", { id: from, snap: f.snap });
          try { await sendProfile(f); await save(); } catch (e) { log("profile after welcome: " + e.message); }
          return;
        }
        case "profile": return f ? onProfile(f, obj) : undefined;
        case "sync": {
          if (!f || f.state !== "connected") return;
          if (obj.have !== st.profile.v) { try { await sendProfile(f); } catch (e) { log("sync reply: " + e.message); } }
          if (typeof obj.mine === "number" && obj.mine > (f.haveV || 0) && !obj.reply) { try { await send(f, { type: "sync", have: f.haveV || 0, mine: st.profile.v, reply: true }); } catch (e) {} }
          await save();
          return;
        }
        case "bye": {
          if (!f) return;
          await dropFriend(from);
          for (const j of Object.values(st.joined)) if (j.id === from) j.state = "ended";
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
      if (hit.used) { // codes work once; the same Ghost asking again only means our welcome never reached it
        const again = hit.id === from && st.friends[from];
        if (again) { try { await send(again, { type: "welcome", p: await proof(hit.code, "welcome", (await identity(false)).id) }); again.sentV = -1; await sendProfile(again); await save(); } catch (e) { log("welcome again: " + e.message); } }
        return;
      }
      if (card.snap !== hit.to) { hit.wrong = (hit.wrong || 0) + 1; await save(); log("invite " + hit.code + " accepted by the wrong person"); changed("invites", { code: hit.code }); return; }
      const old = friendBySnap(card.snap);
      if (old && old.id !== from) await dropFriend(old.id); // they reinstalled: new keys
      st.friends[from] = { id: from, x: card.x, s: card.s, snap: card.snap, inbox: await inboxOf(from), state: "connected", since: now(), haveV: 0, sentV: -1, keyChanged: old && old.id !== from ? now() : 0 };
      hit.used = true; hit.id = from;
      await save();
      changed("friends", { id: from, snap: card.snap, keyChanged: !!(old && old.id !== from) });
      const fr = st.friends[from];
      try { await send(fr, { type: "welcome", p: await proof(hit.code, "welcome", (await identity(false)).id) }); await sendProfile(fr); await save(); }
      catch (e) { log("welcome: " + e.message); }
    }
    async function onProfile(f, obj) {
      if (typeof obj.v !== "number" || obj.v <= (f.haveV || 0)) return;
      if (obj.private) {
        f.profile = null; f.haveV = obj.v;
        await Promise.all([deps.picDel(f.id + ":pic"), deps.picDel(f.id + ":banner")].map((p) => Promise.resolve(p).catch(() => {})));
        await save(); changed("profile", { id: f.id, snap: f.snap });
        return;
      }
      const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, " ").trim().slice(0, n);
      let complete = true;
      const pics = {};
      for (const kind of ["pic", "banner"]) {
        if (!obj[kind]) { pics[kind] = false; await Promise.resolve(deps.picDel(f.id + ":" + kind)).catch(() => {}); continue; }
        try { await deps.picPut(f.id + ":" + kind, await fetchPic(obj[kind])); pics[kind] = true; }
        catch (e) { complete = false; pics[kind] = !!(f.profile && f.profile[kind]); log(kind + " from " + f.id + ": " + e.message); }
      }
      f.profile = { name: clean(obj.name, LIMITS.name), bio: clean(obj.bio, LIMITS.bio), accent: ACCENTS.includes(obj.accent) ? obj.accent : "", pic: pics.pic, banner: pics.banner };
      if (complete) f.haveV = obj.v; // a picture that expired on ntfy.sh is asked for again at the next sync
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
        if (Object.keys(st.friends).length) return true;
        return Object.values(st.invites).some((i) => !i.used && now() - i.created < INVITE_TTL);
      },
      profile() { return st ? Object.assign({}, st.profile) : blank().profile; },
      share() { return { mode: st.share, with: (st.shareWith || []).slice() }; },
      inviteFor(convId) { // the newest live invite you sent in this chat
        if (!st) return null;
        return Object.values(st.invites).filter((i) => i.conv === convId && !i.used && now() - i.created < INVITE_TTL).sort((a, b) => b.created - a.created)[0] || null;
      },
      // what a "ghost:connect" message should show. fromMe: your own invite. sender: the Snapchat id who sent it.
      inviteState(code, fromMe, sender, ts) {
        if (!st) return "off";
        if (!st.on) return "off";
        if (fromMe) {
          const inv = st.invites[code];
          if (!inv) return "unknown"; // sent from another device / an older install
          if (inv.used) return st.friends[inv.id] && st.friends[inv.id].state === "connected" ? "connected" : "ended";
          return now() - inv.created > INVITE_TTL ? "expired" : "waiting";
        }
        const j = st.joined[code];
        if (j && j.state === "ended") return "ended"; // you were connected through this invite, then disconnected
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
        for (const m of await poll(await rvTopic(code), "all")) {
          try {
            const o = JSON.parse(m.message);
            if (!o || o.rv !== 1) continue;
            const c = await readCard(JSON.parse(td.decode(await subtle.decrypt({ name: "AES-GCM", iv: unb64(o.i) }, key, unb64(o.c)))));
            if (c.snap !== sender) { log("rendezvous card isn't from the sender"); continue; }
            card = c; break;
          } catch (e) {}
        }
        if (!card) throw new Error("Couldn't find their Ghost. Ask them to open Ghost, or to send a new invite.");
        if (card.id === me.id) throw new Error("That's your own invite");
        const old = friendBySnap(card.snap);
        if (old && old.id !== card.id) await dropFriend(old.id);
        const f = st.friends[card.id] && st.friends[card.id].state === "connected" ? st.friends[card.id]
          : { id: card.id, x: card.x, s: card.s, snap: card.snap, inbox: await inboxOf(card.id), state: "connecting", code, since: now(), haveV: 0, sentV: -1, keyChanged: old && old.id !== card.id ? now() : 0 };
        st.friends[card.id] = f;
        st.joined[code] = { id: card.id, state: f.state, at: now(), conv: convId };
        const myCard = await makeCard(me, deps.me() && deps.me().id, now());
        await send(f, { type: "accept", p: await proof(code, "accept", me.id), card: myCard });
        await save(); changed("friends", { id: card.id, snap: card.snap });
        return f.state;
      },
      // one round: read the inbox, repost rendezvous cards about to expire, resend accepts that are still waiting
      async poll() {
        await state();
        if (!st.on) return 0;
        if (busy) return busy;
        busy = (async () => {
          const me = await identity(false);
          if (!me) return 0;
          let n = 0;
          const msgs = await poll(me.inbox, st.since[me.inbox]);
          for (const m of msgs) { st.since[me.inbox] = m.id; n++; try { await handle(m); } catch (e) { log("handle: " + e.message); } }
          for (const inv of Object.values(st.invites)) {
            if (inv.used || now() - inv.created > INVITE_TTL) { if (now() - inv.created > 3 * INVITE_TTL) delete st.invites[inv.code]; continue; }
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
              if (j && f.code && now() - j[1].at < INVITE_TTL && (force || now() - (f.lastSync || 0) > 3600e3)) {
                const me = await identity(false);
                await send(f, { type: "accept", p: await proof(f.code, "accept", me.id), card: await makeCard(me, deps.me() && deps.me().id, now()) });
                f.lastSync = now();
              }
              continue;
            }
            if (!force && now() - (f.lastSync || 0) < SYNC_EVERY) continue;
            await send(f, { type: "sync", have: f.haveV || 0, mine: st.profile.v });
            f.lastSync = now();
          } catch (e) { log("sync " + f.id + ": " + e.message); }
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
        await save(); changed("me", {});
        await pushProfileToAll();
      },
      async disconnect(id) {
        await state();
        const f = st.friends[id];
        if (!f) return;
        try { await send(f, { type: "bye" }); } catch (e) { log("bye: " + e.message); }
        await dropFriend(id);
        for (const j of Object.values(st.joined)) if (j.id === id) j.state = "ended";
        st.shareWith = (st.shareWith || []).filter((x) => x !== id);
        await save(); changed("friends", { id, snap: f.snap, removed: true });
      },
      // Leave Ghost Network: tell every connected Ghost, then delete the keys and everything received
      async leave() {
        await state();
        for (const f of Object.values(st.friends)) { try { await send(f, { type: "bye" }); } catch (e) {} await dropFriend(f.id); }
        await Promise.all([deps.picDel("me:pic"), deps.picDel("me:banner")].map((p) => Promise.resolve(p).catch(() => {})));
        try { await deps.keysDelete(); } catch (e) {}
        ident = null;
        const on = st.on;
        st = blank(); st.on = on;
        await save(); changed("left", {});
      },
    };
    return api;
  }

  return { create, parseInvite, inviteText, _test: { seal, unseal, loadIdentity, newKeyFile, makeCard, readCard, proof, newCode, rvTopic, b32 } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = GhostNetCore;
