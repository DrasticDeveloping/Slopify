#!/usr/bin/env node
/*
 * `npm run db:backup`: saves the live database (every account's profile and
 * library) as SQL in backups/, named by date. D1 also keeps its own recovery
 * points (Time Travel: 7 days on the Free plan, 30 on Paid); this is a copy
 * kept for longer, off Cloudflare. Backups hold personal data: keep them private.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("backups", { recursive: true });
const file = `backups/slopify-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
// npx.cmd is a batch file, which Windows only runs through a shell.
const result = spawnSync(npx, ["wrangler", "d1", "export", "slopify", "--remote", "--output", file], { stdio: "inherit", shell: process.platform === "win32" });
if (result.status === 0) console.log(`Saved ${file}`);
process.exit(result.status ?? 1);
