// Proof transcript: real HTTP/WebSocket calls to three local Worker copies.
// Tokens are signed with a throwaway key made for this run and are never printed.
import { createSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const dir = process.argv[2];
const key = readFileSync(`${dir}/key.pem`, "utf8");
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function token(sub) {
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({ sub, sid: "proof-session", iss: "https://clerk.slopify.unblocked.mov", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const TOKEN = token("proof_user_1");

const lines = [];
const out = (s = "") => { lines.push(s); console.log(s); };
const SERVERS = { base: "http://127.0.0.1:8791", pr: "http://127.0.0.1:8792", probe: "http://127.0.0.1:8793" };
const NAMES = { base: "master (006f28c), before this PR", pr: "this PR (a9b7e97)", probe: "this PR + temporary proof-probe check (harness only)" };

async function call(server, label, path, { method = "GET", headers = {} } = {}) {
  const shown = Object.entries(headers).map(([k, v]) => `${k}: ${k === "Authorization" ? "Bearer <test token>" : v}`);
  const res = await fetch(SERVERS[server] + path, { method, headers });
  const text = await res.text();
  out(`> ${method} ${path}   (${label})`);
  for (const h of shown) out(`>   ${h}`);
  out(`< ${res.status}`);
  if (method === "OPTIONS") out(`<   Access-Control-Allow-Headers: ${res.headers.get("access-control-allow-headers")}`);
  else if (text) {
    let body = text;
    try {
      const j = JSON.parse(text);
      if (j?.result && path === "/v1/me") j.result = { userId: j.result.userId, "…": "(profile fields omitted)" };
      body = JSON.stringify(j);
    } catch {}
    out(`<   ${body.length > 200 ? body.slice(0, 200) + "…" : body}`);
  }
  out();
  return res;
}

const oldBuild = { Authorization: `Bearer ${TOKEN}`, "X-Slopify-Client": "2" };
const newBuild = { ...oldBuild, "X-Slopify-Features": "proof-probe" };
const preflight = { Origin: "http://localhost:5197", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,x-slopify-client,x-slopify-features" };

for (const server of ["base", "pr"]) {
  out(`=============== ${NAMES[server]} — ${SERVERS[server]} ===============`);
  out();
  await call(server, "browser preflight from a build that sends X-Slopify-Features", "/v1/me", { method: "OPTIONS", headers: preflight });
  await call(server, "a build from before X-Slopify-Client: no client number", "/v1/me");
  await call(server, "client 1", "/v1/me", { headers: { Authorization: `Bearer ${TOKEN}`, "X-Slopify-Client": "1" } });
  await call(server, "today's builds: client 2, no names", "/v1/me", { headers: oldBuild });
  await call(server, "a build naming proof-probe", "/v1/me", { headers: newBuild });
}

out(`=============== ${NAMES.probe} — ${SERVERS.probe} ===============`);
out();
await call("probe", "no names", "/v1/health");
await call("probe", "naming proof-probe", "/v1/health", { headers: { "X-Slopify-Features": "proof-probe" } });
await call("probe", "naming other things too", "/v1/health", { headers: { "X-Slopify-Features": "something-else, proof-probe" } });
await call("probe", "a different name only", "/v1/health", { headers: { "X-Slopify-Features": "proof-probe-2" } });
await call("probe", "old build, signed in", "/v1/me", { headers: oldBuild });
await call("probe", "new build, signed in", "/v1/me", { headers: newBuild });
await call("probe", "old client 1 naming proof-probe: the 426 gate still comes first", "/v1/me", { headers: { ...newBuild, "X-Slopify-Client": "1" } });

await fetch(SERVERS.probe + "/v1/me", { method: "PUT", headers: { ...oldBuild, "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "Proof Tester" }) });
out("> PUT /v1/me   (give the test account a display name, so it can start a room)");
out();
// Listen Along: features ride on the WebSocket's query, as roomSocketUrl builds it.
const room = await (await fetch(SERVERS.probe + "/v1/rooms", { method: "POST", headers: { ...oldBuild, "Content-Type": "application/json" }, body: "{}" })).json();
out(`> POST /v1/rooms   (start a Listen Along room) → ${room.ok ? "room started" : JSON.stringify(room)}`);
out();
const code = room.result?.code;
for (const [label, features] of [["old build", null], ["new build", "proof-probe"]]) {
  const url = new URL(`${SERVERS.probe.replace("http", "ws")}/v1/rooms/${code}/socket`);
  url.searchParams.set("token", TOKEN);
  url.searchParams.set("client", "2");
  if (features) url.searchParams.set("features", features);
  const shown = `/v1/rooms/<code>/socket?token=<test token>&client=2${features ? `&features=${features}` : ""}`;
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (r) => { try { ws.close(); } catch {} resolve(r); };
    ws.onopen = () => setTimeout(() => done("open"), 300);
    ws.onerror = () => done("error");
    setTimeout(() => done("timeout"), 5000);
  });
  out(`> WebSocket ${shown}   (${label})`);
  out(`< ${result}`);
  out();
}
writeFileSync(`${dir}/out/requests.txt`, lines.join("\n") + "\n");
