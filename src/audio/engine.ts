import { hasVideoDemand, parkMedia, releaseVideo, setCurrentVideo } from "./video";
import { fadeLevel, type FadeShape } from "../data/types";
import { activateNativeAudio, isNativeApp } from "../lib/native";

interface Voice {
  position(): number;
  play(): Promise<void>;
  paused(): boolean;
  ended(): boolean;
  syncPresentation(): void;
  pause(immediate?: boolean): void;
  seek(position: number): void;
  setRate(rate: number): void;
  fadeOut(seconds: number): void;
  /** The clip's fade level (0–1), separate from crossfades. `now` jumps straight to it (after a seek). */
  setLevel(level: number, now?: boolean): void;
  /** Carries the clip's fade on by itself: through `curve` (levels, evenly spaced) over `seconds` (a voice retired mid-fade). */
  rampLevel(curve: Float32Array, seconds: number): void;
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
  onPaused: () => void = () => undefined;
  onWaiting: () => void = () => undefined;
  onPlaying: () => void = () => undefined;
  private el: HTMLMediaElement;
  private out: GainNode;
  /** The clip's fade in/out, ahead of `out` (which crossfades and retiring use). */
  private env: GainNode;
  /** Pause/play declicking: pausing fades this out before the element stops, and starting fades it back in. */
  private gate: GainNode;
  /** A pause waiting for its fade to finish. Playing again in that window cancels it, so quick toggles never stop the media. */
  private pauseTimer = 0;
  private level = 1;
  private ctx: AudioContext;
  private retired = false;
  /** Playback was asked for and not since paused. */
  private wanted = false;
  private playRequest = 0;
  private pendingSeek: number | null = null;
  private awaitingMetadata = true;
  /** On iPhone the audible owner stays an audio element. The optional muted
   * picture may be suspended by iOS without interrupting listening. */
  private picture: HTMLVideoElement | null = null;

  private onEnded: () => void;
  private onBlocked: () => void;

  /** `hold`: silent and out of sight until `takeOver` (a copy getting ready to replace the playing one). */
  constructor(
    ctx: AudioContext, dest: AudioNode, url: string, video: boolean, start: number, rate: number, fadeIn: number,
    onDuration: (d: number) => void, onError: (error?: MediaError | null) => void, onEnded: () => void, onBlocked: () => void, hold = false,
  ) {
    this.onEnded = onEnded;
    this.onBlocked = onBlocked;
    this.ctx = ctx;
    if (video && !isNativeApp) {
      const el = document.createElement("video");
      el.playsInline = true;
      el.className = "player-video";
      this.el = el;
      if (video && !hold) setCurrentVideo(el);
      else parkMedia(el);
    } else this.el = new Audio();
    if (isNativeApp) parkMedia(this.el);
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, ctx.currentTime);
    if (!hold) this.out.gain.linearRampToValueAtTime(1, ctx.currentTime + Math.max(0.02, fadeIn));
    this.env = ctx.createGain();
    this.gate = ctx.createGain();
    ctx.createMediaElementSource(this.el).connect(this.env);
    this.env.connect(this.gate);
    this.gate.connect(this.out);
    // WebKit can replay a few stale milliseconds when a paused element starts again; it opens under a short fade.
    this.el.onplaying = () => {
      if (!this.wanted || this.retired) return;
      this.openGate();
      this.onPlaying();
    };
    this.el.onpause = () => {
      // Our own pause/source changes clear wanted first. A remaining pause is
      // WebKit or the listener's audio route stopping playback, not a retry.
      if (!this.wanted || this.retired || !this.el.paused || this.el.ended) return;
      this.wanted = false;
      this.playRequest++;
      this.onPaused();
    };
    this.el.onwaiting = this.el.onstalled = () => {
      if (this.wanted && !this.retired && !this.el.paused) this.onWaiting();
    };
    this.out.connect(dest);
    this.setSource(url, start, rate, onDuration, onError, onEnded, onBlocked);
    this.present(url, video, hold);
  }

  private present(url: string, video: boolean, hold = false) {
    if (!isNativeApp) return;
    if (this.picture) {
      this.picture.onloadedmetadata = null;
      this.picture.pause();
      this.picture.removeAttribute("src");
      releaseVideo(this.picture, 0);
      this.picture = null;
    }
    if (!video) return;
    const picture = document.createElement("video");
    picture.playsInline = true;
    picture.muted = true;
    picture.defaultMuted = true;
    picture.disableRemotePlayback = true;
    picture.className = "player-video";
    picture.src = url;
    picture.preload = "metadata";
    picture.playbackRate = this.el.playbackRate;
    picture.onloadedmetadata = () => this.syncPresentation();
    picture.addEventListener("presentationchange", () => this.syncPresentation());
    this.picture = picture;
    if (hold) parkMedia(picture);
    else setCurrentVideo(picture);
  }

  syncPresentation() {
    const picture = this.picture;
    if (!picture) return;
    if (document.visibilityState === "hidden" || !hasVideoDemand(picture)) {
      if (!picture.paused) picture.pause();
      return;
    }
    if (Math.abs(picture.currentTime - this.el.currentTime) > 0.3) {
      try { picture.currentTime = this.el.currentTime; } catch { /* Metadata will align it. */ }
    }
    if (this.wanted && !this.retired && picture.paused) void picture.play().catch(() => undefined);
  }

  private setSource(url: string, start: number, rate: number, onDuration: (d: number) => void, onError: (error?: MediaError | null) => void, onEnded: () => void, onBlocked: () => void) {
    this.onEnded = onEnded;
    this.onBlocked = onBlocked;
    this.awaitingMetadata = true;
    this.el.src = url;
    this.el.preload = "auto";
    this.el.playbackRate = rate;
    this.seek(start);
    this.el.onloadedmetadata = () => {
      // A restored position or a user seek may have replaced the clip start
      // while metadata was loading. Apply the latest request exactly once.
      const position = this.pendingSeek;
      this.pendingSeek = null;
      this.awaitingMetadata = false;
      if (position !== null) this.el.currentTime = position;
      if (Number.isFinite(this.el.duration)) onDuration(this.el.duration);
    };
    this.el.onerror = () => {
      if (!this.retired) onError(this.el.error);
    };
    // The file can end before the expected duration; treat that as the end of the song.
    this.el.onended = () => {
      if (!this.retired) this.onEnded();
    };
  }

  /** Native ordinary handoffs retain the element/source node that owns the
   * playback session. A retired voice is never reusable: it has cleanup queued.
   */
  replace(url: string, video: boolean, start: number, rate: number, onDuration: (d: number) => void, onError: (error?: MediaError | null) => void, onEnded: () => void, onBlocked: () => void) {
    if (this.retired) return false;
    this.playRequest++;
    this.wanted = false;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = 0;
    const now = this.ctx.currentTime;
    this.gate.gain.cancelScheduledValues(now);
    // Shut until the new song plays (play() opens it), so a pause still fading out can't blip the old one at full level.
    this.gate.gain.setValueAtTime(0, now);
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(1, now);
    this.env.gain.cancelScheduledValues(now);
    this.env.gain.setValueAtTime(1, now);
    this.level = 1;
    this.setSource(url, start, rate, onDuration, onError, onEnded, onBlocked);
    this.present(url, video);
    if (this.el instanceof HTMLVideoElement) setCurrentVideo(video ? this.el : null);
    return true;
  }

  /** Calls `ready` once a held voice is playing (silently), or, if it isn't to play, once it could. */
  prepare(play: boolean, ready: () => void) {
    const done = () => {
      if (!this.retired) ready();
    };
    if (play) {
      this.el.addEventListener("playing", done, { once: true });
      void this.play().catch(() => { if (!this.retired && this.wanted) this.onBlocked(); });
    } else if (this.el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) queueMicrotask(done);
    else this.el.addEventListener("canplay", done, { once: true });
  }

  /** A held voice becomes the one heard (and seen). */
  takeOver(fadeIn: number) {
    if (this.picture) setCurrentVideo(this.picture);
    else if (this.el instanceof HTMLVideoElement) setCurrentVideo(this.el);
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(1, now + Math.max(0.02, fadeIn));
  }

  position() {
    return this.el.currentTime;
  }
  paused() { return this.el.paused; }
  ended() { return this.el.ended; }

  private openGate() {
    const now = this.ctx.currentTime;
    this.gate.gain.cancelScheduledValues(now);
    this.gate.gain.setValueAtTime(this.gate.gain.value, now);
    this.gate.gain.linearRampToValueAtTime(1, now + 0.04);
  }

  /** A canceled start can never report failure against a later Play request. */
  play(): Promise<void> {
    this.wanted = true;
    const request = ++this.playRequest;
    if (this.pauseTimer) {
      // Still fading out from a pause: the element never stopped, so it just fades back in.
      clearTimeout(this.pauseTimer);
      this.pauseTimer = 0;
      this.openGate();
    } else if (this.el.paused) {
      // Held shut until the element is actually playing (onplaying opens it).
      const now = this.ctx.currentTime;
      this.gate.gain.cancelScheduledValues(now);
      this.gate.gain.setValueAtTime(0, now);
    }
    const current = () => this.wanted && !this.retired && this.playRequest === request;
    const start = async (retry: boolean): Promise<void> => {
      try {
        await this.el.play();
        // In case "playing" fired before this request (or not at all), never leave a started song silent.
        if (current()) this.openGate();
      } catch (error) {
        if (!current()) return;
        // Seeking or updating metadata may interrupt a start. A fresh play()
        // waits for readiness itself; don't wait for a canplay event that may
        // already have fired, or leave the second failure silently pending.
        if (!retry && error instanceof DOMException && error.name === "AbortError") {
          await Promise.resolve();
          if (current()) return start(true);
          return;
        }
        throw error;
      }
    };
    const playing = start(false);
    this.syncPresentation();
    return playing;
  }
  pause(immediate = false) {
    this.playRequest++;
    this.wanted = false;
    if (immediate) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = 0;
      const now = this.ctx.currentTime;
      this.gate.gain.cancelScheduledValues(now);
      this.gate.gain.setValueAtTime(0, now);
      this.stopMedia();
      return;
    }
    if (this.pauseTimer) return;
    // A suspended graph can't run the fade, and a hidden page's timers may be held back: stop at once.
    if (this.el.paused || this.ctx.state !== "running" || document.visibilityState === "hidden") {
      this.stopMedia();
      return;
    }
    const now = this.ctx.currentTime;
    this.gate.gain.cancelScheduledValues(now);
    this.gate.gain.setValueAtTime(this.gate.gain.value, now);
    this.gate.gain.linearRampToValueAtTime(0, now + 0.045);
    this.pauseTimer = window.setTimeout(() => {
      this.pauseTimer = 0;
      if (!this.wanted) this.stopMedia();
    }, 60);
  }
  private stopMedia() {
    this.el.pause();
    this.picture?.pause();
  }
  seek(position: number) {
    this.pendingSeek = this.awaitingMetadata || this.el.readyState === HTMLMediaElement.HAVE_NOTHING ? position : null;
    // Some engines cannot apply a seek before metadata; loadedmetadata will
    // apply the latest position if this initial assignment is not yet legal.
    try { this.el.currentTime = position; } catch { this.pendingSeek = position; }
    this.syncPresentation();
  }
  setRate(rate: number) {
    this.el.playbackRate = rate;
    if (this.picture) this.picture.playbackRate = rate;
  }
  rampLevel(curve: Float32Array, seconds: number) {
    const t = this.ctx.currentTime;
    this.env.gain.cancelScheduledValues(t);
    this.env.gain.setValueCurveAtTime(curve, t, Math.max(0.01, seconds));
    this.level = curve[curve.length - 1] ?? 0;
  }
  setLevel(level: number, now = false) {
    if (!now && Math.abs(level - this.level) < 0.002) return;
    this.level = level;
    const t = this.ctx.currentTime;
    this.env.gain.cancelScheduledValues(t);
    if (now) this.env.gain.setValueAtTime(level, t);
    // Followed smoothly between the monitor's 60ms looks, so a fade is a curve, not steps.
    else this.env.gain.setTargetAtTime(level, t, 0.03);
  }
  fadeOut(seconds: number) {
    this.playRequest++;
    clearTimeout(this.pauseTimer);
    this.pauseTimer = 0;
    this.retired = true;
    this.wanted = false;
    retire(this.ctx, this.out, seconds);
    if (this.el instanceof HTMLVideoElement) releaseVideo(this.el, seconds * 1000 + 300);
    if (this.picture) releaseVideo(this.picture, seconds * 1000 + 300);
    setTimeout(() => {
      this.el.pause();
      this.el.removeAttribute("src");
      this.picture?.pause();
      this.picture?.removeAttribute("src");
      // Explicit load() on an outgoing element creates a fresh empty media
      // session in WebKit, which can reclaim Now Playing from the next song.
    }, seconds * 1000 + 200);
  }
}

export interface LoadOptions {
  start?: number;
  /** Initial playhead, independent of the clip's start boundary. */
  position?: number;
  end: number;
  /** The clip's fade in and out, in song seconds (0 for none). */
  fadeIn?: number;
  fadeOut?: number;
  fadeShape?: FadeShape;
  autoplay: boolean;
  /** Seconds to overlap with the outgoing track. */
  crossfade?: number;
}

/** Tone controls: gains in dB (−12 to +12) and left/right balance (−1 to 1). */
export interface Tone { bass: number; mid: number; treble: number; balance: number }
export const FLAT: Tone = { bass: 0, mid: 0, treble: 0, balance: 0 };

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
  private eq: { pre: GainNode; bass: BiquadFilterNode; mid: BiquadFilterNode; treble: BiquadFilterNode; pan: StereoPannerNode } | null = null;
  tone: Tone = FLAT;
  private start = 0;
  private end = 0;
  private fadeInFor = 0;
  private fadeOutFor = 0;
  private fadeShape: FadeShape = "smooth";
  /** While a clip is being edited: the song whose range plays round and round instead of moving on (see the clip editor). */
  loopTrack: string | null = null;
  private get looping() {
    return this.loopTrack !== null && this.loopTrack === this.trackId;
  }
  private monitor = 0;
  private firedNear = false;
  private firedEnd = false;
  private trackId: string | null = null;
  private url: string | null = null;
  /** A copy of the loaded song getting ready to replace it (see `swap`). */
  private swapping: MediaVoice | null = null;
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
  onError: (trackId: string, error?: MediaError | null) => void = () => undefined;
  /** The browser refused to start playback (e.g. autoplay rules), so nothing is audible. */
  onBlocked: (trackId: string) => void = () => undefined;
  /** Position samples for listening credit: where playback is, when, at what rate, and whether it can be heard. */
  onProgress: (position: number, clock: number, rate: number, audible: boolean) => void = () => undefined;
  /** Playback jumped or changed pace, so the next sample must not be compared with the last one. */
  onDiscontinuity: () => void = () => undefined;
  /** Playback started, stopped or moved, so anything showing the position should look again. */
  onChange: () => void = () => undefined;
  /** Suspends the audio graph a little after pausing, so an idle app isn't processing silence. */
  private sleepTimer = 0;
  private playRequest = 0;
  private nativeSessionActive = false;
  private nativeActivation: Promise<void> | null = null;
  private starting = false;
  /** An OS interruption or external media pause requires an explicit Play. */
  onInterrupted: (trackId: string) => void = () => undefined;
  onWaiting: (trackId: string) => void = () => undefined;
  onStarted: (trackId: string) => void = () => undefined;

  private jumped() {
    this.onDiscontinuity();
    this.onChange();
  }

  /** Lets the audio graph sleep once nothing is playing or fading out. */
  private sleepSoon() {
    clearTimeout(this.sleepTimer);
    this.sleepTimer = window.setTimeout(() => {
      const ctx = this.ctx;
      if (this.playing || ctx?.state !== "running") return;
      void ctx.suspend().catch(() => undefined).then(() => {
        // Played again while it was going to sleep (ensure() still saw it running): wake it back up.
        if (this.playing && ctx.state !== "running" && ctx.state !== "closed") void ctx.resume().catch(() => undefined);
      });
    }, 3000);
  }

  captureProgress() {
    this.onProgress(this.position, performance.now(), this.rate, this.playing && this.ctx?.state === "running" && !this.muted && this.volume > 0);
  }

  private mediaEnded(id: string) {
    if (id !== this.trackId || !this.playing || this.firedEnd) return;
    if (this.looping) {
      this.seek(this.start);
      this.play();
      this.onChange();
      return;
    }
    this.firedEnd = true;
    this.captureProgress();
    this.onEnded();
  }

  private ensure() {
    // WebKit's Web Audio background policy uses the web session type as well
    // as the containing app's AVAudioSession category.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session && session.type !== "playback") {
      try { session.type = "playback"; } catch { /* Older engines may expose a read-only implementation. */ }
    }
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "playback" });
      const mix = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      this.comp = comp;
      const master = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.82;
      // Tone controls: headroom, then bass (low shelf), mid (a broad bell) and treble (high shelf), and balance.
      const pre = ctx.createGain();
      const bass = ctx.createBiquadFilter();
      bass.type = "lowshelf";
      bass.frequency.value = 120;
      const mid = ctx.createBiquadFilter();
      mid.type = "peaking";
      mid.frequency.value = 1000;
      mid.Q.value = 0.7;
      const treble = ctx.createBiquadFilter();
      treble.type = "highshelf";
      treble.frequency.value = 6000;
      const pan = ctx.createStereoPanner();
      this.eq = { pre, bass, mid, treble, pan };
      mix.connect(pre).connect(bass).connect(mid).connect(treble).connect(comp).connect(pan).connect(master).connect(analyser).connect(ctx.destination);
      this.ctx = ctx;
      ctx.addEventListener("statechange", () => {
        if (ctx.state !== "running") {
          this.nativeSessionActive = false;
          // While a start is in progress, its own handshake rides out (and finally checks) this state: activating the
          // native session can briefly interrupt WebKit's graph, and treating that as an OS interruption cancelled
          // the start it was part of.
          if (this.playing && !this.starting) this.interrupted();
        }
      });
      this.mix = mix;
      this.master = master;
      this.analyser = analyser;
      this.applyVolume();
      this.applyNormalize();
      this.applyTone();
    }
    clearTimeout(this.sleepTimer);
    // Loaded without playing (a restored song, say): sleep again unless playback starts.
    this.sleepSoon();
    return this.ctx;
  }

  private applyVolume() {
    if (!this.master || !this.ctx) return;
    const target = this.muted ? 0 : this.volume ** 2;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  setTone(tone: Tone) {
    this.tone = tone;
    this.applyTone();
  }

  private applyTone() {
    if (!this.eq || !this.ctx) return;
    const { pre, bass, mid, treble, pan } = this.eq;
    const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
    const t = { bass: clamp(this.tone.bass, -12, 12), mid: clamp(this.tone.mid, -12, 12), treble: clamp(this.tone.treble, -12, 12) };
    const now = this.ctx.currentTime;
    // Glides rather than jumps, so dragging a control never clicks.
    bass.gain.setTargetAtTime(t.bass, now, 0.03);
    mid.gain.setTargetAtTime(t.mid, now, 0.03);
    treble.gain.setTargetAtTime(t.treble, now, 0.03);
    // Boosting adds loudness that could clip; turn the input down by part of the biggest boost.
    const boost = Math.max(0, t.bass, t.mid, t.treble);
    pre.gain.setTargetAtTime(10 ** (-(boost * 0.6) / 20), now, 0.03);
    pan.pan.setTargetAtTime(clamp(this.tone.balance, -1, 1), now, 0.03);
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
    if (this.fadeOutFor > 0) {
      const pos = v.position();
      const left = Math.max(0, this.end - pos);
      if (left > 0 && left < this.fadeOutFor + 0.05) {
        // The rest of its fade, in its shape, sampled for the audio clock to follow.
        const curve = new Float32Array(32);
        for (let i = 0; i < curve.length; i++) curve[i] = fadeLevel((left - (left * i) / (curve.length - 1)) / this.fadeOutFor, this.fadeShape);
        v.rampLevel(curve, left / (this.rate || 1));
      }
    }
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

  /** The file the loaded song plays from. */
  get loadedUrl() {
    return this.url;
  }

  private dropSwap() {
    this.swapping?.fadeOut(0);
    this.swapping = null;
  }

  private interrupted() {
    const id = this.trackId;
    if (!this.playing || !id) return;
    this.nativeSessionActive = false;
    this.pause(true);
    this.onInterrupted(id);
  }

  private watchVoice(voice: MediaVoice, id: string) {
    const current = () => this.voice === voice && this.trackId === id && this.playing;
    // (A start in progress replays a paused element itself; see startVoice.)
    voice.onPaused = () => { if (current() && !this.starting) this.interrupted(); };
    voice.onWaiting = () => { if (current()) this.onWaiting(id); };
    voice.onPlaying = () => {
      if (current() && !this.starting && this.ctx?.state === "running") this.onStarted(id);
    };
  }

  /**
   * Switches the loaded song to another copy of it (a streamed video, once its
   * picture is ready, in place of its audio) without a break: the new copy gets
   * going silently from where the song is, then takes over with a short fade.
   */
  swap(track: EngineTrack) {
    const old = this.voice;
    if (!old || this.trackId !== track.id || !track.fileUrl || track.fileUrl === this.url) return;
    const ctx = this.ensure();
    const id = track.id;
    const url = track.fileUrl;
    this.dropSwap();
    const next: MediaVoice = new MediaVoice(
      ctx, this.mix!, url, Boolean(track.video), old.position(), this.rate, 0,
      (d) => this.onDuration(id, d),
      // The old copy is still fine, so a copy that fails before taking over is just dropped.
      (error) => (this.voice === next ? this.onError(id, error) : this.swapping === next && this.dropSwap()),
      () => {
        if (this.voice === next) this.mediaEnded(id);
      },
      () => {
        if (this.voice === next) this.onBlocked(id);
      },
      true,
    );
    this.watchVoice(next, id);
    this.swapping = next;
    next.prepare(this.playing, () => {
      if (this.swapping !== next) return;
      if (this.voice !== old || this.trackId !== id) return this.dropSwap();
      this.swapping = null;
      // Catch up with the old copy (it kept playing while this one started), or follow a seek made meanwhile.
      if (Math.abs(next.position() - old.position()) > 0.25) next.seek(old.position());
      // Paused, played or sped up meanwhile: the new copy follows.
      next.setRate(this.rate);
      if (!this.playing) next.pause();
      this.captureProgress();
      this.jumped();
      this.retireVoice(0.2);
      this.voice = next;
      this.url = url;
      this.applyLevel(true);
      next.takeOver(0.2);
      // Transfer startup verification to the replacement, including a native
      // activation that is still pending when the video picture becomes ready.
      if (this.playing) this.startVoice();
    });
  }

  load(track: EngineTrack, options: LoadOptions) {
    this.playRequest++;
    this.jumped();
    this.dropSwap();
    const ctx = this.ensure();
    const crossfade = options.crossfade ?? 0;
    // A new handoff replaces the previous overlap, including when the native
    // audio owner itself can be reused for the next song.
    this.killRetiring();
    const reusable = isNativeApp && crossfade <= 0 && track.fileUrl && this.voice instanceof MediaVoice ? this.voice : null;
    if (!reusable) this.retireVoice(crossfade > 0 ? crossfade : 0.12);
    const start = options.start ?? 0;
    this.start = start;
    this.end = options.end;
    this.fadeInFor = options.fadeIn ?? 0;
    this.fadeOutFor = options.fadeOut ?? 0;
    this.fadeShape = options.fadeShape ?? "smooth";
    this.firedEnd = false;
    this.firedNear = false;
    this.trackId = track.id;
    this.url = track.fileUrl ?? null;
    const id = track.id;
    const position = Math.max(start, Math.min(options.position ?? start, Math.max(start, options.end - 0.05)));
    if (!track.fileUrl) {
      // Every song is a real file or stream; one without audio can only fail.
      this.voice = null;
      this.playing = false;
      queueMicrotask(() => this.onError(id));
      return;
    }
    const onDuration = (d: number) => this.onDuration(id, d);
    const onError = (error?: MediaError | null) => this.onError(id, error);
    const onEnded = () => this.mediaEnded(id);
    const onBlocked = () => this.onBlocked(id);
    if (reusable?.replace(track.fileUrl, Boolean(track.video), position, this.rate, onDuration, onError, onEnded, onBlocked)) this.voice = reusable;
    else this.voice = new MediaVoice(ctx, this.mix!, track.fileUrl, Boolean(track.video), position, this.rate, crossfade, onDuration, onError, onEnded, onBlocked);
    this.watchVoice(this.voice as MediaVoice, id);
    if (options.autoplay) this.play();
    else {
      this.playing = false;
      this.nativeActivation = null;
      clearInterval(this.monitor);
    }
  }

  /** Updates the playable range; playback outside the new range snaps to its start. */
  setRange(start: number, end: number) {
    this.captureProgress();
    this.jumped();
    this.start = start;
    this.setEnd(end);
    // Use the raw voice position; the `position` getter is already clamped to the new end.
    const pos = this.voice?.position();
    if (pos !== undefined && (pos < start - 0.05 || pos > end)) this.seek(start);
  }

  /** A clip's fade in and out (song seconds); 0 for none. */
  setFades(fadeIn: number, fadeOut: number, shape: FadeShape = "smooth") {
    this.fadeInFor = Math.max(0, fadeIn);
    this.fadeOutFor = Math.max(0, fadeOut);
    this.fadeShape = shape;
    this.applyLevel(true);
  }

  /** The clip's fade level where playback is: rising over the fade in, falling over the fade out. */
  private applyLevel(now = false) {
    if (!this.voice) return;
    if (!this.fadeInFor && !this.fadeOutFor) return this.voice.setLevel(1, now);
    const pos = this.voice.position();
    const rise = this.fadeInFor ? (pos - this.start) / this.fadeInFor : 1;
    const fall = this.fadeOutFor ? (this.end - pos) / this.fadeOutFor : 1;
    this.voice.setLevel(fadeLevel(Math.min(rise, fall), this.fadeShape), now);
  }

  setEnd(end: number) {
    this.end = end;
    if (this.position < end - this.leadPos()) this.firedNear = false;
    if (this.position < end) this.firedEnd = false;
  }

  play() {
    if (!this.voice) return;
    this.jumped();
    if (this.position >= this.end - 0.05 || this.position < this.start - 0.05) this.seek(this.start);
    this.startVoice();
  }

  /** Start the media and graph in the caller's gesture, then verify both. */
  private startVoice() {
    if (!this.voice) return;
    const ctx = this.ensure();
    this.applyLevel(true);
    this.playing = true;
    this.starting = true;
    const voice = this.voice;
    const id = this.trackId;
    const request = ++this.playRequest;
    const current = () => this.playing && this.voice === voice && this.playRequest === request;
    queueMicrotask(() => { if (current() && id) this.onWaiting(id); });
    let activation = Promise.resolve();
    if (isNativeApp && (!this.nativeSessionActive || ctx.state !== "running")) {
      if (!this.nativeActivation) {
        const pending = activateNativeAudio().then(() => {
          if (this.nativeActivation === pending) this.nativeSessionActive = true;
        }).finally(() => {
          if (this.nativeActivation === pending) this.nativeActivation = null;
        });
        this.nativeActivation = pending;
      }
      activation = this.nativeActivation;
    }
    // These must happen before awaiting the bridge: awaiting first loses the
    // listener's user activation, particularly on a newly created media element.
    const media = voice.play();
    const resume = ctx.state === "running" ? Promise.resolve() : ctx.resume().catch(() => undefined);
    void (async () => {
      await activation;
      await resume;
      if (!current()) return;
      // Native activation can interrupt WebKit's first resume. Confirm the
      // final graph state rather than swallowing the resume failure.
      if (ctx.state !== "running") await ctx.resume();
      await media;
      if (!current()) return;
      if (ctx.state !== "running") await ctx.resume();
      if (!current()) return;
      if (ctx.state !== "running") throw new Error("The audio session didn't resume.");
      if (voice.paused() && !voice.ended()) await voice.play();
      if (current() && id) {
        this.starting = false;
        this.onStarted(id);
      }
    })().catch((error: unknown) => {
      if (!current() || !id) return;
      // A decode/source error has its own diagnostic and recovery path.
      if (error instanceof DOMException && error.name === "NotSupportedError") return;
      this.starting = false;
      this.onBlocked(id);
    });
    // Install a rejection observer immediately, including if activation fails
    // before the start task reaches this promise.
    void media.catch(() => undefined);
    clearInterval(this.monitor);
    this.monitor = window.setInterval(this.check, 60);
  }

  /** Foregrounding must not start a song the listener paused. */
  resumeAfterInterruption() {
    if (!this.playing || !this.voice || !this.ctx || this.ctx.state === "closed") return;
    const voice = this.voice;
    // A real ended event still advances once. Merely reaching a clip boundary
    // on a voice the OS paused is not permission to start the next song.
    if (!voice.ended() && (this.ctx.state !== "running" || voice.paused())) {
      this.interrupted();
      return;
    }
    // Foregrounding is not an explicit replay. An end event delayed while
    // suspended must advance the queue before anything can rewind this voice.
    if (voice.ended() || voice.position() >= this.end - 0.02) {
      if (this.trackId) this.mediaEnded(this.trackId);
      return;
    }
    this.check();
    if (this.voice !== voice || !this.playing) return;
    voice.syncPresentation();
  }

  pause(immediate = false) {
    this.playRequest++;
    this.starting = false;
    this.nativeActivation = null;
    this.captureProgress();
    this.jumped();
    this.voice?.pause(immediate);
    this.killRetiring();
    this.playing = false;
    clearInterval(this.monitor);
    this.sleepSoon();
  }

  seek(position: number) {
    if (!this.voice) return;
    this.captureProgress();
    this.jumped();
    // Stay inside the clip range.
    const p = Math.max(this.start, Math.min(position, Math.max(this.start, this.end - 0.05)));
    this.killRetiring();
    this.voice.seek(p);
    this.applyLevel(true);
    if (p < this.end - this.leadPos()) this.firedNear = false;
    this.firedEnd = false;
  }

  unload() {
    this.dropSwap();
    this.pause();
    this.retireVoice(0.1);
    this.voice = null;
    this.trackId = null;
    this.url = null;
  }

  setVolume(volume: number, muted = this.muted) {
    this.captureProgress();
    this.jumped();
    this.volume = volume;
    this.muted = muted;
    this.applyVolume();
  }

  setRate(rate: number) {
    this.captureProgress();
    this.jumped();
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
    this.voice.syncPresentation();
    this.captureProgress();
    const pos = this.voice.position();
    // Editing a clip: round again from its start rather than ending (or crossfading into the next song).
    if (this.looping && pos >= this.end - 0.03) {
      this.seek(this.start);
      this.onChange();
      return;
    }
    this.applyLevel();
    const lead = this.looping ? 0 : this.leadPos();
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
