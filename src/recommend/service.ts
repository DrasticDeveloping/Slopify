import { discoveryKey, discoveryQueries, fetchRelated, MIN_QUERIES, pickDiscoveries, popularQueries, relatedLinks, type DiscoveredSong, type DiscoveryBatch, type DiscoveryQuery, type Related, type Seed } from "./discover";
import { chartSongs, fullTitle } from "./popular";
import { meaningfulArtist } from "./taste";
import { rememberSongLinks } from "../state/actions";
import { searchDiscovery, searchMore, type MediaKind, type Resolution } from "../state/importer";
import { getState, type AppState } from "../state/store";

/*
 * One discovery service for every surface (Home, mixes, radio, artist pages,
 * playlist suggestions). They share three provider search slots, a per-minute
 * search budget and cached answers, so opening several at once never floods
 * the providers or repeats a search another surface just made.
 */

export type Seeds = { songs: Seed[]; artists: Seed[] };

/*
 * Every provider search goes through one queue, kept to a pace YouTube puts up with: a quick run of searches
 * (from about a dozen) gets it to turn this computer's searches away for a minute or so, clicks included.
 * Measured: two at a time, starting at least 2.5 s apart (24 a minute), stays clear. Searches someone is waiting
 * for go first: a click (or typed search), then the page that's open, then background shelves.
 */
const SLOTS = 2;
/** Provider searches allowed in any minute, across every surface: what the gap between starts allows. */
const PER_MINUTE = 24;
/** A discovery stops searching after this many failed searches in a row. */
const STOP_AFTER_FAILURES = 3;
const MINUTE = 60_000;
const DAY = 86_400_000;

/* ───────────────────────── shared limits ───────────────────────── */

/** Who is waiting for a search: someone who clicked, the page that's open, or a background shelf. */
export type Priority = "click" | "page" | "shelf";
const RANK: Record<Priority, number> = { click: 0, page: 1, shelf: 2 };
/** Searches start at least this far apart. */
const GAP = MINUTE / PER_MINUTE;

interface Waiter { rank: number; seq: number; text?: string; start: () => void }
const waiters: Waiter[] = [];
let busy = 0;
let lastStart = 0;
let seq = 0;
let admitTimer = 0;

/** Starts the most urgent waiting search once a slot is free and the last one started long enough ago. */
function admit() {
  window.clearTimeout(admitTimer);
  while (waiters.length && busy < SLOTS) {
    const wait = lastStart + GAP - Date.now();
    if (wait > 0) {
      admitTimer = window.setTimeout(admit, wait);
      return;
    }
    waiters.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
    const next = waiters.shift()!;
    busy++;
    lastStart = Date.now();
    next.start();
  }
}

/**
 * Waits for this search's turn, then runs it holding a slot. One called off (`signal`) while still waiting is
 * never sent; once sent it runs to the end, since YouTube has counted it anyway and its answer is still useful.
 */
function inTurn<T>(priority: Priority, signal: AbortSignal | undefined, run: () => Promise<T>, text?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const waiter: Waiter = {
      rank: RANK[priority],
      seq: seq++,
      text,
      start: () => {
        signal?.removeEventListener("abort", cancel);
        run().then(resolve, reject).finally(() => {
          busy--;
          admit();
        });
      },
    };
    const cancel = () => {
      const at = waiters.indexOf(waiter);
      if (at < 0) return;
      waiters.splice(at, 1);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    waiters.push(waiter);
    admit();
  });
}

/** A search for these words still waiting moves up to `priority` (someone is now waiting for its answer). */
function raise(text: string, priority: Priority) {
  let moved = false;
  for (const w of waiters) if (w.text === text && w.rank > RANK[priority]) [w.rank, moved] = [RANK[priority], true];
  if (moved) admit();
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

/**
 * A search where YouTube or SoundCloud didn't answer, or YouTube said it has nothing at all (which for a known
 * song's artist and title is more likely its throttling than the truth), so finding nothing proves little.
 */
export const doubtful = (r: Resolution) => Boolean(r.unavailableProviders?.some((p) => p === "youtube" || p === "soundcloud") || r.emptyProviders?.length);

/** Searches with results are good for ten minutes; empty ones, and ones a provider didn't answer, are retried after one. */
const cachedSearch = sharedCache<Resolution>(160, (r) => (r.candidates.length && !r.unavailableProviders?.length && !r.emptyProviders?.length ? 10 * MINUTE : MINUTE));
/** Relationships last a day, but an answer where a lookup failed (rate limiting, say) is retried after a minute. */
const cachedRelated = sharedCache<Related>(40, (r) => ([...r.songs, ...r.artists].some((seed) => seed.status === "unavailable") ? MINUTE : DAY));

/** Someone clicked to play a song whose search is already queued: it goes first. */
export const hurry = (text: string) => raise(text, "click");

/** The page that wanted these words searched has closed: a search for them still waiting goes behind the others. */
export function demote(text: string) {
  for (const w of waiters) if (w.text === text && w.rank < RANK.shelf && w.rank > RANK.click) w.rank = RANK.shelf;
}

function search(text: string, priority: Priority = "shelf", signal?: AbortSignal) {
  // Someone clicked to play it: searched afresh, since a cached answer from while a provider was down would only
  // fail again. A newer click calls off one still waiting.
  if (priority === "click") {
    return inTurn("click", signal, () => searchDiscovery(text, AbortSignal.timeout(30_000), "audio", true));
  }
  raise(text, priority);
  // A shared search outlives whichever surface asked first, so it has its own deadline rather than that caller's signal.
  return cachedSearch(text, () => inTurn(priority, AbortSignal.timeout(120_000), () => searchDiscovery(text, AbortSignal.timeout(12_000)), text));
}

/**
 * One provider search (artist and title, say), sharing the queue and cache with every other surface. A "click"
 * search can be called off by `signal` until it's sent.
 */
export const searchSongs = (text: string, priority: Priority = "shelf", signal?: AbortSignal) => search(text, priority, signal);

/** More results for a search (Resolution.more), in the same queue. */
export const searchMoreSongs = (more: string, priority: Priority, signal?: AbortSignal) =>
  inTurn(priority, signal, () => searchMore(more, "audio", AbortSignal.timeout(30_000)));

/** A search someone typed (Search page), first in the queue; a newer one calls it off until it's sent. */
export const searchTyped = (query: string, signal: AbortSignal, kind: MediaKind) => inTurn("click", signal, () => searchDiscovery(query, signal, kind));
/** More results for a typed search, first in the queue. */
export const searchTypedMore = (more: string, signal: AbortSignal, kind: MediaKind) => inTurn("click", signal, () => searchMore(more, kind, signal));

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
  /** `noChart`: popular songs were wanted but the chart was unavailable (see Discovery). */
  onSongs?: (songs: DiscoveredSong[], noChart: boolean) => void;
  /** Keep songs already in the library (marked `owned`), for lists like an artist's popular songs. */
  withOwned?: boolean;
  /**
   * For suggestions across your whole taste (Home, Discover Weekly): when your music gives too little to go on,
   * songs popular right now fill in, starting this far down the chart (so two surfaces don't show the same ones).
   */
  popular?: number;
}

export interface Discovery {
  songs: DiscoveredSong[];
  note: string;
  /** Some searches failed or a provider didn't answer, so an empty list may not mean there's nothing to find. */
  failed: boolean;
  /** Popular songs were wanted (little to go on) but the chart couldn't be loaded. */
  noChart?: boolean;
}

/** Songs outside the library for these seeds, searched three at a time until there are enough. */
export async function discover({ seeds, signal, refresh = 0, exclude = new Set(), limit = 30, budget = 48, queries: fixed, onSongs, withOwned = false, popular }: DiscoverOptions): Promise<Discovery> {
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
  let queries = fixed ?? discoveryQueries(related, seeds, getState(), refresh);
  let noChart = false;
  // Few searches from your own music (a new listener, or artists with few relationships): popular songs fill in.
  if (!fixed && popular !== undefined && queries.filter((q) => q.artist).length < MIN_QUERIES) {
    const chart = await chartSongs().catch(() => []);
    signal.throwIfAborted();
    noChart = !chart.length;
    // A remix or live recording in the chart is searched for as that recording, not the plain song.
    const songs = chart.map((song) => ({ artist: song.artist, title: fullTitle(song), artwork: song.artwork }));
    // Find more moves a shelf's worth further down the chart.
    const start = songs.length ? (popular + refresh * 30) % songs.length : 0;
    if (songs.length) queries = discoveryQueries(related, seeds, getState(), refresh, Date.now(), popularQueries([...songs.slice(start), ...songs.slice(0, start)]));
  }
  queries = queries.slice(0, budget);
  const batches: DiscoveryBatch[] = [];
  // Fixed searches are all about one artist, so that artist may fill the list.
  const perArtist = fixed ? limit : 2;
  const picks = () => pickDiscoveries(batches, getState(), limit, Date.now(), exclude, perArtist, withOwned);
  const enough = Math.min(24, limit);
  let next = 0;
  let failed = 0;
  /** Failed searches in a row. Music search being down stops the rest, rather than spending the budget other surfaces (and clicks) are waiting for. */
  let streak = 0;
  const worker = async () => {
    while (!signal.aborted && next < queries.length && picks().length < enough && streak < STOP_AFTER_FAILURES) {
      const query = queries[next++];
      try {
        const result = await search(query.text);
        signal.throwIfAborted();
        batches.push({ query, candidates: result.candidates });
        const partial = doubtful(result);
        if (partial) failed++;
        streak = partial ? streak + 1 : 0;
        onSongs?.(picks(), noChart);
      } catch {
        if (!signal.aborted) {
          failed++;
          streak++;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: SLOTS }, worker));
  signal.throwIfAborted();
  const songs = picks();
  if (!songs.length) note = failed ? "Music search isn't responding right now. Try again in a few minutes." : exclude.size ? "No more new songs found. Try again later as the catalog grows." : "No matching songs found right now.";
  else if (failed && !note) note = "Some music searches are unavailable.";
  return { songs, note, failed: failed > 0, ...(noChart ? { noChart } : {}) };
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
