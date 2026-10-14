#!/usr/bin/env node
/*
 * Runs before `npm run build` and `npm run dev` (and so before `npm run desktop`,
 * `node server/main.mjs` and the packaging scripts): a fresh checkout or worktree
 * gets its dependencies installed, and they are reinstalled when package-lock.json
 * changes, instead of the build failing with "'tsc' is not recognized".
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const modules = path.join(appDir, "node_modules");
const mtime = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

// node_modules linked from another checkout belongs to that checkout: `npm ci` here would wipe it.
let linked = false;
try {
  linked = fs.lstatSync(modules).isSymbolicLink();
} catch { /* Not there yet. */ }

// npm writes node_modules/.package-lock.json after every install.
const installed = mtime(path.join(modules, ".package-lock.json"));
const lock = mtime(path.join(appDir, "package-lock.json"));
if (!linked && (!installed || installed < lock)) {
  console.log(installed ? "package-lock.json has changed: reinstalling dependencies…" : "Installing dependencies (first run in this folder)…");
  // npm.cmd is a batch file, which Windows only runs through a shell (given as one command line).
  const result = process.platform === "win32"
    ? spawnSync("npm.cmd ci --no-audit --no-fund", { cwd: appDir, stdio: "inherit", shell: true })
    : spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: appDir, stdio: "inherit" });
  if (result.status !== 0) {
    console.error("Installing dependencies failed (see above). Run `npm ci` to try again.");
    process.exit(result.status || 1);
  }
}
