import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "../lib/hooks";
import { onLiveFrame, wakeLive } from "../lib/live";
import { effectiveRange, positionOf, seek } from "../state/actions";
import { getState, useStore } from "../state/store";
import { lineAt, type LyricLine } from "../lyrics/lrc";
import { setLyricsAdjust, useLyrics, useLyricsAdjust } from "../lyrics/useLyrics";
import { Icon } from "./Icon";

/*
 * The playing song's lyrics. Synced lyrics follow the song: the line being sung
 * lights up and is kept in the middle, until you scroll them yourself ("Back to
 * current line" picks it up again). Clicking a line plays from there.
 *
 * Timing is in the song's own seconds (positionOf), so clips and speed need no
 * handling: lyric time = position + adjustment, and a line at `t` plays from
 * `t - adjustment`.
 */

export function LyricsView({ trackId }: { trackId: string }) {
  const { state, retry } = useLyrics(trackId);
  if (state.status === "loading") return <LyricsNote busy>Looking for lyrics…</LyricsNote>;
  if (state.status === "offline") return <LyricsNote>Lyrics can't be looked up while the music server is offline.</LyricsNote>;
  if (state.status === "failed") {
    return (
      <LyricsNote>
        {state.message}
        <button type="button" className="btn ghost sm" onClick={retry}>Try again</button>
      </LyricsNote>
    );
  }
  const { lyrics } = state;
  if (lyrics.status === "instrumental") return <LyricsNote>This song is instrumental.</LyricsNote>;
  if (lyrics.status === "none") return <LyricsNote>No lyrics found for this song.</LyricsNote>;
  if (lyrics.status === "plain") {
    return (
      <div className="lyrics" tabIndex={0} aria-label="Lyrics">
        <p className="ly-note small muted">These lyrics aren't synced to the song.</p>
        <div className="ly-plain">{lyrics.plain}</div>
        <Credit />
      </div>
    );
  }
  return <SyncedLyrics key={trackId} trackId={trackId} lines={lyrics.lines} />;
}

function LyricsNote({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="lyrics ly-empty" aria-busy={busy || undefined}>
      <Icon name="lyrics" size={28} />
      <p className="muted">{children}</p>
    </div>
  );
}

const Credit = () => <p className="ly-credit small muted">Lyrics from LRCLIB</p>;

/** Keys that move through the lyrics by hand. */
const BROWSE_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

function SyncedLyrics({ trackId, lines }: { trackId: string; lines: LyricLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const adjust = useLyricsAdjust(trackId);
  const reduced = useReducedMotion();
  const [following, setFollowing] = useState(true);
  const live = useRef({ adjust, following, reduced, active: -2 });
  live.current.adjust = adjust;
  live.current.following = following;
  live.current.reduced = reduced;

  /** Puts line `i` in the middle of the lyrics, scrolling only the lyrics themselves. */
  const center = (i: number, smooth: boolean) => {
    const el = box.current;
    const line = el?.querySelector<HTMLElement>(`[data-i="${Math.max(0, i)}"]`);
    if (!el || !line) return;
    el.scrollTo({ top: line.offsetTop - el.clientHeight / 2 + line.offsetHeight / 2, behavior: smooth ? "smooth" : "auto" });
  };

  // Follows the playhead; only touches the page when the line changes.
  useEffect(() => {
    live.current.active = -2;
    return onLiveFrame(() => {
      const s = getState();
      if (s.currentId !== trackId || !box.current) return;
      const at = lineAt(lines, positionOf(trackId) + live.current.adjust);
      if (at === live.current.active) return;
      const initial = live.current.active === -2;
      live.current.active = at;
      box.current.querySelectorAll<HTMLElement>("[data-i]").forEach((el) => {
        const i = Number(el.dataset.i);
        el.classList.toggle("on", i === at);
        el.classList.toggle("past", i < at);
      });
      if (live.current.following) center(at, !initial && !live.current.reduced);
    });
  }, [trackId, lines]);

  // A render can reset the lines' classes (and a new adjustment or clip moves which line is current), so paint again.
  useEffect(() => {
    if (live.current.active !== -2) live.current.active = -3;
    wakeLive();
  });

  const stopFollowing = () => setFollowing(false);
  const resume = () => {
    setFollowing(true);
    center(live.current.active, !reduced);
  };

  // Subscribed, so trimming the song (or dragging the clip editor) updates which lines can be played.
  const range = { start: useStore((s) => effectiveRange(trackId, s).start), end: useStore((s) => effectiveRange(trackId, s).end) };
  const playFrom = (time: number) => {
    const at = Math.max(0, time - adjust);
    // Outside the clip there's nothing to play; the engine would jump to the clip's edge instead.
    if (at < range.start || at >= range.end) return;
    seek(at);
    setFollowing(true);
  };

  return (
    <div className="ly-wrap">
      <div
        ref={box}
        className="lyrics synced"
        tabIndex={0}
        aria-label="Lyrics"
        onWheel={stopFollowing}
        onTouchMove={stopFollowing}
        // A press on the lyrics' own scroll bar (not on a line).
        onPointerDown={(e) => e.target === e.currentTarget && stopFollowing()}
        onKeyDown={(e) => BROWSE_KEYS.has(e.key) && e.target === e.currentTarget && stopFollowing()}
      >
        {lines.map((line, i) => {
          const playable = line.time - adjust >= range.start && line.time - adjust < range.end;
          return (
            <p key={i} data-i={i} className={`ly-line${line.text ? "" : " gap"}${playable ? "" : " out"}`} onClick={playable ? () => playFrom(line.time) : undefined}>
              {line.text || "♪"}
            </p>
          );
        })}
        <Credit />
      </div>
      {!following ? (
        <button type="button" className="btn sm ly-resume" onClick={resume}>
          <Icon name="chevronDown" size={14} />
          Back to current line
        </button>
      ) : null}
      <div className="ly-adjust" role="group" aria-label="Lyrics timing">
        <span className="small muted">Timing</span>
        <button type="button" className="icon-btn sm" onClick={() => setLyricsAdjust(trackId, adjust - 0.5)} aria-label="Show lyrics later" title="Later (−0.5s)">
          <Icon name="chevronLeft" size={16} />
        </button>
        <span className="ly-adjust-value small" aria-live="polite">{adjust > 0 ? "+" : ""}{adjust.toFixed(1)}s</span>
        <button type="button" className="icon-btn sm" onClick={() => setLyricsAdjust(trackId, adjust + 0.5)} aria-label="Show lyrics sooner" title="Sooner (+0.5s)">
          <Icon name="chevronRight" size={16} />
        </button>
        {adjust ? <button type="button" className="text-btn" onClick={() => setLyricsAdjust(trackId, 0)}>Reset</button> : null}
      </div>
    </div>
  );
}
