import { useEffect, useState } from "react";

/*
 * An artist's songs ranked by popularity, and one song's statistics, from the
 * music catalog (Deezer, through server/catalog.mjs). Popularity is Deezer's
 * score for a song, out of 1,000,000. Answers are kept for the session.
 */

export const POPULARITY_MAX = 1_000_000;

export interface TopSong {
  /** The catalog's track id ("dz123"). */
  id: string;
  title: string;
  /** "(Live)", "(Album Version)": which recording of the song this is, if the catalog says. */
  version: string;
  artist: string;
  album: string;
  albumId?: string;
  artwork?: string;
  durationSeconds: number | null;
  /** Popularity score, 0 to POPULARITY_MAX. */
  rank: number;
  explicit: boolean;
  sourceUrl: string;
}

export interface SongStats extends TopSong {
  /** Beats per minute, when the catalog knows it. */
  bpm: number | null;
  /** When the release this copy is on came out (YYYY-MM-DD). */
  released: string | null;
  /** Where it ranks among the artist's songs (1 is the most popular), and how many there are. */
  position: number | null;
  of: number;
  /** The release the song first came out on, as far as the catalog can tell. */
  origin: { album: string; albumId: string; released: string; type: string; artwork?: string } | null;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(50_000) });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error?: { message?: string } } | null;
  if (!res.ok || !json?.ok || !json.result) throw new Error(json?.error?.message || "The music catalog is unavailable.");
  return json.result;
}

/** Kept for the session; a failed lookup is forgotten so the next visit asks again. */
function remembered<T>(load: (key: string) => Promise<T>) {
  const memory = new Map<string, Promise<T>>();
  return (key: string) => {
    let hit = memory.get(key);
    if (!hit) {
      hit = load(key);
      memory.set(key, hit);
      hit.catch(() => memory.delete(key));
    }
    return hit;
  };
}

const statsOf = remembered((key) => {
  const [artist, title] = JSON.parse(key) as [string, string];
  return post<{ song: SongStats | null }>("/api/catalog/song", { artist, title }).then((r) => r.song);
});

interface Loaded<T> { value: T | null; loading: boolean; error: string; retry: () => void }

function useLoaded<T>(key: string | null, load: (key: string) => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ key: string | null; value: T | null; loading: boolean; error: string }>({ key: null, value: null, loading: !!key, error: "" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return setState({ key, value: null, loading: false, error: "" });
    let live = true;
    setState((s) => (s.key === key && s.value ? { ...s, loading: true, error: "" } : { key, value: null, loading: true, error: "" }));
    load(key).then(
      (value) => live && setState({ key, value, loading: false, error: "" }),
      () => live && setState({ key, value: null, loading: false, error: "The music catalog couldn't be reached." }),
    );
    return () => {
      live = false;
    };
  }, [key, attempt]);
  // A different key's answer is never shown as this one's.
  const current = state.key === key;
  return { value: current ? state.value : null, loading: current ? state.loading : !!key, error: current ? state.error : "", retry: () => setAttempt((n) => n + 1) };
}

/** One song's statistics; `value` is null when the catalog doesn't have the song. */
export const useSongStats = (artist: string, title: string) => useLoaded(JSON.stringify([artist, title]), statsOf);

/** "933K" for a popularity score. */
export const formatPopularity = (rank: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: rank >= 100_000 ? 0 : 1 }).format(rank);

/** Versions not worth showing next to a title: the plain album recording. */
export const notableVersion = (version: string) => (/^\(?\s*(album|single|original)\s+version\s*\)?$/i.test(version.trim()) ? "" : version.trim());
