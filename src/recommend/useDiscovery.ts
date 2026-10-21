import { useEffect, useMemo, useRef, useState } from "react";
import { discoverySeeds, type DiscoveredSong, type DiscoveryQuery } from "./discover";
import { ownedCopies, ownedIndex } from "./owned";
import { discover, seedsForIds } from "./service";
import { getState, useStore } from "../state/store";

interface Options {
  /** Songs to base suggestions on; the listener's overall taste when absent. */
  seedIds?: string[];
  /** Fixed searches instead of ones built from seeds. */
  queries?: DiscoveryQuery[];
  limit?: number;
  /** Keep songs already in the library (an artist's popular songs). */
  withOwned?: boolean;
}

/*
 * What each surface last found, kept in localStorage so coming back to it (or
 * reopening the app) shows the same songs straight away instead of searching
 * again. A surface searches afresh on Find more, or once its songs are older
 * than KEEP_FOR. Dismissals and saves still apply to kept songs as they happen.
 */
const CACHE_KEY = "slopify.discovery.v1";
const KEEP_FOR = 12 * 3_600_000;
/** Surfaces kept (Home, plus the artist pages you've visited most recently). */
const MAX_KEPT = 16;

interface Kept {
  songs: DiscoveredSong[];
  note: string;
  edition: number;
  /** Everything this surface has shown, so Find more keeps finding new songs. */
  shown: string[];
  at: number;
}

let kept: Record<string, Kept> | null = null;
function keptAll(): Record<string, Kept> {
  if (kept) return kept;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
    kept = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, Kept>) : {};
  } catch {
    kept = {};
  }
  return kept;
}
/** A surface's kept songs, unless they're too old. */
function keptFor(id: string): Kept | undefined {
  const entry = keptAll()[id];
  return entry && Array.isArray(entry.songs) && Date.now() - entry.at < KEEP_FOR ? entry : undefined;
}
function keep(id: string, entry: Kept) {
  const all = keptAll();
  all[id] = entry;
  // The oldest go first.
  for (const [old] of Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(MAX_KEPT)) delete all[old];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {
    // Full: kept for this session only.
  }
}

/**
 * Songs outside the library for one surface. Each refresh is a new edition that
 * leaves out everything the surface has already shown; `scope` names the surface,
 * so switching to another one starts that history afresh.
 */
export function useDiscovery(scope: string, { seedIds, queries, limit = 30, withOwned = false }: Options = {}) {
  const tracks = useStore((s) => s.tracks);
  const hidden = useStore((s) => s.taste.hiddenDiscoveries);
  // The surface, whatever your taste is at the moment: its kept songs stand until Find more or they get old.
  const id = JSON.stringify([scope, seedIds ?? null, queries ?? null, limit, withOwned]);
  const [edition, setEdition] = useState(() => keptFor(id)?.edition ?? 0);
  const [songs, setSongs] = useState<DiscoveredSong[]>(() => keptFor(id)?.songs ?? []);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState(() => keptFor(id)?.note ?? "");
  const shown = useRef({ id, keys: new Set<string>(keptFor(id)?.shown ?? []) });
  /** The songs shown before Find more, kept if it finds nothing new. */
  const before = useRef<DiscoveredSong[]>([]);
  /** Find more asks for a search even when this edition is kept. */
  const wanted = useRef(-1);

  useEffect(() => {
    const hit = keptFor(id);
    const switched = shown.current.id !== id;
    if (switched) {
      shown.current = { id, keys: new Set(hit?.shown ?? []) };
      // A Find more asked for on the last surface isn't asked of this one.
      wanted.current = -1;
    }
    // Kept (and not asked to find more): shown as it was.
    if (hit && (switched || (hit.edition === edition && wanted.current !== edition))) {
      setSongs(hit.songs);
      setNote(hit.note);
      setLoading(false);
      if (hit.edition !== edition) setEdition(hit.edition);
      return;
    }
    if (switched && edition) {
      // Another surface's edition: start this one from its first.
      setEdition(0);
      return;
    }

    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    const deadline = window.setTimeout(() => {
      controller.abort();
      setLoading(false);
      setNote("Music searches took too long. Try again later.");
    }, 90_000);
    // Each edition rotates which of the surface's songs lead the seeds.
    const seeds = seedIds ? seedsForIds(seedIds, edition * 5) : discoverySeeds(getState());
    setLoading(true);
    setSongs([]);
    setNote("");
    discover({
      seeds,
      queries,
      signal: controller.signal,
      refresh: edition,
      exclude: new Set(shown.current.keys),
      limit,
      withOwned,
      // A handful of suggestions doesn't need the full search budget.
      budget: limit <= 5 ? 12 : 48,
      onSongs: (next) => live() && setSongs(next),
    })
      .then(
        (result) => {
          if (!live()) return;
          const nothingNew = !result.songs.length && edition > 0 && before.current.length > 0;
          const next = nothingNew ? before.current : result.songs;
          const nextNote = nothingNew ? "Nothing new found. Try again later." : result.note;
          setSongs(next);
          setNote(nextNote);
          // Only a search that found something is kept: an empty one (even when the
          // previous songs stay on screen) leaves the kept songs to age as before.
          wanted.current = -1;
          if (result.songs.length) {
            keep(id, { songs: result.songs, note: result.note, edition, shown: [...shown.current.keys], at: Date.now() });
          }
        },
        () => live() && setNote("Music services could not be reached. Try again later."),
      )
      .finally(() => {
        clearTimeout(deadline);
        if (live()) setLoading(false);
      });
    return () => {
      controller.abort();
      clearTimeout(deadline);
    };
    // `id` covers the seed songs and queries; your taste is read when a search starts.
  }, [id, edition]);

  // Dismissals and saves apply straight away, without searching again. A list
  // that keeps library songs points a newly saved one at its library copy instead.
  const owned = useMemo(() => ownedIndex(getState()), [tracks]);
  const listed = new Set<string>();
  const visible = songs.flatMap((song): DiscoveredSong[] => {
    if (hidden[song.key]) return [];
    const copy = ownedCopies(owned, song).find((trackId) => tracks[trackId]);
    if (!copy) return [song.owned ? { ...song, owned: undefined } : song];
    // Two uploads of a song you have are the one library song.
    if (!withOwned || listed.has(copy)) return [];
    listed.add(copy);
    return [{ ...song, owned: copy }];
  });
  const refresh = () => {
    before.current = songs;
    songs.forEach((song) => shown.current.keys.add(song.key));
    wanted.current = edition + 1;
    setEdition((n) => n + 1);
  };
  return { songs: visible, loading, note, refresh };
}
