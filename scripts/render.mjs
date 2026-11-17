// Renders captured transcripts into terminal-style PNGs with headless Edge (CDP).
import { readFileSync, writeFileSync } from "node:fs";
const [dir, cdpPort] = process.argv.slice(2);
const out = `${dir}/out`;
const read = (f) => readFileSync(`${out}/${f}`, "utf8").replace(/^﻿/, "").trimEnd();
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colour(text) {
  return esc(text).split("\n").map((l) => {
    let c = "";
    if (/^=+ /.test(l)) c = "h";
    else if (/^&gt; /.test(l) || /^\$ /.test(l)) c = "req";
    else if (/^&lt; (426|4\d\d)/.test(l) || /\[HTTP 4\d\d\]/.test(l) || /Failed to fetch/.test(l)) c = "bad";
    else if (/^&lt; (2\d\d|101)/.test(l) || /→ (2\d\d|101)/.test(l) || /HTTP 200|^socket: open|204 No Content|\[HTTP 200\]/.test(l)) c = "good";
    else if (/^\{/.test(l)) c = "log";
    let html = l.replace(/(X-Slopify-Features[^,\n]*|features=proof-probe|&quot;behaviour&quot;:&quot;new&quot;|behaviour&quot;:&quot;new|"behaviour":"new")/g, '<mark>$1</mark>');
    html = html.replace(/(&quot;client&quot;:(?:null|\d))/g, '<u>$1</u>');
    return `<div class="${c}">${html || "&nbsp;"}</div>`;
  }).join("");
}
function page(title, columns) {
  const cols = columns.map(([head, body]) => `<section><h2>${esc(head)}</h2><pre>${colour(body)}</pre></section>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0d1117;color:#c9d1d9;font:13px/1.45 Consolas,"Cascadia Mono",monospace;padding:18px}
  h1{font:600 17px Segoe UI,sans-serif;color:#f0f6fc;margin:0 0 14px}
  .wrap{display:flex;gap:16px;align-items:flex-start}
  section{flex:1;min-width:0;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 12px}
  h2{font:600 13px Segoe UI,sans-serif;color:#8b949e;margin:0 0 8px}
  pre{margin:0;white-space:pre-wrap;word-break:break-word;font:inherit}
  .h{color:#d2a8ff;font-weight:bold}.req{color:#79c0ff}.good{color:#7ee787}.bad{color:#ffa198}.log{color:#e3b341}
  mark{background:#3b2e00;color:#ffd866;border-radius:3px;padding:0 2px}u{text-decoration-color:#7ee787;text-underline-offset:3px}
  </style><body><h1>${esc(title)}</h1><div class="wrap">${cols}</div></body>`;
}

const req = read("requests.txt");
const [, base, pr] = req.split(/^(?==+ )/m).map((s) => s.trim()).length >= 3 ? [null, ...req.split(/^(?==+ )/m).map((s) => s.trim())] : [];
const parts = req.split(/^(?==+ )/m).map((s) => s.trim()).filter(Boolean);
const app = read("app.txt").split(/^(?==+ )/m).map((s) => s.trim()).filter(Boolean);

const pages = {
  "1-worker-master-vs-pr.png": page("Local Worker: master (before) vs this PR (after): same calls, and the Worker's log line for each", [
    ["master 006f28c", parts[0] + "\n\nWorker log (wrangler dev):\n" + read("log-requests-base.txt")],
    ["this PR a9b7e97", parts[1] + "\n\nWorker log (wrangler dev):\n" + read("log-requests-pr.txt")],
  ]),
  "2-named-behaviour-probe.png": page("A named behaviour, checked with callerHas(): this PR's Worker plus a temporary 'proof-probe' check (harness only, not in the PR)", [
    ["requests", parts[2]],
    ["Worker log (wrangler dev)", read("log-requests-probe.txt") + "\n\nThe 426 line also says behaviour new: the harness's log field\nchecks the name on every call, but the gate answered 426 first."],
    ["harness patch (not in the PR)", read("probe-harness.diff")],
  ]),
  "3-real-app-old-vs-new-build.png": page("The real app in a browser, through the music server's /api/cloud proxy: an old build vs a build naming 'proof-probe'", [
    ["old build (CLOUD_FEATURES = [])", app[0] + "\n\nWorker log (wrangler dev):\n" + read("log-app-old.txt")],
    ["new build (CLOUD_FEATURES = [\"proof-probe\"], harness only)", app[1] + "\n\nWorker log (wrangler dev):\n" + read("log-app-new.txt") + "\n\nharness patch (not in the PR):\n" + read("app-new-harness.diff")],
  ]),
  "4-cloudflare-preview.png": page("This PR's Cloudflare preview Worker (deployed by the Cloud preview check)", [["curl", read("preview.txt")]]),
};

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const t = targets.find((x) => x.type === "page" && !x.url.startsWith("edge://"));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send("Page.enable");
for (const [name, html] of Object.entries(pages)) {
  const file = `${out}/${name.replace(".png", ".html")}`;
  writeFileSync(file, html);
  const width = name.startsWith("4") ? 1100 : name.startsWith("2") ? 1700 : 1500;
  await send("Emulation.setDeviceMetricsOverride", { width, height: 600, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: "file:///" + file.replace(/\\/g, "/") });
  await new Promise((r) => setTimeout(r, 800));
  const h = (await send("Runtime.evaluate", { expression: "document.documentElement.scrollHeight", returnByValue: true })).result.result.value;
  await send("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 300));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}/${name}`, Buffer.from(shot.result.data, "base64"));
  console.log(name, width, "x", h);
}
ws.close();
