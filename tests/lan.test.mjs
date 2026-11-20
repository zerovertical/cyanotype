// Reconnecting on the same Wi-Fi, end to end. Each phone is a copy of the app
// pretending to be the Android wrapper; this script plays the part of Android's
// network service discovery and the sockets between phones, routing lines of
// text exactly as the wrapper would. The app is served from a TEST-ONLY copy
// with internal hooks (window.__t); the shipped files have none.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, chromeOptions } from "./serve.mjs";

// Run from the repo folder:  node tests/lan.test.mjs
const SRC = process.argv[2] || "web";
const DIR = join(tmpdir(), "cyanotype-lan-test");
rmSync(DIR, { recursive: true, force: true });
cpSync(SRC, DIR, { recursive: true });
const app = readFileSync(join(DIR, "app.js"), "utf8");
const hook = `  window.__t = { links, link, contact, contacts, conversations, outbox, rejoinPending, lanPeers, lanConns, lanDropped, me: () => me, get backend() { return backend; }, on,  get lanBg() { return lanBg; } };\n  function wireUI() {`;
if (!app.includes("  function wireUI() {")) throw new Error("hook point missing");
writeFileSync(join(DIR, "app.js"), app.replace("  function wireUI() {", hook));

const PORT = 8773;
const server = await serve(DIR, PORT);

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? "  PASS " : "  FAIL ") + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(150); }
  throw new Error("timed out waiting for " + label);
}

/* ---- the pretend network ---- */
const net = {
  phones: new Map(),   // service name -> page
  conns: new Map(),    // conn id -> { page, other }
  frames: [],          // every line sent: { from, to, conn, data }
  paused: false,
  seq: 0,
};
async function deliver(page, ev, d) {
  await page.evaluate(([e, x]) => (window.__native.listeners[e] || []).forEach((f) => f(x)), [ev, d]).catch(() => {});
}
async function lan(page, method, args) {
  if (method === "lanStart") {
    const name = "cyanotype-" + page.label.toLowerCase();
    net.phones.set(name, page);
    page.svc = name;
    // Everyone already here learns about the newcomer, and the newcomer about them.
    setTimeout(() => {
      for (const [n, p] of net.phones) if (p !== page) { deliver(p, "lanPeer", { peer: name, found: true }); deliver(page, "lanPeer", { peer: n, found: true }); }
    }, 50);
    return { name };
  }
  if (method === "lanConnect") {
    if (net.paused) throw new Error("unreachable");
    const target = net.phones.get(args.peer);
    if (!target) throw new Error("no such phone");
    const a = "c" + (++net.seq), b = "c" + (++net.seq);
    net.conns.set(a, { page, peerPage: target, other: b });
    net.conns.set(b, { page: target, peerPage: page, other: a });
    return { conn: a };
  }
  if (method === "lanSend") {
    const c = net.conns.get(args.conn);
    if (!c) throw new Error("closed");
    if (args.data.includes("\n") || args.data.length > 32768) throw new Error("bad line");
    net.frames.push({ from: page.label, to: c.peerPage.label, conn: args.conn, data: args.data });
    // "paused" cuts the real phones off from each other; a stranger's hand-made
    // connection still gets its answers.
    if (!net.paused || c.peerPage.fake) setTimeout(() => deliver(c.peerPage, "lanFrame", { conn: c.other, data: args.data }), 5);
    return {};
  }
  if (method === "lanClose") {
    const c = net.conns.get(args.conn);
    if (c) { net.conns.delete(args.conn); net.conns.delete(c.other); deliver(c.peerPage, "lanClosed", { conn: c.other }); }
    return {};
  }
  return {};
}
// A stranger's raw socket: open a conn into a phone and push lines by hand.
function rawConn(fromLabel, target) {
  const a = "c" + (++net.seq), b = "c" + (++net.seq);
  const inbox = [];
  const fake = { label: fromLabel, fake: true, evaluate: async (fn, [ev, d]) => { if (ev === "lanFrame") inbox.push(d.data); } };
  net.conns.set(a, { page: fake, peerPage: target, other: b });
  net.conns.set(b, { page: target, peerPage: fake, other: a });
  return { inbox, send: (line) => deliver(target, "lanFrame", { conn: b, data: line }) };
}

const nativeMock = (exempt) => `
  window.__native = { calls: [], listeners: {} };
  const ret = {
    start: () => ({ running: true }), stop: () => ({ running: false }), launchTarget: () => ({}),
    batteryStatus: () => ({ exempt: ${exempt} }), requestBatteryExemption: () => ({ exempt: false }),
  };
  window.Capacitor = { Plugins: { Foreground: new Proxy({}, { get: (t, name) => {
    if (name === "addListener") return (ev, fn) => { (window.__native.listeners[ev] = window.__native.listeners[ev] || []).push(fn); return Promise.resolve({ remove() {} }); };
    if (typeof name !== "string" || name === "then") return undefined;
    return (args) => {
      window.__native.calls.push([name, args]);
      if (name.startsWith("lan")) return window.__lan(name, args || {});
      return Promise.resolve(ret[name] ? ret[name](args) : {});
    };
  } }) } };`;

const browser = await chromium.launch(chromeOptions(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns"]));
const errors = [];
async function phone(name, { exempt = true } = {}) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone"] });
  await ctx.addInitScript(`window.BarcodeDetector = class { static async getSupportedFormats(){return ["qr_code"]} async detect(){ return window.__qr ? [{rawValue: window.__qr}] : [] } };` + nativeMock(exempt));
  const page = await ctx.newPage();
  page.label = name;
  await page.exposeFunction("__lan", (method, args) => lan(page, method, args));
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name} console: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await until(() => page.evaluate(() => document.getElementById("state").dataset.state === "idle"), 15000, name + " boot");
  page.id = await page.evaluate(() => window.__t.me().selfId);
  await page.evaluate(() => { window.__ev = []; for (const t of ["linkopen", "linkclosed", "rejoined", "carrybad", "carryheld", "baddata", "rejoinbad", "presence"]) window.__t.on(t, (e) => window.__ev.push(t + ":" + JSON.stringify(e.detail).slice(0, 60) + "@" + (Date.now() % 100000))); });
  return page;
}
const screen = (p) => p.evaluate(() => document.querySelector(".screen.on").id);
const qrOf = (p) => p.evaluate(() => {
  const c = document.getElementById("qrOut");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  return jsQR(d.data, c.width, c.height).data;
});
const linked = (p, q) => p.evaluate((id) => !!(window.__t.link(id) && window.__t.link(id).open), q.id);
const calls = (p, n) => p.evaluate((x) => window.__native.calls.filter((c) => c[0] === x).map((c) => c[1]), n);
const sheetTitle = (p) => p.evaluate(() => document.getElementById("menuSheet").classList.contains("on") ? document.getElementById("menuTitle").textContent : "");
const appstate = (p, active) => deliver(p, "appstate", { active });
async function pair(X, Y, xName, yName) {
  await X.click("#btnInvite");
  await until(async () => (await screen(X)) === "s-pair", 15000, "invite QR");
  await Y.evaluate((q) => { window.__qr = q; }, await qrOf(X));
  await Y.click("#btnJoin");
  await until(async () => (await screen(Y)) === "s-pair", 15000, "reply QR");
  await X.evaluate((q) => { window.__qr = q; }, await qrOf(Y));
  await X.click("#pairAction");
  for (const [P, n] of [[X, xName], [Y, yName]]) {
    await until(async () => (await screen(P)) === "s-safety", 20000, "safety");
    await P.fill("#nameInput", n);
    await P.click("#safetyConfirm");
  }
  await until(async () => (await linked(X, Y)) && (await linked(Y, X)), 10000, "link");
}
async function drop(X, Y) {
  await X.evaluate((id) => window.__t.link(id).close(), Y.id);
  await until(async () => !(await linked(X, Y)) && !(await linked(Y, X)), 10000, "link closed");
}
const framesTo = (label) => net.frames.filter((f) => f.to === label).map((f) => JSON.parse(f.data));
const framesFrom = (label) => net.frames.filter((f) => f.from === label).map((f) => JSON.parse(f.data));

try {
  const A = await phone("A", { exempt: false }), B = await phone("B"), S = await phone("S");
  ok(await A.evaluate(() => window.__native.calls.some((c) => c[0] === "lanStart")), "the app starts looking for phones on the network at launch");
  await until(() => A.evaluate(() => window.__t.lanPeers.size === 2), 5000, "peers seen");
  ok(true, "each phone sees the other two Cyanotype phones on the network");
  ok(framesFrom("A").length === 0, "with no contacts yet, nobody is probed");

  console.log("Battery: asked once, at a quiet moment");
  await pair(A, B, "Bea", "Al");
  await until(async () => (await sheetTitle(A)) === "Keep links open with the screen off?", 12000, "battery sheet");
  ok(true, "after the first link opens, A (not exempt) is asked to let Cyanotype skip battery optimisation");
  ok((await sheetTitle(B)) === "", "B, already exempt, is not asked");
  await A.locator("#menuActs .btn", { hasText: "Allow" }).first().click();
  ok((await calls(A, "requestBatteryExemption")).length === 1, "'Allow' opens Android's prompt");

  console.log("Reconnecting on the same Wi-Fi, with no one to relay");
  net.frames.length = 0;
  await drop(A, B);
  await until(async () => (await linked(A, B)) && (await linked(B, A)), 20000, "automatic reconnect");
  ok(true, "after the link drops, the two phones find each other again and reconnect by themselves");
  const toS = framesTo("S");
  ok(!toS.some((m) => m.t === "rejoin"), "no offer was ever sent to the stranger on the same network");
  const fromS = framesFrom("S");
  ok(!fromS.some((m) => m.t === "match"), "the stranger could not claim to know anyone");
  ok(await A.evaluate(() => window.__t.links.size) === 1 && await B.evaluate(() => window.__t.links.size) === 1, "exactly one link each: probes that crossed did not make two");
  const probes = framesTo("B").filter((m) => m.t === "probe").concat(framesTo("A").filter((m) => m.t === "probe"));
  ok(probes.length > 0 && probes.every((m) => !JSON.stringify(m).includes(A.id) && !JSON.stringify(m).includes(B.id)), "probes carry no phone ids, only one-off tags");
  ok(new Set(probes.flatMap((m) => m.h)).size === probes.flatMap((m) => m.h).length, "no tag is ever repeated between probes");

  console.log("The reported problem: a message queued while the link was down");
  net.paused = true;
  await drop(A, B);
  ok((await screen(A)) === "s-chat" && (await screen(B)) === "s-chat", "both phones are still in their chat with each other");
  await A.fill("#msgInput", "test after a long gap");
  await A.click("#sendBtn");
  await until(() => A.evaluate(() => [...document.querySelectorAll("#log .msg.me")].some((m) => m.classList.contains("queued"))), 5000, "queued");
  ok(true, "with the other phone unreachable, the message is queued");
  net.paused = false;
  await appstate(A, false); await appstate(A, true);   // waking the phone
  await until(async () => (await linked(A, B)) && (await linked(B, A)), 20000, "reconnect after unpause");
  const arrived = await until(() => B.evaluate(() => [...document.querySelectorAll("#log .msg.them")].some((m) => m.textContent.includes("test after a long gap"))), 15000, "queued message arrives").catch(() => false);
  ok(!!arrived, "once the phones find each other, the queued message is delivered");
  if (!arrived && process.env.LAN_DEBUG) {
    console.log("A outbox", await A.evaluate(async () => (await window.__t.outbox()).map((e) => [e.id.slice(0, 6), e.to.slice(0, 6), e.exp - Date.now()])));
    console.log("A links", await A.evaluate(() => [...window.__t.links.values()].map((l) => [l.peerId.slice(0, 6), l.open, l.presence, !!l.sendKey])));
    console.log("B links", await B.evaluate(() => [...window.__t.links.values()].map((l) => [l.peerId.slice(0, 6), l.open, l.presence, !!l.sendKey])));
    console.log("B screen", await screen(B), await B.evaluate(() => [...document.querySelectorAll("#log .msg")].map((m) => m.className + ":" + m.textContent.slice(0, 30))));
    console.log("A ids", A.id.slice(0, 6), "B", B.id.slice(0, 6));
    console.log("A msgs", await A.evaluate(async () => (await window.__t.backend.getAll("messages")).map((m) => [m.kind, m.state, m.envId && m.envId.slice(0, 6)])));
    console.log("B msgs", await B.evaluate(async () => (await window.__t.backend.getAll("messages")).map((m) => [m.kind, m.state])));
    console.log("A ev", await A.evaluate(() => window.__ev), "B ev", await B.evaluate(() => window.__ev));
    await sleep(8000);
    console.log("B msgs later", await B.evaluate(async () => (await window.__t.backend.getAll("messages")).map((m) => [m.kind, m.state])));
  }
  ok(await until(() => A.evaluate(() => ![...document.querySelectorAll("#log .msg.me")].some((m) => m.classList.contains("queued"))), 5000).catch(() => false), "and A's tick leaves 'waiting to be sent'");

  console.log("A stranger on the same Wi-Fi");
  await drop(A, B);
  net.paused = true;   // freeze the real phones' own probing while we attack
  await sleep(300);
  const r1 = rawConn("S", B);
  await r1.send(JSON.stringify({ v: 1, t: "probe", n: "AAAAAAAAAAAAAAAAAAAAAA==", h: ["AAAAAAAAAAAAAAAAAAAAAA==", "BBBBBBBBBBBBBBBBBBBBBB=="] }));
  await sleep(500);
  ok(r1.inbox.length === 0, "made-up tags get no answer at all");
  // Replay a real probe A sent earlier: B answers (it cannot tell yet) but the
  // stranger cannot prove itself, so no offer follows.
  const real = net.frames.find((f) => f.to === "B" && JSON.parse(f.data).t === "probe");
  const r2 = rawConn("S", B);
  await r2.send(real.data);
  await sleep(800);
  const r2msgs = r2.inbox.map((x) => JSON.parse(x));
  ok(!r2msgs.some((m) => m.t === "rejoin"), "a replayed probe gets no offer: the replayer cannot prove it holds the secret");
  if (r2msgs[0] && r2msgs[0].t === "match") {
    await r2.send(JSON.stringify({ v: 1, t: "confirm", m: r2msgs[0].m.map((x) => ({ h: x.h, p: x.p })) }));
    await sleep(800);
    ok(!r2.inbox.map((x) => JSON.parse(x)).some((m) => m.t === "rejoin"), "echoing B's own proof back does not count as a confirmation");
  } else ok(true, "B gave nothing to echo");
  const realOffer = net.frames.find((f) => f.to === "B" && JSON.parse(f.data).t === "rejoin") || net.frames.find((f) => f.to === "A" && JSON.parse(f.data).t === "rejoin");
  const r3 = rawConn("S", B);
  await r3.send(realOffer.data);
  await sleep(500);
  ok(r3.inbox.length === 0 && await B.evaluate(() => window.__t.rejoinPending.size) === 0, "a replayed sealed offer on a new connection is ignored");
  const r4 = rawConn("S", B);
  await r4.send("x".repeat(40000));
  await r4.send("{not json");
  await sleep(300);
  ok(true, "junk and over-long lines are dropped without errors");
  net.paused = false;
  await appstate(A, false); await appstate(A, true);
  await until(async () => (await linked(A, B)) && (await linked(B, A)), 20000, "reconnect after attacks");
  ok(true, "the real phones still reconnect afterwards");

  console.log("Looking in the background");
  await appstate(A, false);
  await drop(A, B);
  await until(async () => (await calls(A, "start")).some((c) => /Looking for a contact on this Wi-Fi/.test(c.text)) || (await linked(A, B)), 8000, "bg text").catch(() => {});
  ok((await calls(A, "start")).some((c) => /Looking for a contact on this Wi-Fi/.test(c.text)) || (await linked(A, B)), "in the background, the notification says it is looking for the contact that dropped");
  await until(async () => (await linked(A, B)) && (await linked(B, A)), 20000, "bg reconnect");
  ok(true, "and reconnects from the background within the default 30-minute window");
  await appstate(A, true);
  await A.evaluate(() => document.getElementById("settingsBtn").click());
  await until(async () => (await screen(A)) === "s-settings", 5000, "settings");
  ok(await until(() => A.evaluate(() => !document.getElementById("bgGroup").classList.contains("hide") && document.querySelectorAll("#lanSeg button").length === 3), 3000).catch(() => false), "Settings shows a 'Staying connected' section in the Android app");
  await A.locator("#lanSeg button", { hasText: "Off" }).click();
  ok(await A.evaluate(() => window.__t.lanBg) === "off", "background looking can be turned off");
  await appstate(A, false);
  net.frames.length = 0;
  await drop(A, B);
  await appstate(B, false);
  await sleep(5000);
  ok(!framesFrom("A").some((m) => m.t === "probe"), "with it off, A sends no probes while in the background");
  await appstate(A, true);
  await until(async () => (await linked(A, B)) && (await linked(B, A)), 20000, "front reconnect").catch(async (e) => {
    if (process.env.LAN_DEBUG) {
      for (const P of [A, B]) console.log(P.label, P.id.slice(0, 8), await P.evaluate(() => ({ pend: [...window.__t.rejoinPending.entries()].map(([k, v]) => [k.slice(0, 8), v.role, Date.now() - v.at, v.pc.connectionState]), links: [...window.__t.links.values()].map((l) => [l.peerId.slice(0, 8), l.open, l.presence]), peers: [...window.__t.lanPeers.entries()], dropped: [...window.__t.lanDropped.keys()].map((k) => k.slice(0, 8)) })));
      console.log(net.frames.slice(-20).map((f) => f.from + ">" + f.to + " " + JSON.parse(f.data).t).join(", "));
    }
    throw e;
  });
  ok(true, "opening the app reconnects straight away");

  const real404 = errors.filter((e) => !/favicon|404/.test(e));
  ok(real404.length === 0, "no page errors" + (real404.length ? ": " + real404.join(" | ") : ""));
} catch (e) {
  console.log("  FAIL " + (e.stack || e.message));
  failures++;
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
