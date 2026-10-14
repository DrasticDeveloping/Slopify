import { useCallback, useEffect, useRef } from "react";
import { engine } from "../audio/engine";
import { formatTime } from "../lib/format";
import { pollPosition, useCurrent, useLiveText } from "../lib/hooks";
import { cycleRepeat, isLiked, navigate, next, openMenu, positionOf, previous, seek, setSpeed, setVolume, toggleLike, toggleMute, togglePlay, toggleShuffle } from "../state/actions";
import { setState, useStore } from "../state/store";
import { ArtistLinks } from "./ArtistLinks";
import { TrackArt } from "./Artwork";
import { Icon } from "./Icon";
import { Slider } from "./Slider";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function openSpeedMenu(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  openMenu({
    x: r.left,
    y: r.top - 8,
    title: "Playback speed",
    items: SPEEDS.map((v) => ({ label: v === 1 ? "Normal" : `${v}×`, checked: engine.rate === v, run: () => setSpeed(v) })),
  });
}

export function Transport({ big }: { big?: boolean }) {
  const isPlaying = useStore((s) => s.isPlaying);
  const buffering = useStore((s) => s.buffering !== null && s.buffering === s.currentId);
  const shuffle = useStore((s) => s.shuffle);
  const repeat = useStore((s) => s.repeat);
  const hasTrack = useStore((s) => Boolean(s.currentId));
  const locked = useStore((s) => s.listen.mode === "guest");
  const size = big ? 26 : 20;
  return (
    <div className={`transport${big ? " big" : ""}${locked ? " locked" : ""}`}>
      <button type="button" className={`icon-btn${shuffle ? " on dot" : ""}`} onClick={toggleShuffle} aria-pressed={shuffle} aria-label="Shuffle" title="Shuffle (S)">
        <Icon name="shuffle" size={size - 2} />
      </button>
      <button type="button" className="icon-btn" onClick={previous} disabled={!hasTrack} aria-label="Previous" title="Previous (Ctrl ←)">
        <Icon name="prev" size={size} />
      </button>
      <button type="button" className={`play-main${isPlaying ? " playing" : ""}${buffering ? " loading" : ""}`} onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"} title={isPlaying ? "Pause (Space)" : "Play (Space)"}>
        <span className="pm-icon pm-play"><Icon name="play" size={big ? 30 : 20} /></span>
        <span className="pm-icon pm-pause"><Icon name="pause" size={big ? 30 : 20} /></span>
      </button>
      <button type="button" className="icon-btn" onClick={next} disabled={!hasTrack} aria-label="Next" title="Next (Ctrl →)">
        <Icon name="next" size={size} />
      </button>
      <button
        type="button"
        className={`icon-btn${repeat !== "off" ? " on dot" : ""}`}
        onClick={cycleRepeat}
        aria-label={repeat === "off" ? "Repeat off" : repeat === "all" ? "Repeat all" : "Repeat one"}
        title={`${repeat === "off" ? "Repeat off" : repeat === "all" ? "Repeating all" : "Looping this song"} (R)`}
      >
        <Icon name="repeat" size={size - 2} />
        {repeat === "one" ? <span className="repeat-one">1</span> : null}
      </button>
    </div>
  );
}

export function SeekRow({ big }: { big?: boolean }) {
  const { track, range } = useCurrent();
  const duration = track?.duration ?? 0;
  const elapsed = useLiveText<HTMLSpanElement>(() => formatTime(track ? positionOf(track.id) : 0));
  const fmt = useCallback((v: number) => formatTime(v), []);
  const locked = useStore((s) => s.listen.mode === "guest");
  const clipped = Boolean(track && (range.start > 0 || range.end < duration - 0.5));
  return (
    <div className={`seek-row${big ? " big" : ""}`}>
      <span className="time" ref={elapsed}>0:00</span>
      <div className="seek-wrap">
        {clipped ? <span className="clip-mark" style={{ left: `${(range.start / duration) * 100}%`, right: `${100 - (range.end / duration) * 100}%` }} title="Clip range" /> : null}
        <Slider
          className="seek"
          max={duration || 1}
          poll={track ? pollPosition : undefined}
          value={track ? undefined : 0}
          onCommit={seek}
          label="Seek"
          format={fmt}
          disabled={!track || !duration || locked}
          showTooltip
        />
      </div>
      <span className="time">{track ? formatTime(range.end < duration - 0.5 ? range.end : duration) : "0:00"}</span>
    </div>
  );
}

export function VolumeControl() {
  const volume = useStore((s) => s.volume);
  const muted = useStore((s) => s.muted);
  const fmt = useCallback((v: number) => `${Math.round(v * 100)}%`, []);
  const icon = muted || volume === 0 ? "volumeMute" : volume < 0.5 ? "volumeLow" : "volume";
  return (
    <div className="volume">
      <button type="button" className="icon-btn" onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute (M)" : "Mute (M)"}>
        <Icon name={icon} size={20} />
      </button>
      <Slider className="vol" max={1} step={0.01} value={muted ? 0 : volume} onInput={setVolume} label="Volume" format={fmt} />
    </div>
  );
}

export function PlayerBar() {
  const { id, track, album } = useCurrent();
  const liked = useStore((s) => (id ? isLiked(id, s) : false));
  const panel = useStore((s) => s.panel);
  const speed = useStore((s) => s.speed);
  const listen = useStore((s) => s.listen.mode);

  return (
    <footer className="playerbar" aria-label="Player">
      <div className="pb-left">
        {track ? (
          <>
            <button type="button" className="pb-art" onClick={() => setState({ fullPlayer: true })} aria-label="Open Now Playing" title="Open Now Playing (F)">
              <TrackArt trackId={track.id} />
              <span className="pb-art-expand"><Icon name="expand" size={18} /></span>
            </button>
            <div className="pb-meta" key={track.id}>
              <button type="button" className="link pb-title" onClick={() => album && navigate({ name: "album", id: album.id })}>
                {track.title}
              </button>
              <span className="pb-artist"><ArtistLinks track={track} /></span>
            </div>
            <button type="button" className={`icon-btn like-btn${liked ? " on" : ""}`} onClick={() => toggleLike(track.id)} aria-pressed={liked} aria-label={liked ? "Remove from Liked Songs" : "Add to Liked Songs"} title="Like (L)">
              <Icon name={liked ? "heartFill" : "heart"} size={19} />
            </button>
          </>
        ) : (
          <div className="pb-empty">
            <span className="pb-empty-art"><Icon name="music" size={20} /></span>
            <span><strong>Nothing playing</strong><small>Pick something, or press Space</small></span>
          </div>
        )}
      </div>

      <div className="pb-center">
        <Transport />
        <SeekRow />
      </div>

      <div className="pb-right">
        {listen === "host" || listen === "guest" ? <span className="live-pill"><span className="live-dot" />Live</span> : null}
        <button type="button" className={`speed-btn${speed !== 1 ? " on" : ""}`} onClick={(e) => openSpeedMenu(e.currentTarget)} aria-label={`Playback speed ${speed}x`} title="Playback speed">
          {speed}×
        </button>
        <button type="button" className={`icon-btn${panel === "details" ? " on dot" : ""}`} onClick={() => setState({ panel: panel === "details" ? null : "details" })} aria-pressed={panel === "details"} aria-label="Now playing view" title="Now playing view">
          <Icon name="nowPlaying" size={19} />
        </button>
        <button type="button" className={`icon-btn${panel === "queue" ? " on dot" : ""}`} onClick={() => setState({ panel: panel === "queue" ? null : "queue" })} aria-pressed={panel === "queue"} aria-label="Queue" title="Queue (Q)">
          <Icon name="queue" size={19} />
        </button>
        <VolumeControl />
        <button type="button" className="icon-btn" onClick={() => setState({ fullPlayer: true })} disabled={!track} aria-label="Full screen player" title="Full screen (F)">
          <Icon name="expand" size={18} />
        </button>
      </div>
      <MiniProgress />
    </footer>
  );
}

/** Thin progress line shown on the compact (mobile) player. */
function MiniProgress() {
  const { track, range } = useCurrent();
  const ref = useRef<HTMLSpanElement>(null);
  const end = range.end || track?.duration || 1;
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (ref.current) ref.current.style.transform = `scaleX(${track ? Math.min(1, positionOf(track.id) / end) : 0})`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [track, end]);
  return <span className="mini-progress" aria-hidden="true"><span ref={ref} /></span>;
}
