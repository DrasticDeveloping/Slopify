import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useCurrent } from "../lib/hooks";
import { openTrackMenu } from "../lib/menus";
import { isLiked, navigate, toggleLike } from "../state/actions";
import { setState, useStore } from "../state/store";
import { TrackArt } from "./Artwork";
import { Icon } from "./Icon";
import { openSpeedMenu, SeekRow, Transport, VolumeControl } from "./PlayerBar";
import { QueueView } from "./RightPanel";
import { enterVideoFullscreen, VideoSurface } from "./VideoSurface";
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
  const { id, track, artist, album } = useCurrent();
  const liked = useStore((s) => (id ? isLiked(id, s) : false));
  const context = useStore((s) => s.context);
  const speed = useStore((s) => s.speed);
  const playing = useStore((s) => s.isPlaying);
  const reduced = useStore((s) => s.settings.reduceMotion);
  const [queue, setQueue] = useState(false);
  const pulse = useRef<HTMLDivElement>(null);
  const close = () => setState({ fullPlayer: false });
  const closeBtn = useRef<HTMLButtonElement>(null);

  const dialog = useRef<HTMLDivElement>(null);

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
      close();
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
  const video = track.kind === "video" && Boolean(track.mediaUrl || track.fileUrl);

  const go =(route: Parameters<typeof navigate>[0]) => {
    navigate(route);
    close();
  };

  return (
    <div
      ref={dialog}
      className={`full-player${closing ? " closing" : ""}${queue ? " with-queue" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Now playing"
      style={{ "--a": album.palette.a, "--b": album.palette.b, "--c": album.palette.c } as CSSProperties}
      onKeyDown={trap}
    >
      <div className="fp-backdrop" aria-hidden="true">
        <TrackArt trackId={track.id} />
      </div>
      <header className="fp-head">
        <button ref={closeBtn} type="button" className="icon-btn round glass" onClick={close} aria-label="Close Now Playing" title="Close (Esc)">
          <Icon name="chevronDown" size={22} />
        </button>
        <div className="fp-context">
          <span className="eyebrow">Playing from</span>
          <button type="button" className="link strong" onClick={() => context?.route && go(context.route)}>{context?.label ?? "Library"}</button>
        </div>
        <button type="button" className="icon-btn round glass" onClick={(e) => openTrackMenu(e.currentTarget, [track.id])} aria-label="More options">
          <Icon name="more" size={20} />
        </button>
      </header>

      <div className="fp-body">
        <div className={`fp-stage${video ? " video" : ""}`}>
          {video ? (
            <div className="fp-art video" key={track.id} onDoubleClick={enterVideoFullscreen} title="Double-click for full screen">
              <VideoSurface trackId={track.id} priority={2} label />
            </div>
          ) : (
            <div ref={pulse} className={`fp-art${playing ? " playing" : ""}`} key={track.id}>
              <TrackArt trackId={track.id} label />
            </div>
          )}
          <div className="fp-info">
            <div className="fp-titles" key={track.id}>
              <h2>
                <button type="button" className="link" onClick={() => go({ name: "album", id: album.id })}>{track.title}</button>
              </h2>
              <button type="button" className="link fp-artist" onClick={() => artist && go({ name: "artist", id: artist.id })}>{artist?.name}</button>
            </div>
            <button type="button" className={`icon-btn lg like-btn${liked ? " on" : ""}`} onClick={() => toggleLike(track.id)} aria-pressed={liked} aria-label={liked ? "Remove from Liked Songs" : "Add to Liked Songs"}>
              <Icon name={liked ? "heartFill" : "heart"} size={28} />
            </button>
          </div>
          <SeekRow big />
          <Transport big />
          <div className="fp-utils">
            <button type="button" className={`speed-btn${speed !== 1 ? " on" : ""}`} onClick={(e) => openSpeedMenu(e.currentTarget)} aria-label={`Playback speed ${speed}x`}>
              {speed}×
            </button>
            <VolumeControl />
            {video ? (
              <button type="button" className="btn ghost sm" onClick={enterVideoFullscreen} aria-label="Watch full screen">
                <Icon name="expand" size={18} />
                Full screen
              </button>
            ) : null}
            <button type="button" className={`btn ghost sm${queue ? " on" : ""}`} onClick={() => setQueue(!queue)} aria-pressed={queue}>
              <Icon name="queue" size={18} />
              Queue
            </button>
          </div>
        </div>
        {queue ? (
          <aside className="fp-queue" aria-label="Queue">
            <div className="fp-queue-head">
              <strong>Queue</strong>
              <button type="button" className="icon-btn sm" onClick={() => setQueue(false)} aria-label="Hide queue">
                <Icon name="close" size={16} />
              </button>
            </div>
            <QueueView />
          </aside>
        ) : null}
      </div>
      <Visualizer pulseTarget={pulse} reduced={reduced} bars={72} />
    </div>
  );
}
