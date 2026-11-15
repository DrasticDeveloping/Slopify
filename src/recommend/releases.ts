import { useEffect, useMemo, useState } from "react";
import { cleanArtist, cleanTitle, creditedArtist, discoveryKey } from "./discover";
import { ownedIndex } from "./owned";
import { demote, doubtful, searchMoreSongs, searchSongs, type Priority } from "./service";
import { meaningfulArtist, tasteProfile } from "./taste";
import { canStream, registerStreams, setStreamRepair, streamTrackId, type Candidate } from "../state/importer";
import { getState, useStore, type AppState } from "../state/store";

/*
 * Release Radar (new releases from artists you play) and Albums for you (albums
 * by them and by artists like them), from the server's music catalog
 * (server/catalog.mjs). A release's songs play like other suggestions: each is
 * found on YouTube or SoundCloud and streamed in full, or played from your
 * library if you already have it.
 */

export interface Release {
  id: string;
  title: string;
  artist: string;
  released: string;
  type: "album" | "single" | "ep" | "compile" | string;
  artwork?: string;
  fans: number;
  sourceUrl: string;
}
export interface ReleaseTrack { n: number; title: string; artist: string; durationSeconds: number | null }
export interface ReleaseDetail extends Release { label: string; tracks: ReleaseTrack[] }
interface ArtistReleases { name: string; picture?: string; releases: Release[]; related: string[] }

const DAY = 86_400_000;
/** Release Radar covers the last eight weeks. */
const RADAR_DAYS = 56;
const YOUR_ARTISTS = 12;
const RELATED_ARTISTS = 10;

/** Artists you play, like, save and import most, strongest first. */
export function yourArtists(s: AppState, limit = YOUR_ARTISTS) {
  const profile = tasteProfile(s);
  const weights = new Map<string, { name: string; weight: number }>();
  const add = (name: string | undefined, weight: number) => {
    if (!meaningfulArtist(name)) return;
    const key = cleanArtist(name);
    const known = weights.get(key);
    weights.set(key, { name: known?.name ?? name!, weight: (known?.weight ?? 0) + weight });
  };
  for (const [id, support] of profile.support) add(s.artists[s.tracks[id]?.artistId]?.name, support);
  // Every saved song counts a little, so a new library still has a radar.
  for (const id of s.trackIds) add(s.artists[s.tracks[id]?.artistId]?.name, 0.25);
  return [...weights.values()].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name)).slice(0, limit).map((a) => a.name);
}

async function post<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error?: { message?: string } } | null;
  if (!res.ok || !json?.ok || !json.result) throw new Error(json?.error?.message || "The music catalog is unavailable.");
  return json.result;
}

/** Answers kept for the session, so Home doesn't ask again on every visit. */
const memory = new Map<string, { at: number; value: Promise<Shelves> }>();

export interface Shelves { radar: Release[]; albums: Release[]; partial: boolean }

const releaseKey = (r: Release) => `${cleanArtist(r.artist)}|${cleanTitle(r.title.replace(/\s*[([].*?(deluxe|edition|remaster|version|expanded).*?[)\]]/gi, ""))}`;

async function loadShelves(names: string[], ownedAlbums: Set<string>, signal: AbortSignal): Promise<Shelves> {
  const mine = await post<{ artists: ArtistReleases[]; partial: boolean }>("/api/catalog/releases", { artists: names, related: 6 }, signal);
  const known = new Set(names.map(cleanArtist));
  const relatedNames = [...new Set(mine.artists.flatMap((a) => a.related.slice(0, 3)))].filter((n) => !known.has(cleanArtist(n))).slice(0, RELATED_ARTISTS);
  const theirs = relatedNames.length
    ? await post<{ artists: ArtistReleases[]; partial: boolean }>("/api/catalog/releases", { artists: relatedNames }, signal).catch(() => ({ artists: [], partial: true }))
    : { artists: [], partial: false };

  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - RADAR_DAYS * DAY).toISOString().slice(0, 10);
  const seen = new Set<string>();
  const once = (r: Release) => {
    const key = releaseKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  // Release Radar: everything new from your artists, newest first (a single and the album it's on both count).
  const radar = mine.artists.flatMap((a) => a.releases)
    .filter((r) => r.released >= since && r.released <= today && r.type !== "compile")
    .sort((a, b) => b.released.localeCompare(a.released))
    .filter(once)
    .slice(0, 30);

  // Albums for you: full albums and EPs you don't have, two per artist, yours first, then artists like them.
  const albumsOf = (a: ArtistReleases) => a.releases
    .filter((r) => (r.type === "album" || r.type === "ep") && r.released <= today && !/\blive\b|karaoke|instrumentals?\b/i.test(r.title) && !ownedAlbums.has(releaseKey(r)))
    .sort((x, y) => y.fans - x.fans)
    .filter(once)
    .slice(0, 2);
  const albums: Release[] = [];
  const queues = [...mine.artists, ...theirs.artists].map(albumsOf);
  // One from each artist in turn, so no single artist fills the shelf.
  for (let round = 0; round < 2; round++) for (const list of queues) if (list[round] && albums.length < 24) albums.push(list[round]);
  return { radar, albums, partial: mine.partial || theirs.partial };
}

/** Release Radar and Albums for you for the listener's current taste. */
export function useReleaseShelves() {
  const tracks = useStore((s) => s.tracks);
  const names = useMemo(() => yourArtists(getState()), [tracks]);
  const [state, setState] = useState<{ shelves: Shelves | null; loading: boolean; error: string }>({ shelves: null, loading: false, error: "" });
  const key = names.join("\n");

  useEffect(() => {
    if (!names.length) return setState({ shelves: null, loading: false, error: "" });
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: "" }));
    let hit = memory.get(key);
    if (!hit || Date.now() - hit.at > 30 * 60_000) {
      // Albums of songs you saved; ones made for streamed suggestions don't count.
      const s = getState();
      const savedAlbums = new Set(Object.values(s.tracks).filter((t) => !t.stream).map((t) => t.albumId));
      const owned = new Set([...savedAlbums].flatMap((id) => (s.albums[id] ? [releaseKey({ title: s.albums[id].title, artist: s.artists[s.albums[id].artistId]?.name ?? "" } as Release)] : [])));
      hit = { at: Date.now(), value: loadShelves(names, owned, AbortSignal.timeout(120_000)) };
      memory.set(key, hit);
      // A failed lookup isn't remembered: the next visit asks again.
      hit.value.then((v) => { if (v.partial && !v.radar.length && !v.albums.length) memory.delete(key); }, () => memory.delete(key));
    }
    hit.value.then(
      (shelves) => {
        for (const r of [...shelves.radar, ...shelves.albums]) known.set(r.id, r);
        if (!controller.signal.aborted) setState({ shelves, loading: false, error: "" });
      },
      () => !controller.signal.aborted && setState({ shelves: null, loading: false, error: "The music catalog couldn't be reached. Try again later." }),
    );
    return () => controller.abort();
    // `key` covers the artist names.
  }, [key]);
  return state;
}

/* ───────────────────────── one release ───────────────────────── */

const details = new Map<string, Promise<ReleaseDetail>>();
/** Releases seen on a shelf, so a release's page can show its cover and title before (or without) its details. */
const known = new Map<string, Release>();
export const knownRelease = (id: string) => known.get(id);

export function fetchRelease(id: string): Promise<ReleaseDetail> {
  let hit = details.get(id);
  if (!hit) {
    hit = fetch(`/api/catalog/album/${encodeURIComponent(id)}`).then(async (res) => {
      const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: ReleaseDetail; error?: { message?: string } } | null;
      if (!res.ok || !json?.ok || !json.result) throw new Error(json?.error?.message || "This release couldn't be loaded.");
      return json.result;
    });
    details.set(id, hit);
    hit.catch(() => details.delete(id));
  }
  return hit;
}

/**
 * A title as matching compares it: also without a featured-artist credit written out without brackets, as video
 * titles often are ("Cold ft. Future (Audio)" is the catalog's "Cold"). Only the credit goes: a version after it
 * stays, so "Cold ft. Future (Kaskade Remix)" and "Cold ft. Future - Live" aren't the studio "Cold".
 */
const matchTitle = (title: string) =>
  cleanTitle(title)
    // "Song - Extended Mix", as Spotify writes a version, is "Song (Extended Mix)".
    .replace(/\s+[-–—]\s+([^()[\]\-–—]+)$/u, " ($1)")
    .replace(/\s+(?:feat\.?|ft\.|featuring)\s(?:(?!\s[-–—]\s)[^([])*/gu, " ").replace(/\s+/g, " ").trim();

/** The search result that is this song: by its artist, with its title, and about as long. */
function matchCandidate(candidates: Candidate[], track: Pick<ReleaseTrack, "title" | "artist" | "durationSeconds">): Candidate | undefined {
  const wanted = matchTitle(track.title);
  return candidates.find((c) => {
    if (!canStream(c)) return false;
    const meta = c.importMetadata ?? c;
    const artist = meta.artist || c.artist || "";
    let title = meta.title || c.title || "";
    const credited = title.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
    if (credited && creditedArtist(credited[1], track.artist)) title = credited[2];
    if (!creditedArtist(artist, track.artist) && !(credited && creditedArtist(credited[1], track.artist))) return false;
    if (matchTitle(title) !== wanted) return false;
    const duration = meta.durationSeconds ?? c.durationSeconds;
    return !track.durationSeconds || !duration || Math.abs(duration - track.durationSeconds) <= 20;
  });
}

/** "missing": searched and not found; "failed": the search itself didn't work (try again later). */
export type TrackStatus = { state: "finding" } | { state: "ready"; id: string } | { state: "missing" } | { state: "failed" };

export interface SongToFind {
  title: string;
  artist: string;
  durationSeconds: number | null;
  artwork?: string;
  album?: string;
  released?: string;
}

/*
 * Songs found before, kept in localStorage for a week, so a list opened again (an artist's popular songs, an
 * album) plays at once instead of searching for every song again: each search counts towards the pace YouTube
 * puts up with. Its source is a link, which is looked up afresh when it plays.
 */
const FOUND_KEY = "slopify.found.v1";
const FOUND_FOR = 7 * DAY;
const FOUND_MAX = 400;
let foundSongs: Map<string, { at: number; candidate: Candidate }> | null = null;
function foundAll() {
  if (foundSongs) return foundSongs;
  foundSongs = new Map();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FOUND_KEY) ?? "[]");
    if (Array.isArray(raw)) for (const entry of raw) if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]?.candidate && Date.now() - entry[1].at < FOUND_FOR) foundSongs.set(entry[0], entry[1]);
  } catch {
    // Unreadable: starts afresh.
  }
  return foundSongs;
}
function rememberFound(key: string, candidate: Candidate) {
  const all = foundAll();
  all.delete(key);
  // Only what playing it needs: its source and details, and one other copy to fall back on.
  all.set(key, { at: Date.now(), candidate: { ...candidate, fallbackCandidates: candidate.fallbackCandidates?.slice(0, 1).map(({ fallbackCandidates: _, ...c }) => c) } });
  while (all.size > FOUND_MAX) all.delete(all.keys().next().value!);
  saveFound();
}
let saving = 0;
/** Written once a list's worth of finds and uses has settled, rather than once for each. */
function saveFound() {
  window.clearTimeout(saving);
  saving = window.setTimeout(() => {
    try {
      localStorage.setItem(FOUND_KEY, JSON.stringify([...foundAll()]));
    } catch {
      // Full: kept for this session only.
    }
  }, 1_000);
}

/** Forgets a remembered song (its source has gone), so it's looked for afresh. */
function forgetFound(key: string) {
  if (foundAll().delete(key)) saveFound();
}

const songKey = (song: Pick<SongToFind, "artist" | "title">) => discoveryKey(song.artist, song.title);

/** Registers a found copy as the song's streamed track. */
function register(song: SongToFind, candidate: Candidate): TrackStatus {
  const key = songKey(song);
  registerStreams([{ key, candidate, title: song.title, artist: song.artist, artwork: song.artwork, kind: "discover-artist", album: song.album, released: song.released }]);
  return { state: "ready", id: streamTrackId(key) };
}

/** The song's playable copy without searching: in your library, or found before. */
export function knownSong(song: SongToFind, owned = ownedIndex(getState())): TrackStatus | null {
  const mine = owned.find({ artist: song.artist, title: song.title })[0];
  if (mine) return { state: "ready", id: mine };
  const key = songKey(song);
  const all = foundAll();
  const known = all.get(key);
  if (!known || Date.now() - known.at >= FOUND_FOR || !canStream(known.candidate)) return null;
  // Used again: moved to the back, so the songs played least recently are the ones forgotten when it's full.
  // Its week still counts from when it was found, so a source that has gone is looked for afresh in time.
  all.delete(key);
  all.set(key, known);
  saveFound();
  return register(song, known.candidate);
}

export interface FindOptions {
  /** Who is waiting: a click (searched first, and once more after a moment if music search fails), the open page, or a shelf. */
  priority?: Priority;
  /** Calls off a click's search while it's still waiting for its turn. */
  signal?: AbortSignal;
}

/**
 * Finds a catalog song to play: in your library if you have it (or found before), otherwise on
 * YouTube or SoundCloud (registered as a streamed song). Never rejects.
 */
export async function resolveSong(song: SongToFind, owned = ownedIndex(getState()), { priority = "shelf", signal }: FindOptions = {}): Promise<TrackStatus> {
  const known = knownSong(song, owned);
  if (known) return known;
  let found = await lookUp(song, priority, signal);
  // Someone is waiting to play it: a provider's brief throttling gets one more try a few seconds later.
  if (priority === "click" && !found.candidate && found.state === "failed" && !signal?.aborted) {
    await new Promise((resolve) => window.setTimeout(resolve, URGENT_RETRY_MS));
    if (!signal?.aborted) found = await lookUp(song, priority, signal);
  }
  return found.candidate ? register(song, found.candidate) : { state: found.state === "missing" ? "missing" : "failed" };
}
const URGENT_RETRY_MS = 5_000;

interface LookedUp {
  candidate?: Candidate;
  state: "missing" | "failed" | "ready";
}

/** One search for the song, leaving out copies already known not to play (`refused`). Remembers what it finds. */
async function lookUp(song: SongToFind, priority: Priority, signal?: AbortSignal, refused = new Set<string>()): Promise<LookedUp> {
  try {
    const result = await searchSongs(`${song.artist} ${song.title}`, priority, signal);
    const usable = result.candidates.filter((c) => !refused.has(c.sourceURL ?? ""));
    const match = matchCandidate(usable, song);
    // Not found while YouTube or SoundCloud wasn't answering (or YouTube claimed to have nothing at all for a
    // known song) isn't "missing": it may well be there.
    if (!match) return { state: doubtful(result) ? "failed" : "missing" };
    const candidate = refused.size ? { ...match, fallbackCandidates: match.fallbackCandidates?.filter((c) => !refused.has(c.sourceURL ?? "")) } : match;
    rememberFound(songKey(song), candidate);
    return { candidate, state: "ready" };
  } catch {
    return { state: "failed" };
  }
}

/**
 * Looks for many of an artist's songs with one search (the artist, or an album) and its next pages, matching
 * every result against each song still to find: a few searches instead of one per song. A song it misses is
 * left to its own search, never marked missing. Stops after `pages`, or at a page that finds nothing new.
 */
export async function findMany(query: string, songs: Array<SongToFind | null>, onFound: (i: number, status: TrackStatus) => void, { pages = 1, priority = "page", signal }: FindOptions & { pages?: number } = {}) {
  const left = new Map(songs.flatMap((song, i) => (song ? [[i, song] as const] : [])));
  let more: string | null | undefined;
  for (let page = 0; page < pages && left.size && !signal?.aborted; page++) {
    let result: Awaited<ReturnType<typeof searchSongs>>;
    try {
      result = page === 0 ? await searchSongs(query, priority) : await searchMoreSongs(more!, priority, signal);
    } catch {
      return;
    }
    if (signal?.aborted) return;
    let found = 0;
    for (const [i, song] of left) {
      const match = matchCandidate(result.candidates, song);
      if (!match) continue;
      found++;
      left.delete(i);
      rememberFound(songKey(song), match);
      onFound(i, register(song, match));
    }
    more = result.more;
    if (!found || !more) return;
  }
}

/*
 * A streamed song whose copy has gone (taken down, made private, blocked here) is found again when it fails to
 * play, after its other remembered copy: one fresh search that leaves out the copies that failed.
 */
setStreamRepair({
  find: async ({ key, title, artist, duration }, refused) => {
    forgetFound(key);
    const song: SongToFind = { title, artist, durationSeconds: duration || null };
    // Only songs found by artist and title (not, say, a video someone pasted a link to) can be looked for again.
    if (songKey(song) !== key) return null;
    return (await lookUp(song, "click", undefined, refused)).candidate ?? null;
  },
  replaced: (key, candidate) => {
    if (foundAll().has(key)) rememberFound(key, candidate);
  },
});

/** Failed lookups on a release's page are tried again after one, two, four and eight minutes. */
const RETRY_MS = 60_000;
const RETRIES = 4;

/**
 * Finds each of a release's songs: in your library if you have it (or found before), otherwise on YouTube or
 * SoundCloud (registered as a streamed song), the album's own search first. Reports as each is found.
 */
export function useReleaseTracks(release: ReleaseDetail | null) {
  const [status, setStatus] = useState<TrackStatus[]>([]);
  useEffect(() => {
    if (!release) return;
    let live = true;
    const owned = ownedIndex(getState());
    const songs: SongToFind[] = release.tracks.map((t) => ({ ...t, artwork: release.artwork, album: release.title, released: release.released }));
    const results: TrackStatus[] = songs.map((song) => knownSong(song, owned) ?? { state: "finding" });
    const show = () => {
      if (live) setStatus([...results]);
    };
    show();
    const timers = new Set<number>();
    const closed = new AbortController();
    const look = async (i: number, tries: number) => {
      const found = await resolveSong(songs[i], owned, { priority: "page" });
      if (!live) return;
      results[i] = found;
      show();
      if (found.state !== "failed" || tries >= RETRIES) return;
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (!live) return;
        results[i] = { state: "finding" };
        show();
        void look(i, tries + 1);
      }, RETRY_MS * 2 ** tries);
      timers.add(timer);
    };
    void (async () => {
      const wanted = results.map((r, i) => (r.state === "finding" ? songs[i] : null));
      if (wanted.filter(Boolean).length > 2) {
        await findMany(`${release.artist} ${release.title}`, wanted, (i, found) => {
          if (results[i].state !== "finding") return;
          results[i] = found;
          show();
        }, { signal: closed.signal });
      }
      if (!live) return;
      const todo = results.flatMap((r, i) => (r.state === "finding" ? [i] : []));
      // Two at a time, which is all the shared queue runs anyway; leaving the page stops the rest.
      const worker = async () => {
        while (live && todo.length) await look(todo.shift()!, 0);
      };
      await Promise.all([worker(), worker()]);
    })();
    return () => {
      live = false;
      closed.abort();
      timers.forEach((timer) => window.clearTimeout(timer));
      // Its searches still waiting give way to the page that's open now.
      demote(`${release.artist} ${release.title}`);
      songs.forEach((song, i) => {
        if (results[i].state === "finding") demote(`${song.artist} ${song.title}`);
      });
    };
  }, [release]);
  return status;
}
