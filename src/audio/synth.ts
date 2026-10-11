import { rng } from "../data/library";
import type { Genre } from "../data/types";

/**
 * Procedural song generator. Every mock track gets a deterministic style
 * (tempo, key, progression, groove) derived from its seed, so playback,
 * seeking, speed, crossfade, and clip ranges all behave like real audio
 * without shipping any audio files.
 */

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PROGRESSIONS = [
  [0, 5, 3, 4],
  [0, 4, 5, 3],
  [5, 3, 0, 4],
  [0, 3, 4, 3],
  [0, 5, 1, 4],
  [3, 4, 0, 0],
];

export interface SongStyle {
  genre: Genre;
  bpm: number;
  root: number;
  scale: number[];
  progression: number[];
  motif: Array<{ step: number; degree: number; len: number }>;
  bright: number;
}

export function styleFor(seed: number, genre: Genre): SongStyle {
  const r = rng(seed);
  const tempo: Record<Genre, [number, number]> = {
    lofi: [72, 88],
    synthwave: [98, 116],
    house: [120, 125],
    ambient: [58, 70],
    indie: [96, 124],
  };
  const [lo, hi] = tempo[genre];
  const minor = genre === "synthwave" || genre === "ambient" ? r() < 0.75 : r() < 0.4;
  const motif: SongStyle["motif"] = [];
  for (let step = 0; step < 32; step += 2) {
    if (r() < 0.38) motif.push({ step, degree: Math.floor(r() * 8), len: r() < 0.3 ? 4 : 2 });
  }
  return {
    genre,
    bpm: Math.round(lo + r() * (hi - lo)),
    root: 45 + Math.floor(r() * 9),
    scale: minor ? MINOR : MAJOR,
    progression: PROGRESSIONS[Math.floor(r() * PROGRESSIONS.length)],
    motif,
    bright: 0.6 + r() * 0.8,
  };
}

const midiFreq = (m: number) => 440 * 2 ** ((m - 69) / 12);

let noiseBuffer: AudioBuffer | null = null;
function noise(ctx: BaseAudioContext) {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

interface ToneOptions {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  release?: number;
  cutoff?: number;
  detune?: number;
}

function tone(ctx: BaseAudioContext, dest: AudioNode, t: number, freq: number, dur: number, o: ToneOptions = {}) {
  const osc = ctx.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.value = freq;
  if (o.detune) osc.detune.value = o.detune;
  const env = ctx.createGain();
  const peak = o.gain ?? 0.1;
  const attack = o.attack ?? 0.005;
  const release = o.release ?? 0.12;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + attack);
  env.gain.setValueAtTime(peak, t + Math.max(attack, dur));
  env.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack, dur) + release);
  let head: AudioNode = osc;
  if (o.cutoff) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = o.cutoff;
    filter.Q.value = 0.8;
    osc.connect(filter);
    head = filter;
  }
  head.connect(env).connect(dest);
  osc.start(t);
  osc.stop(t + Math.max(attack, dur) + release + 0.05);
}

function noiseHit(ctx: BaseAudioContext, dest: AudioNode, t: number, o: { type: BiquadFilterType; freq: number; gain: number; decay: number }) {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = o.type;
  filter.frequency.value = o.freq;
  const env = ctx.createGain();
  env.gain.setValueAtTime(o.gain, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + o.decay);
  src.connect(filter).connect(env).connect(dest);
  src.start(t, Math.random() * 0.5);
  src.stop(t + o.decay + 0.02);
}

function kick(ctx: BaseAudioContext, dest: AudioNode, t: number, gain: number) {
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  env.gain.setValueAtTime(gain, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
  osc.connect(env).connect(dest);
  osc.start(t);
  osc.stop(t + 0.4);
}

export function chordNotes(style: SongStyle, bar: number) {
  const degree = style.progression[bar % style.progression.length];
  const note = (d: number) => {
    const octave = Math.floor(d / 7);
    return style.root + style.scale[((d % 7) + 7) % 7] + octave * 12;
  };
  return { root: note(degree), triad: [note(degree), note(degree + 2), note(degree + 4)], note };
}

/** Schedules one 16th-note step of the song at audio time `t`. */
export function scheduleStep(ctx: BaseAudioContext, dest: AudioNode, style: SongStyle, step: number, t: number, stepDur: number, velocity: number) {
  if (velocity <= 0.01) return;
  const v = velocity;
  const bar = Math.floor(step / 16);
  const s = step % 16;
  const g = style.genre;
  const intro = bar < 4;
  const breakdown = bar % 16 >= 12;
  const chord = chordNotes(style, bar);
  const swing = g === "lofi" && s % 2 === 1 ? stepDur * 0.2 : 0;
  const at = t + swing;

  // Pads: one sustained chord per bar (two bars for ambient).
  if (s === 0 && (g !== "ambient" || bar % 2 === 0)) {
    schedulePad(ctx, dest, style, bar, t, stepDur * (g === "ambient" ? 32 : 16), v);
  }

  // Bass
  const bassSteps: Record<Genre, number[]> = {
    house: [0, 3, 6, 8, 11, 14],
    synthwave: [0, 2, 4, 6, 8, 10, 12, 14],
    lofi: [0, 7, 10],
    indie: [0, 6, 8, 14],
    ambient: [0],
  };
  if (!breakdown && !(intro && g !== "ambient") && bassSteps[g].includes(s)) {
    const len = g === "ambient" ? stepDur * 15 : g === "synthwave" ? stepDur * 1.6 : stepDur * 2.4;
    tone(ctx, dest, at, midiFreq(chord.root - 12), len, { type: g === "synthwave" ? "sawtooth" : "triangle", gain: 0.16 * v, cutoff: 420, release: 0.08 });
  }

  // Rhythm / texture layer
  if (g === "synthwave") {
    const notes = [...chord.triad, chord.triad[0] + 12];
    tone(ctx, dest, at, midiFreq(notes[s % 4] + 12), stepDur * 0.7, { type: "square", gain: 0.035 * v, cutoff: 1400 * style.bright, release: 0.05 });
  } else if (g === "house" && [2, 6, 10, 14].includes(s)) {
    chord.triad.forEach((n) => tone(ctx, dest, at, midiFreq(n + 12), stepDur * 0.6, { type: "square", gain: 0.03 * v, cutoff: 1800 * style.bright, release: 0.06 }));
  } else if (g === "lofi" && (s === 0 || s === 6)) {
    chord.triad.forEach((n, i) => tone(ctx, dest, at + i * 0.012, midiFreq(n + 12), stepDur * 3, { type: "sine", gain: 0.06 * v, release: 0.5 }));
  } else if (g === "indie" && s % 2 === 0) {
    const notes = [chord.triad[0], chord.triad[2], chord.triad[1], chord.triad[2]];
    tone(ctx, dest, at, midiFreq(notes[(s / 2) % 4] + 12), stepDur * 1.2, { type: "triangle", gain: 0.06 * v, release: 0.25 });
  } else if (g === "ambient") {
    const r = rng(step * 7919 + style.root);
    if (r() < 0.12) tone(ctx, dest, at, midiFreq(chord.note(Math.floor(r() * 7) + 14)), stepDur * 2, { type: "sine", gain: 0.05 * v, attack: 0.02, release: 2.2 });
  }

  // Melody motif on alternating 8-bar sections.
  if (!intro && Math.floor(bar / 8) % 2 === 1 && g !== "ambient") {
    const pos = step % 32;
    for (const m of style.motif) {
      if (m.step === pos) {
        tone(ctx, dest, at, midiFreq(chord.note(m.degree + 7) + 12), stepDur * m.len, {
          type: g === "lofi" ? "sine" : "triangle", gain: 0.07 * v, attack: 0.01, release: 0.2, cutoff: 2600,
        });
      }
    }
  }

  // Drums
  if (g === "ambient" || intro || (breakdown && s !== 0)) return;
  const kicks: Record<Exclude<Genre, "ambient">, number[]> = {
    house: [0, 4, 8, 12],
    synthwave: [0, 8, 10],
    lofi: [0, 7, 10],
    indie: [0, 7, 8],
  };
  if (!breakdown && kicks[g].includes(s)) kick(ctx, dest, at, 0.55 * v);
  if (!breakdown && (s === 4 || s === 12)) {
    noiseHit(ctx, dest, at, { type: "bandpass", freq: g === "lofi" ? 1400 : 1900, gain: (g === "synthwave" ? 0.32 : 0.22) * v, decay: g === "synthwave" ? 0.32 : 0.16 });
  }
  if (!breakdown && s % 2 === 0) noiseHit(ctx, dest, at, { type: "highpass", freq: 7500, gain: 0.07 * v, decay: 0.04 });
  if (!breakdown && g === "house" && s % 4 === 2) noiseHit(ctx, dest, at, { type: "highpass", freq: 6500, gain: 0.08 * v, decay: 0.18 });
}

/** Sustained chord; also used to fill the remainder of a bar after seeking. */
export function schedulePad(ctx: BaseAudioContext, dest: AudioNode, style: SongStyle, bar: number, t: number, dur: number, v: number) {
  const ambient = style.genre === "ambient";
  const chord = chordNotes(style, bar);
  chord.triad.forEach((n) => {
    for (const detune of [-7, 7]) {
      tone(ctx, dest, t, midiFreq(n + (ambient ? 12 : 0)), dur * 0.92, {
        type: ambient ? "triangle" : "sawtooth",
        gain: (ambient ? 0.035 : 0.018) * v,
        attack: Math.min(ambient ? 1.2 : 0.25, dur / 3),
        release: ambient ? 1.6 : 0.4,
        cutoff: (ambient ? 1600 : 1000) * style.bright,
        detune,
      });
    }
  });
}
