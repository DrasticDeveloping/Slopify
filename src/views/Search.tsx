import { creditsArtist } from "../lib/credits";
import { useMemo, useState, type CSSProperties } from "react";
import { ExternalSearch } from "../components/ExternalSearch";
import { ExternalArtists } from "../components/ExternalArtists";
import { inputIsLink } from "../state/importer";
import { Art, PlaylistArt, TrackArt } from "../components/Artwork";
import { Card, PlayFab, Shelf } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { plural } from "../lib/format";
import { isPlayable, navigate } from "../state/actions";
import { ChooseFiles } from "../components/ChooseFiles";
import { useStore } from "../state/store";

function score(text: string, q: string) {
  const t = text.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 60;
  if (t.split(/\s+/).some((w) => w.startsWith(q))) return 40;
  if (t.includes(q)) return 20;
  return 0;
}

type Category = "all" | "music" | "artists";
const CATEGORIES: Array<[Category, string]> = [["all", "All"], ["music", "Music"], ["artists", "Artists"]];

/** What "Playing from" says for search results: a pasted link would only be a long address. */
const searchLabel = (q: string) => (inputIsLink(q) ? "Pasted link" : `Search “${q}”`);

export function SearchView({ q }: { q: string }) {
  const [mode, setMode] = useState<Category>("all");
  const tracks = useStore((s) => s.tracks);
  const trackIds = useStore((s) => s.trackIds);
  const artists = useStore((s) => s.artists);
  const albums = useStore((s) => s.albums);
  const playlists = useStore((s) => s.playlists);
  const needle = q.trim().toLowerCase();

  const results = useMemo(() => {
    if (!needle) return null;
    // Artists and albums of library songs only (streamed recommendations are not in the library).
    const inLibrary = trackIds.map((id) => tracks[id]).filter(Boolean);
    const libraryArtists = new Set(inLibrary.map((t) => t.artistId));
    const libraryAlbums = new Set(inLibrary.map((t) => t.albumId));
    const songs = trackIds
      .map((id) => tracks[id])
      .filter(Boolean)
      .map((t) => ({ id: t.id, s: Math.max(score(t.title, needle) * 1.2, score(artists[t.artistId]?.name ?? "", needle) * 0.8, score(albums[t.albumId]?.title ?? "", needle) * 0.6) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || tracks[b.id].plays - tracks[a.id].plays)
      .map((r) => r.id);
    const arts = Object.values(artists)
      .filter((a) => libraryArtists.has(a.id))
      .map((a) => ({ a, s: score(a.name, needle) }))
      .filter((r) => r.s > 0)
      .sort((x, y) => y.s - x.s)
      .map((r) => r.a);
    const albs = Object.values(albums)
      .filter((a) => libraryAlbums.has(a.id))
      .map((a) => ({ a, s: Math.max(score(a.title, needle), score(artists[a.artistId]?.name ?? "", needle) * 0.7) }))
      .filter((r) => r.s > 0)
      .sort((x, y) => y.s - x.s)
      .map((r) => r.a);
    const pls = playlists.filter((p) => score(p.name, needle) > 0);
    const topArtist = arts[0] && score(arts[0].name, needle) >= 40 ? arts[0] : null;
    return { songs, artists: arts, albums: albs, playlists: pls, topArtist };
  }, [needle, tracks, trackIds, artists, albums, playlists]);

  if (!results) {
    return (
      <div className="view">
        <h1 className="section-title big">Browse all</h1>
        <p className="muted">Find songs on YouTube, Spotify and SoundCloud using the search bar above. You can also paste playlist links.</p>
        <ChooseFiles />
        <div className="browse-grid">
          <button type="button" className="browse-tile" style={{ "--h": 260 } as CSSProperties} onClick={() => navigate({ name: "library" })}>
            <strong>Your library</strong>
            <Art palette={{ a: "hsl(260 70% 60%)", b: "hsl(290 60% 45%)", c: "hsl(240 55% 25%)" }} icon="library" className="browse-art" />
          </button>
          <button type="button" className="browse-tile" style={{ "--h": 350 } as CSSProperties} onClick={() => navigate({ name: "playlist", id: "liked" })}>
            <strong>Liked Songs</strong>
            <Art palette={playlists[0].palette} icon="heartFill" className="browse-art" />
          </button>
          <button type="button" className="browse-tile" style={{ "--h": 160 } as CSSProperties} onClick={() => navigate({ name: "history" })}>
            <strong>Your stats</strong>
            <Art palette={{ a: "hsl(160 70% 50%)", b: "hsl(190 70% 40%)", c: "hsl(220 60% 25%)" }} icon="stats" className="browse-art" />
          </button>
        </div>
      </div>
    );
  }

  const nothing = !results.songs.length && !results.artists.length && !results.albums.length && !results.playlists.length;

  const top = results.topArtist;
  const topSong = !top && results.songs[0] ? tracks[results.songs[0]] : null;
  const topIds = top ? Object.values(tracks).filter((t) => creditsArtist(t, top.id) && isPlayable(t)).sort((a, b) => b.plays - a.plays).map((t) => t.id) : results.songs;
  const artistSearch = !inputIsLink(q.trim());
  const showMusic = mode !== "artists" || !artistSearch;

  return (
    <div className="view search-view">
      {artistSearch ? (
        <div className="chips search-categories" role="group" aria-label="Search categories">
          {CATEGORIES.map(([value, label]) => (
            <button type="button" key={value} className={`chip${mode === value ? " on" : ""}`} aria-pressed={mode === value} onClick={() => setMode(value)}>
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {/* Under "All", online artists only show when some are found. */}
      {artistSearch && mode !== "music" ? <ExternalArtists query={q.trim()} showStatus={mode === "artists"} /> : null}
      {showMusic ? <ExternalSearch query={q.trim()} /> : null}
      {showMusic && !nothing ? <><h2 className="section-title">In your library</h2><div className="search-top">
        <section>
          <h2 className="section-title">Top result</h2>
          {top || topSong ? (
            <div className="top-result">
              {top ? <Art palette={top.palette} glyph={4} round className="top-art" image={top.image} /> : <TrackArt trackId={topSong!.id} className="top-art" />}
              <button type="button" className="card-link" onClick={() => navigate(top ? { name: "artist", id: top.id } : { name: "album", id: topSong!.albumId })}>
                <strong>{top ? top.name : topSong!.title}</strong>
                <span>
                  <span className="pill">{top ? "Artist" : "Song"}</span>
                  {top ? plural(topIds.length, "song") : artists[topSong!.artistId]?.name}
                </span>
              </button>
              <PlayFab ids={topIds} startId={topSong?.id} label={top ? top.name : `“${q}”`} route={top ? { name: "artist", id: top.id } : { name: "search", q }} className="top-fab" />
            </div>
          ) : null}
        </section>
        <section className="search-songs">
          <h2 className="section-title">Songs</h2>
          <TrackList ids={results.songs.slice(0, 5)} context={{ label: searchLabel(q), route: { name: "search", q } }} showAlbum={false} showAdded={false} sortable={false} />
        </section>
      </div></> : null}
      {showMusic && results.songs.length > 5 ? (
        <section>
          <h2 className="section-title">All songs <span className="muted">{results.songs.length}</span></h2>
          <TrackList ids={results.songs} context={{ label: searchLabel(q), route: { name: "search", q } }} showAdded={false} />
        </section>
      ) : null}
      {mode !== "music" && results.artists.length ? (
        <Shelf title="Artists in your library">
          {results.artists.map((a) => (
            <Card key={a.id} round art={<Art palette={a.palette} glyph={4} round image={a.image} />} title={a.name} subtitle="Artist" onOpen={() => navigate({ name: "artist", id: a.id })} />
          ))}
        </Shelf>
      ) : null}
      {showMusic && results.albums.length ? (
        <Shelf title="Albums">
          {results.albums.map((a) => (
            <Card key={a.id} art={<Art palette={a.palette} glyph={a.glyph} image={a.artworkUrl} />} title={a.title} subtitle={[a.year, artists[a.artistId]?.name].filter(Boolean).join(" · ")} onOpen={() => navigate({ name: "album", id: a.id })} />
          ))}
        </Shelf>
      ) : null}
      {showMusic && results.playlists.length ? (
        <Shelf title="Playlists">
          {results.playlists.map((p) => (
            <Card key={p.id} art={<PlaylistArt playlist={p} />} title={p.name} subtitle={plural(p.trackIds.length, "song")} onOpen={() => navigate({ name: "playlist", id: p.id })} />
          ))}
        </Shelf>
      ) : null}
    </div>
  );
}
