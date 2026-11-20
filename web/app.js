(() => {
  // native.js
  /* Capacitor exists only inside the Android wrapper. In a browser NATIVE is
     null and every caller falls back to the web APIs. */
  var NATIVE = typeof window !== "undefined" && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Foreground || null;
  /* Once the wrapper's keep-visible workaround has run, the WebView reports
     itself visible even with the phone locked, so the page's own visibility
     flag stops telling the truth. Inside the wrapper Android reports the real
     state instead. */
  var nativeAway = NATIVE ? false : null;
  var appAway = () => nativeAway !== null ? nativeAway : document.hidden;

  // crypto.js
  typeof window !== "undefined" && window.__boot && window.__boot.mark("crypto");
  var te = new TextEncoder();
  var td = new TextDecoder();
  var bytesToHex = (b, sep = ":") => Array.from(b).map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(sep);
  function hexToBytes(h) {
    const c = h.replace(/[^0-9a-fA-F]/g, "");
    const o = new Uint8Array(c.length / 2);
    for (let i = 0; i < o.length; i++) o[i] = parseInt(c.substr(i * 2, 2), 16);
    return o;
  }
  var concat = (...arrs) => {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) {
      out.set(a, o);
      o += a.length;
    }
    return out;
  };
  async function newIdentity() {
    return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  }
  var exportPub = (key) => crypto.subtle.exportKey("raw", key).then((b) => new Uint8Array(b));
  var importPub = (raw) => crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  var sign = (priv, bytes) => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, bytes).then((b) => new Uint8Array(b));
  var verify = (pub, sig, bytes) => crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, bytes);
  async function fingerprintOf(pubRaw) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", pubRaw));
    return bytesToHex(d.slice(0, 8), "");
  }
  async function deriveSessionKeys(secret, fpA, fpB, ufA, ufB) {
    /* The certificates behind fpA and fpB last for years, and the message
       counter restarts at zero on every connection, so keys from the
       fingerprints alone would repeat AES-GCM nonces across reconnects. Both
       sides' ICE usernames are fresh random values for each connection and
       both phones see both of them, so mixing them in gives every connection
       its own keys. */
    const pair = [bytesToHex(fpA, ""), bytesToHex(fpB, "")].sort().join("") + "|" + [String(ufA || ""), String(ufB || "")].sort().join("|");
    const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(pair)));
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    const mk = (info) => crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    return { a2b: await mk("cyanotype/v3/a2b"), b2a: await mk("cyanotype/v3/b2a") };
  }
  async function deriveCarryKey(secret, idA, idB) {
    const pair = [idA, idB].sort().join("");
    const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(pair)));
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: te.encode("cyanotype/v2/carry") },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }
  var b64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode(...u8.subarray(i, i + 8192));
    return btoa(s);
  };
  var unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function sha256Hex(bytes) {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return bytesToHex(d.slice(0, 8), "");
  }
  var importGroupKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  var newGroupKey = () => crypto.getRandomValues(new Uint8Array(32));
  function nonceFor(counter, stream = 0) {
    const n = new Uint8Array(12), dv = new DataView(n.buffer);
    dv.setUint32(0, stream >>> 0);
    dv.setUint32(4, Math.floor(counter / 2 ** 32));
    dv.setUint32(8, counter >>> 0);
    return n;
  }
  async function seal(key, counter, payload, stream = 0) {
    const bytes = typeof payload === "string" ? te.encode(payload) : new Uint8Array(payload);
    const n = nonceFor(counter, stream);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: n }, key, bytes));
    return concat(n, ct).buffer;
  }
  async function unseal(key, buf) {
    const a = new Uint8Array(buf);
    if (a.length < 13) throw new Error("short frame");
    const n = a.slice(0, 12);
    const dv = new DataView(n.buffer, n.byteOffset);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: n }, key, a.slice(12)));
    return {
      stream: dv.getUint32(0),
      counter: dv.getUint32(4) * 2 ** 32 + dv.getUint32(8),
      bytes: pt,
      text: () => td.decode(pt)
    };
  }
  async function safetyNumber(pubA, pubB) {
    const pair = [bytesToHex(pubA, ""), bytesToHex(pubB, "")].sort().join("");
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(pair)));
    return Array.from({ length: 8 }, (_, i) => bytesToHex(d.slice(i * 2, i * 2 + 2), ""));
  }
  var newDeviceKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  /* Ten years: the certificate is an identity anchor, not a session artefact.
     RTCCertificate is structured-cloneable, so IndexedDB can hold it without
     the private key ever being readable from script. */
  var newCertificate = () => RTCPeerConnection.generateCertificate({
    name: "ECDSA",
    namedCurve: "P-256",
    hash: "SHA-256"
  });
  async function encryptAtRest(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = typeof bytes === "string" ? te.encode(bytes) : new Uint8Array(bytes);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
    return concat(iv, ct);
  }
  async function decryptAtRest(key, blob) {
    const a = new Uint8Array(blob);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: a.slice(0, 12) }, key, a.slice(12));
    return new Uint8Array(pt);
  }
  var decryptText = async (key, blob) => td.decode(await decryptAtRest(key, blob));

  // store.js
  typeof window !== "undefined" && window.__boot && window.__boot.mark("store");
  var DB = "cyanotype";
  var VER = 2;
  var STORES = ["meta", "contacts", "conversations", "messages", "blobs", "outbox"];
  var OPEN_TIMEOUT = 6e3;
  var backend = null;
  var deviceKey = null;
  var identity = null;
  var certificate = null;
  var selfId = null;
  var selfPub = null;
  var degradedReason = null;
  var degraded = () => degradedReason;
  var uuid = () => crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  function openDb() {
    return new Promise((res, rej) => {
      let settled = false;
      const done = (fn, v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn(v);
        }
      };
      const timer = setTimeout(() => done(rej, new Error(
        "Storage did not respond. Private browsing, blocked site data, or an in-app browser can cause this."
      )), OPEN_TIMEOUT);
      let req;
      try {
        req = indexedDB.open(DB, VER);
      } catch (e) {
        return done(rej, new Error("Storage is unavailable: " + e.message));
      }
      if (!req) return done(rej, new Error("Storage is unavailable in this browser."));
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
        if (!d.objectStoreNames.contains("contacts")) d.createObjectStore("contacts", { keyPath: "id" });
        if (!d.objectStoreNames.contains("conversations")) {
          d.createObjectStore("conversations", { keyPath: "id" }).createIndex("lastAt", "lastAt");
        }
        if (!d.objectStoreNames.contains("messages")) {
          d.createObjectStore("messages", { keyPath: "id" }).createIndex("convAt", ["convId", "at"]);
        }
        if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "id" });
        if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath: "id" });
      };
      req.onsuccess = () => done(res, req.result);
      req.onerror = () => done(rej, req.error || new Error("IndexedDB refused to open."));
      req.onblocked = () => done(rej, new Error(
        "Another tab of this app is blocking storage. Close the other tabs and reload."
      ));
    });
  }
  function idbBackend(db) {
    const run = (names, mode, fn) => new Promise((res, rej) => {
      let out, t;
      try {
        t = db.transaction(names, mode);
      } catch (e) {
        return rej(e);
      }
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("Storage transaction aborted."));
      try {
        out = fn(...names.map((n) => t.objectStore(n)));
      } catch (e) {
        try {
          t.abort();
        } catch (e2) {
        }
        rej(e);
      }
    });
    const wrap = (r) => new Promise((res, rej) => {
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return {
      kind: "indexeddb",
      get: (store, key) => run([store], "readonly", (s) => wrap(s.get(key))),
      getAll: (store) => run([store], "readonly", (s) => wrap(s.getAll())),
      put: (store, val, key) => run([store], "readwrite", (s) => {
        s.put(val, key);
      }),
      del: (store, key) => run([store], "readwrite", (s) => {
        s.delete(key);
      }),
      delMany: (store, keys) => keys.length ? run([store], "readwrite", (s) => {
        keys.forEach((k) => s.delete(k));
      }) : Promise.resolve(),
      byConv: (convId) => run(["messages"], "readonly", (s) => wrap(s.index("convAt").getAll(IDBKeyRange.bound([convId, 0], [convId, Infinity])))),
      purge: (convId, ids, blobIds) => run(["conversations", "messages", "blobs"], "readwrite", (c, m, b) => {
        c.delete(convId);
        ids.forEach((i) => m.delete(i));
        blobIds.forEach((i) => b.delete(i));
      }),
      destroy: () => {
        db.close();
        return new Promise((r) => {
          const q = indexedDB.deleteDatabase(DB);
          q.onsuccess = q.onerror = q.onblocked = r;
        });
      }
    };
  }
  function memoryBackend() {
    const m = {};
    STORES.forEach(function(s) {
      m[s] = /* @__PURE__ */ new Map();
    });
    return {
      kind: "memory",
      get: async (store, key) => m[store].get(key),
      getAll: async (store) => [...m[store].values()],
      put: async (store, val, key) => {
        m[store].set(key !== void 0 ? key : val.id, val);
      },
      del: async (store, key) => {
        m[store].delete(key);
      },
      delMany: async (store, keys) => {
        keys.forEach((k) => m[store].delete(k));
      },
      byConv: async (convId) => [...m.messages.values()].filter((x) => x.convId === convId).sort((a, b) => a.at - b.at),
      purge: async (convId, ids, blobIds) => {
        m.conversations.delete(convId);
        ids.forEach((i) => m.messages.delete(i));
        blobIds.forEach((i) => m.blobs.delete(i));
      },
      destroy: async () => STORES.forEach((s) => m[s].clear())
    };
  }
  async function init() {
    try {
      backend = idbBackend(await openDb());
    } catch (e) {
      degradedReason = e.message;
      backend = memoryBackend();
    }
    let storedId = null, storedKey = null, storedCert = null;
    try {
      storedId = await backend.get("meta", "identity");
      storedKey = await backend.get("meta", "deviceKey");
      storedCert = await backend.get("meta", "dtlsCert");
    } catch (e) {
    }
    identity = storedId || await newIdentity();
    deviceKey = storedKey || await newDeviceKey();
    if (!storedId || !storedKey) {
      try {
        await backend.put("meta", identity, "identity");
        await backend.put("meta", deviceKey, "deviceKey");
      } catch (e) {
        degradedReason = degradedReason || `This browser will not save keys (${e.name}), so contacts reset on reload.`;
      }
    }
    /* An expired stored certificate is worse than none: it would be pinned by
       peers and then start failing. Re-mint before that happens. */
    const certUsable = storedCert && (!storedCert.expires || storedCert.expires > Date.now() + 864e5);
    try {
      certificate = certUsable ? storedCert : await newCertificate();
      if (!certUsable) await backend.put("meta", certificate, "dtlsCert");
    } catch (e) {
      // A browser that will not persist a certificate still works; it just
      // falls back to sending the fingerprint on every reconnect.
      certificate = null;
    }
    selfPub = await exportPub(identity.publicKey);
    selfId = await fingerprintOf(selfPub);
    return { identity, selfId, selfPub, certificate, degraded: degradedReason, backend: backend.kind };
  }
  var contacts = () => backend.getAll("contacts");
  var contact = (id) => backend.get("contacts", id);
  var saveContact = async (c) => {
    await backend.put("contacts", c);
    return c;
  };
  async function upsertContact(pubRaw, name) {
    const id = await fingerprintOf(pubRaw);
    const existing = await contact(id);
    return saveContact(existing ? { ...existing, name: name || existing.name, lastSeen: Date.now() } : { id, name: name || "Unnamed", pubRaw, verified: false, addedAt: Date.now(), lastSeen: Date.now() });
  }
  var conversations = async () => (await backend.getAll("conversations")).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  var conversation = (id) => backend.get("conversations", id);
  var saveConversation = async (c) => {
    await backend.put("conversations", c);
    return c;
  };
  async function touchConversation(id, preview) {
    const c = await conversation(id);
    if (!c) return;
    c.lastAt = Date.now();
    if (preview !== void 0) c.preview = preview;
    await saveConversation(c);
  }
  var PREVIEW = { image: "Photo", audio: "Voice note", file: "File", location: "Location", call: "Voice call" };
  async function addMessage({ convId, from, kind, text, bytes, mime, name, at, state, hash, id, wireId, rid }) {
    const rec = { id: id || uuid(), convId, from, kind, at: at || Date.now(), mime, name };
    if (state) rec.state = state;
    if (wireId) rec.wireId = wireId;
    if (rid) rec.rid = rid;
    if (hash) rec.hash = hash;
    if (text !== void 0) rec.body = await encryptAtRest(deviceKey, text);
    if (bytes) {
      rec.blobId = uuid();
      rec.size = bytes.byteLength;
      await backend.put("blobs", { id: rec.blobId, data: await encryptAtRest(deviceKey, bytes) });
    }
    await backend.put("messages", rec);
    const preview = kind === "text" ? text : PREVIEW[kind] || kind;
    await touchConversation(convId, preview);
    return { ...rec, text };
  }
  /* Existing installs already have their history split in two: one thread of
     what they sent, another of what arrived. Fold the strays into the oldest
     thread for that peer rather than making them start over. */
  async function mergeConversations(intoId, fromId) {
    const rows = await backend.byConv(fromId);
    for (const r of rows) await backend.put("messages", { ...r, convId: intoId });
    await backend.del("conversations", fromId);
    return rows.length;
  }
  async function dedupeDirect() {
    const all = await backend.getAll("conversations");
    const byPeer = /* @__PURE__ */ new Map();
    for (const c of all) {
      if (c.type !== "direct" || !c.peerId) continue;
      const list = byPeer.get(c.peerId) || [];
      list.push(c);
      byPeer.set(c.peerId, list);
    }
    let merged = 0;
    for (const [, list] of byPeer) {
      if (list.length < 2) continue;
      /* Keep whichever thread started first. Conversations carry no creation
         stamp, so the earliest message in each is the honest proxy; an empty
         thread sorts last and gets folded away. */
      const firstAt = /* @__PURE__ */ new Map();
      for (const c of list) {
        const rows = await backend.byConv(c.id);
        firstAt.set(c.id, rows.length ? Math.min(...rows.map((r) => r.at || 0)) : Infinity);
      }
      list.sort((a, b) => firstAt.get(a.id) - firstAt.get(b.id));
      const keep = list[0];
      for (const dup of list.slice(1)) {
        await mergeConversations(keep.id, dup.id);
        keep.lastAt = Math.max(keep.lastAt || 0, dup.lastAt || 0);
        if (!keep.preview && dup.preview) keep.preview = dup.preview;
        merged++;
      }
      await backend.put("conversations", keep);
    }
    return merged;
  }
  async function messages(convId, limit = 300) {
    const rows = (await backend.byConv(convId)).slice(-limit);
    return Promise.all(rows.map(async (m) => ({
      ...m,
      text: m.body ? await decryptText(deviceKey, m.body).catch(() => "[unreadable]") : void 0
    })));
  }
  async function blobUrl(blobId, mime) {
    const rec = await backend.get("blobs", blobId);
    if (!rec) return null;
    const bytes = await decryptAtRest(deviceKey, rec.data);
    return URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
  }
  async function patchMessage(id, fields, text) {
    const rec = await backend.get("messages", id);
    if (!rec) return null;
    Object.assign(rec, fields);
    if (text !== void 0) rec.body = await encryptAtRest(deviceKey, text);
    await backend.put("messages", rec);
    return rec;
  }
  var outbox = () => backend.getAll("outbox");
  var putEnvelope = (e) => backend.put("outbox", e);
  var dropEnvelope = (id) => backend.del("outbox", id);
  /* ---- deleting ---- */
  /* Everything here is local. Nothing is sent: the other phone keeps its copy. */
  async function refreshPreview(convId) {
    const c = await conversation(convId);
    if (!c) return;
    const rows = await backend.byConv(convId);
    const last = rows[rows.length - 1];
    if (!last) {
      c.preview = "";
      c.unread = 0;
    }
    else if (last.kind === "text") c.preview = last.body ? await decryptText(deviceKey, last.body).catch(() => "") : "";
    else c.preview = PREVIEW[last.kind] || last.kind;
    await saveConversation(c);
  }
  async function deleteMessages(ids, preloaded) {
    const recs = preloaded || (await Promise.all(ids.map((id) => backend.get("messages", id)))).filter(Boolean);
    if (!recs.length) return 0;
    await backend.delMany("blobs", recs.filter((r) => r.blobId).map((r) => r.blobId));
    await backend.delMany("messages", recs.map((r) => r.id));
    // A message still waiting in the outbox would otherwise go out anyway.
    await backend.delMany("outbox", recs.filter((r) => r.envId && r.state === "queued").map((r) => r.envId));
    for (const convId of new Set(recs.map((r) => r.convId))) await refreshPreview(convId);
    return recs.length;
  }
  async function clearConversation(convId) {
    const rows = await backend.byConv(convId);
    return deleteMessages(null, rows);
  }
  async function deleteConversation(convId) {
    const rows = await backend.byConv(convId);
    await backend.delMany("outbox", rows.filter((r) => r.envId && r.state === "queued").map((r) => r.envId));
    await backend.purge(convId, rows.map((r) => r.id), rows.filter((r) => r.blobId).map((r) => r.blobId));
  }
  var removeContact = (id) => backend.del("contacts", id);
  /* Queued messages are kept: deleting one nobody has received yet is a
     different decision from tidying up history. */
  async function pruneBefore(cutoff) {
    const old = (await backend.getAll("messages")).filter((r) => (r.at || 0) < cutoff && r.state !== "queued");
    return deleteMessages(null, old);
  }
  async function countBefore(cutoff) {
    return (await backend.getAll("messages")).filter((r) => (r.at || 0) < cutoff && r.state !== "queued").length;
  }
  async function storeStats() {
    const all = await backend.getAll("messages");
    return { count: all.length, bytes: all.reduce((n, r) => n + (r.size || 0), 0) };
  }
  var getSetting = (k) => backend.get("meta", "set:" + k).catch(() => void 0);
  var putSetting = (k, v) => backend.put("meta", v, "set:" + k);
  /* Ids of envelopes already delivered here, so a second carrier bringing the
     same message does not duplicate it. Capped so it cannot grow forever. */
  async function markSeen(id) {
    const list = await backend.get("meta", "carrySeen") || [];
    if (list.includes(id)) return false;
    list.push(id);
    await backend.put("meta", list.slice(-600), "carrySeen");
    return true;
  }

  // net.js
  typeof window !== "undefined" && window.__boot && window.__boot.mark("net");
  var F_TEXT = 1;
  var F_CTRL = 2;
  var F_CHUNK = 3;
  var CHUNK = 16 * 1024;
  var HEARTBEAT = 5e3;
  var DISCONNECT_GRACE = 12e3;
  var STALE = 13e3;
  var te2 = new TextEncoder();
  var td2 = new TextDecoder();
  var links = /* @__PURE__ */ new Map();
  var bus = new EventTarget();
  var on = (type, fn) => bus.addEventListener(type, fn);
  var emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  function newPeerConnection() {
    const cfg = { iceServers: [] };
    if (certificate) cfg.certificates = [certificate];
    return new RTCPeerConnection(cfg);
  }
  function waitForIce(pc, ms = 4e3) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => pc.iceGatheringState === "complete" && finish();
      pc.addEventListener("icegatheringstatechange", check);
      const timer = setTimeout(finish, ms);
    });
  }
  var Link = class {
    constructor(peerId, pc, dc, role) {
      this.peerId = peerId;
      this.pc = pc;
      this.dc = dc;
      this.role = role;
      this.sendCtr = 0;
      this.lastRecv = -1;
      this.streams = /* @__PURE__ */ new Map();
      this.streamSeq = 0;
      this.presence = "connecting";
      this.lastBeat = 0;
      this.groupKeys = /* @__PURE__ */ new Map();
      /* The channel can open before the session keys are derived (on a
         reconnect it is often open already when it reaches us). Nothing is
         sent, read or announced until they are. */
      this.keysReady = new Promise((r) => {
        this._keysOk = r;
      });
      dc.binaryType = "arraybuffer";
    }
    async attachKeys(secret, localFp, remoteFp) {
      const uf = (d) => ((d && d.sdp || "").match(/^a=ice-ufrag:(\S+)/m) || [])[1] || "";
      const k = await deriveSessionKeys(secret, localFp, remoteFp, uf(this.pc.localDescription), uf(this.pc.remoteDescription));
      this.sendKey = this.role === "inviter" ? k.a2b : k.b2a;
      this.recvKey = this.role === "inviter" ? k.b2a : k.a2b;
      this._keysOk();
    }
    get open() {
      var _a;
      return ((_a = this.dc) == null ? void 0 : _a.readyState) === "open";
    }
    async _send(type, payload, stream = 0) {
      if (!this.open) throw new Error("link is not open");
      await this.keysReady;
      const body = payload instanceof Uint8Array ? payload : te2.encode(payload);
      const framed = new Uint8Array(body.length + 1);
      framed[0] = type;
      framed.set(body, 1);
      await this._backpressure();
      this.dc.send(await seal(this.sendKey, ++this.sendCtr, framed, stream));
    }
    /* Without this a large photo queues faster than SCTP drains and the
       channel closes on buffer overflow. */
    _backpressure() {
      if (this.dc.bufferedAmount < 512 * 1024) return Promise.resolve();
      this.dc.bufferedAmountLowThreshold = 128 * 1024;
      return new Promise((res) => this.dc.addEventListener("bufferedamountlow", res, { once: true }));
    }
    sendText(convId, text, id) {
      return this._send(F_TEXT, JSON.stringify({ convId, text, id }));
    }
    sendCtrl(obj) {
      return this._send(F_CTRL, JSON.stringify(obj));
    }
    /** Attachments go as a header control frame then numbered chunks. */
    async sendFile(convId, meta, onProgress) {
      const { bytes, mime, name } = meta;
      const id = crypto.randomUUID();
      const stream = ++this.streamSeq;
      const total = Math.ceil(bytes.length / CHUNK);
      await this.sendCtrl({ t: "file-start", id, convId, mime, name, hash: meta.hash, size: bytes.length, total, stream });
      for (let i = 0; i < total; i++) {
        const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
        const head = te2.encode(id + "\n");
        const frame = new Uint8Array(head.length + 4 + slice.length);
        frame.set(head, 0);
        new DataView(frame.buffer).setUint32(head.length, i);
        frame.set(slice, head.length + 4);
        await this._send(F_CHUNK, frame, stream);
        onProgress == null ? void 0 : onProgress((i + 1) / total);
      }
      return id;
    }
    async handle(buf) {
      await this.keysReady;
      const f = await unseal(this.recvKey, buf);
      if (f.stream === 0) {
        if (f.counter <= this.lastRecv) return;
        this.lastRecv = f.counter;
      }
      const type = f.bytes[0], body = f.bytes.subarray(1);
      if (type === F_TEXT) {
        const { convId, text, id } = JSON.parse(td2.decode(body));
        emit("message", { peerId: this.peerId, convId, text, id });
        return;
      }
      if (type === F_CHUNK) {
        const nl = body.indexOf(10);
        if (nl < 1 || nl > 64 || body.length < nl + 5) return;
        const id = td2.decode(body.subarray(0, nl));
        const idx = new DataView(body.buffer, body.byteOffset + nl + 1).getUint32(0);
        const st = this.streams.get(id);
        if (!st) return;
        /* A piece out of range or sent twice is ignored, and more bytes than
           were announced ends the transfer, so a sender cannot make this phone
           reserve or assemble more than the agreed size. */
        if (idx >= st.total || st.parts[idx]) return;
        const part = body.subarray(nl + 5);
        st.got += part.length;
        if (st.got > st.size) {
          this.streams.delete(id);
          return;
        }
        st.parts[idx] = part;
        st.have++;
        emit("progress", { id, convId: st.convId, ratio: st.have / st.total });
        if (st.have === st.total) {
          this.streams.delete(id);
          if (st.got !== st.size) return;
          st.id = id;
          const out = new Uint8Array(st.size);
          let o = 0;
          for (const p of st.parts) {
            out.set(p, o);
            o += p.length;
          }
          emit("file", { peerId: this.peerId, convId: st.convId, id: st.id, bytes: out, mime: st.mime, name: st.name, hash: st.hash });
        }
        return;
      }
      if (type !== F_CTRL) return;
      const msg = JSON.parse(td2.decode(body));
      switch (msg.t) {
        case "file-start": {
          /* The size limit is enforced here too, not only by the sender: a
             contact must not be able to make this phone reserve gigabytes. */
          const ok = typeof msg.id === "string" && msg.id.length > 0 && msg.id.length <= 64 && Number.isInteger(msg.size) && msg.size > 0 && msg.size <= MAX_FILE && Number.isInteger(msg.total) && msg.total === Math.ceil(msg.size / CHUNK) && !this.streams.has(msg.id);
          if (!ok) break;
          for (const [k, old] of this.streams) if (Date.now() - old.started > 12e4) this.streams.delete(k);
          if (this.streams.size >= 4) break;
          this.streams.set(msg.id, {
            convId: msg.convId,
            mime: String(msg.mime || "").slice(0, 100),
            name: String(msg.name || "").slice(0, 200),
            hash: typeof msg.hash === "string" ? msg.hash.slice(0, 64) : void 0,
            size: msg.size,
            total: msg.total,
            parts: new Array(msg.total),
            have: 0,
            got: 0,
            started: Date.now()
          });
          break;
        }
        case "ping":
          this.lastBeat = Date.now();
          this.sendCtrl({ t: "pong", state: appAway() ? "away" : "online" }).catch(() => {
          });
          break;
        case "pong":
          this.lastBeat = Date.now();
          this.setPresence(msg.state || "online");
          break;
        case "presence":
          this.lastBeat = Date.now();
          this.setPresence(msg.state);
          break;
        // Group traffic: the host re-broadcasts to everyone else in the room.
        // The real sender is set last, so a peerId field inside the message
        // cannot overwrite who it actually came from.
        case "group-invite":
          emit("group-invite", { ...msg, peerId: this.peerId });
          break;
        case "group-msg":
          emit("group-msg", { ...msg, peerId: this.peerId });
          break;
        case "group-roster":
          emit("group-roster", { ...msg, peerId: this.peerId });
          break;
        default:
          emit("ctrl", { peerId: this.peerId, msg });
      }
    }
    /* Try to revive the existing connection in place. Only possible while the
       data channel still carries frames; otherwise the caller must fall back
       to a relayed or coded reconnect. */
    async nudge() {
      if (this.recovering) return false;
      if (!this.open) return false;
      this.recovering = true;
      try {
        if (typeof this.pc.restartIce === "function") this.pc.restartIce();
        await this.sendCtrl({ t: "ping" });
        return true;
      } catch (e) {
        return false;
      } finally {
        setTimeout(() => {
          this.recovering = false;
        }, 4e3);
      }
    }
    setPresence(state) {
      if (this.presence === state) return;
      this.presence = state;
      emit("presence", { peerId: this.peerId, state });
    }
    close() {
      try {
        this.dc.close();
      } catch (e) {
      }
      try {
        this.pc.close();
      } catch (e) {
      }
      clearTimeout(this.graceTimer);
      this.setPresence("offline");
      links.delete(this.peerId);
      emit("linkclosed", { peerId: this.peerId });
    }
  };
  function register(peerId, pc, dc, role) {
    var _a;
    (_a = links.get(peerId)) == null ? void 0 : _a.close();
    const link2 = new Link(peerId, pc, dc, role);
    links.set(peerId, link2);
    dc.onmessage = (ev) => link2.handle(ev.data).catch(() => emit("baddata", { peerId }));
    const announce = () => link2.keysReady.then(() => {
      if (links.get(peerId) !== link2 || !link2.open) return;
      link2.setPresence("online");
      emit("linkopen", { peerId });
    });
    dc.onopen = announce;
    dc.onclose = () => link2.setPresence("offline");
    if (dc.readyState === "open") queueMicrotask(announce);
    pc.ontrack = (ev) => emit("track", { peerId, stream: ev.streams[0], track: ev.track });
    pc.onicecandidate = (ev) => {
      if (ev.candidate) emit("localice", { peerId, candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "closed") {
        link2.setPresence("offline");
      } else if (st === "failed") {
        /* Failed is recoverable where disconnected is not yet fatal: give ICE
           a restart before declaring the link dead. */
        link2.setPresence("away");
        link2.nudge();
      } else if (st === "disconnected") {
        link2.setPresence("away");
        clearTimeout(link2.graceTimer);
        link2.graceTimer = setTimeout(() => {
          if (pc.connectionState === "disconnected") link2.nudge();
        }, DISCONNECT_GRACE);
      } else if (st === "connected") {
        clearTimeout(link2.graceTimer);
        link2.recovering = false;
        link2.setPresence(appAway() ? "away" : "online");
      }
      emit("pcstate", { peerId, state: st });
    };
    return link2;
  }
  var link = (id) => links.get(id);
  var openLinks = () => [...links.values()].filter((l) => l.open);
  var presenceOf = (id) => {
    var _a;
    return ((_a = links.get(id)) == null ? void 0 : _a.presence) || "offline";
  };
  setInterval(() => {
    const now = Date.now();
    for (const l of links.values()) {
      if (!l.open) {
        l.setPresence("offline");
        continue;
      }
      l.sendCtrl({ t: "ping" }).catch(() => {
      });
      if (l.lastBeat && now - l.lastBeat > STALE) l.setPresence("away");
    }
  }, HEARTBEAT);
  document.addEventListener("visibilitychange", () => {
    const state = appAway() ? "away" : "online";
    for (const l of links.values()) if (l.open) l.sendCtrl({ t: "presence", state }).catch(() => {
    });
  });
  async function relayToRoom(convId, members, exceptPeerId, payload) {
    await Promise.all(members.filter((id) => id !== exceptPeerId).map((id) => links.get(id)).filter((l) => l == null ? void 0 : l.open).map((l) => l.sendCtrl({ ...payload, convId }).catch(() => {
    })));
  }
  async function sendGroupText(conv, selfId2, text, groupKey) {
    var _a;
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      groupKey,
      te2.encode(JSON.stringify({ id: crypto.randomUUID(), from: selfId2, text, at: Date.now() }))
    ));
    const packed = btoa(String.fromCharCode(...nonce, ...ct));
    if (conv.hostId === selfId2) {
      await relayToRoom(conv.id, conv.members, null, { t: "group-msg", packed });
    } else {
      await ((_a = links.get(conv.hostId)) == null ? void 0 : _a.sendCtrl({ t: "group-msg", convId: conv.id, packed }));
    }
  }
  async function openGroupPacked(packed, groupKey) {
    const raw = Uint8Array.from(atob(packed), (c) => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, groupKey, raw.slice(12));
    return JSON.parse(td2.decode(new Uint8Array(pt)));
  }

  // scan.js
  typeof window !== "undefined" && window.__boot && window.__boot.mark("scan");
  var activeStream = null;
  var scanLoop = 0;
  var detector = null;
  var detectorUsable = null;
  if ("BarcodeDetector" in window) {
    try {
      detector = new BarcodeDetector({ formats: ["qr_code"] });
    } catch (e) {
      detector = null;
    }
  }
  var CAMERA_HELP = {
    NotAllowedError: "Camera access was refused. Check the padlock in the address bar for this site, then Android Settings > Apps > Chrome > Permissions > Camera. If you added this to your home screen, its permission is separate from the browser tab.",
    NotFoundError: "No camera was found on this device.",
    NotReadableError: "The camera is busy. Another app or tab is holding it \u2014 close anything else using the camera and try again.",
    OverconstrainedError: "No camera matched the requested settings. Retrying with basic settings.",
    SecurityError: "The camera is blocked because this page is not on HTTPS.",
    AbortError: "The camera stopped unexpectedly. Try again."
  };
  var CameraError = class extends Error {
    constructor(name, message) {
      super(message);
      this.name = "CameraError";
      this.reason = name;
    }
  };
  async function cameraState() {
    var _a;
    if (!window.isSecureContext) return "insecure";
    if (!((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia)) return "unsupported";
    try {
      const st = await navigator.permissions.query({ name: "camera" });
      return st.state;
    } catch (e) {
      return "unknown";
    }
  }
  async function openStream() {
    const ideal = { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    try {
      return await navigator.mediaDevices.getUserMedia(ideal);
    } catch (e) {
      if (e.name === "OverconstrainedError" || e.name === "NotFoundError") {
        try {
          return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } catch (e2) {
          throw new CameraError(e2.name, CAMERA_HELP[e2.name] || e2.message);
        }
      }
      throw new CameraError(e.name, CAMERA_HELP[e.name] || e.message);
    }
  }
  function stopCamera() {
    if (activeStream) {
      activeStream.getTracks().forEach((t) => t.stop());
      activeStream = null;
    }
    scanLoop++;
  }
  async function primePermission() {
    const s = await openStream();
    s.getTracks().forEach((t) => t.stop());
  }
  function videoReady(video) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new CameraError(
        "AbortError",
        "The camera preview never started. Close other apps using the camera and try again."
      )), 8e3);
      const done = () => {
        if (video.videoWidth > 0) {
          clearTimeout(timer);
          cleanup();
          res();
        }
      };
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", done);
        video.removeEventListener("playing", done);
      };
      video.addEventListener("loadedmetadata", done);
      video.addEventListener("playing", done);
      done();
    });
  }
  async function scanOnce(video, onFrameError) {
    stopCamera();
    const myLoop = ++scanLoop;
    activeStream = await openStream();
    video.srcObject = activeStream;
    video.setAttribute("playsinline", "");
    video.muted = true;
    try {
      await video.play();
    } catch (e) {
      if (e.name !== "AbortError") onFrameError == null ? void 0 : onFrameError(e.message);
    }
    await videoReady(video);
    const cv = document.createElement("canvas");
    const g = cv.getContext("2d", { willReadFrequently: true });
    const detectorDeadline = Date.now() + 2500;
    return new Promise((resolve, reject) => {
      const tick = async () => {
        if (myLoop !== scanLoop) return reject(new CameraError("AbortError", "Scanning cancelled."));
        if (video.readyState >= video.HAVE_CURRENT_DATA && video.videoWidth > 0) {
          let found = null;
          try {
            if (detector && detectorUsable !== false) {
              const codes = await detector.detect(video);
              if (codes.length) {
                detectorUsable = true;
                found = codes[0].rawValue;
              } else if (detectorUsable === null && Date.now() > detectorDeadline) {
                detectorUsable = false;
              }
            }
            if (!found && (detectorUsable === false || !detector)) {
              const w = Math.min(720, video.videoWidth);
              const h = Math.round(w * video.videoHeight / video.videoWidth);
              cv.width = w;
              cv.height = h;
              g.drawImage(video, 0, 0, w, h);
              const img = g.getImageData(0, 0, w, h);
              const r = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
              if (r) found = r.data;
            }
          } catch (e) {
            if (detector && detectorUsable !== true) detectorUsable = false;
          }
          if (found) {
            stopCamera();
            return resolve(found);
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  function stopScanning() {
    stopCamera();
  }
  function drawQR(text, canvas, maxCss = 420) {
    var _a;
    const qr = qrcode(0, "L");
    qr.addData(text, "Alphanumeric");
    qr.make();
    const n = qr.getModuleCount(), quiet = 4, total = n + quiet * 2;
    const avail = Math.min((((_a = canvas.parentElement) == null ? void 0 : _a.clientWidth) || maxCss) - 36, maxCss);
    const scale = Math.max(2, Math.floor(avail / total));
    const px = total * scale;
    canvas.width = px;
    canvas.height = px;
    canvas.style.width = "100%";
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, px, px);
    g.fillStyle = "#000";
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (qr.isDark(r, c)) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    return { modules: n, version: (n - 17) / 4 };
  }
  async function prepareImage(file, maxEdge = 1600, quality = 0.82) {
    var _a;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
    (_a = bmp.close) == null ? void 0 : _a.call(bmp);
    const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", quality));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg", name: file.name || "photo.jpg" };
  }
  var AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", ""];
  function audioSupported() {
    var _a;
    return !!(window.MediaRecorder && ((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia));
  }
  async function recordAudio() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((e) => {
      throw new CameraError(e.name, CAMERA_HELP[e.name] || "Microphone unavailable.");
    });
    const mime = AUDIO_TYPES.find((t) => !t || MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : void 0);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start();
    return {
      stop: () => new Promise((res) => {
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          res({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type, name: "voice-note" });
        };
        rec.stop();
      }),
      cancel: () => {
        try {
          rec.stop();
        } catch (e) {
        }
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }

  // codec.js
  typeof window !== "undefined" && window.__boot && window.__boot.mark("codec");
  var VERSION = 3;
  var SETUPS = ["actpass", "active", "passive"];
  var FAM_IP4 = 1;
  var FAM_IP6 = 2;
  var FAM_HOST = 3;
  var B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function b32encode(bytes) {
    let bits = 0, value = 0, out = "";
    for (const b of bytes) {
      value = value << 8 | b;
      bits += 8;
      while (bits >= 5) {
        out += B32[value >>> bits - 5 & 31];
        bits -= 5;
      }
    }
    return bits > 0 ? out + B32[value << 5 - bits & 31] : out;
  }
  function b32decode(str) {
    let bits = 0, value = 0;
    const out = [];
    for (const ch of str.trim().toUpperCase()) {
      const i = B32.indexOf(ch);
      if (i < 0) continue;
      value = value << 5 | i;
      bits += 5;
      if (bits >= 8) {
        out.push(value >>> bits - 8 & 255);
        bits -= 8;
      }
    }
    return new Uint8Array(out);
  }
  var Writer = class {
    constructor() {
      this.b = [];
    }
    u8(v) {
      this.b.push(v & 255);
      return this;
    }
    u16(v) {
      this.b.push(v >>> 8 & 255, v & 255);
      return this;
    }
    raw(a) {
      for (const x of a) this.b.push(x & 255);
      return this;
    }
    str(s) {
      const e = new TextEncoder().encode(s);
      if (e.length > 255) throw new Error("field too long");
      return this.u8(e.length).raw(e);
    }
    bytes() {
      return new Uint8Array(this.b);
    }
  };
  var Reader = class {
    constructor(a) {
      this.a = a;
      this.i = 0;
    }
    u8() {
      return this.a[this.i++];
    }
    u16() {
      const v = this.a[this.i] << 8 | this.a[this.i + 1];
      this.i += 2;
      return v;
    }
    raw(n) {
      const v = this.a.slice(this.i, this.i + n);
      this.i += n;
      return v;
    }
    str() {
      return new TextDecoder().decode(this.raw(this.u8()));
    }
  };
  function packAddr(w, addr) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) return w.u8(FAM_IP4).raw(addr.split(".").map(Number));
    if (addr.includes(":")) {
      const [head, tail] = addr.split("::");
      const words = (s) => s ? s.split(":").filter(Boolean) : [];
      const hw = words(head), tw = tail === void 0 ? [] : words(tail);
      const all = tail === void 0 ? hw : hw.concat(Array(8 - hw.length - tw.length).fill("0"), tw);
      const bytes = [];
      for (const x of all) {
        const v = parseInt(x, 16) || 0;
        bytes.push(v >>> 8 & 255, v & 255);
      }
      while (bytes.length < 16) bytes.push(0);
      return w.u8(FAM_IP6).raw(bytes.slice(0, 16));
    }
    return w.u8(FAM_HOST).str(addr);
  }
  function unpackAddr(r) {
    const fam = r.u8();
    if (fam === FAM_IP4) return Array.from(r.raw(4)).join(".");
    if (fam === FAM_IP6) {
      const b = r.raw(16), p = [];
      for (let i = 0; i < 16; i += 2) p.push((b[i] << 8 | b[i + 1]).toString(16));
      return p.join(":").replace(/\b(?:0:){2,}/, ":").replace(/^0:/, "::");
    }
    return r.str();
  }
  function parseSdp(sdp) {
    const grab = (re2) => {
      const m2 = sdp.match(re2);
      return m2 ? m2[1].trim() : null;
    };
    const ufrag = grab(/^a=ice-ufrag:(.+)$/m);
    const pwd = grab(/^a=ice-pwd:(.+)$/m);
    const fp = grab(/^a=fingerprint:sha-256 (.+)$/mi);
    const setup = grab(/^a=setup:(\w+)$/m) || "actpass";
    if (!ufrag || !pwd || !fp) throw new Error("SDP is missing ICE credentials or a fingerprint");
    const fpb = hexToBytes(fp);
    if (fpb.length !== 32) throw new Error("expected a 32-byte sha-256 fingerprint");
    const cands = [];
    const re = /^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)/gm;
    let m;
    while ((m = re.exec(sdp)) !== null) {
      const [, , comp, transport, , addr, port, ctype] = m;
      if (ctype !== "host" || comp !== "1" || transport.toLowerCase() !== "udp") continue;
      if (cands.some((c) => c.addr === addr && c.port === port)) continue;
      cands.push({ addr, port });
    }
    return { ufrag, pwd, fpb, setup, cands: cands.slice(0, 255) };
  }
  /* Pairing keys: each phone puts a one-time public key in its QR code and
     keeps the private half. Both work out the same secret from the two, so
     the secret itself never appears on a screen, in a photo or in a video. */
  var newEphemeral = () => crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  var ephemeralRaw = async (kp) => new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  async function pairSecret(kp, theirRaw) {
    const theirs = await crypto.subtle.importKey("raw", theirRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, kp.privateKey, 256));
  }
  async function encodeSignal(sdp, type, eph, identity2) {
    const { ufrag, pwd, fpb, setup, cands } = parseSdp(sdp);
    const pubRaw = await exportPub(identity2.publicKey);
    const w = new Writer();
    w.u8(VERSION << 4 | Math.max(0, SETUPS.indexOf(setup)) << 2 | (eph ? 2 : 0) | (type === "answer" ? 1 : 0));
    w.str(ufrag).str(pwd).raw(fpb);
    if (eph) w.raw(eph);
    w.u8(cands.length);
    for (const c of cands) {
      packAddr(w, c.addr);
      w.u16(parseInt(c.port, 10));
    }
    w.raw(pubRaw);
    const body = w.bytes();
    const sig = await sign(identity2.privateKey, body);
    return b32encode(concat(body, sig));
  }
  async function decodeSignal(text) {
    const all = b32decode(text);
    if (all.length < 64 + 100) throw new Error("that code is too short to be a valid invite");
    const body = all.slice(0, all.length - 64);
    const sig = all.slice(all.length - 64);
    const r = new Reader(body);
    const flags = r.u8();
    if (flags >> 4 !== VERSION) throw new Error("that code came from a different version of this app");
    const setup = SETUPS[flags >> 2 & 3];
    const hasEph = !!(flags & 2);
    const type = flags & 1 ? "answer" : "offer";
    const ufrag = r.str(), pwd = r.str(), fpBytes = r.raw(32);
    const eph = hasEph ? r.raw(65) : null;
    const n = r.u8(), lines = [];
    for (let i = 0; i < n; i++) {
      const addr = unpackAddr(r), port = r.u16();
      lines.push(`a=candidate:${i + 1} 1 udp ${2130706431 - i} ${addr} ${port} typ host generation 0`);
    }
    const pubRaw = r.raw(65);
    const pub = await importPub(pubRaw);
    if (!await verify(pub, sig, body)) throw new Error("that code failed its signature check \u2014 do not trust it");
    const sdp = [
      "v=0",
      "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "a=group:BUNDLE 0",
      "a=msid-semantic: WMS",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      ...lines,
      `a=ice-ufrag:${ufrag}`,
      `a=ice-pwd:${pwd}`,
      `a=fingerprint:sha-256 ${bytesToHex(fpBytes)}`,
      `a=setup:${setup}`,
      "a=mid:0",
      "a=sctp-port:5000",
      "a=max-message-size:262144",
      ""
    ].join("\r\n");
    return { type, sdp, eph, fpBytes, pubRaw, candidateCount: n };
  }

  // call.js
  typeof window !== "undefined" && window.__boot && window.__boot.mark("call");
  var RING_TIMEOUT = 45e3;
  var call = null;
  var micStream = () => navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false
  });
  var callPeer = () => call && call.peerId;
  function micError(e) {
    if (e && e.name === "NotAllowedError") return "Microphone access is blocked for this site. Allow it in your browser settings and try again.";
    if (e && e.name === "NotFoundError") return "No microphone found on this device.";
    if (e && e.name === "NotReadableError") return "The microphone is already in use by another app.";
    return "Could not open the microphone: " + ((e == null ? void 0 : e.message) || e);
  }
  async function callPlace(peerId, convId, name) {
    if (call) throw new Error("You are already on a call.");
    const l = link(peerId);
    if (!(l == null ? void 0 : l.open)) throw new Error("Not connected to " + name + " \u2014 calls need a live link.");
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw new Error("This browser cannot use the microphone.");
    let stream;
    try {
      stream = await micStream();
    } catch (e) {
      throw new Error(micError(e));
    }
    const mine = call = { peerId, convId, name, dir: "out", status: "ringing", stream, senders: [], pendingIce: [] };
    mine.ringTimer = setTimeout(() => {
      if (call === mine) callEnd("No answer");
    }, RING_TIMEOUT);
    try {
      for (const t of stream.getTracks()) mine.senders.push(l.pc.addTrack(t, stream));
      await l.pc.setLocalDescription(await l.pc.createOffer());
      await waitForIce(l.pc, 1500);
      await l.sendCtrl({ t: "call-offer", sdp: l.pc.localDescription.sdp });
    } catch (e) {
      if (call === mine) await callEnd("Could not start the call", false);
      throw e;
    }
    if (call === mine) emit("callstate", {});
  }
  async function callIncoming(peerId, sdp) {
    const l = link(peerId);
    if (!(l == null ? void 0 : l.open)) return;
    if (call) return void l.sendCtrl({ t: "call-busy" }).catch(() => {
    });
    const c = await contact(peerId);
    const conv = (await conversations()).find((x) => x.type === "direct" && x.peerId === peerId);
    call = {
      peerId,
      convId: conv ? conv.id : null,
      name: (c == null ? void 0 : c.name) || "Unknown contact",
      dir: "in",
      status: "ringing",
      offerSdp: sdp,
      senders: [],
      pendingIce: []
    };
    call.ringTimer = setTimeout(() => callEnd("Missed call"), RING_TIMEOUT);
    emit("callring", {});
  }
  async function callAccept() {
    if (!call || call.dir !== "in") return;
    const mine = call;
    const l = link(mine.peerId);
    if (!(l == null ? void 0 : l.open)) return callEnd("The link dropped before the call connected");
    clearTimeout(mine.ringTimer);
    let stream;
    try {
      await l.pc.setRemoteDescription({ type: "offer", sdp: mine.offerSdp });
      stream = await micStream();
    } catch (e) {
      if (call === mine) await callEnd(micError(e));
      throw new Error(micError(e));
    }
    if (call !== mine) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    mine.stream = stream;
    for (const t of stream.getTracks()) mine.senders.push(l.pc.addTrack(t, stream));
    await l.pc.setLocalDescription(await l.pc.createAnswer());
    await l.sendCtrl({ t: "call-answer", sdp: l.pc.localDescription.sdp });
    if (call !== mine) return;
    await drainIce(l);
    if (call !== mine) return;
    mine.status = "active";
    mine.startedAt = Date.now();
    emit("callstate", {});
  }
  async function callAnswered(peerId, sdp) {
    if (!call || call.peerId !== peerId || call.dir !== "out") return;
    const mine = call;
    const l = link(peerId);
    clearTimeout(mine.ringTimer);
    await l.pc.setRemoteDescription({ type: "answer", sdp });
    if (call !== mine) return;
    await drainIce(l);
    if (call !== mine) return;
    mine.status = "active";
    mine.startedAt = Date.now();
    emit("callstate", {});
  }
  async function drainIce(l) {
    if (!call) return;
    const queued = call.pendingIce;
    call.pendingIce = [];
    for (const c of queued) await l.pc.addIceCandidate(c).catch(() => {
    });
  }
  async function callRemoteIce(peerId, candidate) {
    if (!call || call.peerId !== peerId) return;
    const l = link(peerId);
    if (!l) return;
    if (!l.pc.remoteDescription) return void call.pendingIce.push(candidate);
    await l.pc.addIceCandidate(candidate).catch(() => {
    });
  }
  function callMute(on2) {
    if (!(call == null ? void 0 : call.stream)) return false;
    call.muted = on2;
    call.stream.getAudioTracks().forEach((t) => t.enabled = !on2);
    return on2;
  }
  /* Tracks are stopped and senders detached, but the audio m-line is left in
     place. A later call renegotiates it from scratch, which is simpler and more
     reliable than tearing the section down mid-session. */
  async function callEnd(reason, notify = true) {
    if (!call) return;
    const c = call;
    call = null;
    clearTimeout(c.ringTimer);
    const l = link(c.peerId);
    if (notify && (l == null ? void 0 : l.open)) l.sendCtrl({ t: "call-end" }).catch(() => {
    });
    if (c.stream) c.stream.getTracks().forEach((t) => t.stop());
    if (l) {
      if (l.pc.signalingState === "have-local-offer") {
        try {
          await l.pc.setLocalDescription({ type: "rollback" });
        } catch (e) {
        }
      }
      for (const s of c.senders) {
        try {
          l.pc.removeTrack(s);
        } catch (e) {
        }
      }
    }
    emit("callended", {
      reason,
      secs: c.startedAt ? Math.round((Date.now() - c.startedAt) / 1e3) : 0,
      convId: c.convId,
      dir: c.dir,
      name: c.name,
      peerId: c.peerId,
      connected: !!c.startedAt
    });
  }

  // carry.js  — store and forward
  typeof window !== "undefined" && window.__boot && window.__boot.mark("carry");
  var CARRY_TTL = 24 * 36e5;
  var CARRY_MAX_HOPS = 4;
  var CARRY_MAX_HELD = 200;
  var ackSeen = /* @__PURE__ */ new Set();
  var asBytes = (v) => v instanceof Uint8Array ? v : new Uint8Array(v);
  async function carryKeyFor(rec) {
    if (!rec || !rec.secret) return null;
    return deriveCarryKey(asBytes(rec.secret), selfId, rec.id);
  }
  var carryCanon = (e) => te.encode([e.id, e.from, e.to, e.convId, e.kind, e.at, e.exp, e.packed].join("|"));
  /* The body is sealed to the recipient and signed by the sender, so a phone in
     the middle can carry it but can neither read nor alter it. hops is outside
     the signature on purpose: carriers must be able to increment it. */
  async function carrySeal(to, convId, kind, payload) {
    const rec = await contact(to);
    const key = await carryKeyFor(rec);
    if (!key) throw new Error("No stored key for this contact yet. Pair with them once more to turn on relayed delivery.");
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      te.encode(JSON.stringify(payload))
    ));
    const e = {
      id: uuid(),
      from: selfId,
      to,
      convId,
      kind,
      at: Date.now(),
      exp: Date.now() + CARRY_TTL,
      hops: 0,
      gave: [],
      packed: b64(concat(nonce, ct))
    };
    e.sig = b64(await sign(identity.privateKey, carryCanon(e)));
    await putEnvelope(e);
    carryFlush().catch(() => {
    });
    return e;
  }
  async function carryOpen(e) {
    const rec = await contact(e.from);
    if (!rec) throw new Error("it came from someone who is not in your contacts");
    const pub = await importPub(asBytes(rec.pubRaw));
    if (!await verify(pub, unb64(e.sig), carryCanon(e))) throw new Error("its signature did not check out");
    const key = await carryKeyFor(rec);
    if (!key) throw new Error("you have no stored key for that contact");
    const raw = unb64(e.packed);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(td.decode(new Uint8Array(pt)));
  }
  async function carryFlush(onlyPeer) {
    const now = Date.now();
    const held = await outbox();
    const peers = (onlyPeer ? [onlyPeer] : openLinks().map((l) => l.peerId));
    for (const e of held) {
      if (e.exp < now) {
        await dropEnvelope(e.id);
        continue;
      }
      for (const pid of peers) {
        const l = link(pid);
        if (!(l == null ? void 0 : l.open)) continue;
        const direct = e.to === pid;
        if (!direct) {
          if (e.hops >= CARRY_MAX_HOPS) continue;
          if (e.from === pid) continue;
          if ((e.gave || []).includes(pid)) continue;
        }
        const out = direct ? e : { ...e, hops: e.hops + 1, gave: void 0 };
        try {
          await l.sendCtrl({ t: "carry", env: out });
          if (!direct) {
            e.gave = [...e.gave || [], pid];
            await putEnvelope(e);
          }
        } catch (err) {
        }
      }
    }
  }
  async function carryTake(fromPeer, e) {
    if (!e || !e.id || !e.to || !e.sig) return;
    if (!e.exp || e.exp < Date.now()) return;
    if (e.to === selfId) {
      const fresh = await markSeen(e.id);
      carryAckTo(fromPeer, e.id);
      if (!fresh) return;
      let body;
      try {
        body = await carryOpen(e);
      } catch (err) {
        emit("carrybad", { reason: err.message });
        return;
      }
      emit("carried", { env: e, body });
      return;
    }
    if (e.hops >= CARRY_MAX_HOPS) return;
    const held = await outbox();
    if (held.length >= CARRY_MAX_HELD) return;
    if (held.some((x) => x.id === e.id)) return;
    await putEnvelope({ ...e, gave: [fromPeer] });
    emit("carryheld", { count: held.length + 1 });
  }
  /* Signed by the recipient, with their public key attached, so any phone
     holding the envelope can check the confirmation really came from the
     person it was addressed to. A carrier cannot make mail vanish by claiming
     it arrived. */
  var ackBytes = (id) => te.encode("cyanotype/carry-ack|" + id);
  async function carryAckTo(peerId, id) {
    const l = link(peerId);
    if (!(l == null ? void 0 : l.open)) return;
    const sig = await sign(identity.privateKey, ackBytes(id));
    l.sendCtrl({ t: "carry-ack", id, pub: b64(selfPub), sig: b64(sig) }).catch(() => {
    });
  }
  async function ackValid(msg, env) {
    try {
      if (typeof msg.pub !== "string" || typeof msg.sig !== "string") return false;
      const pubRaw = unb64(msg.pub);
      if (await fingerprintOf(pubRaw) !== env.to) return false;
      return await verify(await importPub(pubRaw), unb64(msg.sig), ackBytes(env.id));
    } catch (e) {
      return false;
    }
  }
  /* An ack is passed on once so other carriers holding the same envelope can
     drop it. The guard stops two phones bouncing the same ack forever. */
  async function carryAcked(msg, fromPeer) {
    const id = msg && msg.id;
    if (typeof id !== "string") return null;
    const held = (await outbox()).find((e) => e.id === id);
    if (held) {
      if (!await ackValid(msg, held)) return null;
      await dropEnvelope(id);
    }
    if (!ackSeen.has(id)) {
      ackSeen.add(id);
      if (ackSeen.size > 800) ackSeen.clear();
      for (const l of openLinks()) {
        if (l.peerId !== fromPeer) l.sendCtrl({ t: "carry-ack", id, pub: msg.pub, sig: msg.sig }).catch(() => {
        });
      }
    }
    return held;
  }
  var carryCount = async () => (await outbox()).length;
  /* Normally everything waiting goes out the moment a link opens. If that one
     attempt is lost (the link was replaced mid-send, say), try again every
     30 seconds while links are open. The recipient ignores repeats. */
  setInterval(() => {
    if (!openLinks().length) return;
    outbox().then((held) => held.length && carryFlush()).catch(() => {
    });
  }, 3e4);

  /* Grouped for reading aloud. Ambiguous characters are already absent from
     the base32 alphabet used elsewhere in the app. */
  var groupCode = (s, n = 4) => (s.match(new RegExp(".{1," + n + "}", "g")) || []).join("-");
  var ungroupCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z2-7]/g, "");

  function packRejoin({ ufrag, pwd, addr, port }) {
    const w = new Writer();
    w.str(ufrag).str(pwd);
    if (addr) {
      w.u8(1);
      packAddr(w, addr);
      w.u16(port);
    } else {
      w.u8(0);
    }
    return b32encode(w.bytes());
  }
  function unpackRejoin(code) {
    const r = new Reader(b32decode(ungroupCode(code)));
    const ufrag = r.str(), pwd = r.str();
    const hasAddr = r.u8();
    const addr = hasAddr ? unpackAddr(r) : null;
    const port = hasAddr ? r.u16() : 0;
    return { ufrag, pwd, addr, port };
  }
  /* Rebuild the peer's description locally. Everything not in the code is
     either fixed boilerplate or already known: the fingerprint is the one
     pinned when we paired. */
  function rejoinSdp({ ufrag, pwd, addr, port }, fpBytes, setup) {
    const lines = [
      "v=0", "o=- 4611731400430051336 2 IN IP4 127.0.0.1", "s=-", "t=0 0",
      "a=group:BUNDLE 0", "a=msid-semantic: WMS",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0"
    ];
    if (addr) lines.push(`a=candidate:1 1 udp 2130706431 ${addr} ${port} typ host generation 0`);
    lines.push(
      `a=ice-ufrag:${ufrag}`,
      `a=ice-pwd:${pwd}`,
      `a=fingerprint:sha-256 ${bytesToHex(new Uint8Array(fpBytes))}`,
      `a=setup:${setup}`,
      "a=mid:0", "a=sctp-port:5000", "a=max-message-size:262144", ""
    );
    return lines.join("\r\n");
  }
  var iceOf = (sdp) => ({
    ufrag: (sdp.match(/^a=ice-ufrag:(.+)$/mi) || [])[1],
    pwd: (sdp.match(/^a=ice-pwd:(.+)$/mi) || [])[1]
  });

  // rejoin.js  — reconnect without re-pairing
  typeof window !== "undefined" && window.__boot && window.__boot.mark("rejoin");
  var REJOIN_TTL = 45e3;
  var REJOIN_COOLDOWN = 2e4;
  var REJOIN_FRESH = 12e4;
  var rejoinTries = /* @__PURE__ */ new Map();
  var rejoinPending = /* @__PURE__ */ new Map();

  /* The relay only ever sees an opaque blob addressed to someone else. It is
     sealed with the same pairing-derived key store-and-forward uses, so a
     helpful third phone cannot read or alter what it passes along. */
  async function rejoinSeal(toId, obj) {
    const rec = await contact(toId);
    const key = await carryKeyFor(rec);
    if (!key) throw new Error("no stored key for that contact");
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce }, key, te.encode(JSON.stringify(obj))
    ));
    return b64(concat(nonce, ct));
  }
  async function rejoinOpen(fromId, packed) {
    const rec = await contact(fromId);
    const key = await carryKeyFor(rec);
    if (!key) throw new Error("no stored key for that contact");
    const raw = unb64(packed);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12)
    );
    return JSON.parse(td.decode(new Uint8Array(pt)));
  }

  /* Peers linked to us that might also be linked to the target. We cannot know
     who they can reach, so we ask them all and let them drop what they cannot
     forward. */
  var relaysFor = (targetId) => openLinks().filter((l) => l.peerId !== targetId);

  function rejoinReady(peerId) {
    const last = rejoinTries.get(peerId) || 0;
    return Date.now() - last > REJOIN_COOLDOWN;
  }

  /* Build a sealed offer for a contact and remember it until it is answered or
     goes stale. Shared by every way of carrying it: a relaying contact, or the
     local network. */
  async function rejoinMakeOffer(peerId) {
    const old = rejoinPending.get(peerId);
    if (old) {
      try {
        old.pc.close();
      } catch (e) {
      }
      rejoinPending.delete(peerId);
    }
    rejoinTries.set(peerId, Date.now());
    const pc = newPeerConnection();
    const dc = pc.createDataChannel("cyanotype", { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc, 2500);
    const payload = {
      sdp: pc.localDescription.sdp,
      at: Date.now(),
      fp: certificate ? null : fpOf(pc)
    };
    const packed = await rejoinSeal(peerId, payload);
    const entry = { pc, dc, role: "inviter", at: Date.now() };
    rejoinPending.set(peerId, entry);
    setTimeout(() => {
      if (rejoinPending.get(peerId) === entry && !(link(peerId) || {}).open) {
        try {
          pc.close();
        } catch (e) {
        }
        rejoinPending.delete(peerId);
        emit("rejoinfail", { peerId });
      }
    }, REJOIN_TTL);
    return packed;
  }

  /* Start a reconnect to a peer we can no longer reach directly. */
  async function rejoinStart(peerId) {
    var _a;
    if (((_a = link(peerId)) == null ? void 0 : _a.open)) return "already-linked";
    if (!rejoinReady(peerId)) return "cooling-down";
    const relays = relaysFor(peerId);
    if (!relays.length) return "no-relay";
    const rec = await contact(peerId);
    if (!rec || !rec.secret) return "not-paired";
    const packed = await rejoinMakeOffer(peerId);

    let sent = 0;
    for (const l of relays) {
      try {
        await l.sendCtrl({ t: "rejoin", to: peerId, from: selfId, packed, exp: Date.now() + REJOIN_TTL });
        sent++;
      } catch (e) {
      }
    }
    emit("rejoinstart", { peerId, relays: sent });
    return sent ? "sent" : "no-relay";
  }

  /* Forward on behalf of someone else, or handle it if we are the target. */
  async function rejoinRelay(fromPeer, msg) {
    if (!msg || !msg.to || !msg.from || !msg.packed) return;
    if (msg.exp && msg.exp < Date.now()) return;
    if (msg.to !== selfId) {
      const l = link(msg.to);
      if (l == null ? void 0 : l.open) {
        l.sendCtrl({ ...msg, t: "rejoin" }).catch(() => {
        });
        emit("rejoinrelayed", { to: msg.to });
      }
      return;
    }
    // We are the target: answer back through whoever can still reach them.
    await rejoinIncoming(msg.from, msg.packed, (packed) => {
      const back = { t: "rejoin", to: msg.from, from: selfId, packed, exp: Date.now() + REJOIN_TTL };
      const direct = link(fromPeer);
      if (direct == null ? void 0 : direct.open) direct.sendCtrl(back).catch(() => {
      });
      for (const l of relaysFor(msg.from)) {
        if (l.peerId !== fromPeer) l.sendCtrl(back).catch(() => {
        });
      }
    });
  }

  /* A sealed offer or answer meant for us, however it arrived. Only a contact
     we paired with can make one we can open, and we act only while we are
     genuinely not connected to them. fresh: also refuse an offer more than two
     minutes old, for transports where a stranger could replay what they saw. */
  async function rejoinIncoming(fromId, packed, reply, opts = {}) {
    const rec = await contact(fromId);
    if (!rec || !rec.secret) return;
    let body;
    try {
      body = await rejoinOpen(fromId, packed);
    } catch (e) {
      return emit("rejoinbad", { from: fromId, reason: "could not be opened" });
    }
    if (body.answer) return void rejoinAnswered(fromId, body);
    if (!body.sdp) return;
    if (opts.fresh && !(typeof body.at === "number" && Math.abs(Date.now() - body.at) < REJOIN_FRESH)) {
      return emit("rejoinbad", { from: fromId, reason: "stale offer" });
    }
    if ((link(fromId) || {}).open) return;
    /* Both phones asked at the same moment: keep the offer from the lower id,
       on both sides, so exactly one link comes out of it. */
    const mine = rejoinPending.get(fromId);
    if (mine && mine.role === "inviter") {
      if (mine.coded || selfId < fromId) return;
      try {
        mine.pc.close();
      } catch (e) {
      }
      rejoinPending.delete(fromId);
    }

    const pc = newPeerConnection();
    pc.ondatachannel = (ev) => rejoinFinish(fromId, pc, ev.channel, "joiner");
    await pc.setRemoteDescription({ type: "offer", sdp: body.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc, 2500);
    rejoinPending.set(fromId, { pc, role: "joiner", at: Date.now() });

    reply(await rejoinSeal(fromId, { answer: true, sdp: pc.localDescription.sdp, at: Date.now() }));
    emit("rejoinanswering", { peerId: fromId });
  }

  async function rejoinAnswered(peerId, body) {
    const p = rejoinPending.get(peerId);
    if (!p || p.role !== "inviter") return;
    if (p.answered) return;
    p.answered = true;
    try {
      await p.pc.setRemoteDescription({ type: "answer", sdp: body.sdp });
      rejoinFinish(peerId, p.pc, p.dc, "inviter");
    } catch (e) {
      // An answer to an offer we had already replaced: wait for the right one.
      p.answered = false;
      emit("rejoinbad", { from: peerId, reason: e.message });
    }
  }

  /* Same key schedule as a fresh pairing, keyed off the stored secret rather
     than one carried in a QR. No safety-number prompt: the identity was pinned
     the first time and has not changed. */
  async function rejoinFinish(peerId, pc, dc, role) {
    const rec = await contact(peerId);
    if (!rec || !rec.secret) return;
    const link2 = register(peerId, pc, dc, role);
    const localFp = fpOf(pc);
    const remoteFp = rec.certFp ? Array.from(rec.certFp) : remoteFpOf(pc);
    await link2.attachKeys(new Uint8Array(rec.secret), new Uint8Array(localFp), new Uint8Array(remoteFp));
    rejoinPending.delete(peerId);
    emit("rejoined", { peerId, role });
  }

  /* Show a code. The address is ours, so the other phone can reach us and we
     can discover them from their first check. */
  async function rejoinOffer(peerId) {
    const rec = await contact(peerId);
    if (!rec || !rec.secret) throw new Error("You have not paired with them yet, so there is nothing to restore.");
    if (!rec.certFp && !certificate) throw new Error("This browser would not keep a certificate, so a short code cannot work. Pair again instead.");
    const pc = newPeerConnection();
    const dc = pc.createDataChannel("cyanotype", { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc, 2500);
    const ice = iceOf(pc.localDescription.sdp);
    const addr = addrOf(pc);
    rejoinPending.set(peerId, { pc, dc, role: "inviter", at: Date.now(), coded: true });
    return {
      code: groupCode(packRejoin({ ufrag: ice.ufrag, pwd: ice.pwd, addr: addr && addr.ip, port: addr && addr.port })),
      peerId
    };
  }
  /* Enter their code, then hand back our own for them to enter. Ours carries no
     address: their checks arrive first and tell us where they are. */
  async function rejoinAccept(peerId, code) {
    const rec = await contact(peerId);
    if (!rec || !rec.secret) throw new Error("You have not paired with them yet.");
    if (!rec.certFp) throw new Error("No pinned certificate for them, so their code cannot be trusted. Pair again instead.");
    const parsed = unpackRejoin(code);
    if (!parsed.ufrag || !parsed.pwd) throw new Error("That code is incomplete.");
    const pc = newPeerConnection();
    pc.ondatachannel = (ev) => rejoinFinish(peerId, pc, ev.channel, "joiner");
    await pc.setRemoteDescription({ type: "offer", sdp: rejoinSdp(parsed, rec.certFp, "actpass") });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitForIce(pc, 2500);
    rejoinPending.set(peerId, { pc, role: "joiner", at: Date.now(), coded: true });
    const ice = iceOf(pc.localDescription.sdp);
    return { code: groupCode(packRejoin({ ufrag: ice.ufrag, pwd: ice.pwd, addr: null, port: 0 })) };
  }
  /* The offering side takes their reply code and completes. */
  async function rejoinComplete(peerId, code) {
    const p = rejoinPending.get(peerId);
    if (!p || p.role !== "inviter") throw new Error("Show a code first, then enter their reply.");
    const rec = await contact(peerId);
    const parsed = unpackRejoin(code);
    if (!parsed.ufrag || !parsed.pwd) throw new Error("That reply code is incomplete.");
    await p.pc.setRemoteDescription({ type: "answer", sdp: rejoinSdp(parsed, rec.certFp, "active") });
    rejoinFinish(peerId, p.pc, p.dc, "inviter");
  }
  var remoteFpOf = (pc) => {
    var _a;
    const m = (((_a = pc.remoteDescription) == null ? void 0 : _a.sdp) || "").match(/^a=fingerprint:sha-256 (.+)$/mi);
    return m ? m[1].split(":").map((h) => parseInt(h, 16)) : [];
  };

  // lan.js — finding contacts again on the same Wi-Fi (Android wrapper only)
  /* A web page cannot announce itself or listen on the local network, so the
     wrapper does the finding (Android's network service discovery) and moves
     lines of text over plain sockets. It understands none of them. Every
     decision is made here: whether the other phone is a contact, whether it
     proved it, and the sealed offer itself.

     What a stranger on the same Wi-Fi can learn: that a Cyanotype phone is
     there. The tags in a probe are keyed by a pairing secret and a fresh random
     value, so they mean nothing to anyone else and never repeat. Both phones
     prove they hold the shared secret before either sends an offer, and the
     offer is sealed with the key from pairing, so a stranger can neither read
     one nor make one. */
  typeof window !== "undefined" && window.__boot && window.__boot.mark("lan");
  var LAN_RETRY = 3e4;
  var LAN_MAX_LINE = 32768;
  var LAN_MAX_TAGS = 64;
  var LAN_BG_WINDOW = 18e5;
  var lanOn = false;
  var lanPeers = /* @__PURE__ */ new Map();
  var lanConns = /* @__PURE__ */ new Map();
  /* Contacts whose link dropped while we were linked: the ones worth looking
     for in the background. Contacts we have not seen this session are only
     looked for while the app is in front. */
  var lanDropped = /* @__PURE__ */ new Map();
  var lanBg = "30";
  var lanKeys = /* @__PURE__ */ new Map();
  async function lanMac(rec, label) {
    let k = lanKeys.get(rec.id);
    if (!k) {
      k = await crypto.subtle.importKey("raw", new Uint8Array(rec.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      lanKeys.set(rec.id, k);
    }
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode("cyanotype/lan/v1|" + label)));
    return b64(mac.subarray(0, 16));
  }
  var lanNonce = () => b64(crypto.getRandomValues(new Uint8Array(16)));
  var lanUsable = (c) => c && c.secret && !(link(c.id) || {}).open;
  /* Who to ask about: everyone missing while the app is in front, only the
     recently dropped while it is in the background. */
  async function lanWanted() {
    const all = (await contacts()).filter((c) => lanUsable(c) && !rejoinPending.has(c.id));
    return appAway() ? all.filter((c) => lanDropped.has(c.id)) : all;
  }
  function lanBgActive() {
    if (!lanOn || !lanDropped.size || lanBg === "off") return false;
    if (lanBg === "always") return true;
    const latest = Math.max(...lanDropped.values());
    return Date.now() - latest < LAN_BG_WINDOW;
  }
  function lanSend(conn, obj) {
    const data = JSON.stringify(obj);
    if (data.length > LAN_MAX_LINE) return Promise.resolve();
    return NATIVE.lanSend({ conn, data }).catch(() => {
    });
  }
  function lanDrop(conn) {
    lanConns.delete(conn);
    NATIVE.lanClose({ conn }).catch(() => {
    });
  }
  /* The socket only carries the handshake. Once the offer and answer have
     crossed it, the link itself runs over WebRTC, so it is closed either way. */
  function lanTrack(conn, st) {
    lanConns.set(conn, st);
    setTimeout(() => {
      if (lanConns.get(conn) === st) lanDrop(conn);
    }, REJOIN_TTL + 5e3);
    return st;
  }
  async function lanProbe(peer, force) {
    if (!lanOn || appAway() && !lanBgActive()) return;
    const p = lanPeers.get(peer);
    if (!p || !force && Date.now() - p.lastProbe < LAN_RETRY) return;
    const wanted = (await lanWanted()).slice(0, LAN_MAX_TAGS);
    if (!wanted.length) return;
    p.lastProbe = Date.now();
    const n = lanNonce();
    const tags = /* @__PURE__ */ new Map();
    for (const c of wanted) tags.set(await lanMac(c, "probe|" + n), c.id);
    let conn;
    try {
      ({ conn } = await NATIVE.lanConnect({ peer }));
    } catch (e) {
      return;
    }
    lanTrack(conn, { out: true, n, tags, ok: /* @__PURE__ */ new Set(), offers: 0 });
    await lanSend(conn, { v: 1, t: "probe", n, h: [...tags.keys()] });
  }
  /* Two probes can cross (each phone found the other): one offer is enough,
     and a second would only replace the first mid-handshake. Reserved before
     the first await, because building an offer takes a moment. */
  var lanOffering = /* @__PURE__ */ new Set();
  async function lanOffer(conn, tag, id) {
    if ((link(id) || {}).open || lanOffering.has(id)) return;
    const mine = rejoinPending.get(id);
    if (mine && Date.now() - mine.at < REJOIN_TTL) return;
    lanOffering.add(id);
    try {
      const packed = await rejoinMakeOffer(id);
      await lanSend(conn, { v: 1, t: "rejoin", h: tag, packed });
      emit("rejoinstart", { peerId: id, lan: true });
    } finally {
      lanOffering.delete(id);
    }
  }
  /* Lines on one connection are handled strictly in order: an offer that
     overtook the proof before it would be refused. */
  var lanChains = /* @__PURE__ */ new Map();
  function lanQueue(conn, data) {
    if (typeof conn !== "string") return;
    const prev = lanChains.get(conn) || Promise.resolve();
    const next = prev.then(() => lanFrame(conn, data)).catch(() => lanDrop(conn));
    lanChains.set(conn, next);
    next.then(() => {
      if (lanChains.get(conn) === next) lanChains.delete(conn);
    });
  }
  async function lanFrame(conn, data) {
    if (typeof conn !== "string") return;
    if (typeof data !== "string" || data.length > LAN_MAX_LINE) return lanDrop(conn);
    let m;
    try {
      m = JSON.parse(data);
    } catch (e) {
      return lanDrop(conn);
    }
    if (!m || m.v !== 1 || typeof m.t !== "string") return lanDrop(conn);
    const st = lanConns.get(conn) || lanTrack(conn, { out: false, tags: /* @__PURE__ */ new Map(), ok: /* @__PURE__ */ new Set(), offers: 0 });
    const str = (x) => typeof x === "string" && x.length <= 64;
    if (m.t === "probe") {
      /* Someone asks whether we know any of these tags. Answer only for real
         matches, each with a proof that we hold the same secret. */
      if (st.out || st.n || !str(m.n) || !Array.isArray(m.h)) return lanDrop(conn);
      st.n = m.n;
      st.mine = lanNonce();
      const asked = new Set(m.h.slice(0, LAN_MAX_TAGS).filter(str));
      const proofs = [];
      for (const c of await contacts()) {
        if (!lanUsable(c)) continue;
        const tag = await lanMac(c, "probe|" + st.n);
        if (!asked.has(tag)) continue;
        st.tags.set(tag, c.id);
        proofs.push({ h: tag, p: await lanMac(c, "match|" + st.n + "|" + st.mine) });
      }
      if (!proofs.length) return lanDrop(conn);
      await lanSend(conn, { v: 1, t: "match", n: st.mine, m: proofs });
      return;
    }
    if (m.t === "match") {
      /* They claim to know some of our contacts: check each proof, prove
         ourselves back, and the lower id of each pair sends the offer. */
      if (!st.out || st.theirs || !str(m.n) || !Array.isArray(m.m)) return lanDrop(conn);
      st.theirs = m.n;
      const back = [];
      for (const it of m.m.slice(0, LAN_MAX_TAGS)) {
        const id = it && str(it.h) && st.tags.get(it.h);
        const rec = id && await contact(id);
        if (!lanUsable(rec) || !str(it.p) || it.p !== await lanMac(rec, "match|" + st.n + "|" + st.theirs)) continue;
        st.ok.add(it.h);
        back.push({ h: it.h, p: await lanMac(rec, "confirm|" + st.theirs) });
      }
      if (!back.length) return lanDrop(conn);
      await lanSend(conn, { v: 1, t: "confirm", m: back });
      for (const h of st.ok) if (selfId < st.tags.get(h)) lanOffer(conn, h, st.tags.get(h)).catch(() => {
      });
      return;
    }
    if (m.t === "confirm") {
      if (st.out || !st.mine || st.confirmed || !Array.isArray(m.m)) return lanDrop(conn);
      st.confirmed = true;
      for (const it of m.m.slice(0, LAN_MAX_TAGS)) {
        const id = it && str(it.h) && st.tags.get(it.h);
        const rec = id && await contact(id);
        if (!lanUsable(rec) || !str(it.p) || it.p !== await lanMac(rec, "confirm|" + st.mine)) continue;
        st.ok.add(it.h);
        if (selfId < id) lanOffer(conn, it.h, id).catch(() => {
        });
      }
      if (!st.ok.size) lanDrop(conn);
      return;
    }
    if (m.t === "rejoin") {
      const id = str(m.h) && st.ok.has(m.h) && st.tags.get(m.h);
      if (!id || typeof m.packed !== "string" || ++st.offers > 2 * LAN_MAX_TAGS) return lanDrop(conn);
      await rejoinIncoming(id, m.packed, (packed) => lanSend(conn, { v: 1, t: "rejoin", h: m.h, packed }), { fresh: true });
      return;
    }
    lanDrop(conn);
  }
  /* Called on a timer, when a link drops, and when the app comes to the front. */
  function lanSweep(force) {
    if (!lanOn) return;
    for (const peer of lanPeers.keys()) lanProbe(peer, force).catch(() => {
    });
  }
  function lanWire() {
    if (!NATIVE || typeof NATIVE.lanStart !== "function") return;
    NATIVE.addListener("lanPeer", (d) => {
      if (!d || typeof d.peer !== "string") return;
      if (!d.found) return void lanPeers.delete(d.peer);
      if (!lanPeers.has(d.peer)) lanPeers.set(d.peer, { lastProbe: 0 });
      lanProbe(d.peer).catch(() => {
      });
    });
    NATIVE.addListener("lanFrame", (d) => {
      if (d) lanQueue(d.conn, d.data);
    });
    NATIVE.addListener("lanClosed", (d) => {
      if (d) lanConns.delete(d.conn);
    });
    lanOn = true;
    NATIVE.lanStart().catch(() => {
      lanOn = false;
    });
    setInterval(() => {
      lanSweep(false);
      syncService();
    }, LAN_RETRY);
  }

  // geo.js
  typeof window !== "undefined" && window.__boot && window.__boot.mark("geo");
  var LOC_WINDOW = 6e5;
  var LOC_WARN = 6e4;
  var LOC_MIN_GAP = 12e3;
  var locShare = null;
  var fixOf = (p) => ({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: p.timestamp || Date.now() });
  function locError(e) {
    if ((e == null ? void 0 : e.code) === 1) return "Location access is blocked for this site. Allow it in your browser settings and try again.";
    if ((e == null ? void 0 : e.code) === 2) return "Your position is not available right now. Indoors with no GPS fix is the usual cause.";
    if ((e == null ? void 0 : e.code) === 3) return "Timed out waiting for a position fix. Try again near a window or outside.";
    return "Could not read your location.";
  }
  async function sendGroupObj(conv, obj, groupKey) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      groupKey,
      te.encode(JSON.stringify({ id: crypto.randomUUID(), from: selfId, at: Date.now(), ...obj }))
    ));
    const packed = b64(concat(nonce, ct));
    if (conv.hostId === selfId) await relayToRoom(conv.id, conv.members, null, { t: "group-msg", packed });
    else {
      const l = link(conv.hostId);
      await (l == null ? void 0 : l.sendCtrl({ t: "group-msg", convId: conv.id, packed }));
    }
  }
  /* One window, ten minutes, no silent renewal. The timer is the whole point of
     the feature, so it lives here rather than in the UI: whatever the screen is
     showing, the watch stops when the window closes. */
  async function locStart(conv, groupKey) {
    if (!navigator.geolocation) throw new Error("This browser has no location access.");
    if (locShare) throw new Error("You are already sharing your location. Stop that first.");
    let first;
    try {
      first = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(
        res, rej, { enableHighAccuracy: true, timeout: 15e3, maximumAge: 0 }
      ));
    } catch (e) {
      throw new Error(locError(e));
    }
    locShare = {
      id: uuid(),
      convId: conv.id,
      title: conv.title,
      type: conv.type,
      peerId: conv.peerId,
      hostId: conv.hostId,
      members: conv.members,
      groupKey,
      endsAt: Date.now() + LOC_WINDOW,
      extensions: 0,
      warned: false,
      lastSent: 0
    };
    locShare.tick = setInterval(locTick, 1e3);
    locShare.watchId = navigator.geolocation.watchPosition(
      (p) => locPush(fixOf(p)),
      () => {
      },
      { enableHighAccuracy: true, maximumAge: 1e4, timeout: 3e4 }
    );
    emit("locstart", { share: locShare, fix: fixOf(first) });
    await locPush(fixOf(first), true);
    return locShare;
  }
  async function locPush(fix, force) {
    if (!locShare) return;
    const now = Date.now();
    if (!force && now - locShare.lastSent < LOC_MIN_GAP) return;
    locShare.lastSent = now;
    locShare.last = fix;
    const payload = { shareId: locShare.id, ...fix, endsAt: locShare.endsAt, live: true };
    try {
      if (locShare.type === "group") {
        await sendGroupObj({ id: locShare.convId, hostId: locShare.hostId, members: locShare.members }, { kind: "location", ...payload }, locShare.groupKey);
      } else {
        const l = link(locShare.peerId);
        if (l == null ? void 0 : l.open) await l.sendCtrl({ t: "loc", convId: locShare.convId, ...payload });
      }
    } catch (e) {
    }
    emit("locfix", { fix, share: locShare });
  }
  function locTick() {
    if (!locShare) return;
    const left = locShare.endsAt - Date.now();
    if (left <= 0) return void locStop("window closed");
    if (left <= LOC_WARN && !locShare.warned) {
      locShare.warned = true;
      emit("locwarn", { share: locShare, left });
    }
    emit("loctick", { left, share: locShare });
  }
  /* Only ever called from a tap. There is deliberately no path that extends the
     window automatically. */
  function locExtend() {
    if (!locShare) return null;
    locShare.endsAt = Date.now() + LOC_WINDOW;
    locShare.warned = false;
    locShare.extensions++;
    locPush(locShare.last || {}, true).catch(() => {
    });
    emit("locextend", { share: locShare });
    return locShare;
  }
  async function locStop(reason) {
    if (!locShare) return;
    const s = locShare;
    locShare = null;
    clearInterval(s.tick);
    if (s.watchId != null) navigator.geolocation.clearWatch(s.watchId);
    try {
      if (s.type === "group") {
        await sendGroupObj({ id: s.convId, hostId: s.hostId, members: s.members }, { kind: "location-end", shareId: s.id }, s.groupKey);
      } else {
        const l = link(s.peerId);
        if (l == null ? void 0 : l.open) await l.sendCtrl({ t: "loc-end", convId: s.convId, shareId: s.id });
      }
    } catch (e) {
    }
    emit("locstop", { share: s, reason });
  }

  // app.js
  typeof window !== "undefined" && window.__boot && window.__boot.mark("app");
  var $ = (id) => document.getElementById(id);
  var el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== void 0) n.textContent = text;
    return n;
  };
  var me = null;
  var activeConv = null;
  var pending = null;
  var recorder = null;
  var groupKeys = /* @__PURE__ */ new Map();
  var PRESENCE_LABEL = { online: "Online", away: "Away", offline: "Not connected", connecting: "Connecting\u2026" };
  /* What the status pill says. The raw state stays on data-state for code and tests. */
  var STATUS_LABEL = {
    starting: "Starting\u2026",
    idle: "Ready",
    linked: "Connected",
    connecting: "Connecting\u2026",
    "gathering routes": "Getting ready\u2026",
    "opening camera": "Opening camera\u2026",
    scanning: "Scanning\u2026",
    "waiting for them": "Waiting for them\u2026",
    error: "Something went wrong",
    "needs https": "Needs HTTPS",
    unsupported: "Not supported here"
  };
  var MAX_FILE = 32 * 1024 * 1024;
  function show(name) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === "s-" + name));
    $("backBtn").classList.toggle("hide", name === "home");
    /* In a chat the page is pinned to the screen so only the messages
       scroll and the composer stays in reach. */
    document.body.classList.toggle("inChat", name === "chat");
    setTimeout(() => offerInvites().catch(() => {
    }), 400);
  }
  function toast(text, bad, onTap) {
    const t = $("toast");
    t.textContent = text;
    t.className = "toast on" + (bad ? " bad" : "") + (onTap ? " tap" : "");
    clearTimeout(toast.timer);
    t.onclick = onTap ? () => {
      t.className = "toast";
      t.onclick = null;
      onTap();
    } : null;
    if (!onTap) toast.timer = setTimeout(() => t.className = "toast", 5200);
  }
  function status(text, kind) {
    $("state").dataset.state = text;
    $("state").textContent = STATUS_LABEL[text] || text;
    $("dot").className = "dot" + (kind ? " " + kind : "");
  }
  /* Browsers keep storage per site, not per folder: on yourname.github.io/cyanotype,
     every other page under yourname.github.io could read this app's keys. */
  var sharedOrigin = () => {
    if (!/\.(github|gitlab)\.io$/i.test(location.hostname)) return false;
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.length > 1 || (parts.length === 1 && !parts[0].includes("."));
  };
  /* ---- small drawing helpers ---- */
  var ICON_CHAT = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg>';
  function iconEl(svgText) {
    const t = document.createElement("template");
    t.innerHTML = svgText;
    return t.content.firstChild;
  }
  var groupSize = (c) => {
    const n = (c.members || []).length;
    return n ? `${n + 1} people` : "Just you so far \u2014 add people from the chat";
  };
  var hueOf = (s) => {
    let h = 7;
    for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  };
  function initials(name) {
    const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    const pick = (w) => Array.from(w)[0] || "";
    return (words.length > 1 ? pick(words[0]) + pick(words[words.length - 1]) : pick(words[0])).toUpperCase();
  }
  /* Colour comes from the id, not the name, so renaming keeps the colour. */
  function avatarFor(name, isGroup, pres, key) {
    const a = el("span", "avatar" + (isGroup ? " group" : ""), initials(name));
    a.style.setProperty("--h", hueOf(key || name));
    if (!isGroup || pres === "online") a.append(el("span", "pip " + (pres === "online" ? "on" : pres === "away" ? "away" : "")));
    return a;
  }
  async function renderHome() {
    const [convs, contacts2] = await Promise.all([conversations(), contacts()]);
    const list = $("convList");
    list.innerHTML = "";
    $("homeNote").classList.toggle("hide", convs.length > 0);
    const totalUnread = convs.reduce((n, c) => n + (c.unread || 0), 0);
    $("tabChats").textContent = "Chats";
    if (totalUnread) $("tabChats").append(el("span", "badge", totalUnread > 99 ? "99+" : String(totalUnread)));
    if (!convs.length) {
      const empty = el("div", "empty");
      empty.append(
        iconEl(ICON_CHAT),
        el("p", null, "No chats yet"),
        el("p", "dim", "Pair with someone nearby to start one. You only scan a code the first time \u2014 after that they stay in your contacts.")
      );
      list.append(empty);
    }
    for (const c of convs) {
      const row = el("button", "row" + (c.unread ? " unread" : ""));
      onHold(row, () => chatMenu(c));
      const pres = c.type === "group" ? (c.members || []).some((id) => presenceOf(id) === "online") ? "online" : "offline" : presenceOf(c.peerId);
      const main = el("span", "rowMain");
      const top = el("span", "rowTop");
      top.append(el("span", "rowName", c.title), el("span", "rowTime", c.lastAt ? shortTime(c.lastAt) : ""));
      const bottom = el("span", "rowBottom");
      bottom.append(el("span", "rowSub", c.preview || (c.type === "group" ? `${groupSize(c)}` : "No messages yet")));
      if (c.unread) bottom.append(el("span", "badge", c.unread > 99 ? "99+" : String(c.unread)));
      main.append(top, bottom);
      row.append(avatarFor(c.title, c.type === "group", pres, c.peerId || c.id), main);
      row.onclick = () => openChat(c.id);
      list.append(row);
    }
    const cl = $("contactList");
    cl.innerHTML = "";
    if (!contacts2.length) {
      const empty = el("div", "empty");
      empty.append(
        el("p", null, "No contacts yet"),
        el("p", "dim", "People you pair with are saved here. You check a safety number with each of them once, and after that they stay trusted.")
      );
      cl.append(empty);
    }
    contacts2.sort((a, b) => a.name.localeCompare(b.name));
    for (const c of contacts2) {
      const row = el("button", "row");
      row.onclick = () => contactSheet(c);
      const pres = presenceOf(c.id);
      row.append(
        avatarFor(c.name, false, pres, c.id),
        (() => {
          const m = el("span", "rowMain");
          const top = el("span", "rowTop");
          top.append(el("span", "rowName", c.name));
          m.append(top, el("span", "rowSub", PRESENCE_LABEL[pres] + (c.verified ? " \xB7 safety number checked" : " \xB7 safety number not checked")));
          return m;
        })()
      );
      cl.append(row);
    }
  }
  var shortTime = (ts) => {
    const d = new Date(ts), now = /* @__PURE__ */ new Date();
    return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
  };
  async function guardCamera() {
    const st = await cameraState();
    if (st === "insecure") throw new Error("This page must be served over HTTPS. Camera and WebRTC are blocked otherwise.");
    if (st === "unsupported") throw new Error("This browser has no camera API. Try Chrome, Edge, or Safari.");
    if (st === "denied") throw new Error(
      "Camera access is blocked for this site. Tap the padlock in the address bar to re-allow it, and check Android Settings > Apps > Chrome > Permissions > Camera. A home-screen install has its own separate permission."
    );
  }
  async function startInvite(forConvId) {
    try {
      await guardCamera();
      status("opening camera", "wait");
      await primePermission();
      const eph = await newEphemeral();
      const pc = newPeerConnection();
      const dc = pc.createDataChannel("cyanotype", { ordered: true });
      status("gathering routes", "wait");
      await pc.setLocalDescription(await pc.createOffer());
      await waitForIce(pc);
      const payload = await encodeSignal(pc.localDescription.sdp, "offer", await ephemeralRaw(eph), me.identity);
      pending = { role: "inviter", pc, dc, eph, forConvId, localFp: fpOf(pc) };
      $("pairTitle").textContent = "Have them scan this";
      $("pairStep").textContent = "Step 1 of 2";
      $("pairHint").textContent = "Turn your brightness up. Once they've scanned it, they'll show you a code to scan back.";
      $("pairAction").textContent = "Scan their reply";
      $("pairAction").classList.remove("hide");
      $("pairAction").onclick = scanReply;
      show("pair");
      const info = drawQR(payload, $("qrOut"));
      $("qrStamp").textContent = `invite \xB7 ${payload.length} chars \xB7 v${info.version}`;
      keepAwake(true);
      status("waiting for them", "wait");
    } catch (e) {
      fail(e);
    }
  }
  async function startJoin() {
    try {
      await guardCamera();
      status("scanning", "wait");
      $("scanHint").textContent = "Hold steady about 20 cm from their screen.";
      show("scanner");
      const raw = await scanOnce($("cam"), (m) => toast(m, true));
      const got = await decodeSignal(raw);
      if (got.type !== "offer") throw new Error("That is a reply code, not an invite.");
      if (!got.eph) throw new Error("That invite is missing its key.");
      const pc = newPeerConnection();
      let dc = null;
      pc.ondatachannel = (ev) => {
        dc = ev.channel;
        finishLink(pc, dc, got, "joiner");
      };
      await pc.setRemoteDescription({ type: "offer", sdp: got.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      status("gathering routes", "wait");
      await waitForIce(pc);
      const eph = await newEphemeral();
      const secret = await pairSecret(eph, got.eph);
      pending = { role: "joiner", pc, secret, remote: got, localFp: fpOf(pc) };
      const payload = await encodeSignal(pc.localDescription.sdp, "answer", await ephemeralRaw(eph), me.identity);
      $("pairTitle").textContent = "Now show them this";
      $("pairStep").textContent = "Step 2 of 2";
      $("pairHint").textContent = "They scan this to finish the link. It connects a second or two later.";
      $("pairAction").classList.add("hide");
      show("pair");
      const info = drawQR(payload, $("qrOut"));
      $("qrStamp").textContent = `reply \xB7 ${payload.length} chars \xB7 v${info.version}`;
      keepAwake(true);
      status("connecting", "wait");
    } catch (e) {
      fail(e);
    }
  }
  async function scanReply() {
    try {
      $("scanHint").textContent = "Scan the reply code on their screen.";
      show("scanner");
      status("scanning", "wait");
      const raw = await scanOnce($("cam"), (m) => toast(m, true));
      const got = await decodeSignal(raw);
      if (got.type !== "answer") throw new Error("That is an invite code \u2014 you need their reply.");
      if (!got.eph) throw new Error("That reply is missing its key.");
      pending.secret = await pairSecret(pending.eph, got.eph);
      pending.eph = null;
      await pending.pc.setRemoteDescription({ type: "answer", sdp: got.sdp });
      finishLink(pending.pc, pending.dc, got, "inviter");
      status("connecting", "wait");
    } catch (e) {
      fail(e);
    }
  }
  /* The host candidate we are reachable on, remembered so a reconnect can name
     it. The port changes every session, so this is a hint, not a guarantee. */
  var addrOf = (pc) => {
    var _a;
    const sdp = ((_a = pc.localDescription) == null ? void 0 : _a.sdp) || "";
    const m = sdp.match(/^a=candidate:\S+ 1 udp \S+ (\S+) (\d+) typ host/mi);
    return m ? { ip: m[1], port: parseInt(m[2], 10) } : null;
  };
  var fpOf = (pc) => {
    const m = pc.localDescription.sdp.match(/^a=fingerprint:sha-256 (.+)$/mi);
    return m[1].split(":").map((h) => parseInt(h, 16));
  };
  async function finishLink(pc, dc, remote, role) {
    const peerId = await fingerprintOf(remote.pubRaw);
    const known = await contact(peerId);
    if (known && !equalBytes(known.pubRaw, remote.pubRaw)) {
      pc.close();
      return fail(new Error(`${known.name}'s identity key has changed. This could be a different device \u2014 or someone impersonating them. Remove the contact first if you meant to re-pair.`));
    }
    const link2 = register(peerId, pc, dc, role);
    await link2.attachKeys(pending.secret, new Uint8Array(pending.localFp), remote.fpBytes);
    const contact2 = await upsertContact(remote.pubRaw, (known == null ? void 0 : known.name) || "New contact");
    contact2.secret = new Uint8Array(pending.secret);
    // Pinned so a later reconnect needs no fingerprint on the wire, and so a
    // swapped certificate is visible.
    if (remote.fpBytes) contact2.certFp = new Uint8Array(remote.fpBytes);
    contact2.lastAddr = addrOf(pc);
    await saveContact(contact2);
    const forConvId = pending.forConvId;
    pending = null;
    keepAwake(false);
    if (forConvId) {
      if (known) return void await addToGroup(forConvId, contact2);
      // Someone new joining a group gets the same check as any new contact,
      // before they are given the group's key.
      const sn = await safetyNumber(me.selfPub, remote.pubRaw);
      showSafety(sn, contact2, () => addToGroup(forConvId, contact2), null);
      return;
    }
    let conv = (await conversations()).find((c) => c.type === "direct" && c.peerId === peerId);
    if (!conv) {
      conv = await saveConversation({
        id: crypto.randomUUID(),
        type: "direct",
        peerId,
        title: contact2.name,
        lastAt: Date.now(),
        members: [peerId]
      });
    }
    if (!known) {
      const sn = await safetyNumber(me.selfPub, remote.pubRaw);
      showSafety(sn, contact2, () => openChat(conv.id), conv.id);
    } else {
      toast(`Reconnected to ${contact2.name} \u2014 key matched, no check needed`);
      openChat(conv.id);
    }
    renderHome();
  }
  var equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  function showSafety(sn, contact2, onConfirm, convId) {
    const grid = $("safetyGrid");
    grid.innerHTML = "";
    sn.forEach((q) => grid.append(el("div", null, q)));
    $("nameInput").value = contact2.name === "New contact" ? "" : contact2.name;
    $("safetyConfirm").onclick = async () => {
      askNotify().catch(() => {
      });
      contact2.name = $("nameInput").value.trim() || "Unnamed";
      contact2.verified = true;
      await saveContact(contact2);
      const conv = convId ? await conversation(convId) : null;
      if (conv) {
        conv.title = contact2.name;
        await saveConversation(conv);
      }
      await onConfirm();
      renderHome();
    };
    $("safetyReject").onclick = () => rejectPairing(contact2, convId).catch((e) => toast(e.message, true));
    show("safety");
    status("linked", "live");
  }
  /* The numbers did not match: whoever is on the other end is not trusted
     with anything. Close the link and forget them completely. */
  async function rejectPairing(c, convId) {
    const l = link(c.id);
    if (l) l.close();
    if (convId) await deleteConversation(convId);
    await removeContact(c.id);
    show("home");
    renderHome();
    toast("Not saved. Pair again \u2014 if the numbers still differ, someone may be intercepting the link.", true);
  }
  async function openChat(convId) {
    activeConv = await conversation(convId);
    if (!activeConv) return;
    clearAlerts(convId);
    $("chatTitle").textContent = activeConv.title;
    updateChatPresence();
    const log = $("log");
    log.innerHTML = "";
    delete log.dataset.day;
    log.dataset.loading = "1";
    for (const m of await messages(convId)) await renderMessage(m, log);
    delete log.dataset.loading;
    log.scrollTop = log.scrollHeight;
    $("jumpBtn").classList.add("hide");
    syncComposer();
    $("groupAdd").classList.toggle("hide", activeConv.type !== "group" || activeConv.hostId !== me.selfId);
    $("callBtn").classList.toggle("hide", activeConv.type !== "direct");
    $("rejoinBtn").classList.toggle("hide",
      activeConv.type !== "direct" || presenceOf(activeConv.peerId) === "online");
    show("chat");
    markRead(activeConv).catch(() => {
    });
    resetUnread(convId).catch(() => {
    });
    holdTip().catch(() => {
    });
  }
  async function resetUnread(convId) {
    const c = await conversation(convId);
    if (!c || !c.unread) return;
    c.unread = 0;
    await saveConversation(c);
    renderHome();
  }
  /* Press-and-hold has no visible sign, so say so once. */
  async function holdTip() {
    if (!$("log").querySelector(".msg") || await getSetting("tipHold")) return;
    await putSetting("tipHold", true);
    setTimeout(() => toast("Tip: press and hold a message to copy, save or delete it"), 700);
  }
  var clockTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function dayLabel(ts) {
    const d = new Date(ts), today = /* @__PURE__ */ new Date(), yest = /* @__PURE__ */ new Date();
    yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yest.toDateString()) return "Yesterday";
    const opts = { weekday: "short", day: "numeric", month: "short" };
    if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString([], opts);
  }
  /* The composer grows with the text, and the round button is the mic until
     there is something to send. */
  function syncComposer() {
    const ta = $("msgInput");
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight + 2, 132) + "px";
    const has = ta.value.trim().length > 0;
    $("sendBtn").classList.toggle("hide", !has);
    $("micBtn").classList.toggle("hide", has && !$("micBtn").classList.contains("rec"));
  }
  function attachMenu() {
    sheet({
      eyebrow: "Send",
      title: "Add to the chat",
      actions: [
        { label: "Photo or file", sub: `Up to ${fmtSize(MAX_FILE)}`, run: () => $("fileInput").click() },
        { label: "Share my location", kind: "alt", sub: "Live for 10 minutes, then stops by itself", run: () => $("locBtn").click() }
      ]
    });
  }
  function updateChatPresence() {
    if (!activeConv) return;
    if (activeConv.type === "group") {
      const on2 = (activeConv.members || []).filter((id) => presenceOf(id) === "online").length;
      $("chatSub").textContent = (activeConv.members || []).length ? `${activeConv.members.length + 1} people \xB7 ${on2} connected` : "Just you so far";
      return;
    }
    const p = presenceOf(activeConv.peerId);
    $("chatSub").textContent = PRESENCE_LABEL[p];
    $("chatSub").className = "chatSub " + p;
  }
  async function renderMessage(m, log = $("log")) {
    const mine = m.from === me.selfId;
    const wrap = el("div", "msg " + (mine ? "me" : "them"));
    if ((activeConv == null ? void 0 : activeConv.type) === "group" && !mine && m.senderName) wrap.append(el("span", "who", m.senderName));
    if (m.kind === "text") {
      wrap.append(document.createTextNode(m.text || ""));
    } else if (m.kind === "image") {
      const img = el("img", "att");
      img.loading = "lazy";
      blobUrl(m.blobId, m.mime).then((u) => u && (img.src = u));
      wrap.append(img);
    } else if (m.kind === "audio") {
      const a = el("audio", "att");
      a.controls = true;
      blobUrl(m.blobId, m.mime).then((u) => u && (a.src = u));
      wrap.append(a);
    } else if (m.kind === "file") {
      wrap.append(fileCard(m));
    } else if (m.kind === "location") {
      const lc = locCard(m);
      lc.dataset.msg = m.id;
      wrap.append(lc);
    } else if (m.kind === "call") {
      wrap.append(callCard(m));
    }
    if (m.state === "queued") wrap.classList.add("queued");
    wrap.dataset.id = m.id;
    const stamp = el("span", "t", clockTime(m.at));
    if (m.state === "relayed") stamp.append(el("span", "tag", "via relay"));
    /* One tick left this phone, two reached theirs, two blue were opened.
       Only for your own messages in a one-to-one thread. */
    if (mine && (activeConv == null ? void 0 : activeConv.type) === "direct" && m.kind !== "call") {
      const st = m.state || "sent";
      const tick = el("span", "ticks " + st,
        st === "queued" ? "\u25CB" : st === "sent" ? "\u2713" : "\u2713\u2713");
      tick.title = { queued: "waiting to be sent", sent: "sent", delivered: "delivered to their phone", read: "opened" }[st] || st;
      stamp.append(tick);
    }
    wrap.append(stamp);
    onHold(wrap, () => messageMenu(wrap, m));
    const day = new Date(m.at).toDateString();
    if (log.dataset.day !== day) {
      log.dataset.day = day;
      log.append(el("div", "daySep", dayLabel(m.at)));
    }
    /* Follow the conversation only if the reader is already at the bottom:
       someone scrolled up to reread something should not be yanked down. */
    const following = log.dataset.loading || mine || log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    log.append(wrap);
    if (following) log.scrollTop = log.scrollHeight;
    else if (log.id === "log") $("jumpBtn").classList.remove("hide");
    return wrap;
  }
  var fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " bytes";
  var fmtClock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1e3));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  /* Files are never opened for you \u2014 only saved. The announced hash is shown so a
     receiver can tell a truncated or swapped file from a good one. */
  function fileCard(m) {
    const box = el("div", "card2");
    box.append(el("span", "cap", "file"));
    box.append(el("span", "nm", m.name || "unnamed file"));
    box.append(el("span", "meta", fmtSize(m.size || 0) + (m.hash ? " \xB7 sha256 " + m.hash : "")));
    if (m.hashOk === false) box.append(el("span", "meta", "\u26A0 this does not match the hash the sender announced"));
    const acts = el("div", "acts");
    const a = el("button", null, "Save");
    a.onclick = () => saveAttachment(m).catch((e) => toast(e.message || String(e), true));
    acts.append(a);
    box.append(acts);
    return box;
  }
  function locCard(m) {
    let d = {};
    try {
      d = JSON.parse(m.text || "{}");
    } catch (e) {
    }
    const box = el("div", "card2");
    box.dataset.share = d.shareId || "";
    const live = d.live && d.endsAt && d.endsAt > Date.now();
    box.append(el("span", "cap", live ? "live location" : "location"));
    box.append(el("span", "nm", d.lat != null ? d.lat.toFixed(5) + ", " + d.lon.toFixed(5) : "waiting for a fix"));
    const bits = [];
    if (d.acc != null) bits.push("\xB1" + Math.round(d.acc) + " m");
    bits.push("updated " + shortTime(d.at || m.at));
    if (live) bits.push("stops in " + fmtClock(d.endsAt - Date.now()));
    else if (d.endsAt) bits.push("sharing ended");
    box.append(el("span", "meta", bits.join(" \xB7 ")));
    if (d.lat != null) {
      const acts = el("div", "acts");
      const a = el("a", null, "Open in maps");
      a.href = "geo:" + d.lat + "," + d.lon + "?q=" + d.lat + "," + d.lon;
      const cp = el("button", null, "Copy");
      cp.onclick = () => {
        const s = d.lat + ", " + d.lon;
        if (navigator.clipboard) navigator.clipboard.writeText(s).then(() => toast("Coordinates copied")).catch(() => toast(s));
        else toast(s);
      };
      acts.append(a, cp);
      box.append(acts);
    }
    return box;
  }
  function callCard(m) {
    let d = {};
    try {
      d = JSON.parse(m.text || "{}");
    } catch (e) {
    }
    const box = el("div", "card2");
    box.append(el("span", "cap", "voice call"));
    box.append(el("span", "nm", d.label || "Call"));
    if (d.secs) box.append(el("span", "meta", fmtClock(d.secs * 1e3)));
    return box;
  }
  function refreshLocCard(shareId) {
    const node = document.querySelector('.card2[data-share="' + shareId + '"]');
    if (!node) return;
    const msgId = node.dataset.msg;
    if (!msgId) return;
    messages(activeConv ? activeConv.id : "", 400).then((rows) => {
      const m = rows.find((r) => r.id === msgId);
      if (!m) return;
      const fresh = locCard(m);
      fresh.dataset.msg = msgId;
      node.replaceWith(fresh);
    });
  }
  async function sendText() {
    const input = $("msgInput");
    const text = input.value.trim();
    if (!text || !activeConv) return;
    input.value = "";
    syncComposer();
    try {
      if (activeConv.type === "group") {
        await sendGroupText(activeConv, me.selfId, text, groupKeys.get(activeConv.id));
        const gm = await addMessage({ convId: activeConv.id, from: me.selfId, kind: "text", text });
        await renderMessage(gm);
        renderHome();
        return;
      }
      const l = link(activeConv.peerId);
      if (!(l == null ? void 0 : l.open)) return queueText(text);
      // The id is minted first so the frame on the wire and the local row agree.
      const id = crypto.randomUUID();
      await l.sendText(activeConv.id, text, id);
      const m = await addMessage({ convId: activeConv.id, from: me.selfId, kind: "text", text, id, state: "sent" });
      await renderMessage(m);
      renderHome();
    } catch (e) {
      toast(e.message, true);
    }
  }
  /* Nobody is reachable, so the message is sealed to the recipient and parked.
     It goes out when we meet them, or hitches a ride on a contact we both have. */
  async function queueText(text) {
    const conv = activeConv;
    try {
      const env = await carrySeal(conv.peerId, conv.id, "text", { text });
      const m = await addMessage({ convId: conv.id, from: me.selfId, kind: "text", text, state: "queued" });
      await patchMessage(m.id, { envId: env.id });
      m.envId = env.id;
      await renderMessage(m);
      toast("Not connected \u2014 queued. It goes out when you next meet, or via a contact you both trust.");
      renderHome();
    } catch (e) {
      toast(e.message, true);
    }
  }
  var LABEL = { image: "Photo", audio: "Voice note", file: "File" };
  /* Attachments have no store-and-forward path: a queued 20 MB file would sit in
     the relay's storage for a day. They need a live link. */
  function fanout(conv) {
    if (conv.type !== "group") return [link(conv.peerId)].filter((l) => l == null ? void 0 : l.open);
    const ids = conv.hostId === me.selfId ? conv.members || [] : [conv.hostId];
    return ids.map((id) => link(id)).filter((l) => l == null ? void 0 : l.open);
  }
  async function sendAttachment(payload, kind) {
    if (!activeConv) return;
    const conv = activeConv;
    const targets = fanout(conv);
    if (!targets.length) return toast("Not connected \u2014 files need a live link. Text and location can queue, attachments cannot.", true);
    payload.hash = await sha256Hex(payload.bytes);
    const m = await addMessage({
      convId: conv.id,
      from: me.selfId,
      kind,
      bytes: payload.bytes,
      mime: payload.mime,
      name: payload.name,
      hash: payload.hash
    });
    await renderMessage(m);
    toast(`Sending ${LABEL[kind].toLowerCase()}\u2026`);
    try {
      for (const l of targets) {
        const wid = await l.sendFile(conv.id, payload, (r) => status(`sending ${Math.round(r * 100)}%`, "wait"));
        if (wid && conv.type === "direct") {
          await patchMessage(m.id, { wireId: wid, state: "sent" });
          m.wireId = wid;
          m.state = "sent";
          refreshTicks(m);
        }
      }
      status("linked", "live");
      toast(`${LABEL[kind]} sent`);
    } catch (e) {
      toast("Send failed: " + e.message, true);
    }
    renderHome();
  }
  function createGroup() {
    askText({
      eyebrow: "New group",
      title: "Name the group",
      text: "You host it. Add people from inside the chat with the add-person button, pairing with each of them in person.",
      placeholder: "Group name",
      action: "Create group",
      run: (title) => makeGroup(title)
    });
  }
  async function makeGroup(title) {
    if (!title) throw new Error("Give the group a name.");
    const key = newGroupKey();
    const conv = await saveConversation({
      id: crypto.randomUUID(),
      type: "group",
      title,
      hostId: me.selfId,
      members: [],
      groupKey: key,
      lastAt: Date.now(),
      names: { [me.selfId]: "You" }
    });
    groupKeys.set(conv.id, await importGroupKey(key));
    renderHome();
    openChat(conv.id);
    toast("Group created \u2014 add people with the add-person button at the top");
  }
  async function addToGroup(convId, contact2) {
    const conv = await conversation(convId);
    if (!conv) return;
    if (!conv.members.includes(contact2.id)) conv.members.push(contact2.id);
    conv.names = { ...conv.names, [contact2.id]: contact2.name };
    await saveConversation(conv);
    const l = link(contact2.id);
    await (l == null ? void 0 : l.sendCtrl({
      t: "group-invite",
      convId: conv.id,
      title: conv.title,
      hostId: me.selfId,
      groupKey: btoa(String.fromCharCode(...conv.groupKey)),
      members: conv.members,
      names: conv.names
    }));
    await relayToRoom(
      conv.id,
      conv.members,
      contact2.id,
      { t: "group-roster", members: conv.members, names: conv.names }
    );
    toast(`${contact2.name} added to ${conv.title}`);
    openChat(conv.id);
    renderHome();
  }
  async function resolveDirect(peerId, fallbackId) {
    const all = await conversations();
    const found = all.find((c) => c.type === "direct" && c.peerId === peerId);
    if (found) return found;
    const c = await contact(peerId);
    return saveConversation({
      id: fallbackId || crypto.randomUUID(),
      type: "direct",
      peerId,
      title: (c == null ? void 0 : c.name) || "Unknown",
      members: [peerId],
      lastAt: Date.now()
    });
  }
  /* Group ids come from the host and are genuinely shared, so those stay as
     sent. Only direct traffic needs re-pointing at the local thread. */
  async function threadFor(peerId, wireConvId) {
    const existing = wireConvId ? await conversation(wireConvId) : null;
    if ((existing == null ? void 0 : existing.type) === "group") {
      // Only the group's host and members can post into it.
      if (existing.hostId === peerId || (existing.members || []).includes(peerId)) return existing;
      return resolveDirect(peerId);
    }
    // A chat id that already belongs to another conversation is never reused.
    return resolveDirect(peerId, existing ? null : wireConvId);
  }
  on("message", async (ev) => {
    const { convId, text, peerId, id } = ev.detail;
    const conv = await threadFor(peerId, convId);
    const m = await addMessage({ convId: conv.id, from: peerId, kind: "text", text, rid: id });
    if (conv.type === "group") m.senderName = (conv.names || {})[peerId];
    const open = (activeConv == null ? void 0 : activeConv.id) === conv.id;
    if (open) await renderMessage(m);
    else toast(`${conv.title}: ${text.slice(0, 60)}`);
    noteIncoming(conv, m.senderName ? `${m.senderName}: ${text}` : text);
    if (id) {
      await sendReceipt(conv, [id], "delivered");
      if (open && !appAway()) await markRead(conv);
    }
    renderHome();
  });
  on("file", async (ev) => {
    const { convId, bytes, mime, name, peerId, hash } = ev.detail;
    const kind = (mime || "").startsWith("image/") ? "image" : (mime || "").startsWith("audio/") ? "audio" : "file";
    const got = await sha256Hex(bytes);
    const thread = await threadFor(peerId, convId);
    const m = await addMessage({ convId: thread.id, from: peerId, kind, bytes, mime, name, hash: hash || got, rid: ev.detail.id });
    if (ev.detail.id) await sendReceipt(thread, [ev.detail.id], "delivered");
    if (hash && hash !== got) {
      await patchMessage(m.id, { hashOk: false });
      m.hashOk = false;
      toast("A file arrived that does not match its announced hash. Treat it as damaged.", true);
    }
    if ((activeConv == null ? void 0 : activeConv.id) === thread.id) await renderMessage(m);
    else toast(kind === "file" ? `File received: ${name || "unnamed"}` : "Attachment received");
    noteIncoming(thread, kind === "file" ? `File: ${name || "unnamed"}` : kind === "image" ? "Photo" : "Voice note");
    const conv = thread;
    if ((conv == null ? void 0 : conv.type) === "group" && conv.hostId === me.selfId) {
      for (const id of (conv.members || []).filter((x) => x !== peerId)) {
        const l = link(id);
        if (l == null ? void 0 : l.open) l.sendFile(convId, { bytes, mime, name, hash: hash || got }).catch(() => {
        });
      }
    }
    renderHome();
  });
  on("progress", (ev) => {
    const { ratio } = ev.detail;
    status(ratio < 1 ? `receiving ${Math.round(ratio * 100)}%` : "linked", ratio < 1 ? "wait" : "live");
  });
  /* Joining a group is your decision, and a group can only be changed by its
     own host. Invitations wait until you are not in the middle of pairing or
     another menu, then ask. */
  var pendingInvites = [];
  on("group-invite", async (ev) => {
    const d = ev.detail;
    if (typeof d.convId !== "string" || typeof d.groupKey !== "string") return;
    const existing = await conversation(d.convId);
    if (existing) {
      // Nobody may turn another chat into a group, or take over a group they do not host.
      if (existing.type !== "group" || existing.hostId !== d.peerId) return;
      existing.members = (d.members || []).filter((id) => typeof id === "string" && id !== me.selfId);
      existing.names = d.names && typeof d.names === "object" ? d.names : existing.names;
      await saveConversation(existing);
      renderHome();
      return;
    }
    if (pendingInvites.some((p) => p.convId === d.convId)) return;
    pendingInvites.push(d);
    if (appAway()) notify("Group invitation", `You have been added to ${String(d.title || "a group").slice(0, 60)}`, "invite-" + d.convId);
    offerInvites();
  });
  async function offerInvites() {
    if (!pendingInvites.length || $("menuSheet").classList.contains("on")) return;
    const cur = document.querySelector(".screen.on");
    if (cur && (cur.id === "s-safety" || cur.id === "s-pair" || cur.id === "s-scanner")) return;
    const d = pendingInvites.shift();
    const from = await contact(d.peerId);
    if (!from || await conversation(d.convId)) return offerInvites();
    const title = String(d.title || "Group").slice(0, 60);
    sheet({
      eyebrow: "Group invitation",
      title: `Join ${title}?`,
      text: `${from.name} added you to this group. They host it, so messages between members pass through their phone.`,
      actions: [
        { label: "Join group", run: () => joinGroup(d, title) },
        { label: "Decline", kind: "danger", run: () => {
        } }
      ]
    });
  }
  async function joinGroup(d, title) {
    const key = Uint8Array.from(atob(d.groupKey), (c) => c.charCodeAt(0));
    if (key.length !== 32) throw new Error("That invitation's key is damaged.");
    await saveConversation({
      id: d.convId,
      type: "group",
      title,
      hostId: d.peerId,
      members: (d.members || []).filter((id) => typeof id === "string" && id !== me.selfId),
      groupKey: key,
      names: d.names && typeof d.names === "object" ? d.names : {},
      lastAt: Date.now()
    });
    groupKeys.set(d.convId, await importGroupKey(key));
    toast(`Joined ${title}`);
    renderHome();
  }
  on("group-roster", async (ev) => {
    const conv = await conversation(ev.detail.convId);
    if (!conv || conv.type !== "group") return;
    // Only the host decides who is in the group and what they are called.
    if (ev.detail.peerId !== conv.hostId || conv.hostId === me.selfId) return;
    if (!Array.isArray(ev.detail.members)) return;
    conv.members = ev.detail.members.filter((id) => typeof id === "string" && id !== me.selfId);
    conv.names = ev.detail.names && typeof ev.detail.names === "object" ? ev.detail.names : conv.names;
    await saveConversation(conv);
    if ((activeConv == null ? void 0 : activeConv.id) === conv.id) updateChatPresence();
    renderHome();
  });
  var groupSeen = /* @__PURE__ */ new Set();
  on("group-msg", async (ev) => {
    var _a;
    const { convId, packed, peerId } = ev.detail;
    const conv = await conversation(convId);
    if (!conv || conv.type !== "group") return;
    /* Trust the link a message arrived on, not what it says inside. Members
       take group traffic only from the host's link; the host takes a
       member's messages only from that member's own link, and only when the
       message says it is from them. Everyone has the group key, so the
       encryption alone cannot tell members apart. */
    const hosting = conv.hostId === me.selfId;
    if (hosting ? !(conv.members || []).includes(peerId) : peerId !== conv.hostId) return;
    let key = groupKeys.get(convId);
    if (!key) {
      key = await importGroupKey(conv.groupKey);
      groupKeys.set(convId, key);
    }
    try {
      const body = await openGroupPacked(packed, key);
      if (!body || typeof body.from !== "string") return;
      if (hosting && body.from !== peerId) return;
      if (body.from === me.selfId) return;
      if (!hosting && body.from !== conv.hostId && !(conv.members || []).includes(body.from)) return;
      // The same sealed message sent again is shown once.
      if (body.id) {
        if (groupSeen.has(body.id)) return;
        groupSeen.add(body.id);
        if (groupSeen.size > 2e3) groupSeen.clear();
        if ((await backend.byConv(convId)).some((r) => r.rid === body.id)) return;
      }
      const senderName = ((_a = conv.names) == null ? void 0 : _a[body.from]) || "Someone";
      if (body.kind === "location" || body.kind === "location-end") {
        await onLocation({ ...body, convId, from: body.from, senderName, ending: body.kind === "location-end" });
        if (hosting) await relayToRoom(convId, conv.members, peerId, { t: "group-msg", packed });
        return;
      }
      if (typeof body.text !== "string") return;
      const m = await addMessage({ convId, from: body.from, kind: "text", text: body.text, at: body.at, rid: body.id });
      m.senderName = senderName;
      if ((activeConv == null ? void 0 : activeConv.id) === convId) await renderMessage(m);
      else toast(`${conv.title} \xB7 ${senderName}: ${body.text.slice(0, 50)}`);
      noteIncoming(conv, `${senderName}: ${body.text}`);
      if (hosting) await relayToRoom(convId, conv.members, peerId, { t: "group-msg", packed });
      renderHome();
    } catch (e) {
      toast("Could not read a group message", true);
    }
  });
  on("presence", () => {
    updateChatPresence();
    renderHome();
  });
  /* Every new link is a possible route to someone else we have lost. */
  on("linkopen", async (ev) => {
    const convs = await conversations();
    for (const c of convs) {
      if (c.type !== "direct" || !c.peerId) continue;
      if (c.peerId === ev.detail.peerId) continue;
      if ((link(c.peerId) || {}).open) continue;
      rejoinStart(c.peerId).catch(() => {
      });
    }
  });
  on("rejoined", async (ev) => {
    if (rejoinFor === ev.detail.peerId) {
      rejoinFor = null;
      if (document.getElementById("s-rejoin").classList.contains("on")) back();
    }
    const c = await contact(ev.detail.peerId);
    toast(`Reconnected to ${(c == null ? void 0 : c.name) || "a contact"} \u2014 no re-pairing needed`);
    renderHome();
    updateChatPresence();
  });
  on("linkopen", (ev) => {
    lanDropped.delete(ev.detail.peerId);
    // Any other reconnect still in flight for them is now beside the point.
    const stale = rejoinPending.get(ev.detail.peerId);
    if (stale && stale.pc !== (link(ev.detail.peerId) || {}).pc) {
      try {
        stale.pc.close();
      } catch (e) {
      }
      rejoinPending.delete(ev.detail.peerId);
    }
    batteryNudge().catch(() => {
    });
    status("linked", "live");
    updateChatPresence();
    renderHome();
    carryFlush(ev.detail.peerId).catch(() => {
    });
  });
  /* A link can end from either side: we closed it (linkclosed), or it went
     quiet or the other phone closed it (presence goes offline). Either way the
     contact is worth looking for. */
  function lanLost(peerId) {
    if ((link(peerId) || {}).open || lanDropped.has(peerId)) return;
    lanDropped.set(peerId, Date.now());
    setTimeout(() => {
      lanSweep(true);
      syncService();
    }, 3e3);
  }
  on("presence", (ev) => {
    if (ev.detail.state === "offline") lanLost(ev.detail.peerId);
  });
  on("linkclosed", (ev) => {
    lanLost(ev.detail.peerId);
    updateChatPresence();
    renderHome();
    if (callPeer() === ev.detail.peerId) callEnd("The link dropped", false);
    if (locShare && locShare.peerId === ev.detail.peerId) toast("Link lost \u2014 location updates will resume if they reconnect");
  });
  on("baddata", () => toast("Dropped an unreadable message", true));

  /* ---- control traffic for calls, location and carried mail ---- */
  on("ctrl", async (ev) => {
    const { peerId, msg } = ev.detail;
    switch (msg.t) {
      case "call-offer":
        return void callIncoming(peerId, msg.sdp);
      case "call-answer":
        return void callAnswered(peerId, msg.sdp).catch((e) => toast(e.message, true));
      case "call-ice":
        return void callRemoteIce(peerId, msg.candidate);
      // Only the person you are on a call with can end it.
      case "call-end":
        if (callPeer() !== peerId) return;
        return void callEnd("Call ended", false);
      case "call-busy":
        if (callPeer() !== peerId) return;
        return void callEnd("They are already on a call", false);
      case "loc":
        return void onLocation({ ...msg, from: peerId });
      case "loc-end":
        return void onLocation({ ...msg, from: peerId, ending: true });
      case "carry":
        return void carryTake(peerId, msg.env);
      case "carry-ack":
        return void onCarryAck(msg, peerId);
      case "receipt":
        return void onReceipt(peerId, msg);
      case "rejoin":
        return void rejoinRelay(peerId, msg).catch(() => {
        });
    }
  });
  on("localice", (ev) => {
    const { peerId, candidate } = ev.detail;
    if (callPeer() !== peerId) return;
    const l = link(peerId);
    if (l == null ? void 0 : l.open) l.sendCtrl({ t: "call-ice", candidate }).catch(() => {
    });
  });
  on("track", (ev) => {
    const a = $("remoteAudio");
    a.srcObject = ev.detail.stream;
    a.play().catch(() => {
    });
  });

  /* ---- calls ---- */
  var callTimer = null;
  function paintCall() {
    const bar = $("callBar");
    if (!call) {
      bar.classList.remove("on");
      clearInterval(callTimer);
      callTimer = null;
      $("muteBtn").classList.remove("muted");
      return;
    }
    bar.classList.add("on");
    $("callName").textContent = call.name;
    $("callDot").className = "dot " + (call.status === "active" ? "live" : "wait");
    const paint = () => {
      $("callState").textContent = call ? (call.status === "active" ? fmtClock(Date.now() - call.startedAt) : call.dir === "out" ? "calling\u2026" : "connecting\u2026") : "";
      $("callState").className = "s" + ((call == null ? void 0 : call.status) === "active" ? " live" : "");
    };
    paint();
    clearInterval(callTimer);
    callTimer = setInterval(paint, 1e3);
  }
  on("callstate", () => {
    if (swWaiting && !busy()) toast("New version ready \u2014 tap to update", false, applyUpdate);
  });
  on("callstate", () => {
    paintCall();
    keepAwake(true);
  });
  on("callring", async () => {
    $("ringName").textContent = call.name;
    $("ringSheet").classList.add("on");
    keepAwake(true);
    notify("Incoming voice call", call.name + " is calling", "call", { kind: "call", convId: call.convId });
    if (navigator.vibrate) navigator.vibrate([300, 200, 300]);
  });
  on("callended", async (ev) => {
    const { reason, secs, convId, dir, connected } = ev.detail;
    $("ringSheet").classList.remove("on");
    dropAlert("call");
    const a = $("remoteAudio");
    a.srcObject = null;
    paintCall();
    keepAwake(false);
    if (reason) toast(reason);
    if (convId) {
      const label = connected ? (dir === "out" ? "Outgoing call" : "Incoming call") : dir === "out" ? "No answer" : "Missed call";
      const m = await addMessage({ convId, from: dir === "out" ? me.selfId : null, kind: "call", text: JSON.stringify({ label, secs }) });
      if ((activeConv == null ? void 0 : activeConv.id) === convId) await renderMessage(m);
      if (label === "Missed call") noteIncoming(await conversation(convId), "Missed call");
      renderHome();
    }
  });

  /* ---- location ---- */
  var locNodes = /* @__PURE__ */ new Map();
  async function onLocation(d) {
    // Coordinates come from another phone: numbers in range, or nothing.
    if (typeof d.shareId !== "string" || d.shareId.length > 64) return;
    if (!d.ending) {
      const lat = Number(d.lat), lon = Number(d.lon), acc = Number(d.acc);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      d = { ...d, lat, lon, acc: Number.isFinite(acc) ? acc : null };
    }
    const conv = d.from ? await threadFor(d.from, d.convId) : await conversation(d.convId);
    if (!conv) return;
    const convId = conv.id;
    const who = d.senderName || conv.title;
    const known = locNodes.get(d.shareId);
    if (d.ending) {
      if (known) {
        const rows = await messages(convId, 400);
        const m = rows.find((r) => r.id === known);
        if (m) {
          const body = { ...JSON.parse(m.text || "{}"), live: false };
          await patchMessage(m.id, {}, JSON.stringify(body));
        }
        if ((activeConv == null ? void 0 : activeConv.id) === convId) refreshLocCard(d.shareId);
      }
      toast(`${who} stopped sharing their location`);
      return;
    }
    const body = JSON.stringify({ shareId: d.shareId, lat: d.lat, lon: d.lon, acc: d.acc, at: d.at, endsAt: d.endsAt, live: true });
    if (known) {
      await patchMessage(known, {}, body);
      if ((activeConv == null ? void 0 : activeConv.id) === convId) refreshLocCard(d.shareId);
      return;
    }
    const m = await addMessage({ convId, from: d.from, kind: "location", text: body });
    locNodes.set(d.shareId, m.id);
    m.senderName = d.senderName;
    if ((activeConv == null ? void 0 : activeConv.id) === convId) await renderMessage(m);
    else toast(`${who} is sharing their location for 10 minutes`);
    if (appAway()) notify("Location shared", `${who} is sharing their location for 10 minutes`, "loc-" + d.shareId, { convId });
    renderHome();
  }
  function paintLoc() {
    const b = $("locBanner");
    if (!locShare) {
      b.classList.remove("on", "expiring");
      return;
    }
    b.classList.add("on");
    $("locWho").textContent = "Visible to " + locShare.title + (locShare.extensions ? ` \xB7 extended ${locShare.extensions}\xD7` : "");
  }
  on("locstart", () => {
    paintLoc();
    keepAwake(true);
    toast("Sharing your location for 10 minutes");
  });
  on("loctick", (ev) => {
    const left = ev.detail.left;
    $("locCd").textContent = fmtClock(left);
    $("locBanner").classList.toggle("expiring", left <= LOC_WARN);
    $("locLbl").textContent = left <= LOC_WARN ? "Ending soon" : "Sharing location";
  });
  on("locfix", (ev) => {
    if (!locShare) return;
    const known = locNodes.get(locShare.id);
    const body = JSON.stringify({ shareId: locShare.id, ...ev.detail.fix, endsAt: locShare.endsAt, live: true });
    (async () => {
      if (known) {
        await patchMessage(known, {}, body);
        if ((activeConv == null ? void 0 : activeConv.id) === locShare.convId) refreshLocCard(locShare.id);
      } else {
        const m = await addMessage({ convId: locShare.convId, from: me.selfId, kind: "location", text: body });
        locNodes.set(locShare.id, m.id);
        if ((activeConv == null ? void 0 : activeConv.id) === locShare.convId) await renderMessage(m);
        renderHome();
      }
    })();
  });
  on("locwarn", () => {
    paintLoc();
    notify("Location sharing ends in 1 minute", "Open Cyanotype and tap Keep sharing to continue. It stops on its own otherwise.", "loc-warn");
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    toast("Location sharing ends in 1 minute \u2014 tap Keep sharing to continue");
  });
  on("locextend", () => {
    paintLoc();
    toast("Sharing for another 10 minutes");
  });
  on("locstop", () => {
    if (swWaiting && !busy()) toast("New version ready \u2014 tap to update", false, applyUpdate);
  });
  on("locstop", async (ev) => {
    paintLoc();
    keepAwake(false);
    const s = ev.detail.share;
    const id = locNodes.get(s.id);
    if (id) {
      const rows = await messages(s.convId, 400);
      const m = rows.find((r) => r.id === id);
      if (m) await patchMessage(id, {}, JSON.stringify({ ...JSON.parse(m.text || "{}"), live: false }));
      if ((activeConv == null ? void 0 : activeConv.id) === s.convId) refreshLocCard(s.id);
    }
    if (ev.detail.reason === "window closed") {
      notify("Location sharing stopped", "The 10 minute window closed. Nothing further is being sent.", "loc-warn");
      toast("Location sharing stopped \u2014 the 10 minute window closed");
    } else {
      toast("Location sharing stopped");
    }
  });

  /* ---- carried mail ---- */
  on("carried", async (ev) => {
    const { env, body } = ev.detail;
    const conv = await threadFor(env.from, env.convId);
    if (env.kind === "text") {
      const m = await addMessage({ convId: conv.id, from: env.from, kind: "text", text: body.text, at: env.at, state: "relayed" });
      if ((activeConv == null ? void 0 : activeConv.id) === conv.id) await renderMessage(m);
      else toast(`${conv.title} (relayed): ${String(body.text).slice(0, 50)}`);
      noteIncoming(conv, body.text);
      renderHome();
    }
  });
  on("carrybad", (ev) => toast("Discarded a relayed message \u2014 " + ev.detail.reason, true));
  on("carryheld", (ev) => status(`carrying ${ev.detail.count}`, "live"));
  async function onCarryAck(msg, fromPeer) {
    const held = await carryAcked(msg, fromPeer);
    if (!held || held.from !== me.selfId) return;
    const rows = await messages(held.convId, 400);
    const hit = rows.find((r) => r.envId === held.id);
    if (!hit) return;
    await patchMessage(hit.id, { state: "delivered" });
    hit.state = "delivered";
    if ((activeConv == null ? void 0 : activeConv.id) === held.convId) refreshTicks(hit);
    renderHome();
  }
  var TICK_RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
  async function onReceipt(peerId, msg) {
    const conv = await threadFor(peerId, msg.convId);
    if (!conv) return;
    const want = msg.state === "read" ? "read" : "delivered";
    const rows = await messages(conv.id, 400);
    let touched = 0;
    for (const id of msg.ids || []) {
      const hit = rows.find((r) => (r.wireId || r.id) === id && r.from === me.selfId);
      if (!hit) continue;
      if ((TICK_RANK[hit.state] || 0) >= TICK_RANK[want]) continue;
      await patchMessage(hit.id, { state: want });
      hit.state = want;
      touched++;
      if ((activeConv == null ? void 0 : activeConv.id) === conv.id) refreshTicks(hit);
    }
    if (touched) renderHome();
  }
  /* Repaint just the tick rather than the bubble: re-rendering the message
     would drop an in-flight image or restart an audio element. */
  function refreshTicks(m) {
    const node = $("log").querySelector(`.msg[data-id="${m.id}"] .ticks`);
    if (!node) return;
    node.className = "ticks " + m.state;
    node.textContent = m.state === "queued" ? "\u25CB" : m.state === "sent" ? "\u2713" : "\u2713\u2713";
    node.title = { queued: "waiting to be sent", sent: "sent", delivered: "delivered to their phone", read: "opened" }[m.state] || m.state;
    // A queued bubble is drawn faded; it stops being queued once it is sent.
    const wrap = node.closest(".msg");
    if (wrap) wrap.classList.toggle("queued", m.state === "queued");
  }
  /* Receipts are only meaningful one-to-one. In a group "delivered" would have
     to mean delivered to whom, so groups get no ticks at all. */
  async function sendReceipt(conv, ids, state) {
    if (!ids.length || conv.type !== "direct") return;
    const l = link(conv.peerId);
    if (!(l == null ? void 0 : l.open)) return;
    await l.sendCtrl({ t: "receipt", convId: conv.id, ids, state }).catch(() => {
    });
  }
  /* Called when a thread is on screen and the app is actually in front. A
     backgrounded tab must not claim the message was read. */
  async function markRead(conv) {
    if (!conv || conv.type !== "direct" || appAway()) return;
    const rows = await messages(conv.id, 400);
    const pending = rows.filter((r) => r.from !== me.selfId && r.rid && r.rstate !== "read");
    if (!pending.length) return;
    await sendReceipt(conv, pending.map((r) => r.rid), "read");
    for (const r of pending) await patchMessage(r.id, { rstate: "read" });
  }
  /* ---- notifications ---- */
  /* Inside the wrapper the WebView has no Notification API at all, so alerts
     go through the plugin. In a browser they go through the service worker,
     which is also what lets a tap open the right chat. */
  async function notify(title, body, tag, opts = {}) {
    try {
      if (NATIVE) {
        const r = await NATIVE.showAlert({ title, body: String(body || ""), tag, convId: opts.convId, kind: opts.kind });
        return !!(r && r.shown);
      }
      if (!("Notification" in window) || Notification.permission !== "granted") return false;
      // getRegistration, not .ready: .ready never settles if registration failed.
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration().catch(() => null);
      const options = { body: String(body || ""), tag, renotify: true, icon: "./icon-192.png", badge: "./icon-192.png", data: { convId: opts.convId } };
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
        return true;
      }
      new Notification(title, options);
      return true;
    } catch (e) {
      return false;
    }
  }
  async function askNotify() {
    try {
      if (NATIVE) {
        const r = await NATIVE.requestAlerts();
        return !!(r && r.granted);
      }
      if (!("Notification" in window)) return false;
      if (Notification.permission === "granted") return true;
      if (Notification.permission === "denied") return false;
      return await Notification.requestPermission() === "granted";
    } catch (e) {
      return false;
    }
  }
  /* One notification per chat, replaced as more arrive, so a busy group does
     not bury the shade. Only while the app is out of sight: in front, the
     in-app toast already says it. */
  var unseen = /* @__PURE__ */ new Map();
  var alertTag = (convId) => "conv-" + convId;
  async function noteIncoming(conv, preview) {
    if (!conv) return;
    const viewing = activeConv && activeConv.id === conv.id && $("s-chat").classList.contains("on") && !appAway();
    if (!viewing) {
      const c = await conversation(conv.id);
      if (c) {
        c.unread = (c.unread || 0) + 1;
        await saveConversation(c);
        renderHome();
      }
    }
    alertMessage(conv, preview);
  }
  function alertMessage(conv, preview) {
    if (!conv || !appAway()) return;
    const tag = alertTag(conv.id);
    const count = (unseen.get(tag) || 0) + 1;
    unseen.set(tag, count);
    notify(count > 1 ? `${conv.title} (${count} new)` : conv.title, preview, tag, { convId: conv.id });
  }
  function dropAlert(tag) {
    unseen.delete(tag);
    if (NATIVE) return void NATIVE.clearAlert({ tag }).catch(() => {
    });
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.getRegistration().then((reg) => reg && reg.getNotifications ? reg.getNotifications({ tag }) : []).then((ns) => ns.forEach((n) => n.close())).catch(() => {
    });
  }
  var clearAlerts = (convId) => dropAlert(alertTag(convId));
  /* ---- holding the process open (Android wrapper only) ---- */
  /* The "connected" notification should mean exactly that. Hold the service
     while any link is live or recovering, or a call or location share is
     running. Let it go 90 seconds after the last one ends, so a brief drop
     does not make the notification flicker. */
  var svcOn = false;
  var svcText = "";
  var svcTimer = null;
  function wantService() {
    for (const l of links.values()) if (l.open || l.presence === "away") return true;
    return !!call || !!locShare || lanBgActive();
  }
  function syncService() {
    if (!NATIVE) return;
    if (wantService()) {
      clearTimeout(svcTimer);
      svcTimer = null;
      const n = openLinks().length;
      const lost = [...lanDropped.keys()].filter((id) => !(link(id) || {}).open).length;
      const text = n ? `Linked to ${n} ${n === 1 ? "person" : "people"}` : lost && lanBgActive() ? `Looking for ${lost === 1 ? "a contact" : lost + " contacts"} on this Wi-Fi` : "Reconnecting\u2026";
      if (svcOn && text === svcText) return;
      // Android refuses this from the background; the next resume retries.
      NATIVE.start({ text }).then(() => {
        svcOn = true;
        svcText = text;
      }).catch(() => {
      });
    } else if (svcOn && !svcTimer) {
      svcTimer = setTimeout(() => {
        svcTimer = null;
        if (wantService()) return;
        svcOn = false;
        svcText = "";
        NATIVE.stop().catch(() => {
        });
      }, 9e4);
    }
  }
  function wireNative() {
    if (!NATIVE) return;
    NATIVE.addListener("appstate", (d) => {
      nativeAway = !(d && d.active);
      // Let every visibility listener re-check against the real state.
      document.dispatchEvent(new Event("visibilitychange"));
      if (!nativeAway) {
        syncService();
        lanSweep(true);
        if ($("s-settings").classList.contains("on")) paintBackground();
      }
    });
    getSetting("lanBg").then((v) => {
      if (v === "off" || v === "30" || v === "always") lanBg = v;
    }).catch(() => {
    });
    lanWire();
    NATIVE.addListener("open", (d) => {
      if (d && d.convId) openChat(d.convId);
    });
    NATIVE.launchTarget().then((r) => {
      if (r && r.convId) openChat(r.convId);
    }).catch(() => {
    });
  }
  var wakeLock = null;
  /* Waking the phone is the moment a dropped link is most worth retrying. */
  async function rejoinSweep() {
    if (appAway()) return;
    for (const c of await conversations()) {
      if (c.type !== "direct" || !c.peerId) continue;
      if ((link(c.peerId) || {}).open) continue;
      rejoinStart(c.peerId).catch(() => {
      });
    }
  }
  async function keepAwake(on2) {
    try {
      if (on2 && "wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen");
      else if (!on2 && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) {
    }
  }
  function fail(e) {
    stopScanning();
    keepAwake(false);
    pending = null;
    status("error", "bad");
    toast(e.message || String(e), true);
    show("home");
  }
  function back() {
    stopScanning();
    if (!call && !locShare) keepAwake(false);
    activeConv = null;
    status(openLinks().length ? "linked" : "idle", openLinks().length ? "live" : null);
    show("home");
    renderHome();
  }
  /* ---- one reusable sheet for menus, confirmations and small forms ---- */
  function closeSheet() {
    setTimeout(() => offerInvites().catch(() => {
    }), 400);
    $("menuSheet").classList.remove("on");
    $("menuBody").innerHTML = "";
    $("menuActs").innerHTML = "";
    document.querySelectorAll(".msg.held").forEach((n) => n.classList.remove("held"));
  }
  function sheet({ eyebrow, title, text, body, actions }) {
    $("menuEyebrow").textContent = eyebrow || "";
    $("menuTitle").textContent = title || "";
    $("menuText").textContent = text || "";
    $("menuText").classList.toggle("hide", !text);
    $("menuBody").innerHTML = "";
    if (body) $("menuBody").append(body);
    const acts = $("menuActs");
    acts.innerHTML = "";
    for (const a of actions || []) {
      const b = el("button", "btn" + (a.kind ? " " + a.kind : ""), a.label);
      if (a.sub) b.append(el("span", "sub", a.sub));
      b.onclick = async () => {
        closeSheet();
        try {
          await a.run();
        } catch (e) {
          toast(e.message || String(e), true);
        }
      };
      acts.append(b);
    }
    const cancel = el("button", "btn ghost", "Cancel");
    cancel.onclick = closeSheet;
    acts.append(cancel);
    $("menuSheet").classList.add("on");
  }
  function askText({ eyebrow, title, text, value, placeholder, action, run }) {
    const wrap = el("label", "field");
    const input = el("input");
    input.value = value || "";
    input.placeholder = placeholder || "";
    input.autocomplete = "off";
    input.maxLength = 60;
    wrap.append(input);
    sheet({ eyebrow, title, text, body: wrap, actions: [{ label: action || "Save", run: () => run(input.value.trim()) }] });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("menuActs").firstChild.click();
    });
    setTimeout(() => input.focus(), 60);
  }
  /* Long-press on touch, right-click on a desktop. A hold suppresses the tap
     that would otherwise follow it. */
  function onHold(node, fn) {
    let timer = null, sx = 0, sy = 0;
    const fire = () => {
      timer = null;
      node.dataset.held = "1";
      if (navigator.vibrate) navigator.vibrate(15);
      fn();
    };
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };
    node.addEventListener("pointerdown", (e) => {
      if (e.button || e.target.closest("audio, input, .acts")) return;
      sx = e.clientX;
      sy = e.clientY;
      cancel();
      delete node.dataset.held;
      timer = setTimeout(fire, 550);
    });
    node.addEventListener("pointermove", (e) => {
      if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((t) => node.addEventListener(t, cancel));
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (node.dataset.held) return;
      cancel();
      fire();
    });
    node.addEventListener("click", (e) => {
      if (!node.dataset.held) return;
      delete node.dataset.held;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }
  function copyText(text) {
    if (navigator.clipboard) return navigator.clipboard.writeText(text).then(() => toast("Copied")).catch(() => toast(text));
    toast(text);
  }
  var fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "unknown";
  /* ---- contacts ---- */
  function addContactSheet() {
    sheet({
      eyebrow: "Add a contact",
      title: "Pair in person",
      text: "Contacts are added by scanning codes with the two phones side by side. Nobody can add themselves to your contacts from a distance, and you check a safety number once so you know the link is private.",
      actions: [
        { label: "Show my code", sub: "They scan it with their phone", run: () => startInvite(null) },
        { label: "Scan their code", kind: "alt", sub: "They show a code on their phone", run: () => startJoin() }
      ]
    });
  }
  async function contactSheet(c) {
    c = await contact(c.id) || c;
    const pres = presenceOf(c.id);
    const body = el("div");
    body.append(el("span", "eyebrow", "Key fingerprint"));
    body.append(el("div", "keyGrid", (c.id.match(/.{1,4}/g) || [c.id]).join(" ")));
    const facts = [PRESENCE_LABEL[pres], c.verified ? "safety number checked" : "safety number not checked", "paired " + fmtDate(c.addedAt)];
    if (c.lastSeen) facts.push("last seen " + shortTime(c.lastSeen));
    body.append(el("p", "dim", facts.join(" \xB7 ")));
    sheet({
      eyebrow: "Contact",
      title: c.name,
      body,
      actions: [
        { label: "Message", run: async () => {
          const conv = await resolveDirect(c.id);
          await renderHome();
          openChat(conv.id);
        } },
        { label: "Rename", kind: "alt", run: () => renameContact(c) },
        { label: "Delete contact", kind: "danger", sub: "Removes their key from this phone", run: () => confirmForget(c) }
      ]
    });
  }
  function renameContact(c) {
    askText({
      eyebrow: "Contact",
      title: "Rename " + c.name,
      value: c.name,
      placeholder: "Name",
      run: async (name) => {
        if (!name) throw new Error("A name cannot be empty.");
        const rec = await contact(c.id);
        if (!rec) throw new Error("That contact is no longer on this phone.");
        rec.name = name;
        await saveContact(rec);
        for (const cv of await conversations()) {
          if (cv.type === "direct" && cv.peerId === c.id) {
            cv.title = name;
            await saveConversation(cv);
          }
        }
        if (activeConv && activeConv.type === "direct" && activeConv.peerId === c.id) {
          activeConv.title = name;
          $("chatTitle").textContent = name;
        }
        renderHome();
        toast("Renamed to " + name);
      }
    });
  }
  function confirmForget(c) {
    sheet({
      eyebrow: "Delete contact",
      title: `Delete ${c.name}?`,
      text: "Their key is removed from this phone. They can no longer reconnect, message you or pass messages through you, and anything you queued for them is not sent. To talk again you would pair in person and check the safety number again. Their phone keeps its own copy of your chats.",
      actions: [
        { label: "Delete contact and chat", kind: "danger", run: () => forgetContact(c, true) },
        { label: "Delete contact, keep chat history", kind: "danger", run: () => forgetContact(c, false) }
      ]
    });
  }
  async function forgetContact(c, withChat) {
    const l = link(c.id);
    if (l) l.close();
    const direct = (await conversations()).filter((cv) => cv.type === "direct" && cv.peerId === c.id);
    if (withChat) {
      for (const cv of direct) {
        await deleteConversation(cv.id);
        clearAlerts(cv.id);
      }
    }
    const queued = (await outbox()).filter((e) => e.to === c.id && e.from === me.selfId);
    await backend.delMany("outbox", queued.map((e) => e.id));
    await removeContact(c.id);
    if (activeConv && direct.some((cv) => cv.id === activeConv.id)) {
      if (withChat) back();
      else openChat(activeConv.id);
    }
    renderHome();
    toast(`${c.name} deleted from this phone`);
  }
  /* ---- chats ---- */
  function chatMenu(conv) {
    conv = conv || activeConv;
    if (!conv) return;
    const actions = [];
    if (conv.type === "direct") {
      actions.push({ label: "Contact details", run: async () => {
        const c = await contact(conv.peerId);
        if (c) contactSheet(c);
        else toast("This person is no longer in your contacts.", true);
      } });
      actions.push({ label: "Rename", kind: "alt", run: async () => {
        const c = await contact(conv.peerId);
        if (c) renameContact(c);
        else renameConv(conv);
      } });
    } else {
      actions.push({ label: "Rename group", kind: "alt", sub: "Only changes the name on this phone", run: () => renameConv(conv) });
    }
    actions.push({ label: "Clear messages", kind: "danger", sub: "Empties the chat on this phone", run: () => confirmClear(conv) });
    actions.push({ label: conv.type === "group" ? "Delete group" : "Delete chat", kind: "danger", sub: "Removes it from this phone", run: () => confirmDeleteConv(conv) });
    sheet({ eyebrow: conv.type === "group" ? "Group" : "Chat", title: conv.title, actions });
  }
  function renameConv(conv) {
    askText({
      eyebrow: conv.type === "group" ? "Group" : "Chat",
      title: "Rename " + conv.title,
      value: conv.title,
      placeholder: "Name",
      run: async (name) => {
        if (!name) throw new Error("A name cannot be empty.");
        const cv = await conversation(conv.id);
        if (!cv) return;
        cv.title = name;
        await saveConversation(cv);
        if (activeConv && activeConv.id === cv.id) {
          activeConv.title = name;
          $("chatTitle").textContent = name;
        }
        renderHome();
      }
    });
  }
  function confirmClear(conv) {
    sheet({
      eyebrow: "Clear messages",
      title: `Clear ${conv.title}?`,
      text: "Every message, photo and file in this chat is deleted from this phone. The chat itself stays, and the other phone keeps its copy.",
      actions: [{ label: "Clear messages", kind: "danger", run: async () => {
        const n = await clearConversation(conv.id);
        if (activeConv && activeConv.id === conv.id) await openChat(conv.id);
        renderHome();
        toast(`Deleted ${n} message${n === 1 ? "" : "s"}`);
      } }]
    });
  }
  function confirmDeleteConv(conv) {
    const hosting = conv.type === "group" && conv.hostId === me.selfId;
    const text = conv.type !== "group" ? "The chat and everything in it are deleted from this phone. They stay in your contacts, so you can start a new chat with them at any time." : (hosting ? "You host this group. Messages between the other members pass through your phone, so once it is deleted they stop reaching each other. " : "You stop receiving this group's messages on this phone. ") + "Other members keep their copies.";
    sheet({
      eyebrow: conv.type === "group" ? "Delete group" : "Delete chat",
      title: `Delete ${conv.title}?`,
      text,
      actions: [{ label: conv.type === "group" ? "Delete group" : "Delete chat", kind: "danger", run: async () => {
        await deleteConversation(conv.id);
        groupKeys.delete(conv.id);
        clearAlerts(conv.id);
        if (activeConv && activeConv.id === conv.id) back();
        renderHome();
        toast(`${conv.title} deleted from this phone`);
      } }]
    });
  }
  /* ---- single messages ---- */
  function messageMenu(node, m) {
    node.classList.add("held");
    const mine = m.from === me.selfId;
    const actions = [];
    if (m.kind === "text" && m.text) actions.push({ label: "Copy text", run: () => copyText(m.text) });
    if (m.blobId && (m.kind === "image" || m.kind === "audio" || m.kind === "file")) actions.push({ label: "Save to phone", run: () => saveAttachment(m) });
    actions.push({
      label: "Delete from this phone",
      kind: "danger",
      sub: m.state === "queued" ? "It has not been sent yet, and now will not be" : "Their copy is not affected",
      run: async () => {
        await deleteMessages([m.id]);
        node.remove();
        renderHome();
      }
    });
    const who = mine ? "You" : m.senderName || (activeConv ? activeConv.title : "Them");
    sheet({
      eyebrow: "Message",
      title: `${who} \xB7 ${shortTime(m.at)}`,
      text: m.kind === "text" ? String(m.text || "").slice(0, 160) : PREVIEW[m.kind] || "",
      actions
    });
  }
  /* ---- saving attachments ---- */
  var EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3" };
  function attachmentName(m) {
    if (m.name) return m.name;
    const ext = EXT[(m.mime || "").split(";")[0]] || "bin";
    return `cyanotype-${m.kind}-${new Date(m.at).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
  }
  function toB64(u8) {
    let out = "";
    for (let i = 0; i < u8.length; i += 32768) out += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
    return btoa(out);
  }
  /* In a browser a download link does the job. Inside the wrapper the WebView
     ignores download links, so the file goes to Downloads through the plugin,
     a slice at a time. */
  async function saveAttachment(m) {
    const rec = await backend.get("blobs", m.blobId);
    if (!rec) throw new Error("That attachment is no longer on this phone.");
    const bytes = await decryptAtRest(deviceKey, rec.data);
    const name = attachmentName(m);
    const mime = (m.mime || "application/octet-stream").split(";")[0];
    if (NATIVE) {
      const { id } = await NATIVE.saveStart({ name, mime });
      try {
        const SLICE = 3 * 65536;
        for (let i = 0; i < bytes.length; i += SLICE) await NATIVE.saveChunk({ id, data: toB64(bytes.subarray(i, i + SLICE)) });
        const r = await NATIVE.saveFinish({ id });
        toast("Saved to " + (r && r.savedAs || "Downloads"));
      } catch (e) {
        NATIVE.saveAbort({ id }).catch(() => {
        });
        throw e;
      }
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = el("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6e4);
  }
  /* ---- settings ---- */
  var KEEP_CHOICES = [[0, "Forever"], [30, "30 days"], [90, "90 days"], [365, "1 year"]];
  async function showSettings() {
    show("settings");
    paintNotifState();
    const keep = await getSetting("keepDays") || 0;
    const seg = $("keepSeg");
    seg.innerHTML = "";
    for (const [days, label] of KEEP_CHOICES) {
      const b = el("button", days === keep ? "sel" : "", label);
      b.onclick = () => setKeep(days, label).catch((e) => toast(e.message, true));
      seg.append(b);
    }
    paintStats();
    paintBackground();
  }
  /* ---- staying connected with the screen off (Android wrapper only) ---- */
  var LAN_BG_CHOICES = [["off", "Off"], ["30", "30 minutes"], ["always", "Until found"]];
  async function paintBackground() {
    const group = $("bgGroup");
    if (!NATIVE || typeof NATIVE.batteryStatus !== "function") return void group.classList.add("hide");
    group.classList.remove("hide");
    const st = await NATIVE.batteryStatus().catch(() => null);
    const exempt = !!(st && st.exempt);
    $("batteryState").textContent = exempt ? "On. Android lets Cyanotype keep its links open while the phone is locked." : "Off. Android may cut Cyanotype off while the phone is locked, which drops the link to your contacts.";
    $("batteryBtn").classList.toggle("hide", exempt);
    const seg = $("lanSeg");
    seg.innerHTML = "";
    for (const [v, label] of LAN_BG_CHOICES) {
      const b = el("button", v === lanBg ? "sel" : "", label);
      b.onclick = async () => {
        lanBg = v;
        await putSetting("lanBg", v);
        syncService();
        paintBackground();
      };
      seg.append(b);
    }
  }
  async function askBattery() {
    const r = await NATIVE.requestBatteryExemption();
    if (r && r.exempt) toast("Already allowed");
  }
  /* Asked once, the first time a link opens: that is when it starts to matter. */
  async function batteryNudge() {
    if (!NATIVE || typeof NATIVE.batteryStatus !== "function") return;
    if (await getSetting("batteryAsked")) return;
    const st = await NATIVE.batteryStatus().catch(() => null);
    if (!st || st.exempt) return;
    await putSetting("batteryAsked", true);
    /* Not over the safety-number check or another question: wait for a quiet
       moment on the chat list or a chat. */
    const tryShow = (left) => {
      const scr = document.querySelector(".screen.on");
      if ($("menuSheet").classList.contains("on") || !scr || scr.id !== "s-home" && scr.id !== "s-chat") {
        if (left > 0) setTimeout(() => tryShow(left - 1), 3e3);
        return;
      }
      sheet({
        eyebrow: "Staying connected",
        title: "Keep links open with the screen off?",
        text: "Android saves battery by cutting apps off while the phone is locked, and that drops the link to your contacts. Letting Cyanotype skip battery optimisation keeps it connected, at the cost of a little more battery while a link is open. You can change this later in Settings.",
        actions: [{ label: "Allow", sub: "Android asks you to confirm", run: askBattery }]
      });
    };
    setTimeout(() => tryShow(20), 2500);
  }
  async function paintStats() {
    const st = await storeStats().catch(() => null);
    $("storeStats").textContent = st ? `${st.count} message${st.count === 1 ? "" : "s"} on this phone \xB7 ${fmtSize(st.bytes)} of photos, voice notes and files` : "";
  }
  function paintNotifState() {
    const p = $("notifState"), btn = $("notifBtn");
    btn.classList.remove("hide");
    if (NATIVE) {
      p.textContent = "New messages and calls show as notifications while Cyanotype is connected in the background. To change the sound or turn them off, go to Android Settings \u2192 Apps \u2192 Cyanotype \u2192 Notifications.";
      btn.textContent = "Check notifications are allowed";
      return;
    }
    if (!("Notification" in window)) {
      p.textContent = "This browser cannot show notifications.";
      btn.classList.add("hide");
    } else if (Notification.permission === "granted") {
      p.textContent = "On. You get an alert for new messages while this page is open in the background. If the browser closes the page, alerts stop until you open it again \u2014 the Android app avoids this.";
      btn.classList.add("hide");
    } else if (Notification.permission === "denied") {
      p.textContent = "Blocked. Allow notifications for this site in your browser's settings, then come back.";
      btn.classList.add("hide");
    } else {
      p.textContent = "Off. Turn them on to hear about new messages while the app is in the background.";
      btn.textContent = "Turn on notifications";
    }
  }
  async function setKeep(days, label) {
    if (days) {
      const n = await countBefore(Date.now() - days * 864e5);
      if (n) {
        sheet({
          eyebrow: "Keep messages for",
          title: `Keep ${label}?`,
          text: `${n} message${n === 1 ? " is" : "s are"} already older than ${label} and will be deleted from this phone now. After that, messages are deleted as they pass that age.`,
          actions: [{ label: `Delete ${n} and keep ${label}`, kind: "danger", run: async () => {
            await putSetting("keepDays", days);
            await applyRetention(true);
            showSettings();
            toast(`Deleted ${n} message${n === 1 ? "" : "s"}`);
          } }]
        });
        return;
      }
    }
    await putSetting("keepDays", days);
    showSettings();
    toast(days ? `Messages older than ${label} will be deleted` : "Messages are kept until you delete them");
  }
  var lastPrune = 0;
  async function applyRetention(force) {
    if (!force && Date.now() - lastPrune < 6 * 36e5) return 0;
    lastPrune = Date.now();
    const days = await getSetting("keepDays");
    if (!days) return 0;
    const n = await pruneBefore(Date.now() - days * 864e5);
    if (n) {
      renderHome();
      if (activeConv && $("s-chat").classList.contains("on")) openChat(activeConv.id);
    }
    return n;
  }
  function pruneNowMenu() {
    sheet({
      eyebrow: "Delete older messages",
      title: "Delete messages older than\u2026",
      text: "Deletes from every chat on this phone. Messages still waiting to be sent are kept.",
      actions: [[7, "1 week"], [30, "1 month"], [90, "3 months"], [365, "1 year"]].map(([d, label]) => ({
        label,
        kind: "danger",
        run: async () => {
          const n = await pruneBefore(Date.now() - d * 864e5);
          toast(n ? `Deleted ${n} message${n === 1 ? "" : "s"}` : `Nothing older than ${label}`);
          renderHome();
          paintStats();
        }
      }))
    });
  }
  function wireUI() {
    const guard = (fn) => (...a) => {
      if (!me) return toast("Still starting up \u2014 one moment.", true);
      return fn(...a);
    };
    $("tabChats").onclick = () => switchTab("chats");
    $("batteryBtn").onclick = () => askBattery().catch((e) => toast(e.message || String(e), true));
    $("tabContacts").onclick = () => switchTab("contacts");
    $("btnInvite").onclick = guard(() => startInvite(null));
    $("btnJoin").onclick = guard(startJoin);
    $("btnGroup").onclick = guard(createGroup);
    $("groupAdd").onclick = guard(() => startInvite(activeConv == null ? void 0 : activeConv.id));
    $("backBtn").onclick = back;
    $("cancelScan").onclick = back;
    $("cancelPair").onclick = back;
    $("sendBtn").onclick = guard(sendText);
    $("msgInput").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      guard(sendText)();
    });
    $("msgInput").addEventListener("input", syncComposer);
    $("plusBtn").onclick = guard(attachMenu);
    $("chatTitleBtn").onclick = guard(async () => {
      if (!activeConv) return;
      if (activeConv.type === "direct") {
        const c = await contact(activeConv.peerId);
        if (c) return contactSheet(c);
      }
      chatMenu();
    });
    $("jumpBtn").onclick = () => {
      const log = $("log");
      log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
      $("jumpBtn").classList.add("hide");
    };
    $("log").addEventListener("scroll", () => {
      const log = $("log");
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 60) $("jumpBtn").classList.add("hide");
    }, { passive: true });
    $("diagBtn").onclick = showDiagnostics;
    $("settingsBtn").onclick = guard(showSettings);
    $("addContactBtn").onclick = guard(addContactSheet);
    $("chatMenuBtn").onclick = guard(() => chatMenu());
    $("notifBtn").onclick = async () => {
      const ok = await askNotify();
      paintNotifState();
      toast(ok ? "Notifications are on" : NATIVE ? "Notifications are blocked \u2014 allow them in Android Settings \u2192 Apps \u2192 Cyanotype \u2192 Notifications" : "Notifications were not allowed", !ok);
    };
    $("pruneNow").onclick = guard(pruneNowMenu);
    $("menuSheet").addEventListener("click", (e) => {
      if (e.target === $("menuSheet")) closeSheet();
    });
    /* The Android wrapper offers the system back gesture here first. Returning
       false lets it send the app to the background instead of closing it. */
    window.cyanotypeBack = () => {
      if ($("menuSheet").classList.contains("on")) {
        closeSheet();
        return true;
      }
      const cur = document.querySelector(".screen.on");
      if (cur && cur.id !== "s-home") {
        back();
        return true;
      }
      if (!$("paneContacts").classList.contains("hide")) {
        switchTab("chats");
        return true;
      }
      return false;
    };
    $("rjCancel").onclick = back;
    $("rjCopy").onclick = () => {
      const txt = $("rjCode").textContent;
      const done = () => toast("Code copied");
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done).catch(() => toast(txt));
      else toast(txt);
    };
    /* Offered only when the peer is actually unreachable, and only after the
       relay has had its chance: a code is the fallback, not the first resort. */
    $("rejoinBtn").onclick = guard(async () => {
      const conv = activeConv;
      if (!conv || conv.type !== "direct") return;
      const viaRelay = await rejoinStart(conv.peerId).catch(() => "no-relay");
      if (viaRelay === "sent") {
        toast("Trying to restore the link through someone you are both connected to\u2026");
        return;
      }
      sheet({
        eyebrow: "Reconnect",
        title: "Swap codes instead",
        text: "Nobody you are both connected to can pass the reconnection along, so you will read short codes to each other. One of you goes first.",
        actions: [
          { label: "I'll read mine out first", sub: "Your phone shows a code to read to them", run: () => startRejoinCode() },
          { label: "They've read me theirs", kind: "alt", sub: "Type in the code they gave you", run: () => startRejoinEnter() }
        ]
      });
    });
    $("fileInput").onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      if (f.size > MAX_FILE) {
        return toast(`That file is ${fmtSize(f.size)}. The limit is ${fmtSize(MAX_FILE)} \u2014 a bigger one has to be assembled in memory on both phones.`, true);
      }
      try {
        if (f.type.startsWith("image/")) return void await sendAttachment(await prepareImage(f), "image");
        const bytes = new Uint8Array(await f.arrayBuffer());
        await sendAttachment({ bytes, mime: f.type || "application/octet-stream", name: f.name || "file" }, "file");
      } catch (err) {
        toast("Could not read that file: " + err.message, true);
      }
    };
    $("attachBtn").onclick = guard(() => $("fileInput").click());
    $("micBtn").onclick = guard(async () => {
      if (!audioSupported()) return toast("This browser cannot record audio", true);
      if (recorder) {
        const payload = await recorder.stop();
        recorder = null;
        $("micBtn").classList.remove("rec");
        syncComposer();
        await sendAttachment(payload, "audio");
      } else {
        try {
          recorder = await recordAudio();
          $("micBtn").classList.add("rec");
          toast("Recording \u2014 tap again to send");
        } catch (err) {
          toast(err.message, true);
        }
      }
    });
    $("callBtn").onclick = guard(async () => {
      if (!activeConv || activeConv.type !== "direct") return;
      try {
        await callPlace(activeConv.peerId, activeConv.id, activeConv.title);
      } catch (e) {
        toast(e.message, true);
      }
    });
    $("acceptBtn").onclick = async () => {
      $("ringSheet").classList.remove("on");
      dropAlert("call");
      try {
        await callAccept();
      } catch (e) {
        toast(e.message, true);
      }
    };
    $("declineBtn").onclick = () => {
      $("ringSheet").classList.remove("on");
      callEnd("Call declined");
    };
    $("hangupBtn").onclick = () => callEnd("Call ended");
    $("muteBtn").onclick = () => {
      const m = callMute(!(call && call.muted));
      $("muteBtn").classList.toggle("muted", m);
      $("muteBtn").setAttribute("aria-label", m ? "Unmute your microphone" : "Mute your microphone");
      toast(m ? "Microphone muted" : "Microphone on");
    };
    $("locBtn").onclick = guard(async () => {
      if (locShare) return toast("Already sharing \u2014 use the banner to extend or stop");
      if (!activeConv) return;
      await askNotify();
      try {
        await locStart(activeConv, groupKeys.get(activeConv.id));
      } catch (e) {
        toast(e.message, true);
      }
    });
    $("locKeep").onclick = () => locExtend();
    $("locStop").onclick = () => locStop("stopped by you");
    document.addEventListener("visibilitychange", () => {
      if (appAway()) return;
      if (activeConv) {
        markRead(activeConv).catch(() => {
        });
        if ($("s-chat").classList.contains("on") && !appAway()) {
          clearAlerts(activeConv.id);
          resetUnread(activeConv.id).catch(() => {
          });
        }
      }
      rejoinSweep().catch(() => {
      });
      applyRetention().catch(() => {
      });
    });
    window.addEventListener("pagehide", () => stopScanning());
  }
  var rejoinFor = null;
  function rejoinScreen({ title, hint, code, input, inputLabel, action, step }) {
    $("rjStep").textContent = step || "Reconnect";
    $("rjTitle").textContent = title;
    $("rjHint").textContent = hint;
    $("rjOut").classList.toggle("hide", !code);
    if (code) $("rjCode").textContent = code;
    $("rjInWrap").classList.toggle("hide", !input);
    $("rjGo").classList.toggle("hide", !input);
    if (input) {
      $("rjIn").value = "";
      $("rjInLbl").textContent = inputLabel || "Their code";
      $("rjGo").textContent = action || "Connect";
    }
    show("rejoin");
  }
  async function startRejoinCode() {
    const conv = activeConv;
    if (!conv || conv.type !== "direct") return;
    rejoinFor = conv.peerId;
    try {
      const { code } = await rejoinOffer(conv.peerId);
      rejoinScreen({
        step: "Step 1 of 2",
        title: "Read them this code",
        hint: "They type it into their phone, then read you the code it gives back.",
        code,
        input: true,
        inputLabel: "The code they read back",
        action: "Connect"
      });
      $("rjGo").onclick = async () => {
        try {
          await rejoinComplete(rejoinFor, $("rjIn").value);
          status("connecting", "wait");
        } catch (e) {
          toast(e.message, true);
        }
      };
    } catch (e) {
      toast(e.message, true);
      back();
    }
  }
  async function startRejoinEnter() {
    const conv = activeConv;
    if (!conv || conv.type !== "direct") return;
    rejoinFor = conv.peerId;
    rejoinScreen({
      step: "Step 1 of 2",
      title: "Type their code",
      hint: "Whichever of you starts, the other types first. Spaces and case do not matter.",
      input: true,
      inputLabel: "Their code",
      action: "Next"
    });
    $("rjGo").onclick = async () => {
      try {
        const { code } = await rejoinAccept(rejoinFor, $("rjIn").value);
        rejoinScreen({
          step: "Step 2 of 2",
          title: "Now read them this",
          hint: "They type it in and the link comes back a second or two later.",
          code
        });
      } catch (e) {
        toast(e.message, true);
      }
    };
  }
  async function showDiagnostics() {
    var _a, _a2, _b;
    const queuedCount = await carryCount().catch(() => "?");
    const yes = (v) => v ? "yes" : "NO";
    const rows = [
      ["secure context", yes(window.isSecureContext)],
      ["web crypto", yes(!!(crypto == null ? void 0 : crypto.subtle))],
      ["webrtc", yes(!!window.RTCPeerConnection)],
      ["camera api", yes(!!((_a = navigator.mediaDevices) == null ? void 0 : _a.getUserMedia))],
      ["barcode detector", yes("BarcodeDetector" in window)],
      ["media recorder", yes(!!window.MediaRecorder)],
      ["microphone api", yes(!!((_a2 = navigator.mediaDevices) == null ? void 0 : _a2.getUserMedia))],
      ["geolocation", yes(!!navigator.geolocation)],
      ["notifications", "Notification" in window ? Notification.permission : "NO"],
      ["queued for relay", String(queuedCount)],
      ["call", call ? call.status + " with " + call.name : "none"],
      ["sharing location", locShare ? fmtClock(locShare.endsAt - Date.now()) + " left" : "no"],
      ["indexeddb", yes(!!window.indexedDB)],
      ["storage backend", (bootInfo == null ? void 0 : bootInfo.backend) || "not started"],
      ["service worker", ((_b = navigator.serviceWorker) == null ? void 0 : _b.controller) ? "controlling" : "none"],
      ["cache version", swVersion || "unknown"],
      ["dtls certificate", (me == null ? void 0 : me.certificate) ? "persistent" : "per-session"],
      ["storage isolation", sharedOrigin() ? "SHARED with other pages on this site \u2014 host Cyanotype on its own domain" : "own site"],
      ["update", swWaiting ? "ready, waiting" : "none pending"],
      ["identity", (me == null ? void 0 : me.selfId) || "none"],
      ["degraded", degraded() || "no"],
      ["ua", navigator.userAgent.slice(0, 72)]
    ];
    const box = $("diagBody");
    box.innerHTML = "";
    for (const [k, v] of rows) {
      const r = el("div", "diagRow");
      r.append(el("span", "diagKey", k), el("span", "diagVal", String(v)));
      box.append(r);
    }
    show("diag");
  }
  /* A voice call or a live location share must not be interrupted by a page
     reload, so a ready update parks until both are clear. */
  var swReg = null;
  var swWaiting = null;
  var swVersion = null;
  var swReloading = false;
  var busy = () => !!call || !!locShare;
  function applyUpdate() {
    if (!swWaiting) return;
    const w = swWaiting;
    swWaiting = null;
    w.postMessage("skip-waiting");
  }
  function offerUpdate(worker) {
    swWaiting = worker;
    $("cache").textContent = "update ready to install";
    if (busy()) return;
    toast("New version ready \u2014 tap to update", false, applyUpdate);
  }
  function initUpdates() {
    navigator.serviceWorker.register("./sw.js").then((reg) => {
      swReg = reg;
      $("cache").textContent = "works offline";
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          // No controller means this is the very first install, which needs no
          // prompt: there is no running version to replace.
          if (sw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(sw);
        });
      });
      navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage("version");
    }).catch(() => $("cache").textContent = "needs a connection to open");

    navigator.serviceWorker.addEventListener("message", (ev) => {
      if (ev.data && ev.data.type === "version") swVersion = ev.data.version;
    });

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (swReloading) return;
      swReloading = true;
      location.reload();
    });

    // Browsers re-check the worker on their own schedule, which can be hours.
    // Returning to the app is the moment the user is most likely online.
    document.addEventListener("visibilitychange", () => {
      if (appAway() || !swReg) return;
      swReg.update().catch(() => {
      });
      if (swWaiting && !busy()) toast("New version ready \u2014 tap to update", false, applyUpdate);
    });
  }
  var bootInfo = null;
  async function boot() {
    typeof window !== "undefined" && window.__boot && window.__boot.mark("boot-start");
    wireUI();
    typeof window !== "undefined" && window.__boot && window.__boot.mark("ui-wired");
    status("starting", "wait");
    if (!window.isSecureContext) {
      status("needs https", "bad");
      return toast("Serve this over HTTPS or localhost \u2014 camera and WebRTC are blocked otherwise.", true);
    }
    if (!(crypto == null ? void 0 : crypto.subtle) || !window.RTCPeerConnection) {
      status("unsupported", "bad");
      return toast("This browser is missing WebCrypto or WebRTC. Try Chrome, Edge, or Safari.", true);
    }
    typeof window !== "undefined" && window.__boot && window.__boot.mark("store-init");
    bootInfo = await init();
    typeof window !== "undefined" && window.__boot && window.__boot.mark("store-ready:" + bootInfo.backend);
    me = bootInfo;
    $("selfId").textContent = me.selfId.slice(0, 8);
    if (bootInfo.degraded) toast(bootInfo.degraded, true);
    let mergedThreads = 0;
    try {
      mergedThreads = await dedupeDirect();
    } catch (e) {
    }
    for (const c of await conversations()) {
      if (c.type === "group" && c.groupKey) groupKeys.set(c.id, await importGroupKey(c.groupKey));
    }
    typeof window !== "undefined" && window.__boot && window.__boot.mark("render");
    await renderHome();
    status("idle");
    typeof window !== "undefined" && window.__boot && window.__boot.done();
    if ("serviceWorker" in navigator) initUpdates();
    if (mergedThreads) {
      toast(`Joined up ${mergedThreads} split conversation${mergedThreads === 1 ? "" : "s"} \u2014 sent and received messages now share one thread.`);
    }
    const queued = await carryCount().catch(() => 0);
    if (queued) toast(`${queued} message${queued === 1 ? "" : "s"} waiting to be delivered when you next meet someone.`);
    carryFlush().catch(() => {
    });
    ["presence", "linkopen", "linkclosed", "callstate", "callended", "locstart", "locstop"].forEach((t) => on(t, syncService));
    wireNative();
    if (!NATIVE && "serviceWorker" in navigator) {
      // A tap on a browser notification: the worker hands over the chat to open.
      navigator.serviceWorker.addEventListener("message", (ev) => {
        if (ev.data && ev.data.type === "open" && ev.data.convId) openChat(ev.data.convId);
      });
      const want = new URLSearchParams(location.search).get("open");
      if (want) {
        history.replaceState(null, "", location.pathname);
        openChat(want);
      }
    }
    applyRetention(true).catch(() => {
    });
    window.addEventListener("pagehide", () => {
      if (locShare) locStop("app closed");
      if (call) callEnd("App closed");
    });
  }
  function switchTab(which) {
    $("tabChats").classList.toggle("sel", which === "chats");
    $("tabContacts").classList.toggle("sel", which === "contacts");
    $("paneChats").classList.toggle("hide", which !== "chats");
    $("paneContacts").classList.toggle("hide", which !== "contacts");
  }
  boot().catch((e) => {
    status("error", "bad");
    toast("Startup failed: " + ((e == null ? void 0 : e.message) || e) + " \u2014 tap Diagnostics for detail.", true);
    typeof window !== "undefined" && window.__boot && window.__boot.fail((e == null ? void 0 : e.message) || String(e));
  });
})();
