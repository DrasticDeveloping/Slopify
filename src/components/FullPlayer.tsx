import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useCurrent } from "../lib/hooks";
import { openTrackMenu } from "../lib/menus";
import { isLiked, navigate, toggleLike, togglePlay } from "../state/actions";
import { getState, setState, useStore } from "../state/store";
import { ArtistLinks } from "./ArtistLinks";
import { TrackArt } from "./Artwork";
import { Icon } from "./Icon";
import { openSpeedMenu, SeekRow, Transport, VolumeControl } from "./PlayerBar";
import { QueueView } from "./RightPanel";
import { toggleFullscreen, useIsFullscreen, VideoSurface } from "./VideoSurface";
import { Visualizer } from "./Visualizer";

export function FullPlayer() {
  const open = useStore((s) => s.fullPlayer);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  // Capture the opener in a layout effect, before the app marks the background inert (which blurs it).
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement as HTMLElement | null;
  }, [open]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const t = window.setTimeout(() => {
        setMounted(false);
        setClosing(false);
      }, 280);
      return () => clearTimeout(t);
    }
  }, [open, mounted]);

  if (!mounted) return null;
  return <FullPlayerBody closing={closing} opener={opener} />;
}

function FullPlayerBody({ closing, opener }: { closing: boolean; opener: { current: HTMLElement | null } }) {
  const { id, track, album } = useCurrent();
  const liked = useStore((s) => (id ? isLiked(id, s) : false));
  const context = useStore((s) => s.context);
  const speed = useStore((s) => s.speed);
  const playing = useStore((s) => s.isPlaying);
  const reduced = useStore((s) => s.settings.reduceMotion);
  const menuOpen = useStore((s) => s.menu !== null);
  const [queue, setQueue] = useState(false);
  const pulse = useRef<HTMLDivElement>(null);
  const close = () => setState({ fullPlayer: false });
  const closeBtn = useRef<HTMLButtonElement>(null);

  const dialog = useRef<HTMLDivElement>(null);
  const video = Boolean(track && track.kind === "video" && (track.mediaUrl || track.fileUrl));
  const enteredFullscreen = useRef(false);
  const clickTimer = useRef(0);
  const watchBtn = useRef<HTMLButtonElement>(null);
  /*
   * A video plays blurred behind the artwork while you listen; "Watch video" shows
   * it properly until Return (or the song changes). Keyed by song, so the next
   * song never opens in watching mode, even for the render before the reset.
   */
  const [watchId, setWatchId] = useState<string | null>(null);
  const watching = video && watchId === id;
  useEffect(() => setWatchId(null), [id]);
  const watch = () => {
    setQueue(false);
    setWatchId(id);
    requestAnimationFrame(() => closeBtn.current?.focus());
  };
  const returnToMusic = () => {
    clearTimeout(clickTimer.current);
    setWatchId(null);
    if (enteredFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    requestAnimationFrame(() => watchBtn.current?.focus());
  };
  const fullscreen = useIsFullscreen();
  // Video controls fade out while the video plays undisturbed.
  const idle = useIdle(dialog, watching && playing && !queue && !menuOpen);

  // Switching modes can remove the focused transport or artwork button.
  // Keep keyboard focus in the player after that DOM change.
  useLayoutEffect(() => {
    const s = getState();
    if (!s.menu && !s.modal && dialog.current && !dialog.current.contains(document.activeElement)) closeBtn.current?.focus();
  }, [watching, id]);

  const flipFullscreen = () => {
    enteredFullscreen.current = !document.fullscreenElement;
    toggleFullscreen();
  };

  // Leave full screen with the player if the player put the app there.
  useEffect(() => () => {
    clearTimeout(clickTimer.current);
    if (enteredFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, []);

  // F toggles full screen while watching a video (it otherwise opens and closes this player).
  useEffect(() => {
    if (!watching) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const s = getState();
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() !== "f" || e.ctrlKey || e.metaKey || e.altKey || s.modal || s.menu || t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      e.preventDefault();
      e.stopPropagation();
      flipFullscreen();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [watching]);

  // Hidden controls should not keep focus, or Space would press an invisible button.
  useEffect(() => {
    const root = dialog.current;
    if (idle && root && root !== document.activeElement && root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }, [idle]);

  // A click plays/pauses, a double-click toggles full screen; wait briefly so a double-click does not also pause.
  const onVideoClick = (e: MouseEvent) => {
    // On touch, a tap only brings the controls back.
    if ((e.nativeEvent as PointerEvent).pointerType === "touch") return;
    clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(togglePlay, 220);
  };
  const onVideoDoubleClick = () => {
    clearTimeout(clickTimer.current);
    flipFullscreen();
  };

  // Move focus in, and give it back to whatever opened the player on close.
  useEffect(() => {
    closeBtn.current?.focus();
    // Runs after the close animation, by which time the background is no longer inert.
    return () => {
      const el = opener.current;
      if (el?.isConnected && el !== document.body) el.focus();
    };
  }, [opener]);

  const trap = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      // The first Escape only leaves full screen (where the browser lets the page see it).
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else if (watching) returnToMusic();
      else close();
      return;
    }
    if (e.key !== "Tab" || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), [role="slider"]:not([aria-disabled="true"]), input, [tabindex="0"]')].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    if (!track) close();
  }, [track]);

  if (!track || !album) return null;

  const go = (route: Parameters<typeof navigate>[0]) => {
    navigate(route);
    close();
  };

  const info = (
    <div className="fp-info">
      <div className="fp-titles" key={track.id}>
        <h2>
          <button type="button" className="link" onClick={() => go({ name: "album", id: album.id })}>{track.title}</button>
        </h2>
        <span className="fp-artist"><ArtistLinks track={track} go={go} /></span>
      </div>
      <button type="button" className={`icon-btn lg like-btn${liked ? " on" : ""}`} onClick={() => toggleLike(track.id)} aria-pressed={liked} aria-label={liked ? "Remove from Liked Songs" : "Add to Liked Songs"}>
        <Icon name={liked ? "heartFill" : "heart"} size={28} />
      </button>
    </div>
  );
  const speedBtn = (
    <button type="button" className={`speed-btn${speed !== 1 ? " on" : ""}`} onClick={(e) => openSpeedMenu(e.currentTarget)} aria-label={`Playback speed ${speed}x`}>
      {speed}×
    </button>
  );
  const queuePanel = queue ? (
    <aside className="fp-queue" aria-label="Queue">
      <div className="fp-queue-head">
        <strong>Queue</strong>
        <button type="button" className="icon-btn sm" onClick={() => setQueue(false)} aria-label="Hide queue">
          <Icon name="close" size={16} />
        </button>
      </div>
      <QueueView />
    </aside>
  ) : null;

  return (
    <div
      ref={dialog}
      className={`full-player${closing ? " closing" : ""}${queue ? " with-queue" : ""}${watching ? " video-mode" : ""}${idle ? " idle" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      tabIndex={-1}
      style={{ "--a": album.palette.a, "--b": album.palette.b, "--c": album.palette.c } as CSSProperties}
      onKeyDown={trap}
    >
      {video ? (
        // One video element for both modes, so switching never restarts or reloads it.
        <div
          className={`fp-video${watching ? "" : " ambient"}`}
          aria-hidden={watching ? undefined : true}
          onClick={watching ? onVideoClick : undefined}
          onDoubleClick={watching ? onVideoDoubleClick : undefined}
        >
          <VideoSurface trackId={track.id} priority={2} label={watching} />
          {watching && !playing ? <span className="fp-video-paused" aria-hidden="true"><Icon name="play" size={40} /></span> : null}
        </div>
      ) : (
        <div className="fp-backdrop" aria-hidden="true">
          <TrackArt trackId={track.id} />
        </div>
      )}
      <header className="fp-head">
        <button
          ref={closeBtn}
          type="button"
          className="icon-btn round glass"
          onClick={watching ? returnToMusic : close}
          aria-label={watching ? "Return to Now Playing" : "Close Now Playing"}
          title={watching ? "Return to Now Playing (Esc)" : "Close (Esc)"}
        >
          <Icon name={watching ? "chevronLeft" : "chevronDown"} size={22} />
        </button>
        <div className="fp-context">
          <span className="eyebrow">Playing from</span>
          <button type="button" className="link strong" onClick={() => context?.route && go(context.route)}>{context?.label ?? "Library"}</button>
        </div>
        <button type="button" className="icon-btn round glass" onClick={(e) => openTrackMenu(e.currentTarget, [track.id])} aria-label="More options">
          <Icon name="more" size={20} />
        </button>
      </header>

      {watching ? (
        <>
          <div className="fp-vcontrols">
            {info}
            <SeekRow big />
            <div className="fp-vbar">
              <div className="fp-vbar-side">
                {speedBtn}
                <VolumeControl />
              </div>
              <Transport big />
              <div className="fp-vbar-side end">
                <button type="button" className={`icon-btn${queue ? " on dot" : ""}`} onClick={() => setQueue(!queue)} aria-pressed={queue} aria-label="Queue" title="Queue">
                  <Icon name="queue" size={20} />
                </button>
                <button type="button" className="icon-btn" onClick={flipFullscreen} aria-label={fullscreen ? "Exit full screen" : "Full screen"} title={fullscreen ? "Exit full screen (F)" : "Full screen (F)"}>
                  <Icon name={fullscreen ? "collapse" : "expand"} size={20} />
                </button>
              </div>
            </div>
          </div>
          {queuePanel}
        </>
      ) : (
        <>
          <div className="fp-body">
            <div className="fp-stage">
              <div className="fp-art-slot">
                <div ref={pulse} className={`fp-art${playing ? " playing" : ""}`} key={track.id}>
                  <TrackArt trackId={track.id} label />
                  {video ? (
                    <button ref={watchBtn} type="button" className="fp-watch" aria-label={`Watch video for ${track.title}`} title="Watch video" onClick={watch}>
                      <Icon name="play" size={30} />
                      <span>Watch video</span>
                    </button>
                  ) : null}
                </div>
              </div>
              {info}
              <SeekRow big />
              <Transport big />
              <div className="fp-utils">
                {speedBtn}
                <VolumeControl />
                <button type="button" className={`btn ghost sm${queue ? " on" : ""}`} onClick={() => setQueue(!queue)} aria-pressed={queue}>
                  <Icon name="queue" size={18} />
                  Queue
                </button>
              </div>
            </div>
            {queuePanel}
          </div>
          <Visualizer pulseTarget={pulse} reduced={reduced} bars={72} />
        </>
      )}
    </div>
  );
}

/**
 * Becomes true once the pointer and keyboard have rested for `ms`, so video
 * controls can fade away. Controls stay up while the pointer or focus is on them.
 */
function useIdle(root: RefObject<HTMLElement | null>, enabled: boolean, ms = 2800) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    setIdle(false);
    const el = root.current;
    if (!enabled || !el) return;
    let timer = 0;
    const wake = (e?: Event) => {
      // Focus parked on the dialog itself (see FullPlayerBody) is not activity.
      if (e?.type === "focusin" && e.target === el) return;
      setIdle(false);
      clearTimeout(timer);
      const t = e?.target;
      if (t instanceof Element && t.closest(".fp-head, .fp-vcontrols, .fp-queue")) return;
      timer = window.setTimeout(() => setIdle(true), ms);
    };
    wake();
    const types = ["pointermove", "pointerdown", "wheel", "focusin"];
    for (const type of types) el.addEventListener(type, wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(timer);
      for (const type of types) el.removeEventListener(type, wake);
      window.removeEventListener("keydown", wake);
    };
  }, [root, enabled, ms]);
  return idle;
}
