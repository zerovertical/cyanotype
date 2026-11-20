// End-to-end check of the new features: two copies of the app pair over a
// real local WebRTC link. Phone A pretends to be the Android wrapper (a mock
// plugin records every native call); phone B is a plain browser.
import { chromium } from "playwright-core";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, chromeOptions } from "./serve.mjs";

// Run from the repo folder:  node tests/app.test.mjs
const WEB = process.argv[2] || "web";
const PORT = 8765;
const URL = `http://localhost:${PORT}/index.html`;
const server = await serve(WEB, PORT);
const SAMPLE = join(tmpdir(), "cyanotype-sample.bin");

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? "  PASS " : "  FAIL ") + msg); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(150); }
  throw new Error("timed out waiting for " + label);
}

const barcodeMock = `
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ["qr_code"]; }
    async detect() { return window.__qr ? [{ rawValue: window.__qr }] : []; }
  };`;
const nativeMock = `
  window.__native = { calls: [], listeners: {} };
  const ret = {
    start: () => ({ running: true }), stop: () => ({ running: false }),
    showAlert: () => ({ shown: true }), requestAlerts: () => ({ granted: true }),
    saveStart: () => ({ id: "s1" }), saveFinish: () => ({ savedAs: "Downloads/Cyanotype/test.bin" }),
    launchTarget: () => ({}), clearAlert: () => ({}), saveChunk: () => ({}), saveAbort: () => ({}),
    // Already allowed, so the one-off battery question stays out of these flows
    // (tests/lan.test.mjs covers it).
    batteryStatus: () => ({ exempt: true }),
  };
  window.Capacitor = { Plugins: { Foreground: new Proxy({}, { get: (t, name) => {
    if (name === "addListener") return (ev, fn) => { (window.__native.listeners[ev] = window.__native.listeners[ev] || []).push(fn); return Promise.resolve({ remove() {} }); };
    if (typeof name !== "string" || name === "then") return undefined;
    return (args) => { window.__native.calls.push([name, args]); return Promise.resolve(ret[name] ? ret[name](args) : {}); };
  } }) } };`;
const hiddenMock = `
  Object.defineProperty(document, "hidden", { configurable: true, get: () => !!window.__hidden });`;

const browser = await chromium.launch(chromeOptions(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns"]));
const errors = [];
async function phone(name, extra) {
  const ctx = await browser.newContext({ permissions: ["camera", "microphone", "notifications"], acceptDownloads: true });
  await ctx.addInitScript(barcodeMock + extra);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${name} console: ${m.text()}`); });
  await page.goto(URL);
  await until(() => page.evaluate(() => document.getElementById("state").dataset.state === "idle"), 15000, name + " boot");
  return page;
}
const qrOf = (page) => page.evaluate(() => {
  const c = document.getElementById("qrOut");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  return jsQR(d.data, c.width, c.height).data;
});
const calls = (page, name) => page.evaluate((n) => window.__native.calls.filter((c) => c[0] === n).map((c) => c[1]), name);
const screen = (page) => page.evaluate(() => document.querySelector(".screen.on").id);
const toastText = (page) => page.evaluate(() => document.getElementById("toast").textContent);
const clickAction = (page, label) => page.locator("#menuActs .btn", { hasText: label }).first().click();

try {
  console.log("Boot");
  const A = await phone("A", nativeMock);
  const B = await phone("B", hiddenMock);
  ok(true, "both copies start without errors");
  ok(await A.evaluate(() => window.__native.calls.some((c) => c[0] === "launchTarget")), "A asks Android whether a notification tap launched it");
  ok((await calls(A, "start")).length === 0, "A does not start the 'connected' service with no links");

  console.log("Pairing");
  await A.click("#btnInvite");
  await until(async () => (await screen(A)) === "s-pair", 15000, "A invite QR");
  const invite = await qrOf(A);
  await B.evaluate((q) => { window.__qr = q; }, invite);
  await B.click("#btnJoin");
  await until(async () => (await screen(B)) === "s-pair", 15000, "B reply QR");
  const reply = await qrOf(B);
  await A.evaluate((q) => { window.__qr = q; }, reply);
  await A.click("#pairAction");
  await until(async () => (await screen(A)) === "s-safety" && (await screen(B)) === "s-safety", 20000, "safety screens");
  await A.fill("#nameInput", "Bea");
  await A.click("#safetyConfirm");
  await B.fill("#nameInput", "Al");
  await B.click("#safetyConfirm");
  await until(async () => (await screen(A)) === "s-chat" && (await screen(B)) === "s-chat", 8000, "chats open");
  ok(true, "two phones pair and open a chat");
  ok(await A.textContent("#state") === "Connected", "status pill says 'Connected' in plain words");
  ok(await A.evaluate(() => !document.getElementById("micBtn").classList.contains("hide") && document.getElementById("sendBtn").classList.contains("hide")), "empty composer shows the mic button, not send");
  await A.fill("#msgInput", "x");
  ok(await A.evaluate(() => document.getElementById("micBtn").classList.contains("hide") && !document.getElementById("sendBtn").classList.contains("hide")), "typing swaps the mic for the send button");
  await A.fill("#msgInput", "");
  await until(async () => (await calls(A, "start")).length > 0, 5000, "service start");
  ok((await calls(A, "start")).some((c) => c.text === "Linked to 1 person"), "A starts the 'connected' service once a link is live, saying 'Linked to 1 person'");
  ok((await calls(A, "requestAlerts")).length > 0, "A asks for notification permission on first pairing");

  console.log("Notifications (Android path)");
  await B.fill("#msgInput", "hello while you look");
  await B.click("#sendBtn");
  await until(() => A.evaluate(() => document.querySelectorAll("#log .msg.them").length === 1), 5000, "first msg");
  ok((await calls(A, "showAlert")).length === 0, "no notification while A is looking at the chat");
  ok(await A.evaluate(() => document.querySelector("#log .daySep") && document.querySelector("#log .daySep").textContent === "Today"), "messages are grouped under a 'Today' heading");
  await A.evaluate(() => window.__native.listeners.appstate.forEach((f) => f({ active: false })));
  await B.fill("#msgInput", "are you there?");
  await B.click("#sendBtn");
  await until(async () => (await calls(A, "showAlert")).length === 1, 5000, "alert 1");
  let al = (await calls(A, "showAlert"))[0];
  ok(al.title === "Bea" && al.body === "are you there?" && !!al.convId, `background message raises a notification: "${al.title}: ${al.body}"`);
  await B.fill("#msgInput", "hello??");
  await B.click("#sendBtn");
  await until(async () => (await calls(A, "showAlert")).length === 2, 5000, "alert 2");
  al = (await calls(A, "showAlert"))[1];
  ok(al.title === "Bea (2 new)" && al.tag === (await calls(A, "showAlert"))[0].tag, `second one replaces the first: "${al.title}"`);
  await sleep(1200);
  const readBefore = await B.evaluate(() => [...document.querySelectorAll("#log .msg.me .ticks")].slice(-2).map((t) => t.className));
  ok(readBefore.length === 2 && !readBefore.some((c) => c.includes("read")), "B does not see blue 'read' ticks for messages sent while A is in the background: " + readBefore.join(", "));
  await A.evaluate(() => window.__native.listeners.appstate.forEach((f) => f({ active: true })));
  ok((await calls(A, "clearAlert")).some((c) => c.tag === al.tag), "returning to the open chat clears its notification");
  await until(() => B.evaluate(() => [...document.querySelectorAll("#log .msg.me .ticks")].some((t) => t.className.includes("read"))), 5000, "read ticks");
  ok(true, "B sees 'read' once A is actually back in front");
  // Tap on a notification while running
  await A.evaluate(() => document.getElementById("backBtn").click());
  await A.evaluate((id) => window.__native.listeners.open.forEach((f) => f({ convId: id })), al.convId);
  await until(async () => (await screen(A)) === "s-chat", 3000, "open from tap");
  ok(true, "tapping a notification opens that chat");

  console.log("Unread counts");
  await A.evaluate(() => document.getElementById("backBtn").click());
  await B.fill("#msgInput", "one");
  await B.click("#sendBtn");
  await B.fill("#msgInput", "two");
  await B.click("#sendBtn");
  await until(() => A.evaluate(() => { const b = document.querySelector("#convList .row .badge"); return b && b.textContent === "2"; }), 5000, "badge").catch(() => {});
  ok(await A.evaluate(() => { const b = document.querySelector("#convList .row .badge"); return !!b && b.textContent === "2"; }), "chat list shows 2 unread on the chat");
  ok(await A.evaluate(() => { const b = document.querySelector("#tabChats .badge"); return !!b && b.textContent === "2"; }), "and on the Chats tab");
  await A.locator("#convList .row").first().click();
  await until(() => A.evaluate(() => !document.querySelector("#tabChats .badge")), 3000, "badge cleared").catch(() => {});
  ok(await A.evaluate(() => !document.querySelector("#tabChats .badge")), "opening the chat clears the count");
  console.log("Scrolling");
  await A.evaluate(() => { const log = document.getElementById("log"); for (let i = 0; i < 30; i++) { const d = document.createElement("div"); d.className = "msg them"; d.textContent = "filler " + i; log.append(d); } log.scrollTop = 0; });
  await B.fill("#msgInput", "while you scroll");
  await B.click("#sendBtn");
  await until(() => A.evaluate(() => !document.getElementById("jumpBtn").classList.contains("hide")), 5000, "jump").catch(() => {});
  ok(await A.evaluate(() => !document.getElementById("jumpBtn").classList.contains("hide") && document.getElementById("log").scrollTop < 50), "reading older messages is not interrupted; a 'New messages' button appears instead");
  await A.click("#jumpBtn");
  await A.evaluate(() => [...document.querySelectorAll("#log .msg")].filter((n) => n.textContent.startsWith("filler")).forEach((n) => n.remove()));

  console.log("Notifications (browser path)");
  await B.evaluate(() => { window.__hidden = true; document.dispatchEvent(new Event("visibilitychange")); });
  await A.fill("#msgInput", "ping from A");
  await A.click("#sendBtn");
  await until(() => B.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg && (await reg.getNotifications()).length > 0;
  }), 8000, "browser notification");
  const bn = await B.evaluate(async () => (await (await navigator.serviceWorker.getRegistration()).getNotifications()).map((n) => [n.title, n.body, n.data && n.data.convId]));
  ok(bn[0][0] === "Al" && bn[0][1] === "ping from A" && !!bn[0][2], `browser shows a notification via the service worker: "${bn[0][0]}: ${bn[0][1]}"`);
  await B.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); });

  console.log("Saving a received file (Android path)");
  const bytes = randomBytes(700 * 1024);
  writeFileSync(SAMPLE, bytes);
  await B.setInputFiles("#fileInput", SAMPLE);
  await until(() => A.evaluate(() => !!document.querySelector("#log .card2 .acts button")), 10000, "file card");
  await A.locator("#log .card2 .acts button", { hasText: "Save" }).click();
  await until(async () => (await calls(A, "saveFinish")).length === 1, 5000, "save finish");
  const chunks = await calls(A, "saveChunk");
  const joined = Buffer.concat(chunks.map((c) => Buffer.from(c.data, "base64")));
  const start = (await calls(A, "saveStart"))[0];
  ok(createHash("sha256").update(joined).digest("hex") === createHash("sha256").update(bytes).digest("hex"),
    `file reaches Android intact in ${chunks.length} pieces (${start.name}, ${start.mime})`);
  ok((await toastText(A)).includes("Downloads/Cyanotype"), "user is told where it was saved");

  console.log("Reactions");
  const sheetOnA = () => A.evaluate(() => document.getElementById("menuSheet").classList.contains("on"));
  await A.locator("#log .msg.them", { hasText: "hello??" }).dispatchEvent("contextmenu");
  await until(sheetOnA, 3000, "reaction sheet");
  ok(await A.evaluate(() => document.querySelectorAll("#menuBody .reactBar .rx").length) === 6, "pressing and holding a message offers six reactions above the other options");
  await A.locator("#menuBody .reactBar .rx").first().click();
  await until(() => A.evaluate(() => { const b = [...document.querySelectorAll("#log .msg.them")].find((m) => m.textContent.includes("hello??")); return !!(b && b.querySelector(".reacts .react.mine")); }), 3000, "pill on A").catch(() => {});
  ok(await A.evaluate(() => { const b = [...document.querySelectorAll("#log .msg.them")].find((m) => m.textContent.includes("hello??")); return b && b.querySelector(".reacts .react.mine").textContent === "\u{1F44D}"; }), "the reaction shows under the message, marked as yours");
  // B's own copy of "hello??", and the reaction pill under it (null when none).
  const bReact = () => B.evaluate(() => {
    const b = [...document.querySelectorAll("#log .msg.me")].find((m) => m.textContent.includes("hello??"));
    const p = b && b.querySelector(".reacts .react");
    return p ? p.textContent : null;
  });
  await until(async () => (await bReact()) === "\u{1F44D}", 5000, "reaction reaches B").catch(() => {});
  ok((await bReact()) === "\u{1F44D}", "it reaches the other phone and shows under their copy of that message");
  await sleep(600);
  await A.locator("#log .msg.them", { hasText: "hello??" }).dispatchEvent("contextmenu");
  await until(sheetOnA, 3000, "reaction sheet again");
  ok(await A.evaluate(() => document.querySelector("#menuBody .reactBar .rx.on") !== null && document.querySelector("#menuBody .reactWho").textContent.includes("You")), "the sheet shows who reacted, with your choice highlighted");
  await A.locator("#menuBody .reactBar .rx.on").click();
  await until(async () => (await bReact()) === null, 5000, "reaction removed").catch(() => {});
  ok((await bReact()) === null && await A.evaluate(() => !document.querySelector("#log .msg.them .reacts")), "picking the same reaction again takes it back, on both phones");
  if ((await bReact()) !== null || await A.evaluate(() => !!document.querySelector("#log .msg.them .reacts"))) {
    console.log("    debug: B pill", await bReact(), "| A pill", await A.evaluate(() => (document.querySelector("#log .msg.them .reacts") || {}).textContent),
      "| A sheet", await sheetOnA(), "| A toast", await toastText(A), "| B toast", await toastText(B));
  }

  console.log("Deleting a single message");
  const countA = () => A.evaluate(() => document.querySelectorAll("#log .msg").length);
  const before = await countA();
  await A.locator("#log .msg.them", { hasText: "hello??" }).dispatchEvent("contextmenu");
  await until(() => A.evaluate(() => document.getElementById("menuSheet").classList.contains("on")), 3000, "msg menu");
  const labels = await A.evaluate(() => [...document.querySelectorAll("#menuActs .btn")].map((b) => b.firstChild.textContent));
  ok(labels.includes("Copy text") && labels.includes("Delete from this phone"), "long-press offers: " + labels.join(", "));
  await clickAction(A, "Delete from this phone");
  await until(async () => (await countA()) === before - 1, 3000, "msg removed").catch(() => {});
  ok((await countA()) === before - 1, "message removed from the chat");
  ok(await A.evaluate(() => window.cyanotypeBack()) === true && (await screen(A)) === "s-home", "Android back gesture goes from chat to home");
  ok(await A.evaluate(() => window.cyanotypeBack()) === false, "back on home lets Android put the app in the background");

  console.log("Contacts");
  await A.click("#tabContacts");
  await A.locator("#contactList .row", { hasText: "Bea" }).click();
  await until(() => A.evaluate(() => document.getElementById("menuSheet").classList.contains("on")), 3000, "contact sheet");
  const fp = await A.evaluate(() => document.querySelector("#menuBody .keyGrid").textContent);
  ok(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/.test(fp), "contact details show their key fingerprint: " + fp);
  await clickAction(A, "Rename");
  await A.fill("#menuBody input", "Beatrice");
  await clickAction(A, "Save");
  await A.click("#tabChats");
  ok(await A.evaluate(() => [...document.querySelectorAll("#convList .rowName")].some((n) => n.textContent === "Beatrice")), "rename updates the contact and the chat title");
  await A.click("#addContactBtn").catch(() => {});
  await A.click("#tabContacts");
  await A.click("#addContactBtn");
  const addTitle = await A.evaluate(() => document.getElementById("menuTitle").textContent);
  ok(addTitle === "Pair in person", "'Add a contact' explains pairing and offers both QR options");
  await A.evaluate(() => window.cyanotypeBack());
  await A.click("#tabChats");

  console.log("Clearing a chat");
  await A.locator("#convList .row", { hasText: "Beatrice" }).dispatchEvent("contextmenu");
  await clickAction(A, "Clear messages");
  await clickAction(A, "Clear messages");
  await A.locator("#convList .row", { hasText: "Beatrice" }).click();
  await until(async () => (await screen(A)) === "s-chat", 3000, "chat").catch(() => {});
  await sleep(300);
  ok((await countA()) === 0, "clear messages empties the chat");
  const preview = await A.evaluate(() => document.querySelector("#convList .rowSub") && document.querySelector("#convList .rowSub").textContent);
  ok(preview === "No messages yet", "chat preview resets after clearing");

  console.log("Old messages");
  await B.fill("#msgInput", "old news");
  await B.click("#sendBtn");
  await B.fill("#msgInput", "fresh news");
  await B.click("#sendBtn");
  await until(async () => (await countA()) === 2, 5000, "two msgs");
  // Age one message 40 days directly in storage.
  await A.evaluate(() => new Promise((res, rej) => {
    const r = indexedDB.open("cyanotype");
    r.onsuccess = () => {
      const t = r.result.transaction("messages", "readwrite");
      const st = t.objectStore("messages");
      st.getAll().onsuccess = (e) => {
        const rows = e.target.result.sort((a, b) => a.at - b.at);
        const target = rows[rows.length - 2];
        target.at = Date.now() - 40 * 864e5;
        st.put(target);
      };
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    };
  }));
  await A.evaluate(() => window.cyanotypeBack());
  await A.click("#settingsBtn");
  ok((await screen(A)) === "s-settings", "settings screen opens");
  await until(async () => (await A.textContent("#storeStats")).length > 0, 3000, "stats").catch(() => {});
  ok((await A.textContent("#storeStats")).startsWith("2 messages"), "storage summary: " + (await A.textContent("#storeStats")));
  ok((await A.textContent("#notifState")).includes("Android Settings"), "Android build explains where notification settings live");
  await A.locator("#keepSeg button", { hasText: "30 days" }).click();
  await until(() => A.evaluate(() => document.getElementById("menuSheet").classList.contains("on")), 3000, "keep confirm");
  ok((await A.textContent("#menuText")).startsWith("1 message is already older than 30 days"), "choosing 30 days warns how many will go");
  await clickAction(A, "Delete 1 and keep 30 days");
  await until(async () => (await A.textContent("#storeStats")).startsWith("1 message"), 3000, "pruned");
  ok(true, "old message deleted, the recent one kept");
  ok(await A.evaluate(() => document.querySelector("#keepSeg .sel").textContent) === "30 days", "the choice is remembered");
  await A.reload();
  await until(() => A.evaluate(() => document.getElementById("state").dataset.state !== "starting"), 15000, "reload");
  await A.click("#settingsBtn");
  await until(() => A.evaluate(() => !!document.querySelector("#keepSeg .sel")), 3000, "seg").catch(() => {});
  ok(await A.evaluate(() => document.querySelector("#keepSeg .sel").textContent) === "30 days", "and survives a reload");
  await A.evaluate(() => window.cyanotypeBack());

  console.log("Groups");
  await A.click("#btnGroup");
  ok(await A.evaluate(() => document.getElementById("menuSheet").classList.contains("on") && !!document.querySelector("#menuBody input")), "New group asks for a name in the app's own sheet, not a browser pop-up");
  await A.fill("#menuBody input", "Climbing club");
  await clickAction(A, "Create group");
  await until(async () => (await screen(A)) === "s-chat", 3000, "group chat").catch(() => {});
  ok(await A.textContent("#chatTitle") === "Climbing club", "group created and opened");
  await A.evaluate(() => window.cyanotypeBack());

  console.log("Deleting a contact");
  // Reconnect after reload is not under test here; delete from the contacts tab.
  await A.click("#tabContacts");
  await A.locator("#contactList .row", { hasText: "Beatrice" }).click();
  await clickAction(A, "Delete contact");
  await clickAction(A, "Delete contact and chat");
  await sleep(600);
  ok(await A.evaluate(() => document.querySelectorAll("#contactList .row").length === 0), "contact gone from the list");
  await A.click("#tabChats");
  ok(await A.evaluate(() => ![...document.querySelectorAll("#convList .rowName")].some((n) => n.textContent === "Beatrice")), "and the chat with them");
  const left = await A.evaluate(() => new Promise((res) => {
    const r = indexedDB.open("cyanotype");
    r.onsuccess = () => {
      const t = r.result.transaction(["messages", "blobs", "contacts"]);
      const out = {};
      let n = 0;
      for (const s of ["messages", "blobs", "contacts"]) t.objectStore(s).count().onsuccess = (e) => { out[s] = e.target.result; if (++n === 3) res(out); };
    };
  }));
  ok(left.messages === 0 && left.blobs === 0 && left.contacts === 0, "nothing of theirs left in storage: " + JSON.stringify(left));
} catch (e) {
  failures++;
  console.log("  ERROR " + e.message);
} finally {
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  if (real.length) { failures += real.length; console.log("Page errors:\n  " + real.join("\n  ")); }
  console.log(failures ? `\n${failures} problem(s)` : "\nAll checks passed");
  await browser.close();
  server.close();
  process.exit(failures ? 1 : 0);
}
