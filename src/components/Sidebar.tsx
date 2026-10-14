import { useMemo, useState, type DragEvent, type ReactNode } from "react";
import type { Album, Artist, Playlist, Track } from "../data/types";
import { plural } from "../lib/format";
import { openPlaylistMenu } from "../lib/menus";
import { addToPlaylist, navigate, openModal } from "../state/actions";
import { setState, useStore, type Route } from "../state/store";
import { Art, PlaylistArt } from "./Artwork";
import { Icon } from "./Icon";
import { DRAG_MIME } from "./TrackList";

type EntryType = "playlist" | "album" | "artist";
type Filter = "all" | EntryType;

interface Entry {
  id: string;
  type: EntryType;
  /** An album of one library song: a single, already listed under its artist. */
  single?: boolean;
  name: string;
  subtitle: string;
  /** When it last gained a song (or was created), for most-recent-first order. */
  at: number;
  art: ReactNode;
}

const nav: Array<{ route: Route; label: string; icon: string; match: Route["name"][] }> = [
  { route: { name: "home" }, label: "Home", icon: "home", match: ["home", "mix"] },
  { route: { name: "search", q: "" }, label: "Search", icon: "search", match: ["search"] },
  { route: { name: "library" }, label: "Library", icon: "library", match: ["library", "album", "artist"] },
  { route: { name: "playlists" }, label: "Playlists", icon: "playlists", match: ["playlists"] },
];

const FILTERS: Array<[EntryType, string]> = [["playlist", "Playlists"], ["album", "Albums"], ["artist", "Artists"]];

/** Playlists, plus the albums and artists of library songs, most recently added to first. */
function libraryEntries(library: Track[], playlists: Playlist[], albums: Record<string, Album>, artists: Record<string, Artist>): Entry[] {
  const added = new Map<string, number>();
  const albumSongs = new Map<string, number>();
  const latest = (key: string, at: number) => added.set(key, Math.max(added.get(key) ?? 0, at));
  for (const t of library) {
    latest(t.id, t.addedAt);
    latest(`album:${t.albumId}`, t.addedAt);
    for (const id of [t.artistId, ...(t.featuring ?? [])]) latest(`artist:${id}`, t.addedAt);
    albumSongs.set(t.albumId, (albumSongs.get(t.albumId) ?? 0) + 1);
  }
  const entries: Entry[] = playlists.map((p) => ({
    id: p.id,
    type: "playlist",
    name: p.name,
    subtitle: `${p.system ? "Collection" : "Playlist"} · ${plural(p.trackIds.length, "song")}`,
    at: Math.max(p.createdAt, ...p.trackIds.map((id) => added.get(id) ?? 0)),
    art: <PlaylistArt playlist={p} className="side-art" />,
  }));
  for (const a of Object.values(albums)) {
    const at = added.get(`album:${a.id}`);
    if (at === undefined) continue;
    const single = (albumSongs.get(a.id) ?? 0) < 2;
    entries.push({ id: a.id, type: "album", single, name: a.title, subtitle: `${single ? "Single" : "Album"} · ${artists[a.artistId]?.name ?? "Unknown artist"}`, at, art: <Art palette={a.palette} glyph={a.glyph} image={a.artworkUrl} className="side-art" /> });
  }
  for (const a of Object.values(artists)) {
    const at = added.get(`artist:${a.id}`);
    if (at === undefined) continue;
    entries.push({ id: a.id, type: "artist", name: a.name, subtitle: "Artist", at, art: <Art palette={a.palette} image={a.image} round className="side-art" /> });
  }
  return entries.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

const showsEntry = (route: Route | undefined, entry: Entry) => route?.name === entry.type && "id" in route && route.id === entry.id;

export function Sidebar() {
  const route = useStore((s) => s.route);
  const playlists = useStore((s) => s.playlists);
  const tracks = useStore((s) => s.tracks);
  const trackIds = useStore((s) => s.trackIds);
  const albums = useStore((s) => s.albums);
  const artists = useStore((s) => s.artists);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const contextRoute = useStore((s) => s.context?.route);
  const isPlaying = useStore((s) => s.isPlaying);
  const listen = useStore((s) => s.listen);
  const [dropId, setDropId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const entries = useMemo(() => {
    // Streamed suggestions are not in the library.
    const library = trackIds.map((id) => tracks[id]).filter((t) => t && !t.stream);
    return libraryEntries(library, playlists, albums, artists);
  }, [trackIds, tracks, artists, albums, playlists]);
  // Most saved songs are singles; listing each as an album as well as under its artist
  // would double the list. The Albums filter still shows them.
  const shown = filter === "all" ? entries.filter((e) => !e.single) : entries.filter((e) => e.type === filter);

  const dragOver = (e: DragEvent, id: string) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropId(id);
  };
  const drop = (e: DragEvent, id: string) => {
    setDropId(null);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const ids: unknown = JSON.parse(raw);
      if (Array.isArray(ids) && ids.every((v) => typeof v === "string")) addToPlaylist(id, ids);
    } catch {
      // Not a track drag.
    }
  };
  const collapseLabel = collapsed ? "Expand Your Library" : "Collapse Your Library";

  return (
    <aside className={`sidebar library-sidebar${collapsed ? " collapsed" : ""}`} aria-label="Your library">
      <div className="side-head library-head">
        <button type="button" className="icon-btn collapse-btn" onClick={() => setState({ sidebarCollapsed: !collapsed })} aria-label={collapseLabel} title={collapseLabel}>
          <Icon name="sidebar" size={20} />
        </button>
        <button type="button" className="library-title" onClick={() => navigate({ name: "library" })}>Your Library</button>
        <button type="button" className="btn sm library-create" onClick={() => openModal({ type: "createPlaylist" })} aria-label="Create playlist" title="Create playlist">
          <Icon name="plus" size={18} />
          <span>Create</span>
        </button>
      </div>

      <div className="library-controls">
        <div className="chips library-filters" role="group" aria-label="Filter your library">
          {FILTERS.map(([value, label]) => (
            <button key={value} type="button" className={`chip${filter === value ? " on" : ""}`} aria-pressed={filter === value} onClick={() => setFilter(filter === value ? "all" : value)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <nav className="nav">
        {nav.map((item) => {
          const active = item.match.includes(route.name);
          return (
            <button
              key={item.label}
              type="button"
              className={`nav-item${active ? " active" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-label={item.label}
              title={item.label}
              onClick={() => {
                if (item.route.name === "search") setState((s) => ({ searchFocusNonce: s.searchFocusNonce + 1 }));
                if (!(item.route.name === "search" && route.name === "search")) navigate(item.route);
              }}
            >
              <Icon name={item.icon} size={21} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="side-section">
        <div className="side-list" role="list">
          {shown.map((entry) => {
            const active = showsEntry(route, entry);
            const playing = showsEntry(contextRoute, entry);
            const playlist = entry.type === "playlist";
            return (
              <button
                key={`${entry.type}:${entry.id}`}
                type="button"
                role="listitem"
                className={`side-item${active ? " active" : ""}${dropId === entry.id ? " drop" : ""}`}
                onClick={() => navigate({ name: entry.type, id: entry.id })}
                onContextMenu={playlist ? (e) => openPlaylistMenu(e, entry.id) : undefined}
                onDragOver={playlist ? (e) => dragOver(e, entry.id) : undefined}
                onDragLeave={() => setDropId(null)}
                onDrop={playlist ? (e) => drop(e, entry.id) : undefined}
                aria-current={active ? "page" : undefined}
                aria-label={`${entry.name}, ${entry.subtitle}`}
                title={entry.name}
              >
                {entry.art}
                <span className="side-copy">
                  <strong className={playing ? "accent" : ""}>{entry.name}</strong>
                  <small>{entry.subtitle}</small>
                </span>
                {playing ? <Icon name={isPlaying ? "volume" : "volumeLow"} size={16} className="accent side-speaker" /> : null}
              </button>
            );
          })}
          {!shown.length ? <p className="muted small library-empty">Your saved music will appear here</p> : null}
        </div>
      </div>

      {listen.mode === "host" || listen.mode === "guest" ? (
        <button type="button" className="listen-chip" onClick={() => openModal({ type: "listenAlong" })}>
          <span className="live-dot" />
          <span>
            <strong>{listen.mode === "host" ? "Hosting a room" : `In ${listen.host}'s room`}</strong>
            <small>{plural(listen.members.length, "listener")}</small>
          </span>
        </button>
      ) : null}
    </aside>
  );
}
