import { useEffect } from "react";
import { hashString, paletteFromSeed } from "../data/library";
import type { DiscoveredSong } from "../recommend/discover";
import { ownedCopies, ownedIndex } from "../recommend/owned";
import { useDiscovery } from "../recommend/useDiscovery";
import { addToPlaylist, hideDiscovery, playList } from "../state/actions";
import { addDiscoveredSong, canStream, registerStreams, streamTrackId } from "../state/importer";
import { getState } from "../state/store";
import { Art } from "./Artwork";
import { Icon } from "./Icon";

/** Adds a suggestion to the playlist: the library copy if it's been saved, else the stream, else after downloading it. */
function addSuggestion(playlistId: string, song: DiscoveredSong) {
  const [owned] = ownedCopies(ownedIndex(getState()), song);
  if (owned) addToPlaylist(playlistId, [owned]);
  else if (canStream(song.candidate)) addToPlaylist(playlistId, [streamTrackId(song.key)]);
  else void addDiscoveredSong(song.candidate, song.kind, { play: false, done: (libraryId) => addToPlaylist(playlistId, [libraryId]) });
}

/** A few new songs that fit a playlist, found from the songs already in it. */
export function PlaylistSuggestions({ id, name, seedIds }: { id: string; name: string; seedIds: string[] }) {
  const { songs, loading, note, refresh } = useDiscovery(`playlist-${id}`, { seedIds, limit: 5 });
  useEffect(() => registerStreams(songs), [songs]);
  const ids = songs.filter((song) => canStream(song.candidate)).map((song) => streamTrackId(song.key));
  const play = (song: DiscoveredSong) => {
    if (canStream(song.candidate)) playList(ids, streamTrackId(song.key), { label: `Suggestions for ${name}`, route: { name: "playlist", id } });
    else void addDiscoveredSong(song.candidate, song.kind);
  };
  const status = loading ? "Finding songs for this playlist…" : note || (!songs.length ? "No more matching songs right now." : "");

  return (
    <section className="playlist-suggestions" aria-label="Recommended for this playlist">
      <div className="shelf-head">
        <div>
          <h2>Recommended for this playlist</h2>
          <p className="muted">New songs that fit {name}</p>
        </div>
        <button type="button" className="text-btn" disabled={loading} onClick={refresh}>Find more</button>
      </div>
      {songs.map((song) => (
        <div className="suggestion-row" key={song.key}>
          <Art palette={paletteFromSeed(hashString(song.key))} image={song.artwork} glyph={3} />
          <button type="button" className="icon-btn" aria-label={`Play ${song.title}`} onClick={() => play(song)}>
            <Icon name="play" size={18} />
          </button>
          <div className="suggestion-title">
            <strong>{song.title}</strong>
            <span className="muted">{song.artist}</span>
          </div>
          <button type="button" className="btn" onClick={() => addSuggestion(id, song)}>Add</button>
          <button type="button" className="icon-btn" aria-label={`Hide ${song.title}`} onClick={() => hideDiscovery(song.key, song.kind)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
      {status ? <p className="muted" role="status">{status}</p> : null}
    </section>
  );
}
