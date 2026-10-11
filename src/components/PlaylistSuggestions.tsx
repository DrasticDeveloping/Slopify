import { useEffect } from "react";
import { discoveryKey } from "../recommend/discover";
import { useDiscovery } from "../recommend/useDiscovery";
import { addToPlaylist, hideDiscovery, playList } from "../state/actions";
import { addDiscoveredSong, canStream, registerStreams, streamTrackId } from "../state/importer";
import { getState } from "../state/store";
import { Art } from "./Artwork";
import { hashString, paletteFromSeed } from "../data/library";
import { Icon } from "./Icon";

export function PlaylistSuggestions({ id, name, seedIds }: { id: string; name: string; seedIds: string[] }) {
  const { songs, loading, note, refresh } = useDiscovery(`playlist-${id}`, seedIds, undefined, 5);
  useEffect(() => registerStreams(songs), [songs]);
  const ids = songs.filter((s) => canStream(s.candidate)).map((s) => streamTrackId(s.key));
  return <section className="playlist-suggestions" aria-label="Recommended for this playlist">
    <div className="shelf-head"><div><h2>Recommended for this playlist</h2><p className="muted">New songs that fit {name}</p></div><button type="button" className="text-btn" disabled={loading} onClick={refresh}>Find more</button></div>
    {songs.map((song) => <div className="suggestion-row" key={song.key}>
      <Art palette={paletteFromSeed(hashString(song.key))} image={song.artwork} glyph={3} />
      <button type="button" className="icon-btn" aria-label={`Play ${song.title}`} onClick={() => canStream(song.candidate) ? playList(ids, streamTrackId(song.key), { label: `Suggestions for ${name}`, route: { name: "playlist", id } }) : void addDiscoveredSong(song.candidate, song.kind)}><Icon name="play" size={18} /></button>
      <div className="suggestion-title"><strong>{song.title}</strong><span className="muted">{song.artist}</span></div>
      <button type="button" className="btn" onClick={() => {
        const s = getState();
        const owned = Object.values(s.tracks).find((t) => !t.stream && discoveryKey(s.artists[t.artistId]?.name, t.title) === song.key);
        if (owned) addToPlaylist(id, [owned.id]);
        else if (canStream(song.candidate)) addToPlaylist(id, [streamTrackId(song.key)]);
        else void addDiscoveredSong(song.candidate, song.kind, { play: false, done: (libraryId) => addToPlaylist(id, [libraryId]) });
      }}>Add</button>
      <button type="button" className="icon-btn" aria-label={`Hide ${song.title}`} onClick={() => hideDiscovery(song.key, song.kind)}><Icon name="close" size={16} /></button>
    </div>)}
    {loading || !songs.length || note ? <p className="muted" role="status">{loading ? "Finding songs for this playlist…" : note || "No more matching songs right now."}</p> : null}
  </section>;
}
