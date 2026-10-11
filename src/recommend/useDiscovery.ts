import { useEffect, useRef, useState } from "react";
import { discoveryKey, discoverySeeds, type DiscoveredSong, type DiscoveryQuery } from "./discover";
import { discover, seedsForIds } from "./service";
import { getState, useStore } from "../state/store";

export function useDiscovery(scope: string, seedIds?: string[], queries?: DiscoveryQuery[], limit = 30) {
  const rev = useStore((s) => s.taste.rev);
  const tracks = useStore((s) => s.tracks);
  const [edition, setEdition] = useState(0);
  const [songs, setSongs] = useState<DiscoveredSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const seen = useRef(new Set<string>());
  const previousScope = useRef(scope);
  if (previousScope.current !== scope) { seen.current = new Set(); previousScope.current = scope; }
  const seeds = seedIds ? seedsForIds(seedIds, edition * 5) : discoverySeeds(getState());
  const key = JSON.stringify([scope, seeds.songs.map((s) => [s.name, s.title]), seeds.artists.map((s) => s.name), queries]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { controller.abort(); setLoading(false); setNote("Music searches took too long. Try again later."); }, 90_000);
    setLoading(true);
    setSongs([]);
    setNote("");
    void discover({ seeds, queries, signal: controller.signal, refresh: edition, exclude: new Set(seen.current), limit, budget: limit <= 5 ? 12 : 48, onSongs: (next) => { if (!controller.signal.aborted) setSongs(next); } }).then(
      (result) => { if (!controller.signal.aborted) { setSongs(result.songs); setNote(result.note); } },
      () => { if (!controller.signal.aborted) setNote("Music services could not be reached. Try again later."); },
    ).finally(() => { clearTimeout(timer); if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [key, edition, limit]);
  const owned = new Set(Object.values(tracks).filter((t) => !t.stream).map((t) => discoveryKey(getState().artists[t.artistId]?.name, t.title)));
  const visible = songs.filter((song) => !getState().taste.hiddenDiscoveries[song.key] && !owned.has(song.key));
  void rev; // global dismissals update immediately, without rebuilding the edition.
  return { songs: visible, loading, note, refresh: () => {
    songs.forEach((song) => seen.current.add(song.key));
    setEdition((n) => n + 1);
  } };
}
