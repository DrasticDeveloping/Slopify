import { creditLine } from "../../lib/credits";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { videoFrames, wavePeaks } from "../../audio/analysis";
import { engine } from "../../audio/engine";
import { rng } from "../../data/library";
import { formatTime } from "../../lib/format";
import { onLiveFrame } from "../../lib/live";
import { closeModal, isPlayable, libraryIds, mediaUrlOf, previewClip, saveClip, seek, setClipDraft, toast, togglePlay } from "../../state/actions";
import { getState, useStore } from "../../state/store";
import { TrackArt } from "../Artwork";
import { Icon } from "../Icon";
import { Shell } from "./Shell";

const BARS = 96;
const FRAMES = 8;
const MIN_LEN = 3;

/** The song's real waveform, and frames from a video, read from its file. */
function useAnalysis(id: string | undefined, video: boolean) {
  const [result, setResult] = useState<{ id?: string; peaks?: number[]; frames?: string[]; failed?: boolean }>({});
  useEffect(() => {
    const url = id ? mediaUrlOf(id) : undefined;
    if (!id || !url) {
      setResult({ id, failed: true });
      return;
    }
    let live = true;
    setResult({ id });
    wavePeaks(url, BARS).then(
      (peaks) => live && setResult((r) => (r.id === id ? { ...r, peaks } : r)),
      () => live && setResult((r) => (r.id === id ? { ...r, failed: true } : r)),
    );
    if (video) {
      videoFrames(url, FRAMES).then(
        (frames) => live && setResult((r) => (r.id === id ? { ...r, frames } : r)),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [id, video]);
  return result.id === id ? result : {};
}

/** Accepts plain seconds ("123"), or m:ss and h:mm:ss as formatTime shows them, with optional decimals. */
function parseTime(text: string) {
  const m = text.trim().match(/^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [hours, minutes] = m[2] === undefined ? [0, Number(m[1] ?? 0)] : [Number(m[1]), Number(m[2])];
  const seconds = Number(m[3]);
  // After a colon, seconds (and minutes that follow hours) stay under 60.
  if ((m[1] !== undefined && seconds >= 60) || (m[2] !== undefined && minutes >= 60)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function TimeInput({ value, onCommit, label }: { value: number; onCommit: (v: number) => void; label: string }) {
  const [text, setText] = useState(formatTime(value));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : formatTime(value);
  const commit = () => {
    const v = parseTime(text);
    if (v === null) setText(formatTime(value));
    else onCommit(v);
  };
  return (
    <label className="time-input">
      <small>{label}</small>
      <input
        value={shown}
        onFocus={() => { setFocused(true); setText(formatTime(value)); }}
        onBlur={() => { setFocused(false); commit(); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur())}
        inputMode="numeric"
        aria-label={`${label} time`}
        spellCheck={false}
      />
    </label>
  );
}

export function ClipEditorModal({ trackId }: { trackId?: string }) {
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const clips = useStore((s) => s.clips);
  const currentId = useStore((s) => s.currentId);
  const isPlaying = useStore((s) => s.isPlaying);
  // Library songs to switch between, and the one opened here even when it isn't in the library (a song streamed from search).
  const options = useMemo(() => {
    const ids = libraryIds(getState()).filter((id) => isPlayable(tracks[id]) && tracks[id].duration > MIN_LEN * 2);
    return trackId && tracks[trackId] && !ids.includes(trackId) ? [trackId, ...ids] : ids;
  }, [tracks, trackId]);
  const [id, setId] = useState(() => (trackId && tracks[trackId] ? trackId : currentId && options.includes(currentId) ? currentId : options[0]));
  const track = id ? tracks[id] : undefined;
  const duration = track?.duration ?? 0;
  const [range, setRange] = useState(() => (id && clips[id] ? clips[id] : { start: 0, end: duration }));
  const wave = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLSpanElement>(null);
  const dragging = useRef<"start" | "end" | null>(null);

  // A song opened before its length was known starts as the whole song once the length arrives.
  useEffect(() => {
    if (duration) setRange((r) => (r.end === 0 ? { start: 0, end: duration } : r));
  }, [duration]);

  // Keep the live player honouring the draft while the editor is open.
  useEffect(() => {
    if (id) setClipDraft(id, range);
  }, [id, range]);

  useEffect(() => onLiveFrame(() => {
    if (head.current) {
      const live = engine.loadedTrackId === id && duration;
      head.current.style.opacity = live ? "1" : "0";
      if (live) head.current.style.left = `${(engine.position / duration) * 100}%`;
    }
  }), [id, duration]);

  const analysis = useAnalysis(id, track?.kind === "video");
  const levels = useMemo(() => {
    if (!track) return [];
    if (analysis.peaks) return analysis.peaks.map((v) => Math.max(0.04, v));
    // Until the file is read (or if it can't be), an outline of a typical song.
    const r = rng(track.seed);
    return Array.from({ length: BARS }, (_, i) => {
      const t = i / BARS;
      const intro = Math.min(1, t * 6);
      const outro = Math.min(1, (1 - t) * 8);
      const section = 0.55 + 0.45 * Math.abs(Math.sin(t * Math.PI * (2 + (track.seed % 3))));
      return Math.max(0.08, intro * outro * section * (0.55 + r() * 0.45));
    });
  }, [track, analysis.peaks]);

  if (!track || !id) {
    return (
      <Shell title="Clip editor" icon="scissors" size="lg">
        <div className="empty"><strong>No songs to edit yet</strong><p>Import or download a song, then come back to set its playback range.</p></div>
      </Shell>
    );
  }

  const clamp = (r: { start: number; end: number }, which: "start" | "end") => {
    let { start, end } = r;
    start = Math.max(0, Math.min(start, duration - MIN_LEN));
    end = Math.min(duration, Math.max(end, MIN_LEN));
    if (end - start < MIN_LEN) {
      if (which === "start") start = end - MIN_LEN;
      else end = start + MIN_LEN;
    }
    return { start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 };
  };

  const timeAt = (clientX: number) => {
    const rect = wave.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration;
  };

  const handleDown = (which: "start" | "end") => (e: PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = which;
  };
  const handleMove = (e: PointerEvent<HTMLButtonElement>) => {
    const which = dragging.current;
    if (!which) return;
    const t = timeAt(e.clientX);
    setRange((r) => clamp({ ...r, [which]: t }, which));
  };
  const handleUp = () => {
    dragging.current = null;
  };
  const handleKey = (which: "start" | "end") => (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 5 : 1;
    const delta = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    setRange((r) => clamp({ ...r, [which]: r[which] + delta }, which));
  };

  const scrub = (e: PointerEvent<HTMLDivElement>) => {
    if (engine.loadedTrackId !== id) return;
    seek(timeAt(e.clientX));
  };

  const pick = (next: string) => {
    setClipDraft(id, null);
    setId(next);
    const d = tracks[next].duration;
    setRange(clips[next] ?? { start: 0, end: d });
  };

  const full = range.start <= 0.05 && range.end >= duration - 0.05;
  const saved = clips[id];
  const dirty = saved ? saved.start !== range.start || saved.end !== range.end : !full;
  const previewing = currentId === id && isPlaying;

  return (
    <Shell
      title="Clip editor"
      subtitle="Choose exactly which part of a song plays. The file itself is never changed."
      icon="scissors"
      size="lg"
      footer={
        <>
          <button type="button" className="btn ghost" onClick={() => setRange({ start: 0, end: duration })} disabled={full}>Use full song</button>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={closeModal}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!dirty}
            onClick={() => {
              saveClip(id, full ? null : range);
              toast(full ? "Clip removed" : `Clip saved · ${formatTime(range.end - range.start)}`, { tone: "success", detail: track.title });
              closeModal();
            }}
          >
            Save clip
          </button>
        </>
      }
    >
      <div className="clip-track">
        <TrackArt trackId={id} className="clip-art" />
        <div className="title-text">
          <span className="t-name">{track.title}</span>
          <span className="t-sub">{creditLine(track, artists)} · {formatTime(duration)}</span>
        </div>
        {options.length > 1 ? <label className="select">
          <span className="sr-only">Song</span>
          <select value={id} onChange={(e) => pick(e.target.value)} aria-label="Choose a song to clip">
            {options.map((o) => (
              <option key={o} value={o}>{tracks[o].title} — {creditLine(tracks[o], artists)}{clips[o] ? " ✂" : ""}</option>
            ))}
          </select>
        </label> : null}
      </div>

      <div className="clip-stage">
        <div className="clip-ruler" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => <span key={i}>{formatTime((duration * i) / 5)}</span>)}
        </div>
        {analysis.frames?.length ? (
          <div className="clip-frames" aria-hidden="true">
            {analysis.frames.map((src, i) => <img key={i} src={src} alt="" />)}
          </div>
        ) : null}
        <div ref={wave} className={`clip-wave${analysis.peaks ? "" : " estimated"}`} onPointerDown={scrub} style={{ "--s": range.start / duration, "--e": range.end / duration } as CSSProperties}>
          <div className="clip-bars" aria-hidden="true">
            {levels.map((v, i) => {
              const t = (i + 0.5) / BARS;
              const inside = t >= range.start / duration && t <= range.end / duration;
              return <i key={i} className={inside ? "in" : ""} style={{ "--v": v } as CSSProperties} />;
            })}
          </div>
          <span className="clip-shade left" aria-hidden="true" />
          <span className="clip-shade right" aria-hidden="true" />
          <span className="clip-window" aria-hidden="true" />
          <span ref={head} className="clip-head" aria-hidden="true" />
          {(["start", "end"] as const).map((which) => (
            <button
              key={which}
              type="button"
              className={`clip-handle ${which}`}
              role="slider"
              aria-label={`Clip ${which}`}
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(range[which])}
              aria-valuetext={formatTime(range[which])}
              onPointerDown={handleDown(which)}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
              onKeyDown={handleKey(which)}
            >
              <span className="grip" />
              <span className="handle-time">{formatTime(range[which])}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="clip-controls">
        <TimeInput label="Start" value={range.start} onCommit={(v) => setRange((r) => clamp({ ...r, start: v }, "start"))} />
        <div className="clip-length">
          <small>Clip length</small>
          <strong>{formatTime(range.end - range.start)}</strong>
        </div>
        <TimeInput label="End" value={range.end} onCommit={(v) => setRange((r) => clamp({ ...r, end: v }, "end"))} />
        <button type="button" className={`btn${previewing ? "" : " primary"}`} onClick={() => (previewing ? togglePlay() : previewClip(id))}>
          <Icon name={previewing ? "pause" : "play"} size={18} />
          {previewing ? "Pause" : "Preview"}
        </button>
      </div>
      <p className="muted small" role="status">
        {analysis.peaks ? "" : analysis.failed ? "This song's file couldn't be read, so the waveform is only an outline. " : "Reading the song's waveform… "}
        Drag the handles, use arrow keys (Shift for 5s steps), or type exact times. Click the waveform to scrub while previewing.
      </p>
    </Shell>
  );
}
