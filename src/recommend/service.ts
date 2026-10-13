import { discoveryKey, discoveryQueries, fetchRelated, pickDiscoveries, relatedLinks, type DiscoveredSong, type DiscoveryBatch, type DiscoveryQuery, type Related, type Seed } from "./discover";
import { meaningfulArtist } from "./taste";
import { rememberSongLinks } from "../state/actions";
import { searchDiscovery, type Resolution } from "../state/importer";
import { getState, type AppState } from "../state/store";

/*
 * One discovery service for every surface (Home, mixes, radio, artist pages,
 * playlist suggestions). They share three provider search slots, a per-minute
 * search budget and cached answers, so opening several at once never floods
 * the providers or repeats a search another surface just made.
 */

export type Seeds = { songs: Seed[]; artists: Seed[] };

const SLOTS = 3;
/** Provider searches allowed in any rolling minute, across every surface. */
const PER_MINUTE = 48;
const MINUTE = 60_000;
const DAY = 86_400_000;

/* ───────────────────────── shared limits ───────────────────────── */

let busySlots = 0;
const slotQueue: Array<() => void> = [];
const recentSearches: number[] = [];

/** Waits for one of the shared search slots. A released slot passes straight to the next waiter. */
function takeSlot() {
  if (busySlots < SLOTS) {
    busySlots++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => slotQueue.push(resolve));
}
function releaseSlot() {
  const next = slotQueue.shift();
  if (next) next();
  else busySlots--;
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Waits until the rolling minute has room for another search, then counts it. */
async function spendSearch(signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    while (recentSearches.length && recentSearches[0] <= Date.now() - MINUTE) recentSearches.shift();
    if (recentSearches.length < PER_MINUTE) break;
    await sleep(Math.max(1, recentSearches[0] + MINUTE - Date.now()), signal);
  }
  recentSearches.push(Date.now());
}

/* ───────────────────────── cached work ───────────────────────── */

/** Remembers answers for their own lifetime and shares a request that is still running. */
function sharedCache<T>(size: number, lifetime: (value: T) => number) {
  const done = new Map<string, { at: number; value: T }>();
  const running = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = done.get(key);
    if (hit && Date.now() - hit.at < lifetime(hit.value)) return Promise.resolve(hit.value);
    const pending = running.get(key);
    if (pending) return pending;
    const task = load()
      .then((value) => {
        done.delete(key);
        done.set(key, { at: Date.now(), value });
        while (done.size > size) done.delete(done.keys().next().value!);
        return value;
      })
      .finally(() => running.delete(key));
    running.set(key, task);
    return task;
  };
}

/** Searches with results are good for ten minutes; empty ones are retried after one. */
const cachedSearch = sharedCache<Resolution>(160, (r) => (r.candidates.length ? 10 * MINUTE : MINUTE));
/** Relationships last a day, but an answer where a lookup failed (rate limiting, say) is retried after a minute. */
const cachedRelated = sharedCache<Related>(40, (r) => ([...r.songs, ...r.artists].some((seed) => seed.status === "unavailable") ? MINUTE : DAY));

function search(text: string) {
  return cachedSearch(text, async () => {
    // A shared search outlives whichever surface asked first, so it has its own deadline rather than that caller's signal.
    const signal = AbortSignal.timeout(90_000);
    await takeSlot();
    try {
      await spendSearch(signal);
      return await searchDiscovery(text, AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
    } finally {
      releaseSlot();
    }
  });
}

/** One provider search (artist and title, say), sharing the slots, budget and cache with every other surface. */
export const searchSongs = (text: string) => search(text);

/** "Listeners also play" relationships for these seeds, cached for a day. */
export async function relatedFor(seeds: Seeds, signal: AbortSignal) {
  signal.throwIfAborted();
  const key = JSON.stringify([seeds.songs.map((s) => [s.name, s.title]), seeds.artists.map((s) => [s.name, s.title])]);
  const related = await cachedRelated(key, async () => {
    const value = await fetchRelated(seeds, AbortSignal.timeout(30_000));
    rememberSongLinks(relatedLinks(value));
    return value;
  });
  signal.throwIfAborted();
  return related;
}

/* ───────────────────────── discovery ───────────────────────── */

export interface DiscoverOptions {
  seeds: Seeds;
  signal: AbortSignal;
  /** Which refresh this is; each one varies the fallback searches. */
  refresh?: number;
  /** Songs already shown, which must not take any of the `limit` places. */
  exclude?: Set<string>;
  limit?: number;
  /** Most provider searches this request may make. */
  budget?: number;
  /** Fixed searches (an artist's popular songs) instead of ones built from the seeds. */
  queries?: DiscoveryQuery[];
  /** Called with the picks so far as each search arrives. */
  onSongs?: (songs: DiscoveredSong[]) => void;
  /** Keep songs already in the library (marked `owned`), for lists like an artist's popular songs. */
  withOwned?: boolean;
}

export interface Discovery { songs: DiscoveredSong[]; note: string }

/** Songs outside the library for these seeds, searched three at a time until there are enough. */
export async function discover({ seeds, signal, refresh = 0, exclude = new Set(), limit = 30, budget = 48, queries: fixed, onSongs, withOwned = false }: DiscoverOptions): Promise<Discovery> {
  let related: Related | null = null;
  let note = "";
  if (!fixed && (seeds.songs.length || seeds.artists.length)) {
    try {
      related = await relatedFor(seeds, signal);
    } catch {
      note = "Related music is unavailable; looking for more from these artists.";
    }
  }
  signal.throwIfAborted();
  const queries = (fixed ?? discoveryQueries(related, seeds, getState(), refresh)).slice(0, budget);
  const batches: DiscoveryBatch[] = [];
  // Fixed searches are all about one artist, so that artist may fill the list.
  const perArtist = fixed ? limit : 2;
  const picks = () => pickDiscoveries(batches, getState(), limit, Date.now(), exclude, perArtist, withOwned);
  const enough = Math.min(24, limit);
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (!signal.aborted && next < queries.length && picks().length < enough) {
      const query = queries[next++];
      try {
        const result = await search(query.text);
        signal.throwIfAborted();
        batches.push({ query, candidates: result.candidates });
        onSongs?.(picks());
      } catch {
        if (!signal.aborted) failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: SLOTS }, worker));
  signal.throwIfAborted();
  const songs = picks();
  if (!songs.length) note = exclude.size ? "No more new songs found. Try again later as the catalog grows." : "No matching songs found right now.";
  else if (failed && !note) note = "Some music searches are unavailable.";
  return { songs, note };
}

/* ───────────────────────── seeds and the library ───────────────────────── */

/** Seeds from a set of songs (a playlist, album, artist or mix), rather than the listener's overall favourites. `offset` rotates which five lead. */
export function seedsForIds(ids: string[], offset = 0): Seeds {
  const s = getState();
  const songs = ids
    .map((id) => s.tracks[id])
    .filter((t) => t && meaningfulArtist(s.artists[t.artistId]?.name))
    .map((t) => ({ name: s.artists[t.artistId].name, title: t.title, weight: 1 }));
  const start = songs.length ? offset % songs.length : 0;
  const rotated = [...songs.slice(start), ...songs.slice(0, start)];
  const artists = [...new Map(rotated.map((seed) => [seed.name.toLowerCase(), seed])).values()].slice(0, 5);
  return { songs: rotated.slice(0, 5), artists };
}

/** The song key of a library or streamed track, as discovery compares songs. */
export const trackKey = (s: AppState, id: string) => discoveryKey(s.artists[s.tracks[id]?.artistId]?.name, s.tracks[id]?.title);

/** Familiar songs with one new song after every two, as mixes and radio play them. */
export function interleave(familiar: string[], fresh: string[]) {
  const out: string[] = [];
  for (let i = 0; i < Math.max(familiar.length, fresh.length * 2); i++) {
    if (familiar[i]) out.push(familiar[i]);
    if (i % 2 === 1 && fresh[(i - 1) / 2]) out.push(fresh[(i - 1) / 2]);
  }
  return out;
}
