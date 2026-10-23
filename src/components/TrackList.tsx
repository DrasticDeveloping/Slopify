import { memo, useMemo, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { Track } from "../data/types";
import { formatAdded, formatTime } from "../lib/format";
import { announce } from "../lib/announce";
import { openTrackMenu } from "../lib/menus";
import { isPlayable, moveInPlaylist, navigate, playList, toggleLike, togglePlay } from "../state/actions";
import { PROVIDERS, trackPlatform } from "../state/importer";
import { getState, setState, snoozedUntil, useStore, type Route } from "../state/store";
import { snoozeEnds } from "../state/snooze";
import { ArtistLinks } from "./ArtistLinks";
import { TrackArt } from "./Artwork";
import { Bars, Icon } from "./Icon";

export const DRAG_MIME = "application/x-resonance-tracks";

type SortKey = "title" | "album" | "added" | "duration";

interface TrackListProps {
  ids: string[];
  context: { label: string; route?: Route };
  playlistId?: string;
  showAlbum?: boolean;
  showAdded?: boolean;
  sortable?: boolean;
  /** Allow drag-reordering (playlists only, and only when the list isn't filtered). */
  reorderable?: boolean;
  /** Override the "#" column with plays (artist pages). */
  showPlays?: boolean;
  empty?: ReactNode;
}

export function TrackList({ ids, context, playlistId, showAlbum = true, showAdded = true, sortable = true, reorderable = true, showPlays, empty }: TrackListProps) {
  const tracks = useStore((s) => s.tracks);
  const albums = useStore((s) => s.albums);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const editable = Boolean(playlistId && !sort && reorderable);

  const sorted = useMemo(() => {
    if (!sort) return ids;
    const val = (id: string): string | number => {
      const t = tracks[id];
      if (!t) return "";
      if (sort.key === "title") return t.title.toLowerCase();
      if (sort.key === "album") return albums[t.albumId]?.title.toLowerCase() ?? "";
      if (sort.key === "added") return t.addedAt;
      return t.duration;
    };
    return [...ids].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [ids, sort, tracks, albums]);

  const ctx = useMemo(() => ({ ...context, ids: sorted }), [context, sorted]);

  const cycleSort = (key: SortKey) => {
    if (!sortable) return;
    setSort((cur) => (!cur || cur.key !== key ? { key, dir: key === "added" ? -1 : 1 } : cur.dir === (key === "added" ? -1 : 1) ? { key, dir: cur.dir === 1 ? -1 : 1 } : null));
  };

  const header = (key: SortKey, label: string, cls: string) => (
    <span className="th-cell" role="columnheader" aria-sort={sort?.key === key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button type="button" className={`th ${cls}${sort?.key === key ? " sorted" : ""}`} onClick={() => cycleSort(key)} disabled={!sortable} aria-label={sortable ? `Sort by ${(label || key).toLowerCase()}` : label || key} title={label ? undefined : "Duration"}>
        <span>{label}</span>
        {sort?.key === key ? <Icon name={sort.dir === 1 ? "chevronUp" : "chevronDown"} size={14} /> : null}
      </button>
    </span>
  );

  if (!ids.length) return <>{empty}</>;

  const onDrop = (e: DragEvent, index: number) => {
    setDropAt(null);
    // Files dropped from the desktop carry no index (getData gives "", which Number reads as 0).
    if (!editable || !playlistId || !e.dataTransfer.types.includes("text/x-resonance-index")) return;
    const from = Number(e.dataTransfer.getData("text/x-resonance-index"));
    if (Number.isNaN(from) || from === index || from + 1 === index || !sorted[from]) return;
    e.preventDefault();
    // Resolve by id so the move is correct against the full playlist.
    moveInPlaylist(playlistId, sorted[from], sorted[index] ?? null);
  };

  return (
    <div className={`tracklist${showAlbum ? "" : " no-album"}${showAdded ? "" : " no-added"}`} role="table" aria-label={`${context.label} songs`}>
      <div className="tl-head" role="row">
        <span className="th num" role="columnheader">#</span>
        {header("title", "Title", "title")}
        {showAlbum ? header("album", "Album", "album") : null}
        {showAdded ? header("added", showPlays ? "Plays" : "Date added", "added") : null}
        <span className="th like" role="columnheader"><span className="sr-only">Liked</span></span>
        {header("duration", "", "dur")}
        <span className="th more" role="columnheader"><span className="sr-only">More</span></span>
      </div>
      <div className="tl-body" role="rowgroup" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropAt(null)}>
        {sorted.map((id, i) => (
          <Row
            key={id}
            id={id}
            index={i}
            ctxIds={sorted}
            ctx={ctx}
            playlistId={playlistId}
            showAlbum={showAlbum}
            showAdded={showAdded}
            showPlays={showPlays}
            draggableReorder={editable}
            dropBefore={dropAt === i}
            dropAfter={dropAt === sorted.length && i === sorted.length - 1}
            onDragOverRow={(after) => editable && setDropAt(after ? i + 1 : i)}
            onDropRow={(e, after) => onDrop(e, after ? i + 1 : i)}
          />
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  id: string;
  index: number;
  ctxIds: string[];
  ctx: { label: string; route?: Route; ids: string[] };
  playlistId?: string;
  showAlbum: boolean;
  showAdded: boolean;
  showPlays?: boolean;
  draggableReorder: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onDragOverRow: (after: boolean) => void;
  onDropRow: (e: DragEvent, after: boolean) => void;
}

const PLATFORM_NAMES = Object.fromEntries(PROVIDERS) as Record<(typeof PROVIDERS)[number][0], string>;

/** Where a song that isn't on this device plays from (YouTube, SoundCloud or Spotify), beside its name. */
export function PlatformBadge({ track }: { track: Track }) {
  const platform = track.stream || track.storage === "server" ? trackPlatform(track) : null;
  if (!platform) return null;
  return (
    <span className={`badge platform ${platform}`} title={`Plays from ${PLATFORM_NAMES[platform]}; not downloaded`}>
      <span className={`prov-dot ${platform}`} aria-hidden="true" />
      {PLATFORM_NAMES[platform]}
    </span>
  );
}

/** A phone or tablet, without a mouse. */
const touchOnly = () => window.matchMedia("(hover: none) and (pointer: coarse)").matches;

const Row = memo(function Row({ id, index, ctxIds, ctx, playlistId, showAlbum, showAdded, showPlays, draggableReorder, dropBefore, dropAfter, onDragOverRow, onDropRow }: RowProps) {
  const track = useStore((s) => s.tracks[id]);
  const album = useStore((s) => (track ? s.albums[track.albumId] : undefined));
  const current = useStore((s) => s.currentId === id);
  const playing = useStore((s) => s.currentId === id && s.isPlaying);
  const selected = useStore((s) => s.selection.includes(id));
  const liked = useStore((s) => Boolean(s.playlists.find((p) => p.id === "liked")?.trackIds.includes(id)));
  const downloading = useStore((s) => s.server.downloads[id]);
  const playable = useStore((s) => isPlayable(s.tracks[id], s));
  const hasClip = useStore((s) => Boolean(s.clips[id]));
  const snoozed = useStore((s) => snoozedUntil(s, id));
  if (!track) return null;

  const play = () => {
    if (!playable) return;
    if (current) togglePlay();
    else playList(ctxIds, id, ctx);
  };

  const select = (e: MouseEvent) => {
    const s = getState();
    // On a touch screen there's no double-click: a tap plays (its menu button, or a long press, has the rest).
    if (touchOnly() && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      play();
      return;
    }
    if (e.shiftKey && s.selection.length) {
      const anchor = ctxIds.indexOf(s.selection[s.selection.length - 1]);
      const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
      setState({ selection: ctxIds.slice(a, b + 1) });
    } else if (e.ctrlKey || e.metaKey) {
      setState({ selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id] });
    } else setState({ selection: [id] });
  };

  const menu = (e: MouseEvent | HTMLElement) => {
    const s = getState();
    const ids = s.selection.includes(id) && s.selection.length > 1 ? s.selection : [id];
    if (!s.selection.includes(id)) setState({ selection: [id] });
    openTrackMenu(e, ids, { playlistId, context: ctx });
  };

  /*
   * Keys on a focused row: Enter plays, the menu key (or Shift+F10) opens its
   * menu, arrows move between rows, Shift+arrows select a range, Ctrl/Cmd+A
   * selects every song and Escape clears the selection. In a playlist,
   * Alt+arrows move the song up or down.
   */
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const s = getState();
    if (e.key === "Enter") {
      e.preventDefault();
      play();
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      menu(e.currentTarget);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey) {
      e.preventDefault();
      if (!draggableReorder || !playlistId) return;
      const down = e.key === "ArrowDown";
      if (down ? index >= ctxIds.length - 1 : index === 0) return;
      moveInPlaylist(playlistId, id, down ? ctxIds[index + 2] ?? null : ctxIds[index - 1]);
      announce(`${track.title} moved to position ${index + (down ? 2 : 0)} of ${ctxIds.length}`);
      // The row is the same element after the move, but moving it can drop its focus.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`.tl-row[data-id="${CSS.escape(id)}"]`)?.focus());
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = ctxIds[index + (e.key === "ArrowDown" ? 1 : -1)];
      const sib = (e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
      if (!sib || !next) return;
      if (e.shiftKey) {
        // Extends from where the selection started (this row when there's none).
        const anchor = s.selection.length ? ctxIds.indexOf(s.selection[0]) : index;
        const to = index + (e.key === "ArrowDown" ? 1 : -1);
        const [a, b] = anchor <= to ? [anchor, to] : [to, anchor];
        const range = ctxIds.slice(Math.max(0, a), b + 1);
        setState({ selection: anchor <= to ? range : range.reverse() });
        announce(`${range.length} ${range.length === 1 ? "song" : "songs"} selected`);
      }
      sib.focus();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setState({ selection: [...ctxIds] });
      announce(`All ${ctxIds.length} songs selected`);
    } else if (e.key === "Escape" && s.selection.length) {
      e.preventDefault();
      setState({ selection: [] });
      announce("Selection cleared");
    }
  };

  const dragStart = (e: DragEvent<HTMLDivElement>) => {
    const s = getState();
    const ids = s.selection.includes(id) ? s.selection : [id];
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
    e.dataTransfer.setData("text/plain", ids.map((x) => s.tracks[x]?.title).join(", "));
    if (draggableReorder && ids.length === 1) e.dataTransfer.setData("text/x-resonance-index", String(index));
    e.dataTransfer.effectAllowed = "copyMove";
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = ids.length === 1 ? track.title : `${ids.length} songs`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 16, 16);
    setTimeout(() => ghost.remove());
  };

  const dragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!draggableReorder || !e.dataTransfer.types.includes("text/x-resonance-index")) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    onDragOverRow(e.clientY > r.top + r.height / 2);
  };

  const drop = (e: DragEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onDropRow(e, e.clientY > r.top + r.height / 2);
  };

  return (
    <div
      className={`tl-row${current ? " current" : ""}${selected ? " selected" : ""}${playable ? "" : " unavailable"}${dropBefore ? " drop-before" : ""}${dropAfter ? " drop-after" : ""}`}
      role="row"
      data-id={id}
      tabIndex={0}
      aria-keyshortcuts={draggableReorder ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      aria-selected={selected}
      onClick={select}
      onDoubleClick={play}
      onContextMenu={menu}
      onKeyDown={key}
      draggable
      onDragStart={dragStart}
      onDragOver={dragOver}
      onDrop={drop}
      style={{ "--i": Math.min(index, 18) } as CSSProperties}
    >
      <span className="td num" role="cell">
        <span className="num-label">{current ? <Bars paused={!playing} /> : index + 1}</span>
        <button type="button" className="row-play" tabIndex={-1} onClick={(e) => { e.stopPropagation(); play(); }} aria-label={playing ? `Pause ${track.title}` : `Play ${track.title}`} disabled={!playable}>
          <Icon name={playing ? "pause" : "play"} size={16} />
        </button>
      </span>
      <span className="td title" role="cell">
        <TrackArt trackId={id} className="row-art" />
        <span className="title-text">
          <span className="t-name">
            {track.title}
            <PlatformBadge track={track} />
            {track.kind === "video" ? <span className="badge">VIDEO</span> : null}
            {hasClip ? <span className="badge clip" title="Clip range applied"><Icon name="scissors" size={11} /></span> : null}
            {snoozed ? <span className="badge snoozed" title={`Snoozed ${snoozeEnds(snoozed)}: skipped unless you play it`}><Icon name="snooze" size={11} /> SNOOZED</span> : null}
          </span>
          <span className="t-sub">
            {track.storage === "downloads" ? <Icon name="downloaded" size={13} className="ok" title="Downloaded" /> : null}
            {track.storage === "server" ? (downloading !== undefined ? <span className="ring" style={{ "--p": downloading } as CSSProperties} title="Downloading" /> : <Icon name="globe" size={13} title="Streams from server" />) : null}
            <span className="t-artists"><ArtistLinks track={track} inRow /></span>
          </span>
        </span>
      </span>
      {showAlbum ? (
        <span className="td album" role="cell">
          <button type="button" className="link" tabIndex={-1} onClick={(e) => { e.stopPropagation(); navigate({ name: "album", id: track.albumId }); }}>
            {/* A single's "album" is the song itself: naming it twice says nothing. */}
            {album && album.title.toLowerCase() !== track.title.toLowerCase() ? album.title : <span className="muted">Single</span>}
          </button>
        </span>
      ) : null}
      {showAdded ? <span className="td added" role="cell">{showPlays ? `${track.plays.toLocaleString()} plays` : formatAdded(track.addedAt)}</span> : null}
      <span className="td like" role="cell">
        <button type="button" className={`icon-btn like-btn${liked ? " on" : ""}`} tabIndex={-1} onClick={(e) => { e.stopPropagation(); toggleLike(id); }} aria-label={liked ? "Remove from Liked Songs" : "Add to Liked Songs"} aria-pressed={liked}>
          <Icon name={liked ? "heartFill" : "heart"} size={17} />
        </button>
      </span>
      <span className="td dur" role="cell">{track.duration ? formatTime(track.duration) : "–:––"}</span>
      <span className="td more" role="cell">
        <button type="button" className="icon-btn" tabIndex={-1} onClick={(e) => { e.stopPropagation(); menu(e.currentTarget); }} aria-label={`More options for ${track.title}`}>
          <Icon name="more" size={18} />
        </button>
      </span>
    </div>
  );
});
