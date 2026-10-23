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
 *   --keep-running, SLOPIFY_KEEP_RUNNING=1
 *                            keep running after the last Slopify window on this computer closes
 *                            (it stops then by default, unless it's shared on your network)
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createImportApi } from "./api.mjs";
import { LibraryInUseError, lockLibrary } from "./library-lock.mjs";
import dataDirs from "./data-dir.cjs";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(appDir, "dist");

let flags;
try {
  ({ values: flags } = parseArgs({ options: { open: { type: "boolean" }, isolated: { type: "boolean" }, port: { type: "string" }, host: { type: "string" }, data: { type: "string" }, "keep-running": { type: "boolean" } } }));
} catch (error) {
  fail(`${error.message.replace(/\.?$/, ".")} The options are --open, --isolated, --port, --host, --data and --keep-running.`);
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
    // No plugins, no <base> pointing scripts elsewhere, and no other site framing Slopify.
    // (Scripts aren't narrowed further: sign-in loads Clerk's from its own address.)
    ...(file.endsWith(".html") ? { "Content-Security-Policy": "object-src 'none'; base-uri 'self'; frame-ancestors 'none'" } : {}),
  });
  if (req.method === "HEAD") return void res.end();
  await pipeline(createReadStream(file), res).catch(() => undefined);
}

// The iPhone app is the only Slopify on its library, and iOS doesn't let it check
// whether the process that left a lock is gone, so it doesn't lock it.
let owned = () => true;
if (process.platform !== "ios") {
  try {
    owned = lockLibrary(dataDir, { port });
  } catch (error) {
    if (error instanceof LibraryInUseError) fail(error.message);
    throw error;
  }
}
/*
 * Run for this computer only, the server stops once the last Slopify window
 * closes, so it doesn't keep the library from the desktop app or another
 * checkout. Not when it's shared on the network (phones use it), when the
 * desktop app runs it (the app stops it), or with --keep-running.
 */
const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
const stopsWhenClosed = loopback && process.platform !== "ios" && !process.env.SLOPIFY_DESKTOP_BACKEND
  && !flags["keep-running"] && process.env.SLOPIFY_KEEP_RUNNING !== "1";
/*
 * Each open page holds a WebSocket to /api/presence. The browser closes it
 * whenever the page goes, however it goes (closed, crashed, or an embedded
 * browser that never says it's closing), so the server knows straight away.
 * WebSockets don't count against the browser's few connections per server, so
 * tabs never hold up the app's requests. The server sends nothing on them.
 */
/** A reload, or a window opened again soon, doesn't stop it. */
const CLOSED_FOR = 20_000;
const pages = new Set();
let stopTimer;
function pageOpened(socket) {
  pages.add(socket);
  clearTimeout(stopTimer);
  stopTimer = undefined;
}
function pageClosed(socket) {
  if (!pages.delete(socket) || pages.size || stopTimer) return;
  stopTimer = setTimeout(() => {
    stopTimer = undefined;
    if (pages.size) return;
    console.log("Every Slopify window is closed, so Slopify is stopping. (To keep it running, start it with --keep-running.)");
    process.emit("SIGTERM");
  }, CLOSED_FOR);
}
/** Accepts a page's WebSocket (only from this server's own pages), and notices when it closes. */
function acceptPresence(req, socket) {
  const key = req.headers["sec-websocket-key"];
  let sameSite = false;
  try {
    sameSite = new URL(req.headers.origin).host === req.headers.host;
  } catch {
    // No origin, or not a URL: not one of Slopify's pages.
  }
  if (!stopsWhenClosed || typeof key !== "string" || !sameSite) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  pageOpened(socket);
  // The page never sends anything but a close frame (opcode 8), answered by closing.
  socket.on("data", (frame) => (frame[0] & 0x0f) === 8 && socket.end(Buffer.from([0x88, 0x00])));
  socket.on("error", () => socket.destroy());
  socket.on("close", () => pageClosed(socket));
}
/*
 * Requests must name this server by an address it really has. A website can't
 * otherwise reach it, but one could point its own name at 127.0.0.1 (DNS
 * rebinding) and then read and change the library as if it were Slopify's page.
 * Run for this computer only, that's 127.0.0.1, localhost or ::1. Shared on the
 * network, any IP address or this computer's own name, plus any names listed
 * in SLOPIFY_ALLOWED_HOSTS (comma-separated, for a domain in front of it).
 */
const extraHosts = (process.env.SLOPIFY_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const computerName = os.hostname().toLowerCase();
function knownHost(req) {
  let name;
  try {
    name = new URL(`http://${req.headers.host}`).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return false;
  }
  if (["127.0.0.1", "localhost", "::1"].includes(name) || extraHosts.includes(name)) return true;
  if (loopback) return false;
  return net.isIP(name) !== 0 || name === computerName || name === `${computerName}.local`;
}

// The online service the built app calls through this server (written by vite.config.ts); none in older builds.
const cloudUrl = await fs.readFile(path.join(dist, "cloud.json"), "utf8").then((text) => String(JSON.parse(text).url || ""), () => "");
const api = createImportApi({ dataDir, owned, stopsWhenClosed, cloudUrl });
const server = http.createServer((req, res) => {
  if (!knownHost(req)) return void res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" }).end("Slopify doesn't answer to that address.");
  api(req, res, () => serveApp(req, res)).catch((error) => {
    // The browser left (a reload, or a request it no longer needs): nothing went wrong.
    if (error?.name === "AbortError" || res.destroyed) return void res.end();
    console.error(`[slopify] ${req.method} ${req.url} failed:`, error);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Server error");
    else res.end();
  });
});

server.on("upgrade", (req, socket) => {
  if (!knownHost(req)) return void socket.destroy();
  if (new URL(req.url || "/", "http://localhost").pathname === "/api/presence") acceptPresence(req, socket);
  else socket.destroy();
});
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") fail(`Port ${port} is already in use. Choose another with --port.`);
  if (error.code === "EACCES") fail(`Not allowed to use port ${port}. Choose another with --port.`);
  fail(error.message);
});
server.listen(port, host, () => {
  console.log(`Slopify is running at ${appUrl}`);
  console.log(`Library: ${dataDir}`);
  if (stopsWhenClosed) console.log("It stops when you close the last Slopify window (--keep-running keeps it running).");
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
