// Drives the real app (two dev builds) in headless Edge over CDP and records what it sends to the online service.
// Tokens are signed with this run's throwaway key and are redacted from everything written.
import { createSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [dir, cdpPort] = process.argv.slice(2);
const key = readFileSync(`${dir}/key.pem`, "utf8");
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
function token(sub) {
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({ sub, sid: "proof-session", iss: "https://clerk.slopify.unblocked.mov", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url")}`;
}
const redact = (s) => String(s).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<test token>").replace(/\/rooms\/[A-Z0-9]{4,}/gi, "/rooms/<code>");

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = targets.find((t) => t.type === "page" && !t.url.startsWith("edge://"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else events.push(msg);
};
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Network.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

const lines = [];
const out = (s = "") => { lines.push(s); console.log(s); };
const BUILDS = [
  { name: "old build", port: 5197, sub: "proof_user_old", note: "this PR's app as it is: CLOUD_FEATURES = [] (sends what every build sends today)" },
  { name: "new build", port: 5199, sub: "proof_user_new", note: "this PR's app with CLOUD_FEATURES = [\"proof-probe\"] (harness only)" },
];

for (const build of BUILDS) {
  const origin = `http://127.0.0.1:${build.port}`;
  await send("Page.navigate", { url: origin + "/" });
  await sleep(2500);
  await evaluate(`localStorage.setItem("slopify.dev.cloud-token", ${JSON.stringify(token(build.sub))}); true`);
  events.length = 0;
  await send("Page.reload", { ignoreCache: true });
  await sleep(9000);

  // Listen Along through the app's own code: name the account, start a room, open its socket.
  const room = await evaluate(`(async () => {
    const m = await import("/src/state/cloud.ts");
    await m.cloudCall("/v1/me", { method: "PUT", body: { displayName: "Proof Tester" } });
    const { code } = await m.cloudCall("/v1/rooms", { method: "POST", body: {} });
    const url = await m.roomSocketUrl(code);
    const opened = await new Promise((r) => { const s = new WebSocket(url); s.onopen = () => { setTimeout(() => s.close(), 300); r("open"); }; s.onerror = () => r("error"); setTimeout(() => r("timeout"), 5000); });
    return { url, opened };
  })().catch((e) => ({ error: String(e) }))`);
  await sleep(1500);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${dir}/out/app-${build.name.replace(" ", "-")}.png`, Buffer.from(shot.result.data, "base64"));

  out(`=============== ${build.name}: ${build.note} ===============`);
  out(`app at ${origin}, signed in with a test token, online service = local Worker http://127.0.0.1:8793 (this PR + proof-probe check)`);
  out();
  const seen = new Map();
  for (const e of events) {
    if (e.method === "Network.requestWillBeSent" && /\/api\/cloud\/|127\.0\.0\.1:879\d/.test(e.params.request.url)) seen.set(e.params.requestId, { method: e.params.request.method, url: e.params.request.url, headers: e.params.request.headers });
    if (e.method === "Network.webSocketCreated" && /879\d/.test(e.params.url)) seen.set(e.params.requestId, { method: "WebSocket", url: e.params.url, headers: {} });
    if (e.method === "Network.responseReceived" && seen.has(e.params.requestId)) seen.get(e.params.requestId).status = e.params.response.status;
    if (e.method === "Network.webSocketHandshakeResponseReceived" && seen.has(e.params.requestId)) seen.get(e.params.requestId).status = e.params.response.status;
  }
  for (const r of seen.values()) {
    const u = new URL(r.url);
    out(`> ${r.method} ${redact(u.pathname + u.search)}  → ${r.status ?? "?"}`);
    for (const [k, v] of Object.entries(r.headers)) if (/^x-slopify|^authorization$/i.test(k)) out(`>   ${k}: ${k.toLowerCase() === "authorization" ? "Bearer <test token>" : v}`);
  }
  out();
  out(`roomSocketUrl() built by the app: ${redact(room?.url ?? JSON.stringify(room))}`);
  out(`socket: ${room?.opened ?? room?.error}`);
  out();

  // CORS, straight from this page to the master Worker and to this PR's Worker, with the new header.
  const cors = await evaluate(`(async () => {
    const t = localStorage.getItem("slopify.dev.cloud-token");
    const r = {};
    for (const [name, base] of [["master Worker (8791)", "http://127.0.0.1:8791"], ["this PR's Worker (8792)", "http://127.0.0.1:8792"]]) {
      try { const res = await fetch(base + "/v1/me", { headers: { Authorization: "Bearer " + t, "X-Slopify-Client": "2", "X-Slopify-Features": "proof-probe" } }); r[name] = "HTTP " + res.status; }
      catch (e) { r[name] = e.name + ": " + e.message; }
    }
    return r;
  })()`);
  out(`Direct fetch from this page with X-Slopify-Features (the browser's CORS check):`);
  for (const [k, v] of Object.entries(cors ?? {})) out(`  ${k}: ${v}`);
  out();
}
writeFileSync(`${dir}/out/app.txt`, lines.join("\n") + "\n");
ws.close();
