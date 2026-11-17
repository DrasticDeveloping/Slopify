/*
 * Song files kept on this device. The music server stores songs as links;
 * every saved song also has its audio here, in native files or Cache Storage, so
 * it plays without fetching it from its source again (and without the server).
 * Playback uses an object URL for each kept file.
 */

import { isNativeApp } from "../lib/native";

const CACHE = "slopify-device-songs-v1";
const urls = new Map<string, string>();

const cacheKey = (trackId: string) => new URL(`/__device-songs/${encodeURIComponent(trackId)}`, location.origin).href;
const openCache = () => ("caches" in window ? caches.open(CACHE) : Promise.reject(new Error("This browser can't keep songs on the device.")));
const nativeFile = (id: string) => `/api/device-files/${encodeURIComponent(id)}`;

async function keepNativeFile(id: string, bytes: ArrayBuffer, type: string) {
  const response = await fetch(nativeFile(id), { method: "PUT", headers: { "Content-Type": type }, body: bytes, signal: AbortSignal.timeout(60000) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok || result.size !== bytes.byteLength) throw new Error("Couldn't save the iPhone's song file.");
  // Verify the persisted bytes before using the new path or retiring the web backup.
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((v) => v.toString(16).padStart(2, "0")).join("");
  if (result.sha256 !== hash) throw new Error("The iPhone's saved song didn't match its original.");
}

/** The kept file's URL for playback, once it has been restored or saved this session. */
export const deviceUrl = (trackId: string) => urls.get(trackId);

function remember(trackId: string, blob: Blob) {
  const old = urls.get(trackId);
  if (old) URL.revokeObjectURL(old);
  urls.set(trackId, URL.createObjectURL(blob));
}

/** Rebuild a failed Cache Storage blob from bytes without deleting the saved song.
 * A fresh in-memory Blob avoids retaining WebKit's cache-backed blob handle.
 */
export async function rebuildDeviceUrl(trackId: string, shouldApply: () => boolean) {
  const response = await (await openCache()).match(cacheKey(trackId));
  if (!response) return false;
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || !shouldApply()) return false;
  if (isNativeApp) {
    await keepNativeFile(trackId, bytes, response.headers.get("Content-Type") || "application/octet-stream");
    if (!shouldApply()) return false;
    urls.set(trackId, nativeFile(trackId));
    try { await (await openCache()).delete(cacheKey(trackId)); } catch { /* Retry retirement when restored. */ }
    return true;
  }
  remember(trackId, new Blob([bytes], { type: response.headers.get("Content-Type") || "application/octet-stream" }));
  return true;
}

/** Keeps a song's verified file on this device. */
export async function keepOnDevice(trackId: string, blob: Blob) {
  const response = () => new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream", "Content-Length": String(blob.size) } });
  if (isNativeApp) {
    await keepNativeFile(trackId, await blob.arrayBuffer(), blob.type || "application/octet-stream");
    urls.set(trackId, nativeFile(trackId));
    // One verified durable copy is enough. Keeping both doubled song storage on iPhone.
    try { await (await openCache()).delete(cacheKey(trackId)); } catch { /* Retry retirement when restored. */ }
    return;
  }
  await (await openCache()).put(cacheKey(trackId), response());
  remember(trackId, blob);
}

export async function dropFromDevice(trackId: string) {
  if (isNativeApp) {
    const response = await fetch(nativeFile(trackId), { method: "DELETE", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Couldn't remove the iPhone's saved song.");
  }
  const url = urls.get(trackId);
  urls.delete(trackId);
  if (url) URL.revokeObjectURL(url);
  if ("caches" in window) {
    // A failed cache deletion must remain queued too, even if the native copy is already gone.
    await (await openCache()).delete(cacheKey(trackId));
  }
}

/** Separates restored files from confirmed missing ones; transient failures remain unknown. */
export async function restoreDeviceFiles(trackIds: string[]) {
  const kept = new Set<string>();
  const missing = new Set<string>();
  let cache: Cache | undefined;
  try {
    cache = await openCache();
  } catch {
    if (!isNativeApp) return { kept, missing };
  }
  let next = 0;
  // Migrate only two files at a time; don't materialize an entire library in RAM.
  const worker = async () => {
    while (next < trackIds.length) {
      const id = trackIds[next++];
      try {
        if (isNativeApp) {
          const existing = await fetch(nativeFile(id), { method: "HEAD", signal: AbortSignal.timeout(15000) });
          if (existing.ok) {
            urls.set(id, nativeFile(id));
            kept.add(id);
            // Older app versions kept a WebKit backup. Check the native bytes before retiring it.
            try {
              if (await cache?.match(cacheKey(id))) {
                const native = await fetch(nativeFile(id), { signal: AbortSignal.timeout(60000) });
                const expected = existing.headers.get("X-Content-SHA256");
                if (native.ok && expected) {
                  const bytes = await native.arrayBuffer();
                  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((v) => v.toString(16).padStart(2, "0")).join("");
                  if (hash === expected) await cache?.delete(cacheKey(id));
                }
              }
            } catch { /* A backup stays until the native file can be verified. */ }
            continue;
          }
          if (existing.status !== 404) throw new Error("Device file check failed.");
        }
        // An unavailable cache is not evidence that a kept file was deleted.
        if (!cache) continue;
        const res = await cache.match(cacheKey(id));
        if (!res) {
          missing.add(id);
          continue;
        }
        if (isNativeApp) {
          await keepNativeFile(id, await res.arrayBuffer(), res.headers.get("Content-Type") || "application/octet-stream");
          urls.set(id, nativeFile(id));
          try { await cache.delete(cacheKey(id)); } catch { /* The verified native copy remains usable. */ }
        } else remember(id, await res.blob());
        kept.add(id);
      } catch {
        // Keep the backup untouched; an error is not evidence that it was deleted.
        try {
          const backup = await cache?.match(cacheKey(id));
          if (backup) { remember(id, await backup.blob()); kept.add(id); }
        } catch { /* Preserve the download status until its files can be checked. */ }
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return { kept, missing };
}
