import { useEffect } from "react";
import { hashString, paletteFromSeed } from "../data/library";
import { openTrackMenu } from "../lib/menus";
import { type DiscoveredSong, type DiscoveryQuery } from "../recommend/discover";
import { useDiscovery } from "../recommend/useDiscovery";
import { addToPlaylist, hideDiscovery, navigate, playList, saveStream, togglePlay } from "../state/actions";
import { addDiscoveredSong, canStream, registerStreams, streamTrackId, useImport } from "../state/importer";
import { useStore, type Route } from "../state/store";
import { Art, TrackArt } from "./Artwork";
import { Icon } from "./Icon";
import { Shelf } from "./Shelf";

const SUBTITLE = "Songs outside your library, picked from what you play. Play any of them in full, or add it to your library.";

export function DiscoveryShelf({ title = "Discover new music", subtitle = SUBTITLE, seedIds, queries, playlistId, limit = 30 }: { title?: string; subtitle?: string; seedIds?: string[]; queries?: DiscoveryQuery[]; playlistId?: string; limit?: number }) {
  const result = useDiscovery(playlistId ?? title, seedIds, queries, limit);
  return <DiscoveryCards {...result} title={title} subtitle={subtitle} playlistId={playlistId} />;
}

export function DiscoveryCards({ songs, loading = false, note = "", refresh, title, subtitle, playlistId, onHide, route = { name: "home" } }: { songs: DiscoveredSong[]; loading?: boolean; note?: string; refresh?: () => void; title: string; subtitle?: string; playlistId?: string; onHide?: (key: string) => void; route?: Route }) {
  const tracks = useStore((s) => s.tracks);
  const importing = useImport((s) => s.busy === "import");
  const currentId = useStore((s) => s.currentId);
  const isPlaying = useStore((s) => s.isPlaying);
  const buffering = useStore((s) => s.buffering);
  // Suggestions become songs the player knows, so they play, queue and show like library songs.
  useEffect(() => registerStreams(songs), [songs]);
  const playable = songs.filter((song) => canStream(song.candidate) && tracks[streamTrackId(song.key)]);
  const ids = playable.map((song) => streamTrackId(song.key));
  const picks = Object.fromEntries(playable.map((song) => [streamTrackId(song.key), song.kind]));
  const context = { label: title, route };
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
            {refresh ? <button type="button" className="text-btn" disabled={loading} onClick={refresh}>Find more</button> : null}
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
                <button type="button" className="icon-btn rec-dismiss" aria-label={`${onHide ? "Hide from this mix:" : "Not interested in"} ${song.title}`} title={onHide ? "Hide from this mix" : "Not interested"} onClick={() => onHide ? onHide(song.key) : hideDiscovery(song.key, song.kind)}>
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
                onClick={() => (known ? (playlistId ? addToPlaylist(playlistId, [id]) : saveStream(id)) : void addDiscoveredSong(song.candidate, song.kind, { play: false, ...(playlistId ? { done: (libraryId: string) => addToPlaylist(playlistId, [libraryId]) } : {}) }))}
              >
                <Icon name="plus" size={14} />
                {song.candidate.requiresReview ? "Review & add" : playlistId ? "Add to playlist" : "Add to library"}
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
