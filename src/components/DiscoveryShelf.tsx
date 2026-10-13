import { useEffect } from "react";
import { hashString, paletteFromSeed } from "../data/library";
import { openTrackMenu } from "../lib/menus";
import type { DiscoveredSong, DiscoveryQuery } from "../recommend/discover";
import { useDiscovery } from "../recommend/useDiscovery";
import { hideDiscovery, navigate, playList, saveStream, togglePlay } from "../state/actions";
import { addDiscoveredSong, canStream, registerStreams, streamTrackId, useImport } from "../state/importer";
import { getState, useStore, type Route } from "../state/store";
import type { ReasonKind } from "../recommend/taste";
import { Art, TrackArt } from "./Artwork";
import { Icon } from "./Icon";
import { Shelf } from "./Shelf";

const SUBTITLE = "Songs outside your library, picked from what you play. Play any of them in full, or add it to your library.";

interface Props {
  title?: string;
  subtitle?: string;
  /** Fixed searches (an artist's popular songs) instead of ones from your taste. */
  queries?: DiscoveryQuery[];
  limit?: number;
  /** Where playback says it came from. */
  route?: Route;
  /** Include songs already in the library, which play from the library. */
  withOwned?: boolean;
}

/** Songs outside the library, as cards that play in full, and can be dismissed or added to the library. */
export function DiscoveryShelf({ title = "Discover new music", subtitle = SUBTITLE, queries, limit = 30, route = { name: "home" }, withOwned = false }: Props) {
  const { songs, loading, note, refresh } = useDiscovery(title, { queries, limit, withOwned });
  const tracks = useStore((s) => s.tracks);
  // Suggestions become songs the player knows, so they play, queue and show like library songs.
  useEffect(() => registerStreams(songs.filter((song) => !song.owned)), [songs]);
  // A song you have plays from the library.
  const idOf = (song: DiscoveredSong) => song.owned ?? streamTrackId(song.key);
  const playable = songs.filter((song) => (song.owned || canStream(song.candidate)) && tracks[idOf(song)]);
  const ids = playable.map(idOf);
  const context = { label: title, route, picks: Object.fromEntries(playable.filter((song) => !song.owned).map((song) => [streamTrackId(song.key), song.kind])) as Record<string, ReasonKind> };
  const play = (song: DiscoveredSong) => {
    const id = idOf(song);
    if (getState().currentId === id) togglePlay();
    else if (ids.includes(id)) playList(ids, id, context);
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
            <button type="button" className="text-btn" disabled={!ids.length} onClick={() => playList(ids, ids[0], context)}>Play all</button>
            <button type="button" className="text-btn" disabled={loading} onClick={refresh}>Find more</button>
          </>
        }
      >
        {songs.map((song) => (
          <DiscoveryCard key={song.key} song={song} onPlay={() => play(song)} menuContext={{ label: title, route, ids }} />
        ))}
        {!songs.length ? <p className="muted shelf-empty" role="status">{loading ? "Finding songs for you…" : note || "No new songs found right now. Try Find more."}</p> : null}
      </Shelf>
      {songs.length && (note || loading) ? <p className="muted small discovery-note" role="status">{loading ? "Finding more…" : note}</p> : null}
    </section>
  );
}

function DiscoveryCard({ song, onPlay, menuContext }: { song: DiscoveredSong; onPlay: () => void; menuContext: { label: string; route: Route; ids: string[] } }) {
  const id = song.owned ?? streamTrackId(song.key);
  const track = useStore((s) => s.tracks[id]);
  const current = useStore((s) => s.currentId === id);
  const playing = useStore((s) => s.isPlaying) && current;
  const buffering = useStore((s) => s.buffering === id);
  const importing = useImport((s) => s.busy === "import");
  return (
    <div className={`card rec-card${current ? " current" : ""}`} onContextMenu={track ? (e) => openTrackMenu(e, [id], { context: menuContext }) : undefined}>
      <div className="card-art">
        {track ? <TrackArt trackId={id} /> : <Art palette={paletteFromSeed(hashString(song.key))} glyph={3} image={song.artwork} />}
        <button type="button" className={`play-fab md card-fab${playing ? " is-playing" : ""}${buffering ? " loading" : ""}`} aria-label={`${playing ? "Pause" : "Play"} ${song.title}`} onClick={onPlay}>
          <Icon name={playing ? "pause" : "play"} size={20} />
        </button>
        {song.owned ? null : (
          <button type="button" className="icon-btn rec-dismiss" aria-label={`Not interested in ${song.title}`} title="Not interested" onClick={() => hideDiscovery(song.key, song.kind)}>
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      <button type="button" className="card-link" onClick={() => (track ? navigate({ name: "album", id: track.albumId }) : onPlay())}>
        <strong>{song.title}</strong>
        <span>{song.artist}</span>
      </button>
      <p className="rec-reason">{song.reason}</p>
      {song.owned ? (
        <span className="small muted rec-save"><Icon name="check" size={14} />In your library</span>
      ) : <button type="button" className="text-btn rec-save" disabled={importing} onClick={() => (track ? saveStream(id) : void addDiscoveredSong(song.candidate, song.kind, { play: false }))}>
        <Icon name="plus" size={14} />
        {song.candidate.requiresReview ? "Review & add" : "Add to library"}
      </button>}
    </div>
  );
}
