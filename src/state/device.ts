/*
 * Song files kept on this device. The music server stores songs as links;
 * every saved song also has its audio here, in the browser's Cache Storage, so
 * it plays without fetching it from its source again (and without the server).
 * Playback uses an object URL for each kept file.
 */

const CACHE = "slopify-device-songs-v1";
const urls = new Map<string, string>();

const cacheKey = (trackId: string) => new URL(`/__device-songs/${encodeURIComponent(trackId)}`, location.origin).href;
const openCache = () => ("caches" in window ? caches.open(CACHE) : Promise.reject(new Error("This browser can't keep songs on the device.")));

/** The kept file's URL for playback, once it has been restored or saved this session. */
export const deviceUrl = (trackId: string) => urls.get(trackId);

function remember(trackId: string, blob: Blob) {
  const old = urls.get(trackId);
  if (old) URL.revokeObjectURL(old);
  urls.set(trackId, URL.createObjectURL(blob));
}

/** Keeps a song's verified file on this device. */
export async function keepOnDevice(trackId: string, blob: Blob) {
  const cache = await openCache();
  await cache.put(cacheKey(trackId), new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream", "Content-Length": String(blob.size) } }));
  remember(trackId, blob);
}

export async function dropFromDevice(trackId: string) {
  const url = urls.get(trackId);
  urls.delete(trackId);
  if (url) URL.revokeObjectURL(url);
  try {
    await (await openCache()).delete(cacheKey(trackId));
  } catch {
    // Nothing kept.
  }
}

/** Loads the kept files for these songs and returns the ones this device actually has. */
export async function restoreDeviceFiles(trackIds: string[]) {
  const kept = new Set<string>();
  let cache: Cache;
  try {
    cache = await openCache();
  } catch {
    return kept;
  }
  await Promise.all(trackIds.map(async (id) => {
    const res = await cache.match(cacheKey(id));
    if (!res) return;
    remember(id, await res.blob());
    kept.add(id);
  }));
  return kept;
}
