import { ownedIndex } from "./owned";
import { fullTitle, type TopSong } from "./popular";
import { findMany, knownSong, resolveSong, type SongToFind, type TrackStatus } from "./releases";
import { demote, hurry } from "./service";
import { extendContext } from "../state/actions";
import { getState, subscribe, type Route } from "../state/store";

/*
 * Finds playable copies of an artist's ranked songs (the Popular page), most popular first and only as far down
 * as someone has looked, or as far as playback has got: each one is a search on YouTube or SoundCloud. One search
 * for the artist goes first and finds many at once. A finder lasts while its page is open or its list is the
 * one playing, so leaving the page doesn't stop songs joining the queue.
 */

/** Songs looked for straight away; the rest as they scroll into view, or as playback nears them. */
const FIRST = 12;
const AHEAD = 8;
/** Pages of the artist's own search: each later one is looked at only if the one before found something. */
const BROAD_PAGES = 3;
/** Failed searches are retried after one, two, four and eight minutes (the server pauses YouTube for a minute after repeated failures). */
const RETRY_MS = 60_000;
const RETRIES = 4;
/** A song not found this recently is answered from that, rather than searched again on every click. */
const MISSING_FOR = 60_000;

export interface Finder {
  /** Each song's state, in rank order (undefined: not looked for yet). */
  status(): Array<TrackStatus | undefined>;
  /** Called whenever a song's state changes. */
  watch(listener: () => void): () => void;
  /** Look for songs up to this rank. */
  want(upTo: number): void;
  /** This song's playable copy, looked for first if it hasn't been yet; `signal` calls that off (a newer click). */
  request(i: number, signal: AbortSignal): Promise<TrackStatus>;
  /** Songs found so far, in rank order. */
  ready(): string[];
  /** Keeps the finder going while its page is open; call the result when the page closes. */
  hold(): () => void;
}

const sameRoute = (a: Route | undefined, b: Route) => JSON.stringify(a) === JSON.stringify(b);
const listOf = (songs: TopSong[]) => songs.map((s) => s.id).join();

/**
 * Each artist's finder, shared by their page and their list's playback: the open page's and the playing list's
 * can be different artists. Each stops itself once neither holds it.
 */
const finders = new Map<string, { list: string; finder: Finder; stop: () => void }>();

export function popularFinder(route: Route, artist: string, songs: TopSong[]): Finder {
  const key = JSON.stringify(route);
  const known = finders.get(key);
  if (known && known.list === listOf(songs)) return known.finder;
  // The catalog's list for this artist changed: a fresh finder for the new list.
  known?.stop();
  const made = createFinder(route, artist, songs);
  finders.set(key, { list: listOf(songs), ...made });
  return made.finder;
}

function createFinder(route: Route, artist: string, list: TopSong[]) {
  const songs: SongToFind[] = list.map((song) => ({ title: fullTitle(song), artist: song.artist, durationSeconds: song.durationSeconds, artwork: song.artwork, album: song.album }));
  const owned = ownedIndex(getState());
  // Songs in the library or found before are ready straight away.
  const results: Array<TrackStatus | undefined> = songs.map((song) => knownSong(song, owned) ?? undefined);
  const listeners = new Set<() => void>();
  const waiting = new Map<number, Array<(s: TrackStatus) => void>>();
  /** The click each waiting song is for, so a background search that fails for it is followed by a click's own. */
  const clicks = new Map<number, AbortSignal>();
  /** Each song's latest search; an older one finishing after it is ignored. */
  const attempts = new Map<number, { n: number; urgent: boolean }>();
  const retries = new Map<number, number>();
  const missingAt = new Map<number, number>();
  /** At most one pending retry per song. */
  const timers = new Map<number, number>();
  let live = true;
  let holds = 0;
  /** Whether a page has held it yet. */
  let held = false;
  let wanted = FIRST;
  let running = 0;
  /** Background searches wait for the artist's own search, which may find their songs anyway. */
  let broadDone = false;
  /** Calls off the artist's search's later pages once the finder stops. */
  const stopped = new AbortController();

  const changed = () => {
    if (!live) return;
    extendContext(route, finder.ready());
    listeners.forEach((listener) => listener());
  };
  const answer = (i: number, found: TrackStatus) => {
    const done = waiting.get(i);
    waiting.delete(i);
    clicks.delete(i);
    // Whoever clicked still gets an answer if the finder has stopped meanwhile.
    done?.forEach((resolve) => resolve(found));
  };
  const cancelRetry = (i: number) => {
    window.clearTimeout(timers.get(i));
    timers.delete(i);
  };
  // A search that failed (a provider paused or rate-limited) is tried again after a while, waiting longer each time.
  const retryLater = (i: number) => {
    cancelRetry(i);
    const tries = retries.get(i) ?? 0;
    if (tries >= RETRIES) return;
    retries.set(i, tries + 1);
    timers.set(i, window.setTimeout(() => {
      timers.delete(i);
      if (!live || results[i]?.state !== "failed") return;
      results[i] = undefined;
      pump();
    }, RETRY_MS * 2 ** tries));
  };

  /** Searches for song `i`; `signal` when someone clicked to play it (and can call that off). */
  const start = (i: number, signal?: AbortSignal) => {
    const urgent = Boolean(signal);
    const attempt = { n: (attempts.get(i)?.n ?? 0) + 1, urgent };
    attempts.set(i, attempt);
    results[i] = { state: "finding" };
    if (!urgent) running++;
    void resolveSong(songs[i], owned, { priority: urgent ? "click" : "page", signal }).then((found) => {
      if (!urgent) running--;
      const latest = attempts.get(i) === attempt;
      if (latest) {
        const click = clicks.get(i);
        // Someone clicked while this background search was on its way, and it didn't find the song: their click
        // gets a search of its own (first in the queue, tried again after a moment).
        if (!urgent && found.state !== "ready" && click && !click.aborted && live) {
          start(i, click);
          pump();
          return;
        }
        answer(i, found);
      }
      if (!live) return;
      if (latest) {
        // A click called off (another song clicked) leaves the song to the finder's own searches.
        if (signal?.aborted && found.state !== "ready") results[i] = undefined;
        else {
          results[i] = found;
          if (found.state === "failed") retryLater(i);
          if (found.state === "missing") missingAt.set(i, Date.now());
        }
      }
      pump();
    });
  };

  const pump = () => {
    while (live && broadDone && running < 2) {
      const i = results.findIndex((r, n) => !r && n < wanted);
      if (i < 0) break;
      start(i);
    }
    changed();
  };

  const stop = () => {
    if (!live) return;
    live = false;
    unsubscribe();
    stopped.abort();
    timers.forEach((timer) => window.clearTimeout(timer));
    timers.clear();
    // Its searches still waiting give way to the page that's open now (a click still waiting keeps its place).
    demote(artist);
    results.forEach((r, i) => {
      if (r?.state === "finding" && !attempts.get(i)?.urgent) demote(`${songs[i].artist} ${songs[i].title}`);
    });
    const key = JSON.stringify(route);
    if (finders.get(key)?.finder === finder) finders.delete(key);
  };
  /** Stops unless something holds it again or its list is playing. Checked a moment later, so a page that closes
   * and opens again at once (React's development double run, or a quick re-render) keeps the same finder. */
  const stopIfUnused = () =>
    window.setTimeout(() => {
      if (live && !holds && !sameRoute(getState().context?.route, route)) stop();
    }, 0);

  const finder: Finder = {
    status: () => results,
    watch: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    want: (upTo) => {
      if (upTo <= wanted) return;
      wanted = upTo;
      pump();
    },
    request: (i, signal) => {
      const now = results[i];
      if (now?.state === "ready") return Promise.resolve(now);
      // Not found a moment ago: that answer stands, rather than another search on every click.
      if (now?.state === "missing" && Date.now() - (missingAt.get(i) ?? 0) < MISSING_FOR) return Promise.resolve(now);
      return new Promise((resolve) => {
        waiting.set(i, [...(waiting.get(i) ?? []), resolve]);
        clicks.set(i, signal);
        cancelRetry(i);
        const attempt = attempts.get(i);
        // Its background search is under way: moved to the front of the queue (if it hasn't gone out yet) and
        // waited for, rather than a second search for the same song.
        if (now?.state === "finding" && attempt && !attempt.urgent) hurry(`${songs[i].artist} ${songs[i].title}`);
        else start(i, signal);
        changed();
      });
    },
    ready: () => results.flatMap((r) => (r?.state === "ready" ? [r.id] : [])),
    hold: () => {
      holds++;
      held = true;
      let holding = true;
      return () => {
        if (!holding) return;
        holding = false;
        holds--;
        if (!holds) stopIfUnused();
      };
    },
  };

  // While its list is playing, songs are looked for ahead of the one playing; once it isn't (and the page is
  // closed), the finder stops.
  let playing: string | null = null;
  const unsubscribe = subscribe(() => {
    if (!live) return;
    const s = getState();
    if (!sameRoute(s.context?.route, route)) {
      // Not held by a page yet (one being opened takes hold just after it's made) isn't unused.
      if (!holds && held) stopIfUnused();
      return;
    }
    if (s.currentId === playing) return;
    playing = s.currentId;
    // Songs found while one from Up Next played (when the list can't take them) join it now.
    extendContext(route, finder.ready());
    const at = results.findIndex((r) => r?.state === "ready" && r.id === s.currentId);
    if (at >= 0 && at + 1 + AHEAD > wanted) finder.want(at + 1 + AHEAD);
  });

  // The artist's own search first: it may find many of the songs in a few searches.
  const unfound = results.map((r, i) => (r ? null : songs[i]));
  void (unfound.some(Boolean)
    ? findMany(artist, unfound, (i, found) => {
        if (!live && !waiting.has(i)) return;
        const attempt = attempts.get(i);
        // A click's own search may be under way; this answer comes first, so that one is ignored.
        attempts.set(i, { n: (attempt?.n ?? 0) + 1, urgent: false });
        results[i] = found;
        answer(i, found);
        changed();
      }, { pages: BROAD_PAGES, priority: "page", signal: stopped.signal })
    : Promise.resolve()
  ).finally(() => {
    broadDone = true;
    pump();
  });
  changed();

  return { finder, stop };
}
