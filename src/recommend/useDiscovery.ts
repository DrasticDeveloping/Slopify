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

/**
 * Songs outside the library for one surface. Each refresh is a new edition that
 * leaves out everything the surface has already shown; `scope` names the surface,
 * so switching to another one starts that history afresh.
 */
export function useDiscovery(scope: string, { seedIds, queries, limit = 30, withOwned = false }: Options = {}) {
  const tracks = useStore((s) => s.tracks);
  const hidden = useStore((s) => s.taste.hiddenDiscoveries);
  const [edition, setEdition] = useState(0);
  const [songs, setSongs] = useState<DiscoveredSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const shown = useRef({ scope, keys: new Set<string>() });
  /** The songs shown before Find more, kept if it finds nothing new. */
  const before = useRef<DiscoveredSong[]>([]);
  if (shown.current.scope !== scope) shown.current = { scope, keys: new Set() };

  // Each edition rotates which of the surface's songs lead the seeds.
  const seeds = seedIds ? seedsForIds(seedIds, edition * 5) : discoverySeeds(getState());
  const key = JSON.stringify([scope, seeds.songs.map((s) => [s.name, s.title]), seeds.artists.map((s) => s.name), queries, limit, edition, withOwned]);

  useEffect(() => {
    const controller = new AbortController();
    const live = () => !controller.signal.aborted;
    const deadline = window.setTimeout(() => {
      controller.abort();
      setLoading(false);
      setNote("Music searches took too long. Try again later.");
    }, 90_000);
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
          if (!result.songs.length && edition && before.current.length) {
            setSongs(before.current);
            setNote("Nothing new found. Try again later.");
          } else {
            setSongs(result.songs);
            setNote(result.note);
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
    // `key` covers the seeds and queries.
  }, [key]);

  // Dismissals and saves apply straight away, without searching again. A list
  // that keeps library songs points a newly saved one at its library copy instead.
  const owned = useMemo(() => ownedIndex(getState()), [tracks]);
  const listed = new Set<string>();
  const visible = songs.flatMap((song): DiscoveredSong[] => {
    if (hidden[song.key]) return [];
    const copy = ownedCopies(owned, song).find((id) => tracks[id]);
    if (!copy) return [song.owned ? { ...song, owned: undefined } : song];
    // Two uploads of a song you have are the one library song.
    if (!withOwned || listed.has(copy)) return [];
    listed.add(copy);
    return [{ ...song, owned: copy }];
  });
  const refresh = () => {
    before.current = songs;
    songs.forEach((song) => shown.current.keys.add(song.key));
    setEdition((n) => n + 1);
  };
  return { songs: visible, loading, note, refresh };
}
