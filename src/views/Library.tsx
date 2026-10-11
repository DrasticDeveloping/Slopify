import { useMemo, useState, type CSSProperties } from "react";
import { Art, PlaylistArt } from "../components/Artwork";
import { Icon } from "../components/Icon";
import { Card, PlayFab, Shelf } from "../components/Shelf";
import { TrackList } from "../components/TrackList";
import { formatLongDuration, plural } from "../lib/format";
import { openPlaylistMenu } from "../lib/menus";
import { isPlayable, libraryIds, likedIds, navigate, openModal, syncPlaylists, toggleShuffle } from "../state/actions";
import { getState, setState, useStore, type Route } from "../state/store";
import { Empty } from "./Collection";

type Filter = "all" | "recent" | "audio" | "video" | "downloaded" | "liked";
const filters: Array<[Filter, string]> = [
  ["all", "All songs"],
  ["recent", "Recently added"],
  ["liked", "Liked"],
  ["downloaded", "Downloaded"],
  ["audio", "Audio"],
  ["video", "Video"],
];

export function LibraryView({ filter: routeFilter }: { filter?: string }) {
  const tracks = useStore((s) => s.tracks);
  const trackIds = useStore((s) => s.trackIds);
  const playlists = useStore((s) => s.playlists);
  const shuffle = useStore((s) => s.shuffle);
  const filter: Filter = filters.some(([f]) => f === routeFilter) ? (routeFilter as Filter) : "all";
  // The filter lives in the route so the play button and "Playing from" match what's on screen.
  const setFilter = (f: Filter) => setState({ route: f === "all" ? { name: "library" } : { name: "library", filter: f } });

  const all = useMemo(() => libraryIds({ ...getState(), tracks, trackIds }), [tracks, trackIds]);
  const ids = useMemo(() => {
    const liked = new Set(likedIds({ ...getState(), playlists }));
    const weekAgo = Date.now() - 14 * 86_400_000;
    const list = all.filter((id) => {
      const t = tracks[id];
      if (filter === "recent") return t.addedAt > weekAgo;
      if (filter === "audio") return t.kind === "audio";
      if (filter === "video") return t.kind === "video";
      if (filter === "downloaded") return t.storage === "downloads";
      if (filter === "liked") return liked.has(id);
      return true;
    });
    return filter === "recent" ? list.sort((a, b) => tracks[b].addedAt - tracks[a].addedAt) : list;
  }, [all, filter, tracks, playlists]);

  const route: Route = filter === "all" ? { name: "library" } : { name: "library", filter };
  const total = ids.reduce((sum, id) => sum + tracks[id].duration, 0);
  const label = filter === "all" ? "Library" : filters.find(([f]) => f === filter)![1];

  return (
    <div className="view">
      <header className="page-head">
        <div>
          <span className="eyebrow">Your collection</span>
          <h1>Library</h1>
          <p className="muted">{plural(all.length, "song")} on this device · {formatLongDuration(all.reduce((n, id) => n + tracks[id].duration, 0))}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => openModal({ type: "import" })}>
            <Icon name="download" size={18} />
            Import
          </button>
        </div>
      </header>
      <div className="chips" role="group" aria-label="Filter songs">
        {filters.map(([f, name]) => (
          <button key={f} type="button" className={`chip${filter === f ? " on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {name}
          </button>
        ))}
      </div>
      <div className="action-bar">
        <PlayFab ids={ids} label={label} route={route} size="lg" />
        <button type="button" className={`icon-btn lg${shuffle ? " on" : ""}`} onClick={toggleShuffle} aria-pressed={shuffle} aria-label="Shuffle" title="Shuffle">
          <Icon name="shuffle" size={24} />
        </button>
        <span className="muted small">{plural(ids.length, "song")} · {formatLongDuration(total)}</span>
      </div>
      <TrackList
        key={filter}
        ids={ids}
        context={{ label, route }}
        empty={<Empty icon="music" title="No songs here yet" body={filter === "all" ? "Import audio files or download songs from your music server." : "Try another filter."} action={filter === "all" ? <button type="button" className="btn primary" onClick={() => openModal({ type: "import" })}>Import music</button> : undefined} />}
      />
    </div>
  );
}

export function PlaylistsView() {
  const playlists = useStore((s) => s.playlists);
  const tracks = useStore((s) => s.tracks);
  return (
    <div className="view">
      <header className="page-head">
        <div>
          <span className="eyebrow">Your collections</span>
          <h1>Playlists</h1>
          <p className="muted">Organize your music into collections shared across your Slopify devices.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={syncPlaylists}>
            <Icon name="sync" size={18} />
            Sync
          </button>
          <button type="button" className="btn primary" onClick={() => openModal({ type: "createPlaylist" })}>
            <Icon name="plus" size={18} />
            New playlist
          </button>
        </div>
      </header>
      <div className="card-grid">
        {playlists.map((p) => {
          const route: Route = { name: "playlist", id: p.id };
          const playable = p.trackIds.filter((id) => isPlayable(tracks[id]));
          return (
            <Card
              key={p.id}
              art={<PlaylistArt playlist={p} />}
              title={p.name}
              subtitle={`${p.system ? "Collection" : "Playlist"} · ${plural(p.trackIds.length, "song")}`}
              onOpen={() => navigate(route)}
              onMenu={(e) => openPlaylistMenu(e, p.id)}
              play={{ ids: playable, label: p.name, route }}
            />
          );
        })}
        <button type="button" className="card new-card" onClick={() => openModal({ type: "createPlaylist" })}>
          <span className="new-card-art"><Icon name="plus" size={36} /></span>
          <strong>New playlist</strong>
          <span>Start a fresh collection</span>
        </button>
      </div>
    </div>
  );
}

export function ArtistView({ id }: { id: string }) {
  const artist = useStore((s) => s.artists[id]);
  const tracks = useStore((s) => s.tracks);
  const albums = useStore((s) => s.albums);
  const [more, setMore] = useState(false);
  // Library songs only: streamed recommendations are not in it.
  const popular = useMemo(() => Object.values(tracks).filter((t) => t.artistId === id && !t.stream).sort((a, b) => b.plays - a.plays).map((t) => t.id), [tracks, id]);
  const discography = useMemo(() => {
    const owned = new Set(popular.map((t) => tracks[t].albumId));
    return Object.values(albums).filter((a) => a.artistId === id && owned.has(a.id)).sort((a, b) => b.year - a.year);
  }, [albums, id, popular, tracks]);
  if (!artist) return null;
  const route: Route = { name: "artist", id };
  const playable = popular.filter((t) => isPlayable(tracks[t]));
  return (
    <div className="view">
      <header className="artist-hero" style={{ "--a": artist.palette.a, "--b": artist.palette.b, "--c": artist.palette.c } as CSSProperties}>
        <div className="artist-hero-bg" aria-hidden="true">
          <Art palette={artist.palette} glyph={4} />
        </div>
        <div className="artist-hero-copy">
          <span className="verified">Artist</span>
          <h1 className="hero-title lg">{artist.name}</h1>
          <p>{plural(popular.length, "song")} in your library</p>
        </div>
      </header>
      <div className="action-bar">
        <PlayFab ids={playable} label={artist.name} route={route} size="lg" />
      </div>
      <h2 className="section-title">Popular</h2>
      <TrackList ids={more ? popular.slice(0, 10) : popular.slice(0, 5)} context={{ label: artist.name, route }} showAlbum={false} showPlays sortable={false} />
      {popular.length > 5 ? (
        <button type="button" className="text-btn see-more" onClick={() => setMore(!more)}>
          {more ? "Show less" : "See more"}
        </button>
      ) : null}
      <Shelf title="Discography">
        {discography.map((a) => {
          const ids = Object.values(tracks).filter((t) => t.albumId === a.id && isPlayable(t)).map((t) => t.id);
          return (
            <Card
              key={a.id}
              art={<Art palette={a.palette} glyph={a.glyph} image={a.artworkUrl} />}
              title={a.title}
              subtitle={`${a.year} · ${ids.length < 3 ? "Single" : "Album"}`}
              onOpen={() => navigate({ name: "album", id: a.id })}
              play={{ ids, label: a.title, route: { name: "album", id: a.id } }}
            />
          );
        })}
      </Shelf>
    </div>
  );
}
