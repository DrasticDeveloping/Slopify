import { useEffect, useMemo, useState } from "react";
import { hashString, paletteFromSeed } from "../data/library";
import { openTrackMenu } from "../lib/menus";
import { discoveryQueries, discoverySeeds, fetchRelated, pickDiscoveries, relatedLinks, SHELF_TARGET, type DiscoveredSong, type DiscoveryBatch, type Related } from "../recommend/discover";
import { hideDiscovery, navigate, playList, rememberSongLinks, saveStream, togglePlay } from "../state/actions";
import { addDiscoveredSong, canStream, registerStreams, searchDiscovery, streamTrackId, useImport, type Resolution } from "../state/importer";
import { getState, useStore, type Route } from "../state/store";
import { Art, TrackArt } from "./Artwork";
import { Icon } from "./Icon";
import { Shelf } from "./Shelf";

/* Kept across visits to Home: relationships for a day, provider searches for ten minutes. */
const related = new Map<string, { at: number; value: Related }>();
const searches = new Map<string, { at: number; value: Resolution }>();
function remember<T>(cache: Map<string, { at: number; value: T }>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > 40) cache.delete(cache.keys().next().value!);
}

const tasteInput = () => {
  const s = getState();
  return { tracks: s.tracks, artists: s.artists, playlists: s.playlists, taste: s.taste };
};

const SUBTITLE = "Songs outside your library, picked from what you play. Play any of them in full, or add it to your library.";

/** Songs outside the library, chosen from your imported favourites. Home's "Recommended for you" by default. */
export function DiscoveryShelf({ title = "Discover new music", subtitle = SUBTITLE }: { title?: string; subtitle?: string }) {
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const playlists = useStore((s) => s.playlists);
  const rev = useStore((s) => s.taste.rev);
  const available = useImport((s) => s.available);
  const importing = useImport((s) => s.busy === "import");
  const currentId = useStore((s) => s.currentId);
  const isPlaying = useStore((s) => s.isPlaying);
  const buffering = useStore((s) => s.buffering);
  const [refresh, setRefresh] = useState(0);
  const [batches, setBatches] = useState<DiscoveryBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");

  const seeds = useMemo(() => discoverySeeds(tasteInput()), [rev, tracks, artists, playlists]);
  const seedKey = JSON.stringify([seeds.songs.map((s) => [s.name, s.title]), seeds.artists.map((s) => s.name)]);
  // Re-filters as the library and feedback change, without searching again.
  const songs = useMemo(() => pickDiscoveries(batches, tasteInput()), [batches, rev, tracks]);

  useEffect(() => {
    if (available === false) {
      setBatches([]);
      setNote("Discovery needs the import service. Start the app with npm run dev.");
      return;
    }
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), 90_000);
    let live = true;
    setBatches([]);
    setLoading(true);
    setNote("");
    void (async () => {
      let graph: Related | null = null;
      let message = "";
      if (seeds.songs.length || seeds.artists.length) {
        const hit = related.get(seedKey);
        if (hit && Date.now() - hit.at < 86_400_000) graph = hit.value;
        else {
          try {
            graph = await fetchRelated(seeds, controller.signal);
            remember(related, seedKey, graph);
            rememberSongLinks(relatedLinks(graph));
          } catch {
            message = "ListenBrainz couldn't be reached, so these come from plain searches.";
          }
        }
        if (!live) return;
      } else message = "Like, save or play songs you've imported and suggestions will follow your taste.";

      const queries = discoveryQueries(graph, seeds, tasteInput(), refresh);
      if (graph && queries.every((q) => q.kind === "discover-search")) message = "ListenBrainz has no related songs for your favourites yet, so these come from plain searches.";
      const found: DiscoveryBatch[] = [];
      let failed = 0;
      let next = 0;
      // Three searches at a time; each result shows as soon as it arrives. Reserve searches only run while the shelf is short.
      const short = () => pickDiscoveries(found, tasteInput()).length < SHELF_TARGET;
      const worker = async () => {
        while (next < queries.length && live && short()) {
          const query = queries[next++];
          try {
            const hit = searches.get(query.text);
            const fresh = hit && Date.now() - hit.at < (hit.value.candidates.length ? 10 : 1) * 60_000;
            const result = fresh ? hit.value : await searchDiscovery(query.text, AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]));
            if (!fresh) remember(searches, query.text, result);
            found.push({ query, candidates: result.candidates });
            if (live) setBatches([...found]);
          } catch {
            failed++;
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (!live) return;
      if (failed && failed === queries.length) message = "The music services couldn't be reached. Try again in a moment.";
      else if (failed && !message) message = "Some searches failed, so there are fewer suggestions than usual.";
      setNote(message);
      setLoading(false);
    })();
    return () => {
      live = false;
      controller.abort();
      clearTimeout(deadline);
      setLoading(false);
    };
  }, [seedKey, refresh, available]);

  // Suggestions become songs the player knows, so they play, queue and show like library songs.
  useEffect(() => registerStreams(songs), [songs]);
  const playable = songs.filter((song) => canStream(song.candidate) && tracks[streamTrackId(song.key)]);
  const ids = playable.map((song) => streamTrackId(song.key));
  const picks = Object.fromEntries(playable.map((song) => [streamTrackId(song.key), song.kind]));
  const context = { label: title, route: { name: "home" } as Route };
  const play = (song: DiscoveredSong) => {
    const id = streamTrackId(song.key);
    if (currentId === id) togglePlay();
    else if (ids.includes(id)) playList(ids, id, { ...context, picks });
    // Sources that can't be streamed are added to the library and played from there.
    else void addDiscoveredSong(song.candidate, song.kind);
  };

  return (
    <section className="discovery" aria-label={title}>
      <Shelf
        title={title}
        subtitle={subtitle}
        action={
          <>
            <button type="button" className="text-btn" disabled={!ids.length} onClick={() => playList(ids, ids[0], { ...context, picks })}>Play all</button>
            <button type="button" className="text-btn" disabled={loading} onClick={() => { searches.clear(); setRefresh((n) => n + 1); }}>Find more</button>
          </>
        }
      >
        {songs.map((song) => {
          const id = streamTrackId(song.key);
          const known = Boolean(tracks[id]);
          const current = currentId === id;
          return (
            <div key={song.key} className={`card rec-card${current ? " current" : ""}`} onContextMenu={known ? (e) => openTrackMenu(e, [id], { context: { ...context, ids } }) : undefined}>
              <div className="card-art">
                {known ? <TrackArt trackId={id} /> : <Art palette={paletteFromSeed(hashString(song.key))} glyph={3} image={song.artwork} />}
                <button
                  type="button"
                  className={`play-fab md card-fab${current && isPlaying ? " is-playing" : ""}${buffering === id ? " loading" : ""}`}
                  aria-label={current && isPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
                  onClick={() => play(song)}
                >
                  <Icon name={current && isPlaying ? "pause" : "play"} size={20} />
                </button>
                <button type="button" className="icon-btn rec-dismiss" aria-label={`Not interested in ${song.title}`} title="Not interested" onClick={() => hideDiscovery(song.key, song.kind)}>
                  <Icon name="close" size={16} />
                </button>
              </div>
              <button type="button" className="card-link" onClick={() => (known ? navigate({ name: "album", id: tracks[id].albumId }) : play(song))}>
                <strong>{song.title}</strong>
                <span>{song.artist}</span>
              </button>
              <p className="rec-reason">{song.reason}</p>
              <button
                type="button"
                className="text-btn rec-save"
                disabled={importing}
                onClick={() => (known ? saveStream(id) : void addDiscoveredSong(song.candidate, song.kind, { play: false }))}
              >
                <Icon name="plus" size={14} />
                {song.candidate.requiresReview ? "Review & add" : "Add to library"}
              </button>
            </div>
          );
        })}
        {!songs.length ? (
          <p className="muted shelf-empty" role="status">{loading ? "Finding songs for you…" : note || "No new songs found right now. Try Find more."}</p>
        ) : null}
      </Shelf>
      {songs.length && (note || loading) ? <p className="muted small discovery-note" role="status">{loading ? "Finding more…" : note}</p> : null}
    </section>
  );
}
