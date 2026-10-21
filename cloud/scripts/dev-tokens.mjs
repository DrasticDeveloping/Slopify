// Test sign-ins for the local service (`npm run dev`), for trying accounts, friends and sharing without Clerk.
//
//   node scripts/dev-tokens.mjs alice bob
//
// The first run makes a signing key (cloud/.dev-key.pem) and puts its public half in
// cloud/.dev.vars as CLERK_JWT_KEY, so the local service accepts tokens signed with
// it; restart `npm run dev` after that. Prints a session token (valid 12 hours) for each
// name, as the user "user_dev_<name>". In the app's Vite dev server, run in the
// browser console:
//
//   localStorage.setItem("slopify.dev.cloud-token", "<token>"); localStorage.setItem("slopify.dev.cloud-name", "<name>"); location.reload();
//
// with SLOPIFY_CLOUD_URL=http://127.0.0.1:8787 set for `npm run dev`. Never used by built apps.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = new URL("..", import.meta.url);
const keyFile = fileURLToPath(new URL(".dev-key.pem", dir));
const varsFile = fileURLToPath(new URL(".dev.vars", dir));
const config = readFileSync(new URL("wrangler.jsonc", dir), "utf8");
const publishable = /"CLERK_PUBLISHABLE_KEY":\s*"(pk_(?:test|live)_[^"]+)"/.exec(config)?.[1];
const issuer = publishable ? `https://${Buffer.from(publishable.replace(/^pk_(test|live)_/, ""), "base64").toString().replace(/\$$/, "")}` : undefined;

if (!existsSync(keyFile)) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
}
const privateKey = createPrivateKey(readFileSync(keyFile));
const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString().trim();
const vars = existsSync(varsFile) ? readFileSync(varsFile, "utf8") : "";
const line = `CLERK_JWT_KEY="${publicPem.replace(/\n/g, "\\n")}"`;
if (!vars.includes(line)) {
  writeFileSync(varsFile, `${vars.split("\n").filter((l) => l && !l.startsWith("CLERK_JWT_KEY=")).join("\n")}${vars.trim() ? "\n" : ""}${line}\n`);
  console.error("Wrote CLERK_JWT_KEY to cloud/.dev.vars. Restart the local service (npm run dev) to use it.");
}

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const names = process.argv.slice(2);
if (!names.length) console.error("Name at least one test user: node scripts/dev-tokens.mjs alice bob");
const now = Math.floor(Date.now() / 1000);
for (const name of names) {
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({ sub: `user_dev_${name}`, iat: now, nbf: now - 5, exp: now + 12 * 3600, ...(issuer ? { iss: issuer } : {}) });
  const signature = sign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
  console.log(`${name}\t${head}.${body}.${signature}`);
}
