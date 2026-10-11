import { releaseVideo, setCurrentVideo } from "./video";

interface Voice {
  position(): number;
  play(): void;
  pause(): void;
  seek(position: number): void;
  setRate(rate: number): void;
  fadeOut(seconds: number): void;
}

/** Fades a gain node to silence and disconnects it once inaudible. */
function retire(ctx: AudioContext, node: GainNode, seconds: number) {
  const now = ctx.currentTime;
  node.gain.cancelScheduledValues(now);
  node.gain.setValueAtTime(node.gain.value, now);
  node.gain.linearRampToValueAtTime(0, now + seconds);
  setTimeout(() => node.disconnect(), (seconds + 0.6) * 1000);
}

class MediaVoice implements Voice {
  private el: HTMLMediaElement;
  private out: GainNode;
  private ctx: AudioContext;
  private retired = false;

  private onEnded: () => void;
  private onBlocked: () => void;

  constructor(
    ctx: AudioContext, dest: AudioNode, url: string, video: boolean, start: number, rate: number, fadeIn: number,
    onDuration: (d: number) => void, onError: () => void, onEnded: () => void, onBlocked: () => void,
  ) {
    this.onEnded = onEnded;
    this.onBlocked = onBlocked;
    this.ctx = ctx;
    if (video) {
      const el = document.createElement("video");
      el.playsInline = true;
      el.className = "player-video";
      this.el = el;
      setCurrentVideo(el);
    } else this.el = new Audio();
    this.el.src = url;
    this.el.preload = "auto";
    this.el.playbackRate = rate;
    this.el.currentTime = start;
    this.el.onloadedmetadata = () => {
      if (Number.isFinite(this.el.duration)) onDuration(this.el.duration);
      if (start) this.el.currentTime = start;
    };
    this.el.onerror = () => {
      if (!this.retired) onError();
    };
    // The file can end before the expected duration; treat that as the end of the song.
    this.el.onended = () => {
      if (!this.retired) this.onEnded();
    };
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, ctx.currentTime);
    this.out.gain.linearRampToValueAtTime(1, ctx.currentTime + Math.max(0.02, fadeIn));
    ctx.createMediaElementSource(this.el).connect(this.out);
    this.out.connect(dest);
  }

  position() {
    return this.el.currentTime;
  }
  play() {
    this.el.play().catch((error: unknown) => {
      // AbortError means a pause/seek interrupted the start, and unsupported files are reported via onerror.
      const name = error instanceof DOMException ? error.name : "";
      if (!this.retired && name !== "AbortError" && name !== "NotSupportedError") this.onBlocked();
    });
  }
  pause() {
    this.el.pause();
  }
  seek(position: number) {
    this.el.currentTime = position;
  }
  setRate(rate: number) {
    this.el.playbackRate = rate;
  }
  fadeOut(seconds: number) {
    this.retired = true;
    retire(this.ctx, this.out, seconds);
    if (this.el instanceof HTMLVideoElement) releaseVideo(this.el, seconds * 1000 + 300);
    setTimeout(() => {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
    }, seconds * 1000 + 200);
  }
}

export interface LoadOptions {
  start?: number;
  end: number;
  autoplay: boolean;
  /** Seconds to overlap with the outgoing track. */
  crossfade?: number;
}

export interface EngineTrack {
  id: string;
  fileUrl?: string;
  /** Play `fileUrl` through a visible <video> element. */
  video?: boolean;
}

/**
 * Single playback engine shared by the whole UI. The store drives it; the
 * engine reports back through the `on*` callbacks.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private mix: GainNode | null = null;
  private master: GainNode | null = null;
  private voice: Voice | null = null;
  /** Outgoing voices still fading out after a track change. */
  private retiring = new Set<Voice>();
  private comp: DynamicsCompressorNode | null = null;
  private start = 0;
  private end = 0;
  private monitor = 0;
  private firedNear = false;
  private firedEnd = false;
  private trackId: string | null = null;
  analyser: AnalyserNode | null = null;
  playing = false;
  volume = 0.8;
  muted = false;
  rate = 1;
  /** When > 0 the engine raises `onNearEnd` this many seconds before the end. */
  lead = 0;
  onEnded: () => void = () => undefined;
  onNearEnd: () => void = () => undefined;
  onDuration: (trackId: string, seconds: number) => void = () => undefined;
  onError: (trackId: string) => void = () => undefined;
  /** The browser refused to start playback (e.g. autoplay rules), so nothing is audible. */
  onBlocked: (trackId: string) => void = () => undefined;
  /** Position samples for listening credit: where playback is, when, at what rate, and whether it can be heard. */
  onProgress: (position: number, clock: number, rate: number, audible: boolean) => void = () => undefined;
  /** Playback jumped or changed pace, so the next sample must not be compared with the last one. */
  onDiscontinuity: () => void = () => undefined;

  captureProgress() {
    this.onProgress(this.position, performance.now(), this.rate, this.playing && this.ctx?.state === "running" && !this.muted && this.volume > 0);
  }

  private mediaEnded(id: string) {
    if (id !== this.trackId || !this.playing || this.firedEnd) return;
    this.firedEnd = true;
    this.captureProgress();
    this.onEnded();
  }

  private ensure() {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "playback" });
      const mix = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      this.comp = comp;
      const master = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      mix.connect(comp).connect(master).connect(analyser).connect(ctx.destination);
      this.ctx = ctx;
      this.mix = mix;
      this.master = master;
      this.analyser = analyser;
      this.applyVolume();
      this.applyNormalize();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private applyVolume() {
    if (!this.master || !this.ctx) return;
    const target = this.muted ? 0 : this.volume ** 2;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  normalize = true;

  setNormalize(on: boolean) {
    this.normalize = on;
    this.applyNormalize();
  }

  /** Normalize on: gentle leveling compressor. Off: effectively a bypass. */
  private applyNormalize() {
    if (!this.comp) return;
    this.comp.threshold.value = this.normalize ? -18 : 0;
    this.comp.ratio.value = this.normalize ? 4 : 1;
    this.comp.knee.value = this.normalize ? 12 : 0;
  }

  /** Fades out the current voice and remembers it until it is silent. */
  private retireVoice(seconds: number) {
    const v = this.voice;
    if (!v) return;
    v.fadeOut(seconds);
    this.retiring.add(v);
    setTimeout(() => this.retiring.delete(v), seconds * 1000 + 300);
  }

  /** Silences any crossfade tail immediately (pause, seek, unload). */
  private killRetiring() {
    this.retiring.forEach((v) => v.fadeOut(0.05));
    this.retiring.clear();
  }

  get position() {
    return this.voice ? Math.min(this.voice.position(), this.end || Infinity) : 0;
  }

  get loadedTrackId() {
    return this.trackId;
  }

  load(track: EngineTrack, options: LoadOptions) {
    this.onDiscontinuity();
    const ctx = this.ensure();
    const crossfade = options.crossfade ?? 0;
    this.retireVoice(crossfade > 0 ? crossfade : 0.12);
    const start = options.start ?? 0;
    this.start = start;
    this.end = options.end;
    this.firedEnd = false;
    this.firedNear = false;
    this.trackId = track.id;
    const id = track.id;
    if (!track.fileUrl) {
      // Every song is a real file or stream; one without audio can only fail.
      this.voice = null;
      this.playing = false;
      queueMicrotask(() => this.onError(id));
      return;
    }
    this.voice = new MediaVoice(
      ctx, this.mix!, track.fileUrl, Boolean(track.video), start, this.rate, crossfade,
      (d) => this.onDuration(id, d),
      () => this.onError(id),
      () => this.mediaEnded(id),
      () => this.onBlocked(id),
    );
    if (options.autoplay) this.play();
    else this.playing = false;
  }

  /** Updates the playable range; playback outside the new range snaps to its start. */
  setRange(start: number, end: number) {
    this.captureProgress();
    this.onDiscontinuity();
    this.start = start;
    this.setEnd(end);
    // Use the raw voice position; the `position` getter is already clamped to the new end.
    const pos = this.voice?.position();
    if (pos !== undefined && (pos < start - 0.05 || pos > end)) this.seek(start);
  }

  setEnd(end: number) {
    this.end = end;
    if (this.position < end - this.leadPos()) this.firedNear = false;
    if (this.position < end) this.firedEnd = false;
  }

  play() {
    if (!this.voice) return;
    this.ensure();
    this.onDiscontinuity();
    if (this.position >= this.end - 0.05 || this.position < this.start - 0.05) this.seek(this.start);
    this.voice.play();
    this.playing = true;
    clearInterval(this.monitor);
    this.monitor = window.setInterval(this.check, 60);
  }

  pause() {
    this.captureProgress();
    this.onDiscontinuity();
    this.voice?.pause();
    this.killRetiring();
    this.playing = false;
    clearInterval(this.monitor);
  }

  seek(position: number) {
    if (!this.voice) return;
    this.captureProgress();
    this.onDiscontinuity();
    // Stay inside the clip range.
    const p = Math.max(this.start, Math.min(position, Math.max(this.start, this.end - 0.05)));
    this.killRetiring();
    this.voice.seek(p);
    if (p < this.end - this.leadPos()) this.firedNear = false;
    this.firedEnd = false;
  }

  unload() {
    this.pause();
    this.retireVoice(0.1);
    this.voice = null;
    this.trackId = null;
  }

  setVolume(volume: number, muted = this.muted) {
    this.captureProgress();
    this.onDiscontinuity();
    this.volume = volume;
    this.muted = muted;
    this.applyVolume();
  }

  setRate(rate: number) {
    this.captureProgress();
    this.onDiscontinuity();
    this.rate = rate;
    this.voice?.setRate(rate);
  }

  /**
   * Crossfade length in song-position seconds. `lead` is wall-clock seconds, so
   * it scales with playback rate, and it never exceeds a third of the clip.
   */
  private leadPos() {
    if (this.lead <= 0) return 0;
    const span = this.end - this.start;
    const wanted = this.lead * this.rate;
    return span >= wanted * 3 ? wanted : 0;
  }

  /** Real seconds the outgoing song overlaps the next one. */
  get crossfadeSeconds() {
    return this.leadPos() / this.rate;
  }

  private check = () => {
    if (!this.voice || !this.playing) return;
    this.captureProgress();
    const pos = this.voice.position();
    const lead = this.leadPos();
    if (lead > 0 && !this.firedNear && pos >= this.end - lead) {
      this.firedNear = true;
      this.onNearEnd();
      return;
    }
    if (!this.firedEnd && pos >= this.end - 0.02) {
      this.firedEnd = true;
      this.onEnded();
    }
  };
}

export const engine = new AudioEngine();

// Live audio and app state cannot be swapped in place: when this module (or anything it imports) changes, reload the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
