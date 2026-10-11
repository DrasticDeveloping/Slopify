import { useMemo, useState, type DragEvent } from "react";
import { plural } from "../lib/format";
import { openPlaylistMenu } from "../lib/menus";
import { addToPlaylist, navigate, openModal } from "../state/actions";
import { setState, useStore, type Route } from "../state/store";
import { Art, PlaylistArt } from "./Artwork";
import { Icon } from "./Icon";
import { DRAG_MIME } from "./TrackList";

type Filter = "all" | "playlist" | "album" | "artist";
const nav: Array<{ route: Route; label: string; icon: string; match: Route["name"][] }> = [
  { route: { name: "home" }, label: "Home", icon: "home", match: ["home", "mix"] },
  { route: { name: "search", q: "" }, label: "Search", icon: "search", match: ["search"] },
  { route: { name: "library" }, label: "Library", icon: "library", match: ["library", "album", "artist"] },
  { route: { name: "playlists" }, label: "Playlists", icon: "playlists", match: ["playlists"] },
  { route: { name: "storage" }, label: "Storage", icon: "storage", match: ["storage"] },
  { route: { name: "server" }, label: "Server", icon: "server", match: ["server"] },
  { route: { name: "history" }, label: "Your stats", icon: "stats", match: ["history"] },
];
export function Sidebar() {
  const route = useStore((s) => s.route);
  const playlists = useStore((s) => s.playlists);
  const tracks = useStore((s) => s.tracks);
  const ids = useStore((s) => s.trackIds);
  const albums = useStore((s) => s.albums);
  const artists = useStore((s) => s.artists);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const contextRoute = useStore((s) => s.context?.route);
  const isPlaying = useStore((s) => s.isPlaying);
  const listen = useStore((s) => s.listen);
  const serverStatus = useStore((s) => s.server.status);
  const [dropId, setDropId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const entries = useMemo(() => {
    const library = ids.map((id) => tracks[id]).filter((t) => t && !t.stream);
    const recent = (predicate: (t: typeof library[number]) => boolean) => library.reduce((at, t) => predicate(t) ? Math.max(at, t.addedAt) : at, 0);
    const rows = [
      ...playlists.map((p) => ({ id: p.id, name: p.name, type: "playlist" as const, subtitle: `${p.system ? "Collection" : "Playlist"} · ${plural(p.trackIds.length, "song")}`, at: Math.max(p.createdAt, recent((t) => p.trackIds.includes(t.id))), art: <PlaylistArt playlist={p} className="side-art" /> })),
      ...Object.values(albums).filter((a) => library.some((t) => t.albumId === a.id)).map((a) => ({ id: a.id, name: a.title, type: "album" as const, subtitle: `Album · ${artists[a.artistId]?.name ?? "Unknown artist"}`, at: recent((t) => t.albumId === a.id), art: <Art palette={a.palette} glyph={a.glyph} image={a.artworkUrl} className="side-art" /> })),
      ...Object.values(artists).filter((a) => library.some((t) => t.artistId === a.id)).map((a) => ({ id: a.id, name: a.name, type: "artist" as const, subtitle: "Artist", at: recent((t) => t.artistId === a.id), art: <Art palette={a.palette} image={a.image} round className="side-art" /> })),
    ];
    return rows.filter((e) => filter === "all" || e.type === filter).sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  }, [ids, tracks, artists, albums, playlists, filter]);
  const over = (e: DragEvent, id: string) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy"; setDropId(id);
  };
  const drop = (e: DragEvent, id: string) => {
    setDropId(null);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    try { const data: unknown = JSON.parse(raw); if (Array.isArray(data) && data.every((v) => typeof v === "string")) addToPlaylist(id, data); } catch { /* Ignore unrelated drops. */ }
  };
  return <aside className={`sidebar library-sidebar${collapsed ? " collapsed" : ""}`} aria-label="Your library">
    <div className="side-head library-head">
      <button type="button" className="icon-btn collapse-btn" onClick={() => setState({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? "Expand Your Library" : "Collapse Your Library"} title={collapsed ? "Expand Your Library" : "Collapse Your Library"}><Icon name="sidebar" size={20} /></button>
      <button type="button" className="library-title" onClick={() => navigate({ name: "library" })}>Your Library</button>
      <button type="button" className="btn sm library-create" onClick={() => openModal({ type: "createPlaylist" })} aria-label="Create playlist" title="Create playlist"><Icon name="plus" size={18} /><span>Create</span></button>
    </div>
    <div className="library-controls">
      <div className="chips library-filters" role="group" aria-label="Filter your library">{([['playlist', 'Playlists'], ['album', 'Albums'], ['artist', 'Artists']] as const).map(([value, label]) => <button key={value} type="button" className={`chip${filter === value ? " on" : ""}`} aria-pressed={filter === value} onClick={() => setFilter(filter === value ? "all" : value)}>{label}</button>)}</div>
    </div>
    <nav className="nav">{nav.map((item) => {
      const active = item.match.includes(route.name);
      return <button key={item.label} type="button" className={`nav-item${active ? " active" : ""}`} aria-current={active ? "page" : undefined} aria-label={item.label} title={item.label} onClick={() => {
        if (item.route.name === "search") setState((s) => ({ searchFocusNonce: s.searchFocusNonce + 1 }));
        if (!(item.route.name === "search" && route.name === "search")) navigate(item.route);
      }}><Icon name={item.icon} size={21} /><span>{item.label}</span>{item.route.name === "server" && serverStatus !== "connected" ? <span className="nav-dot warn" title="Server offline" /> : null}</button>;
    })}</nav>
    <div className="side-section"><div className="side-list" role="list">{entries.map((entry) => {
      const target: Route = { name: entry.type, id: entry.id };
      const active = route.name === target.name && "id" in route && route.id === entry.id;
      const playing = contextRoute?.name === target.name && "id" in contextRoute && contextRoute.id === entry.id;
      return <button key={`${entry.type}:${entry.id}`} type="button" role="listitem" className={`side-item${active ? " active" : ""}${dropId === entry.id ? " drop" : ""}`} onClick={() => navigate(target)} onContextMenu={entry.type === "playlist" ? (e) => openPlaylistMenu(e, entry.id) : undefined} onDragOver={entry.type === "playlist" ? (e) => over(e, entry.id) : undefined} onDragLeave={() => setDropId(null)} onDrop={entry.type === "playlist" ? (e) => drop(e, entry.id) : undefined} aria-current={active ? "page" : undefined} aria-label={`${entry.name}, ${entry.subtitle}`} title={entry.name}>{entry.art}<span className="side-copy"><strong className={playing ? "accent" : ""}>{entry.name}</strong><small>{entry.subtitle}</small></span>{playing ? <Icon name={isPlaying ? "volume" : "volumeLow"} size={16} className="accent side-speaker" /> : null}</button>;
    })}{!entries.length ? <p className="muted small library-empty">Your saved music will appear here</p> : null}</div>
    </div>
    {listen.mode === "host" || listen.mode === "guest" ? <button type="button" className="listen-chip" onClick={() => openModal({ type: "listenAlong" })}><span className="live-dot" /><span><strong>{listen.mode === "host" ? "Hosting a room" : `In ${listen.host}'s room`}</strong><small>{plural(listen.people.length + 1, "listener")}</small></span></button> : null}
  </aside>;
}
