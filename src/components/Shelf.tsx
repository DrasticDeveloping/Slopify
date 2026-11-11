import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { playList, togglePlay } from "../state/actions";
import { useStore, type Route } from "../state/store";
import { Icon } from "./Icon";

interface ShelfProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  /** Opens the shelf's full page ("Show all"). */
  onShowAll?: () => void;
  /** Wraps cards into rows (a full page) instead of one row that scrolls sideways. */
  grid?: boolean;
  children: ReactNode;
}

export function Shelf({ title, subtitle, action, onShowAll, grid = false, children }: ShelfProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  useEffect(() => {
    const el = scroller.current;
    if (!el || grid) return;
    const update = () => setEdges({ start: el.scrollLeft < 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Cards arriving or leaving change how far the row scrolls without resizing it (and the arrows hide when it can't).
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [grid]);

  const page = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section className="shelf">
      <header className="shelf-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <div className="shelf-actions">
          {action}
          {onShowAll ? (
            <button type="button" className="text-btn show-all" onClick={onShowAll} aria-label={`Show all: ${title}`}>
              Show all
            </button>
          ) : null}
          {/* Arrows only when there's more to scroll to, so a short or loading shelf isn't cluttered with dead buttons. */}
          {grid || (edges.start && edges.end) ? null : (
            <>
              <button type="button" className="icon-btn round" onClick={() => page(-1)} disabled={edges.start} aria-label={`Scroll ${title} back`}>
                <Icon name="chevronLeft" size={18} />
              </button>
              <button type="button" className="icon-btn round" onClick={() => page(1)} disabled={edges.end} aria-label={`Scroll ${title} forward`}>
                <Icon name="chevronRight" size={18} />
              </button>
            </>
          )}
        </div>
      </header>
      <div className={grid ? "card-grid" : `shelf-row${edges.start ? "" : " fade-start"}${edges.end ? "" : " fade-end"}`} ref={scroller}>
        {children}
      </div>
    </section>
  );
}

/** Card-shaped placeholders that shimmer while a shelf's songs load, in place of a bare "Loading…" line. */
export function SkeletonCards({ count = 6, label }: { count?: number; label?: string }) {
  return (
    <>
      {label ? <span className="sr-only" role="status">{label}</span> : null}
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card skeleton" aria-hidden="true">
          <span className="sk sk-art" />
          <span className="sk sk-line" />
          <span className="sk sk-line short" />
        </div>
      ))}
    </>
  );
}

/** True when the given collection is the active playback context. */
export function useContextPlaying(route?: Route) {
  return useStore((s) => {
    if (!route || !s.context?.route) return IDLE;
    const active = JSON.stringify(s.context.route) === JSON.stringify(route);
    return active ? (s.isPlaying ? PLAYING : PAUSED) : IDLE;
  });
}
const PLAYING = { active: true, playing: true };
const PAUSED = { active: true, playing: false };
const IDLE = { active: false, playing: false };

export function PlayFab({ ids, label, route, startId, size = "md", className }: { ids: string[]; label: string; route?: Route; startId?: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const state = useContextPlaying(route);
  const click = (e: MouseEvent) => {
    e.stopPropagation();
    if (state.active) togglePlay();
    else playList(ids, startId, { label, route });
  };
  return (
    <button type="button" className={`play-fab ${size}${state.playing ? " is-playing" : ""}${className ? ` ${className}` : ""}`} onClick={click} disabled={!ids.length} aria-label={state.playing ? `Pause ${label}` : `Play ${label}`}>
      <Icon name={state.playing ? "pause" : "play"} size={size === "lg" ? 26 : size === "sm" ? 16 : 20} />
    </button>
  );
}

interface CardProps {
  art: ReactNode;
  title: string;
  subtitle: string;
  onOpen: () => void;
  onMenu?: (e: MouseEvent) => void;
  play?: { ids: string[]; label: string; route?: Route; startId?: string };
  round?: boolean;
}

export function Card({ art, title, subtitle, onOpen, onMenu, play, round }: CardProps) {
  return (
    <div className={`card${round ? " round" : ""}`} onContextMenu={onMenu}>
      <div className="card-art">
        {art}
        {play ? <PlayFab {...play} className="card-fab" /> : null}
      </div>
      <button type="button" className="card-link" onClick={onOpen}>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </button>
    </div>
  );
}
