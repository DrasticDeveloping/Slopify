#!/usr/bin/env node
/*
 * `node scripts/isolated.mjs <npm script>`: runs that script with this checkout's own
 * library and desktop profile (data/), not the one all checkouts share. See server/data-dir.cjs.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = process.argv[2];
if (!script) {
  console.error("Usage: node scripts/isolated.mjs <npm script>");
  process.exit(1);
}
console.log("Isolated mode: using this checkout's own data/ folder.");
const options = { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit", env: { ...process.env, SLOPIFY_ISOLATED_DATA: "1" } };
// npm.cmd is a batch file, which Windows only runs through a shell (given as one command line).
const result = process.platform === "win32"
  ? spawnSync(`npm.cmd run ${script}`, { ...options, shell: true })
  : spawnSync("npm", ["run", script], options);
process.exit(result.status ?? 1);
