import { discoveryQueries, fetchRelated, pickDiscoveries, relatedLinks, type DiscoveredSong, type DiscoveryBatch, type DiscoveryQuery, type Related, type Seed } from "./discover";
import { rememberSongLinks } from "../state/actions";
import { searchDiscovery, type Resolution } from "../state/importer";
import { getState } from "../state/store";

// All discovery surfaces share three provider slots, cached results and in-flight work.
let active = 0;
const waiting: Array<() => void> = [];
const searches = new Map<string, { at: number; value: Resolution }>();
const pending = new Map<string, Promise<Resolution>>();
const graphs = new Map<string, { at: number; value: Related }>();
const pendingGraphs = new Map<string, Promise<Related>>();
const searchTimes: number[] = [];
const input = () => getState();
export type Seeds = { songs: Seed[]; artists: Seed[] };

async function search(text: string) {
  const hit = searches.get(text);
  if (hit && Date.now() - hit.at < (hit.value.candidates.length ? 600_000 : 60_000)) return hit.value;
  const running = pending.get(text);
  if (running) return running;
  const task = (async () => {
    // A shared request outlives any one shelf; StrictMode/navigation cannot cancel another consumer.
    const signal = AbortSignal.timeout(90_000);
    if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      signal.throwIfAborted();
      for (;;) {
        while (searchTimes.length && searchTimes[0] <= Date.now() - 60_000) searchTimes.shift();
        if (searchTimes.length < 48) break;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.max(1, searchTimes[0] + 60_000 - Date.now()));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        signal.throwIfAborted();
      }
      searchTimes.push(Date.now());
      const value = await searchDiscovery(text, AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
      searches.delete(text);
      searches.set(text, { at: Date.now(), value });
      while (searches.size > 160) searches.delete(searches.keys().next().value!);
      return value;
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  })();
  pending.set(text, task);
  try { return await task; } finally { pending.delete(text); }
}

export async function relatedFor(seeds: Seeds, signal: AbortSignal) {
  signal.throwIfAborted();
  const key = JSON.stringify([seeds.songs.map((s) => [s.name, s.title]), seeds.artists.map((s) => [s.name, s.title])]);
  const hit = graphs.get(key);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.value;
  let task = pendingGraphs.get(key);
  if (!task) {
    task = fetchRelated(seeds, AbortSignal.timeout(30_000)).then((value) => {
      graphs.set(key, { at: Date.now(), value });
      while (graphs.size > 40) graphs.delete(graphs.keys().next().value!);
      rememberSongLinks(relatedLinks(value));
      return value;
    }).finally(() => pendingGraphs.delete(key));
    pendingGraphs.set(key, task);
  }
  const value = await task;
  signal.throwIfAborted();
  return value;
}

export interface DiscoverOptions {
  seeds: Seeds;
  signal: AbortSignal;
  refresh?: number;
  exclude?: Set<string>;
  limit?: number;
  budget?: number;
  queries?: DiscoveryQuery[];
  onSongs?: (songs: DiscoveredSong[]) => void;
}
export async function discover({ seeds, signal, refresh = 0, exclude = new Set(), limit = 30, budget = 48, queries: supplied, onSongs }: DiscoverOptions) {
  let graph: Related | null = null;
  let note = "";
  if (!supplied && (seeds.songs.length || seeds.artists.length)) {
    try { graph = await relatedFor(seeds, signal); }
    catch { note = "Related music is unavailable; looking for more from these artists."; }
  }
  signal.throwIfAborted();
  const queries = (supplied ?? discoveryQueries(graph, seeds, input(), refresh)).slice(0, budget);
  const batches: DiscoveryBatch[] = [];
  let next = 0;
  let failed = 0;
  // Exclude before selecting, so previously shown songs never consume the target slots.
  const picks = () => pickDiscoveries(batches, input(), limit, Date.now(), exclude, supplied ? limit : 2);
  const worker = async () => {
    while (!signal.aborted && next < queries.length && picks().length < Math.min(24, limit)) {
      const query = queries[next++];
      try {
        const result = await search(query.text);
        signal.throwIfAborted();
        batches.push({ query, candidates: result.candidates });
        onSongs?.(picks());
      } catch { if (!signal.aborted) failed++; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  signal.throwIfAborted();
  const songs = picks();
  if (!songs.length) note = exclude.size ? "No more new songs found. Try again later as the catalog grows." : "No matching songs found right now.";
  else if (failed && !note) note = "Some music searches are unavailable.";
  return { songs, note, graph };
}

/** Seeds for a collection, rather than the listener's unrelated recent favourites. */
export function seedsForIds(ids: string[], offset = 0): Seeds {
  const s = getState();
  const songs = ids.filter((id) => s.tracks[id]).map((id) => ({ name: s.artists[s.tracks[id].artistId]?.name ?? "", title: s.tracks[id].title, weight: 1 })).filter((v) => v.name && v.name !== "Unknown artist" && v.name !== "Local Files");
  const rotated = [...songs.slice(offset % Math.max(1, songs.length)), ...songs.slice(0, offset % Math.max(1, songs.length))];
  const artists = [...new Map(rotated.map((v) => [v.name.toLowerCase(), v])).values()].slice(0, 5);
  return { songs: rotated.slice(0, 5), artists };
}
