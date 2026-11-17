// Drives the real Slopify window over CDP for PR #70's proof: stills + frames for a video.
// usage: node drive.mjs <cdp port> <fake GitHub port> <out dir>
import fs from "node:fs";
import path from "node:path";
import https from "node:https";

const [cdpPort, fakePort, out] = process.argv.slice(2);
fs.mkdirSync(path.join(out, "frames"), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scenario = (name) => new Promise((resolve, reject) => https.get({ host: "127.0.0.1", port: fakePort, path: `/__scenario/${name}`, rejectUnauthorized: false }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject));

let target;
for (let i = 0; i < 60 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    target = list.find((t) => t.type === "page" && /^http:\/\/127\.0\.0\.1/.test(t.url));
  } catch { /* not up yet */ }
  if (!target) await sleep(500);
}
if (!target) throw new Error("No Slopify window over CDP.");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;

await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
let frame = 0;
const shot = async (name) => {
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, "base64"));
};
/** Frames for the video, every ~200 ms for `ms`. */
const record = async (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { data } = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 85 });
    fs.writeFileSync(path.join(out, "frames", `${String(frame++).padStart(4, "0")}.jpg`), Buffer.from(data, "base64"));
    await sleep(150);
  }
};
/** A caption drawn over the page, so the video says what's happening. */
const caption = (text) => evaluate(`(() => {
  let el = document.getElementById("__proof_caption");
  if (!el) { el = document.createElement("div"); el.id = "__proof_caption"; document.body.appendChild(el);
    Object.assign(el.style, { position: "fixed", left: "16px", bottom: "16px", zIndex: 2147483647, maxWidth: "760px", padding: "10px 14px",
      background: "rgba(255, 214, 0, 0.95)", color: "#111", font: "600 15px/1.35 system-ui, sans-serif", borderRadius: "8px", pointerEvents: "none" }); }
  el.textContent = ${JSON.stringify(text)};
})()`);
const updates = () => evaluate(`window.slopifyDesktop.updates.get()`);
const settled = async (ms = 20_000) => {
  const end = Date.now() + ms;
  let u;
  while (Date.now() < end) { u = await updates(); if (!["idle", "checking"].includes(u.status)) return u; await sleep(250); }
  return u;
};
const click = (selectorOrText) => evaluate(`(() => {
  const want = ${JSON.stringify(selectorOrText)};
  const el = [...document.querySelectorAll("button, a")].find((b) => b.matches(want) || b.textContent.trim().startsWith(want));
  if (!el) return false; el.click(); return true;
})()`);
const text = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.innerText).join("\\n---\\n")`);
const waitFor = async (expression, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evaluate(expression)) return true; await sleep(250); }
  return false;
};
const report = {};

// 1. Phone-only nightly published since this copy: no notification.
await waitFor(`document.readyState === "complete" && !!document.querySelector("#root *")`);
await caption("Installed: this PR's build. Newest release on the (local test) feed: a phone-only nightly.");
report.startupState = await settled(); // The startup check runs 3 s after opening.
if (report.startupState.status === "unsupported") throw new Error("This build doesn't check for updates.");
await record(2500);
report.bannerAfterStartup = await evaluate(`!!document.querySelector(".update-banner")`);
await shot("1-phone-only-no-banner");

// Settings → the update row, checking again by hand.
await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }))`);
await waitFor(`!!document.querySelector('select[aria-label="Update channel"]')`, 8000);
await caption("Settings → Check for updates. The phone-only nightly isn't offered: \"You're up to date.\"");
await record(1200);
report.checkClicked1 = await click("Check for updates");
await record(800);
report.stateAfterCheck1 = await settled();
await record(2500);
report.settingsRow1 = await evaluate(`[...document.querySelectorAll('.row, [class*="row"]')].map((r) => r.innerText).find((t) => /^Slopify \\d/.test(t.trim())) ?? null`);
await shot("2-phone-only-settings-up-to-date");

// 2. A nightly that changes the Windows app: offered.
await scenario("desktop");
await caption("A nightly that changes the Windows app is published. Check for updates again…");
await record(1500);
report.checkClicked2 = await click("Check for updates");
await record(800);
report.stateAfterCheck2 = await settled();
await waitFor(`!!document.querySelector(".update-banner")`, 15_000);
await record(2500);
report.settingsRow2 = await evaluate(`[...document.querySelectorAll('.row, [class*="row"]')].map((r) => r.innerText).find((t) => /^Slopify \\d/.test(t.trim())) ?? null`);
await shot("3-desktop-settings-offered");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(600);
await caption("…and the update notification appears (top right).");
await record(3000);
report.banner = await text(".update-banner");
await shot("4-desktop-banner");

// What's new: the passed-over phone build isn't listed.
await waitFor(`[...document.querySelectorAll(".update-banner button")].some((b) => b.textContent.includes("What"))`, 15_000);
report.stateWithChangelog = await updates();
report.whatsNewClicked = await click("What’s new");
await sleep(1200);
await caption("What's new lists the Windows build's changes; the phone-only build in between is left out.");
await record(3500);
report.whatsNew = await text('[role="dialog"]');
await shot("5-desktop-whats-new");

fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
ws.close();
console.log(JSON.stringify(report, null, 2));
