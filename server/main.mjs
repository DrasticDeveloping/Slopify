#!/usr/bin/env node
/*
 * Slopify's standalone server: the built web app (dist/) and its backend (the
 * music server API in api.mjs) from one Node process, with no Vite at runtime.
 * The backend does everything that touches this computer (files, downloads,
 * ffmpeg), so the same web app runs unchanged on Windows, macOS and Linux.
 *
 *   npm run build && npm start
 *
 * Options (flag or environment variable):
 *   --open                   open the desktop app instead of the standalone server
 *   --port, PORT              default 5199
 *   --host, HOST              default 127.0.0.1 (this computer only); 0.0.0.0 shares it on your network
 *   --data, SLOPIFY_DATA_DIR  where the library is kept; default: the library all checkouts
 *                            share (see data-dir.cjs), or data/ in an installed app folder
 *   --isolated, SLOPIFY_ISOLATED_DATA=1
 *                            use this checkout's own data/ folder (and desktop profile) instead
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createImportApi } from "./api.mjs";
import dataDirs from "./data-dir.cjs";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(appDir, "dist");

let flags;
try {
  ({ values: flags } = parseArgs({ options: { open: { type: "boolean" }, isolated: { type: "boolean" }, port: { type: "string" }, host: { type: "string" }, data: { type: "string" } } }));
} catch (error) {
  fail(`${error.message.replace(/\.?$/, ".")} The options are --open, --isolated, --port, --host and --data.`);
}
const port = Number(flags.port ?? (flags.open ? process.env.SLOPIFY_DESKTOP_PORT ?? 5197 : process.env.PORT ?? 5199));
const host = flags.host ?? process.env.HOST ?? "127.0.0.1";
if (flags.isolated) process.env.SLOPIFY_ISOLATED_DATA = "1";
const chosenData = flags.data ?? process.env.SLOPIFY_DATA_DIR;
const fromCheckout = (await fs.stat(path.join(appDir, "src")).catch(() => null))?.isDirectory() ?? false;
const dataDir = chosenData ? path.resolve(chosenData) : fromCheckout ? dataDirs.checkoutDataDir(appDir) : path.join(appDir, "data");
const shownHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
const appUrl = `http://${shownHost.includes(":") ? `[${shownHost}]` : shownHost}:${port}`;

if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`"${flags.port ?? (flags.open ? process.env.SLOPIFY_DESKTOP_PORT : process.env.PORT)}" isn't a valid port.`);
await buildIfStale();
try {
  await fs.access(path.join(dist, "index.html"));
} catch {
  fail("The web app hasn't been built yet. Run `npm run build` first.");
}

/**
 * Run from a checkout, the web app is rebuilt first when its source has changed
 * since the last build, so this command always shows the current version. An
 * installed copy (no src/ folder) is used as it is.
 */
async function buildIfStale() {
  const newest = async (target) => {
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return 0;
    }
    if (!stat.isDirectory()) return stat.mtimeMs;
    const entries = await fs.readdir(target, { withFileTypes: true });
    const times = await Promise.all(entries.map((e) => newest(path.join(target, e.name))));
    return Math.max(stat.mtimeMs, ...times);
  };
  if (!(await newest(path.join(appDir, "src")))) return;
  const built = await newest(path.join(dist, "index.html"));
  const sources = Math.max(...(await Promise.all(["src", "public", "index.html", "vite.config.ts", "package.json", "release.config.json"].map((p) => newest(path.join(appDir, p))))));
  if (built && built >= sources) return;
  console.log(built ? "The app has changed since it was last built. Building the latest version…" : "Building the app…");
  const { spawnSync } = await import("node:child_process");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // npm.cmd is a batch file, which Windows only runs through a shell.
  const result = spawnSync(npm, ["run", "build"], { cwd: appDir, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) fail("Building the app failed (see above). Fix the error, or run `npm run build` to see it again.");
}

if (flags.open) {
  const { launchDesktop } = await import("../scripts/run-desktop.mjs");
  const overrides = {};
  if (flags.port !== undefined) overrides.SLOPIFY_DESKTOP_PORT = String(port);
  if (flags.data !== undefined) overrides.SLOPIFY_DATA_DIR = dataDir;
  process.exit(await launchDesktop(overrides));
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

/** The built file for a URL path, or null. Never resolves outside dist/. */
async function builtFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = path.join(dist, path.normalize(decoded));
  if (!file.startsWith(dist + path.sep)) return null;
  try {
    return (await fs.stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Serves the web app. Page routes (/library, /playlist/…) get index.html; the app routes itself. */
async function serveApp(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  const { pathname } = new URL(req.url || "/", "http://localhost");
  let file = await builtFile(pathname === "/" ? "/index.html" : pathname);
  // A missing file that looks like one (it has an extension) is a 404, not the app.
  if (!file && !path.extname(pathname)) file = path.join(dist, "index.html");
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  // Built assets have content hashes in their names, so they never change. Everything else
  // (index.html, the service worker, the manifest) must be checked on every load for updates.
  const immutable = pathname.startsWith("/assets/");
  const { size } = await fs.stat(file);
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Content-Length": size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") return void res.end();
  await pipeline(createReadStream(file), res).catch(() => undefined);
}

const api = createImportApi({ dataDir });
const server = http.createServer((req, res) => {
  api(req, res, () => serveApp(req, res)).catch((error) => {
    // The browser left (a reload, or a request it no longer needs): nothing went wrong.
    if (error?.name === "AbortError" || res.destroyed) return void res.end();
    console.error(`[slopify] ${req.method} ${req.url} failed:`, error);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Server error");
    else res.end();
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") fail(`Port ${port} is already in use. Choose another with --port.`);
  if (error.code === "EACCES") fail(`Not allowed to use port ${port}. Choose another with --port.`);
  fail(error.message);
});
server.listen(port, host, () => {
  console.log(`Slopify is running at ${appUrl}`);
  console.log(`Library: ${dataDir}`);
});

// Finish requests in progress on Ctrl+C or a service manager's stop, then exit.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    // Streams that would hold the server open (a song mid-download) don't block stopping.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

function fail(message) {
  console.error(`Slopify couldn't start: ${message}`);
  process.exit(1);
}
