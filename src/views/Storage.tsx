import { creditLine } from "../lib/credits";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { TrackArt } from "../components/Artwork";
import { Icon } from "../components/Icon";
import { formatBytes, plural } from "../lib/format";
import { openTrackMenu } from "../lib/menus";
import { deleteFromDevice, findMusic, playList } from "../state/actions";
import { setState, useStore } from "../state/store";
import { Empty } from "./Collection";

type Scope = "songs" | "downloads" | "files";
type Sort = "size" | "title" | "recent";
interface Disk { total: number; free: number; source: "disk" | "browser" }

/**
 * The real size and free space of the disk the library is on, from the music
 * server. Without one (the app served from elsewhere), the space this browser
 * lets Slopify use.
 */
function useDisk() {
  const [disk, setDisk] = useState<Disk | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = async (): Promise<Disk | null> => {
      try {
        const res = await fetch("/api/storage/disk", { cache: "no-store" });
        const body = (await res.json()) as { ok?: boolean; result?: { total: number; free: number } };
        if (res.ok && body.ok && body.result && body.result.total > 0) return { ...body.result, source: "disk" };
      } catch {
        // No music server here.
      }
      const estimate = await navigator.storage?.estimate?.().catch(() => null);
      if (estimate?.quota) return { total: estimate.quota, free: Math.max(0, estimate.quota - (estimate.usage ?? 0)), source: "browser" };
      return null;
    };
    void load().then((d) => live && setDisk(d));
    return () => {
      live = false;
    };
  }, []);
  return disk;
}

export function StorageView() {
  const tracks = useStore((s) => s.tracks);
  const trackIds = useStore((s) => s.trackIds);
  const artists = useStore((s) => s.artists);
  const [scope, setScope] = useState<Scope>("songs");
  const [sort, setSort] = useState<Sort>("size");
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);

  const disk = useDisk();
  const local = useMemo(() => trackIds.map((id) => tracks[id]).filter((t) => t && t.storage !== "server"), [tracks, trackIds]);
  const fileBytes = local.filter((t) => t.storage === "files").reduce((n, t) => n + t.size, 0);
  const dlBytes = local.filter((t) => t.storage === "downloads").reduce((n, t) => n + t.size, 0);
  const total = disk?.total ?? 0;
  const free = disk?.free ?? 0;
  // Everything else on the disk (other apps, and files Slopify doesn't count).
  const otherBytes = Math.max(0, total - free - fileBytes - dlBytes);

  const list = useMemo(() => {
    const l = local.filter((t) => (scope === "downloads" ? t.storage === "downloads" : scope === "files" ? t.storage === "files" : true));
    return l.sort((a, b) => (sort === "size" ? b.size - a.size : sort === "recent" ? b.addedAt - a.addedAt : a.title.localeCompare(b.title)));
  }, [local, scope, sort]);

  const segments = [
    { key: "files", label: "Imported files", bytes: fileBytes, count: local.filter((t) => t.storage === "files").length, color: "var(--series-1)" },
    { key: "downloads", label: "Server downloads", bytes: dlBytes, count: local.filter((t) => t.storage === "downloads").length, color: "var(--series-2)" },
    ...(disk?.source === "disk" ? [{ key: "other", label: "Everything else", bytes: otherBytes, count: 0, color: "var(--series-muted)" }] : []),
  ];

  // Only songs in the current view count, so nothing hidden is removed or totalled.
  const shown = list.filter((t) => picked.has(t.id));

  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const finish = () => {
    setEditing(false);
    setPicked(new Set());
  };

  return (
    <div className="view">
      <header className="page-head">
        <div>
          <span className="eyebrow">On this device</span>
          <h1>Song storage</h1>
          <p className="muted">{formatBytes(fileBytes + dlBytes)} used by Slopify{disk ? ` · ${formatBytes(free)} free` : ""}</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => findMusic()}>
            <Icon name="search" size={18} />
            Find music
          </button>
          <button type="button" className={`btn${editing ? " primary" : ""}`} onClick={() => (editing ? finish() : setEditing(true))} disabled={!list.length && !editing}>
            <Icon name={editing ? "check" : "edit"} size={18} />
            {editing ? "Done" : "Select"}
          </button>
        </div>
      </header>

      <section className="panel storage-panel" aria-labelledby="disk-title">
        <div className="storage-meter-head">
          <h2 id="disk-title">{disk?.source === "browser" ? "Space this browser allows" : "Disk usage"}</h2>
          <span className="muted small">{disk ? `${formatBytes(total)} total` : disk === null ? "Disk size unavailable" : "Checking disk…"}</span>
        </div>
        <div className="meter" role="img" aria-label={segments.map((s) => `${s.label} ${formatBytes(s.bytes)}`).join(", ") + `, free ${formatBytes(free)}`}>
          {segments.map((s) => (
            <span
              key={s.key}
              className={`meter-seg${hover && hover !== s.key ? " dim" : ""}`}
              style={{ "--w": total ? s.bytes / total : 0, "--c": s.color } as CSSProperties}
              onPointerEnter={() => setHover(s.key)}
              onPointerLeave={() => setHover(null)}
            >
              {hover === s.key ? (
                <span className="meter-tip" role="tooltip">
                  <strong>{formatBytes(s.bytes)}</strong>
                  <span>{s.label}{s.count ? ` · ${plural(s.count, "song")}` : ""}</span>
                </span>
              ) : null}
            </span>
          ))}
          <span className="meter-free" />
        </div>
        <ul className="legend">
          {segments.map((s) => (
            <li key={s.key} onPointerEnter={() => setHover(s.key)} onPointerLeave={() => setHover(null)}>
              <i style={{ background: s.color }} />
              <span>{s.label}</span>
              <strong>{formatBytes(s.bytes)}</strong>
            </li>
          ))}
          {disk ? (
            <li>
              <i className="free" />
              <span>Free</span>
              <strong>{formatBytes(free)}</strong>
            </li>
          ) : null}
        </ul>
      </section>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Storage scope">
          {(["songs", "downloads", "files"] as Scope[]).map((s) => (
            <button key={s} type="button" className={scope === s ? "on" : ""} aria-pressed={scope === s} onClick={() => { setScope(s); setPicked(new Set()); }}>
              {s === "songs" ? "All" : s === "downloads" ? "Downloads" : "Imported"}
            </button>
          ))}
        </div>
        <label className="select">
          <span className="muted small">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="size">Largest first</option>
            <option value="recent">Recently added</option>
            <option value="title">Title</option>
          </select>
        </label>
      </div>

      {editing ? (
        <div className="selection-bar">
          <button type="button" className="btn ghost sm" onClick={() => setPicked(shown.length === list.length ? new Set() : new Set(list.map((t) => t.id)))}>
            {shown.length === list.length ? "Clear" : "Select all"}
          </button>
          <span><strong>{shown.length}</strong> selected · {formatBytes(shown.reduce((n, t) => n + t.size, 0))}</span>
          <span className="spacer" />
          <button type="button" className="btn danger sm" disabled={!shown.length} onClick={() => { deleteFromDevice(shown.map((t) => t.id)); finish(); }}>
            <Icon name="trash" size={16} />
            Remove from device
          </button>
        </div>
      ) : null}

      {list.length ? (
        <div className="storage-list" role="list">
          {list.map((t, i) => {
            const on = picked.has(t.id);
            return (
              <div
                key={t.id}
                role="listitem"
                className={`storage-row${on ? " picked" : ""}`}
                style={{ "--i": Math.min(i, 18) } as CSSProperties}
                onContextMenu={(e) => { setState({ selection: [t.id] }); openTrackMenu(e, [t.id]); }}
              >
                <button
                  type="button"
                  className="storage-hit"
                  onClick={() => (editing ? toggle(t.id) : playList(list.map((x) => x.id), t.id, { label: "Song storage", route: { name: "storage" } }))}
                  aria-label={editing ? `${on ? "Deselect" : "Select"} ${t.title}` : `Play ${t.title}`}
                  aria-pressed={editing ? on : undefined}
                />
                {editing ? <span className={`check${on ? " on" : ""}`} aria-hidden="true">{on ? <Icon name="check" size={14} /> : null}</span> : null}
                <TrackArt trackId={t.id} className="row-art" />
                <span className="title-text">
                  <span className="t-name">{t.title}</span>
                  <span className="t-sub">{creditLine(t, artists)} · {t.storage === "downloads" ? "Downloaded" : "Imported"}{t.kind === "video" ? " · Video" : ""}</span>
                </span>
                <span className="size-bar" aria-hidden="true"><i style={{ "--w": Math.min(1, t.size / (list[0]?.size || 1)) } as CSSProperties} /></span>
                <span className="size">{formatBytes(t.size)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty icon="storage" title={scope === "downloads" ? "No server downloads yet" : "No songs stored yet"} body={scope === "downloads" ? "Download songs from your music server to keep them offline." : "Import audio files to add them to this device."} />
      )}
    </div>
  );
}
