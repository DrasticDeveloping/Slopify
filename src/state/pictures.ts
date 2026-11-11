/*
 * Artist pictures kept on this device. A library artist's picture is a link to
 * an image online; its file is also kept here, in the browser's Cache Storage
 * (keyed by that link), so the sidebar shows it straight away, offline too and
 * without the server. Pictures show from an object URL once loaded.
 */
import { useEffect, useSyncExternalStore } from "react";

const CACHE = "slopify-artist-pictures-v1";
/** Picture link → object URL of its kept file. */
const kept = new Map<string, string>();
/** Links this device has looked for and doesn't have yet (shown from online while they download). */
const missing = new Set<string>();
/** Links that couldn't be downloaded this session; they're tried again after a restart. */
const failed = new Set<string>();
const loading = new Map<string, Promise<string | undefined>>();
// Back online: the ones that failed are tried again (shown from online meanwhile).
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    const retry = [...failed];
    failed.clear();
    for (const url of retry) {
      missing.add(url);
      void keepPicture(url);
    }
  });
}
const listeners = new Set<() => void>();

const canKeep = () => typeof caches !== "undefined";
/** A link as the cache spells it. */
function href(url: string) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

async function imageOf(res: Response) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("Not a picture.");
  return blob;
}

/** The picture's file: straight from its host when it allows that, else through the music server. */
async function download(url: string) {
  try {
    return await imageOf(await fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(20_000) }));
  } catch {
    return imageOf(await fetch(`/api/catalog/picture?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(25_000) }));
  }
}

function settle(url: string, blob?: Blob) {
  missing.delete(url);
  if (blob) kept.set(url, URL.createObjectURL(blob));
  listeners.forEach((l) => l());
}

/** Loads the picture's kept file, downloading and keeping it first if this device doesn't have it. */
export function keepPicture(url: string): Promise<string | undefined> {
  const have = kept.get(url);
  if (have) return Promise.resolve(have);
  if (!canKeep() || failed.has(url)) return Promise.resolve(undefined);
  let task = loading.get(url);
  if (task) return task;
  task = (async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      settle(url, await hit.blob());
      return kept.get(url);
    }
    // Until it's downloaded, the picture shows from online.
    missing.add(url);
    listeners.forEach((l) => l());
    const blob = await download(url);
    await cache.put(url, new Response(blob, { headers: { "Content-Type": blob.type, "Content-Length": String(blob.size) } })).catch(() => {});
    settle(url, blob);
    return kept.get(url);
  })()
    .catch(() => {
      failed.add(url);
      settle(url);
      return undefined;
    })
    .finally(() => loading.delete(url));
  loading.set(url, task);
  return task;
}

/**
 * The URL to show an artist picture from: its kept file, or the link itself while
 * it downloads (or when it can't be kept). Nothing while the device is being
 * checked, which takes a moment, so a kept picture doesn't load from online first.
 */
export function useKeptPicture(url: string | undefined) {
  // A store subscription, so a picture that finishes loading between render and effect still shows.
  const shown = useSyncExternalStore(subscribe, () => showFrom(url));
  useEffect(() => {
    if (url && !kept.has(url)) void keepPicture(url);
  }, [url]);
  return shown;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function showFrom(url: string | undefined) {
  if (!url) return undefined;
  const have = kept.get(url);
  if (have) return have;
  return !canKeep() || missing.has(url) || failed.has(url) ? url : undefined;
}

/** Drops kept pictures no library artist uses any more. */
export async function prunePictures(inUse: Iterable<string>) {
  if (!canKeep()) return;
  const keep = new Set([...inUse].map(href));
  try {
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) {
      if (keep.has(req.url) || loading.has(req.url)) continue;
      await cache.delete(req);
      // Kept under the artist's own spelling of the link.
      for (const [url, objectUrl] of kept) {
        if (href(url) !== req.url) continue;
        kept.delete(url);
        URL.revokeObjectURL(objectUrl);
      }
    }
  } catch {
    // Storage is unavailable: nothing to tidy.
  }
}
