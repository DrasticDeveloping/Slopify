import { useMemo, useState, type CSSProperties } from "react";
import { TrackArt } from "../components/Artwork";
import { Bars, Icon } from "../components/Icon";
import { formatTime, plural } from "../lib/format";
import { openTrackMenu } from "../lib/menus";
import { findMusic, isOnServer, openModal, playList, togglePlay } from "../state/actions";
import { cancelDownloads, connect, downloadTracks } from "../state/server";
import { syncNow } from "../state/sync";
import { useStore } from "../state/store";
import { Empty } from "./Collection";

type Scope = "all" | "remote" | "device";

export function ServerView() {
  const tracks = useStore((s) => s.tracks);
  const trackIds = useStore((s) => s.trackIds);
  const artists = useStore((s) => s.artists);
  const albums = useStore((s) => s.albums);
  const server = useStore((s) => s.server);
  const url = location.origin;
  const downloadMode = useStore((s) => s.settings.downloadMode);
  const playlistCount = useStore((s) => s.playlists.filter((p) => !p.system).length);
  const currentId = useStore((s) => s.currentId);
  const isPlaying = useStore((s) => s.isPlaying);
  const [scope, setScope] = useState<Scope>("all");
  const [q, setQ] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const catalog = useMemo(() => trackIds.map((id) => tracks[id]).filter((t) => t && isOnServer(t)), [tracks, trackIds]);
  const onDevice = catalog.filter((t) => t.storage === "downloads").length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return catalog.filter((t) => {
      if (scope === "remote" && t.storage !== "server") return false;
      if (scope === "device" && t.storage === "server") return false;
      return !needle || `${t.title} ${artists[t.artistId]?.name} ${albums[t.albumId]?.title}`.toLowerCase().includes(needle);
    });
  }, [catalog, scope, q, artists, albums]);

  const connected = server.status === "connected";
  const remoteIds = shown.filter((t) => t.storage === "server").map((t) => t.id);
  const active = Object.keys(server.downloads).length;
  const canDownload = connected && downloadMode === "verified_file_cache";

  if (!connected) {
    return (
      <div className="view">
        <header className="page-head"><div><span className="eyebrow">Music server</span><h1>Server</h1></div></header>
        <div className="panel server-offline">
          <span className={`status-orb ${server.status}`} />
          <div>
            <strong>{server.status === "connecting" ? "Connecting…" : "You're offline"}</strong>
            <p className="muted">{url}</p>
          </div>
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => openModal({ type: "settings", tab: "server" })}>Connection settings</button>
          <button type="button" className="btn primary" disabled={server.status === "connecting"} onClick={() => void connect({ announce: true })}>Reconnect</button>
        </div>
      </div>
    );
  }

  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="view">
      <header className="server-hero panel">
        <div className="server-id">
          <span className="status-orb connected" aria-hidden="true" />
          <div>
            <span className="eyebrow">Connected · {downloadMode === "stream_only" ? "Stream only" : "Device copies"} · Songs saved as links</span>
            <button type="button" className="server-url" onClick={() => openModal({ type: "settings", tab: "server" })} title="Connection settings">
              <span className="server-url-text">{url.replace(/^https?:\/\//, "")}</span>
              <Icon name="edit" size={16} />
            </button>
          </div>
        </div>
        <dl className="stat-row">
          <div><dt>Songs</dt><dd>{catalog.length}</dd></div>
          <div><dt>Playlists</dt><dd>{playlistCount}</dd></div>
          <div><dt>On device</dt><dd>{onDevice}</dd></div>
        </dl>
        <div className="server-actions">
          <button type="button" className="btn" onClick={() => void syncNow()}><Icon name="sync" size={18} />Sync library</button>
          <button type="button" className="btn" onClick={() => findMusic()}>
            <Icon name="plus" size={18} />Save a song
          </button>
          {active ? (
            <button type="button" className="btn danger" onClick={() => cancelDownloads()}><Icon name="close" size={18} />Cancel {active}</button>
          ) : (
            <button type="button" className="btn primary" disabled={!canDownload || !remoteIds.length} onClick={() => downloadTracks(remoteIds)}>
              <Icon name="download" size={18} />Download {q || scope !== "all" ? "shown" : "all"}
            </button>
          )}
        </div>
      </header>

      <div className="toolbar">
        <label className="field search-field">
          <Icon name="search" size={18} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter server songs" aria-label="Filter server songs" />
          {q ? <button type="button" className="icon-btn sm" onClick={() => setQ("")} aria-label="Clear filter"><Icon name="close" size={14} /></button> : null}
        </label>
        <div className="segmented" role="group" aria-label="Server scope">
          {(["all", "remote", "device"] as Scope[]).map((s) => (
            <button key={s} type="button" className={scope === s ? "on" : ""} aria-pressed={scope === s} onClick={() => setScope(s)}>
              {s === "all" ? "All" : s === "remote" ? "Not downloaded" : "On device"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {canDownload ? (
          <button type="button" className={`btn sm${selecting ? " primary" : " ghost"}`} onClick={() => { setSelecting(!selecting); setPicked(new Set()); }}>
            {selecting ? "Cancel" : "Select"}
          </button>
        ) : null}
        {selecting ? (
          <button type="button" className="btn sm primary" disabled={!picked.size} onClick={() => { downloadTracks([...picked]); setSelecting(false); setPicked(new Set()); }}>
            <Icon name="download" size={16} />Download {picked.size || ""}
          </button>
        ) : null}
      </div>
      <p className="muted small result-line">{q || scope !== "all" ? `Showing ${shown.length} of ${catalog.length}` : plural(catalog.length, "song")}</p>

      {shown.length ? (
        <div className="server-list" role="list">
          {shown.map((t, i) => {
            const progress = server.downloads[t.id];
            const current = currentId === t.id;
            const on = picked.has(t.id);
            const selectable = selecting && t.storage === "server";
            return (
              <div key={t.id} role="listitem" className={`server-row${current ? " current" : ""}${on ? " picked" : ""}`} style={{ "--i": Math.min(i, 18) } as CSSProperties} onContextMenu={(e) => openTrackMenu(e, [t.id])}>
                <button
                  type="button"
                  className="storage-hit"
                  onClick={() => (selectable ? toggle(t.id) : current ? togglePlay() : playList(shown.map((x) => x.id), t.id, { label: "Music server", route: { name: "server" } }))}
                  aria-label={selectable ? `${on ? "Deselect" : "Select"} ${t.title}` : current && isPlaying ? `Pause ${t.title}` : `Stream ${t.title}`}
                />
                {selecting ? <span className={`check${on ? " on" : ""}${t.storage !== "server" ? " disabled" : ""}`} aria-hidden="true">{on || t.storage !== "server" ? <Icon name="check" size={14} /> : null}</span> : null}
                <TrackArt trackId={t.id} className="row-art" />
                <span className="title-text">
                  <span className="t-name">{current ? <Bars paused={!isPlaying} /> : null}{t.title}</span>
                  <span className="t-sub">{artists[t.artistId]?.name}</span>
                </span>
                <span className="album-col muted">{albums[t.albumId]?.title}</span>
                <span className="dur muted">{formatTime(t.duration)}</span>
                <span className="status-col">
                  {t.storage === "downloads" ? (
                    <span className="status-chip ok"><Icon name="downloaded" size={15} />On device</span>
                  ) : progress !== undefined ? (
                    <span className="status-chip"><span className="ring" style={{ "--p": progress } as CSSProperties} />{Math.round(progress * 100)}%</span>
                  ) : canDownload ? (
                    <button type="button" className="icon-btn row-dl" onClick={() => downloadTracks([t.id])} aria-label={`Download ${t.title}`}>
                      <Icon name="download" size={18} />
                    </button>
                  ) : (
                    <span className="status-chip"><Icon name="globe" size={14} />Stream</span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty icon="server" title="No matching songs" body="Try another search or filter." />
      )}
    </div>
  );
}
