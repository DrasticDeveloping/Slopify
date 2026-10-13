/*
 * Slopify's offline app shell. scripts/build-pwa.mjs fills in `config` below:
 * this version's cache name and the built files to keep. Music isn't cached
 * here; songs kept on the device have their own cache (src/state/device.ts).
 *
 * A new version installs alongside the old one and waits; it takes over only
 * when the listener chooses to restart (src/state/pwa.ts).
 */

const config = __PWA_CONFIG__;
const assets = new Set(config.assets);
const PREFIX = "slopify-app-";
/** An entry in each version's cache recording whether it finished installing, and when. */
const STATUS = "/__slopify-shell-status";

const statusResponse = (state) => new Response(JSON.stringify({ state, at: Date.now() }));

async function statusOf(cacheName) {
  const entry = await (await caches.open(cacheName)).match(STATUS);
  return entry ? entry.json() : null;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(config.cache);
    await cache.put(STATUS, statusResponse("installing"));
    await cache.addAll(config.assets.map((url) => new Request(url, { cache: "reload" })));
    await cache.put(STATUS, statusResponse("ready"));
    // No skipWaiting: an update waits for the listener to restart.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const own = await statusOf(config.cache);
    // Older versions that finished installing. One still installing (a newer
    // update) is never touched.
    const older = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith(PREFIX) || name === config.cache) continue;
      const status = await statusOf(name);
      if (own && status?.state === "ready" && status.at < own.at) older.push({ name, at: status.at });
    }
    // Keep the newest older version for tabs that haven't restarted yet; delete the rest.
    older.sort((a, b) => b.at - a.at);
    for (const { name } of older.slice(1)) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "APPLY_UPDATE") event.waitUntil(self.skipWaiting());
});

/** A built file from this version's cache, else from a kept older version (for tabs still running it). */
async function cachedAsset(pathname) {
  const own = await (await caches.open(config.cache)).match(pathname);
  if (own) return own;
  for (const name of await caches.keys()) {
    if (!name.startsWith(PREFIX)) continue;
    const match = await (await caches.open(name)).match(pathname);
    if (match) return match;
  }
  return null;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // The library, the API and songs on this device must always be live, never shell data.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/__device-songs/")) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => (await (await caches.open(config.cache)).match("/index.html")) || fetch(request))());
  } else if (assets.has(url.pathname) || url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => (await cachedAsset(url.pathname)) || fetch(request))());
  }
});
