import { useState, type DragEvent } from "react";
import { plural } from "../lib/format";
import { openPlaylistMenu } from "../lib/menus";
import { addToPlaylist, navigate, openModal } from "../state/actions";
import { setState, useStore, type Route } from "../state/store";
import { PlaylistArt } from "./Artwork";
import { Icon } from "./Icon";
import { DRAG_MIME } from "./TrackList";

const nav: Array<{ route: Route; label: string; icon: string; match: Route["name"][] }> = [
  { route: { name: "home" }, label: "Home", icon: "home", match: ["home"] },
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
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const contextRoute = useStore((s) => s.context?.route);
  const isPlaying = useStore((s) => s.isPlaying);
  const serverStatus = useStore((s) => s.server.status);
  const listen = useStore((s) => s.listen);
  const [dropId, setDropId] = useState<string | null>(null);

  const over = (e: DragEvent, id: string) => {
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
    addToPlaylist(id, JSON.parse(raw) as string[]);
  };

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`} aria-label="Navigation">
      <div className="brand">
        <svg className="logo" viewBox="0 0 64 64" aria-hidden="true">
          <rect width="64" height="64" rx="18" fill="url(#lg)" />
          <defs>
            <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--accent)" />
              <stop offset="1" stopColor="var(--accent-2)" />
            </linearGradient>
          </defs>
          <g fill="#fff">
            <rect x="15" y="26" width="5" height="12" rx="2.5" />
            <rect x="24" y="18" width="5" height="28" rx="2.5" />
            <rect x="33" y="22" width="5" height="20" rx="2.5" />
            <rect x="42" y="28" width="5" height="8" rx="2.5" />
          </g>
        </svg>
        <span className="brand-name">Slopify</span>
        <button type="button" className="icon-btn collapse-btn" onClick={() => setState({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <Icon name="sidebar" size={18} />
        </button>
      </div>

      <nav className="nav">
        {nav.map((item) => {
          const active = item.match.includes(route.name) && !(route.name === "playlist");
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
              {item.route.name === "server" && serverStatus !== "connected" ? <span className="nav-dot warn" title="Server offline" /> : null}
            </button>
          );
        })}
      </nav>

      <div className="side-section">
        <div className="side-head">
          <span>Your playlists</span>
          <button type="button" className="icon-btn sm" onClick={() => openModal({ type: "createPlaylist" })} aria-label="Create playlist" title="Create playlist">
            <Icon name="plus" size={18} />
          </button>
        </div>
        <div className="side-list" role="list">
          {playlists.map((p) => {
            const active = route.name === "playlist" && route.id === p.id;
            const playing = contextRoute?.name === "playlist" && contextRoute.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="listitem"
                className={`side-item${active ? " active" : ""}${dropId === p.id ? " drop" : ""}`}
                onClick={() => navigate({ name: "playlist", id: p.id })}
                onContextMenu={(e) => openPlaylistMenu(e, p.id)}
                onDragOver={(e) => over(e, p.id)}
                onDragLeave={() => setDropId(null)}
                onDrop={(e) => drop(e, p.id)}
                title={p.name}
                aria-label={`${p.name}, ${p.system ? "collection" : "playlist"}, ${plural(p.trackIds.length, "song")}`}
              >
                <PlaylistArt playlist={p} className="side-art" />
                <span className="side-copy">
                  <strong className={playing ? "accent" : ""}>{p.name}</strong>
                  <small>{p.system ? "Collection" : "Playlist"} · {plural(p.trackIds.length, "song")}</small>
                </span>
                {playing ? <Icon name={isPlaying ? "volume" : "volumeLow"} size={16} className="accent side-speaker" /> : null}
              </button>
            );
          })}
        </div>
      </div>

      {listen.mode === "host" || listen.mode === "guest" ? (
        <button type="button" className="listen-chip" onClick={() => openModal({ type: "listenAlong" })}>
          <span className="live-dot" />
          <span>
            <strong>{listen.mode === "host" ? "Hosting a room" : `In ${listen.host}'s room`}</strong>
            <small>{plural(listen.people.length + 1, "listener")}</small>
          </span>
        </button>
      ) : null}
    </aside>
  );
}
