import { useEffect, useMemo, useState } from "react";
import { cleanArtist, cleanTitle, creditedArtist, discoveryKey } from "./discover";
import { ownedIndex } from "./owned";
import { searchSongs } from "./service";
import { meaningfulArtist, tasteProfile } from "./taste";
import { canStream, registerStreams, streamTrackId, type Candidate } from "../state/importer";
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
      (shelves) => !controller.signal.aborted && setState({ shelves, loading: false, error: "" }),
      () => !controller.signal.aborted && setState({ shelves: null, loading: false, error: "The music catalog couldn't be reached. Try again later." }),
    );
    return () => controller.abort();
    // `key` covers the artist names.
  }, [key]);
  return state;
}

/* ───────────────────────── one release ───────────────────────── */

const details = new Map<string, Promise<ReleaseDetail>>();

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

/** The search result that is this song: by its artist, with its title, and about as long. */
function matchCandidate(candidates: Candidate[], track: ReleaseTrack): Candidate | undefined {
  const wanted = cleanTitle(track.title);
  return candidates.find((c) => {
    if (!canStream(c)) return false;
    const meta = c.importMetadata ?? c;
    const artist = meta.artist || c.artist || "";
    let title = meta.title || c.title || "";
    const credited = title.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
    if (credited && creditedArtist(credited[1], track.artist)) title = credited[2];
    if (!creditedArtist(artist, track.artist) && !(credited && creditedArtist(credited[1], track.artist))) return false;
    if (cleanTitle(title) !== wanted) return false;
    const duration = meta.durationSeconds ?? c.durationSeconds;
    return !track.durationSeconds || !duration || Math.abs(duration - track.durationSeconds) <= 20;
  });
}

/** "missing": searched and not found; "failed": the search itself didn't work (try again later). */
export type TrackStatus = { state: "finding" } | { state: "ready"; id: string } | { state: "missing" } | { state: "failed" };

/**
 * Finds each of a release's songs: in your library if you have it, otherwise on
 * YouTube or SoundCloud (registered as a streamed song). Reports as each is found.
 */
export function useReleaseTracks(release: ReleaseDetail | null) {
  const [status, setStatus] = useState<TrackStatus[]>([]);
  useEffect(() => {
    if (!release) return;
    let live = true;
    const results: TrackStatus[] = release.tracks.map(() => ({ state: "finding" }));
    setStatus([...results]);
    const owned = ownedIndex(getState());
    let next = 0;
    const worker = async () => {
      while (live && next < release.tracks.length) {
        const i = next++;
        const track = release.tracks[i];
        const mine = owned.find({ artist: track.artist, title: track.title })[0];
        if (mine) {
          results[i] = { state: "ready", id: mine };
        } else {
          try {
            const found = matchCandidate((await searchSongs(`${track.artist} ${track.title}`)).candidates, track);
            if (found) {
              const key = discoveryKey(track.artist, track.title);
              registerStreams([{ key, candidate: found, title: track.title, artist: track.artist, artwork: release.artwork, kind: "discover-artist", album: release.title, released: release.released }]);
              results[i] = { state: "ready", id: streamTrackId(key) };
            } else results[i] = { state: "missing" };
          } catch {
            results[i] = { state: "failed" };
          }
        }
        if (live) setStatus([...results]);
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => {
      live = false;
    };
  }, [release]);
  return status;
}
