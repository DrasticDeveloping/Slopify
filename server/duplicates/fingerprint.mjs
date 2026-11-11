import { spawn } from "node:child_process";

/*
 * Acoustic fingerprints: what a song sounds like, so the same recording from
 * another site (or another upload, re-encoded at another quality) is still
 * recognised, which no hash of its bytes can do.
 *
 * The sound is decoded (by ffmpeg) to mono at 11 kHz and cut into overlapping
 * frames. Each frame's spectrum is split into 33 bands between 300 and 3000 Hz,
 * and gives one 32-bit word: bit b says whether the energy difference between
 * bands b and b+1 grew or shrank since the frame before (the Haitsma–Kalker
 * scheme). Those signs survive re-encoding, loudness changes and EQ; a
 * different song's words differ in about half their bits.
 *
 * A song in the library keeps one word every 1024 samples (about 10.8 a
 * second). A song being checked is printed four times as finely, so whatever its
 * frames' position relative to the library song's, one of four phases lines up
 * within a quarter of a frame. Matching finds the offset where the two agree
 * (from words that agree exactly in one half) and then measures the bit error
 * rate over the overlap.
 */

export const SAMPLE_RATE = 11_025;
const FRAME = 4096;
/** A library fingerprint's word spacing, in samples. */
export const STRIDE = 1024;
const FINE = 256;
const PHASES = STRIDE / FINE;
const BANDS = 33;
const LOW_HZ = 300;
const HIGH_HZ = 3000;
/** Frames quieter than this (about -70 dBFS) carry no fingerprint: silence would match any other silence. */
const SILENCE = 1e-7;

/** Seconds per library fingerprint word. */
export const WORD_SECONDS = STRIDE / SAMPLE_RATE;
/** A fingerprint is kept for at most this much of a song (a long mix needn't be fingerprinted to the end). */
export const MAX_SECONDS = 15 * 60;

/**
 * A half-word that turns up more often than this in a checked song (a held note, a loop) is thinned
 * to this many evenly spaced places: voting cost would otherwise grow with the square of its count,
 * and a few of its places still say where a repetitive song lines up.
 */
const MAX_KEY_REPEATS = 24;

/** A match needs this much shared sound, and a bit error rate this low over it (or over its best stretch). */
const MIN_OVERLAP_SECONDS = 12;
// Measured (scripts/test-duplicates.mjs): the same song re-encoded, quieter or with an intro scores 0.09-0.14;
// different songs made the same way (alike in rhythm and range, so harder than real ones) 0.30 and up.
const MAX_BER = 0.22;
const MAX_WINDOW_BER = 0.19;

/* ───────────────────────── decoding ───────────────────────── */

/**
 * The first `seconds` of a file's sound as mono samples, decoded by ffmpeg, or null if there are
 * fewer than `minSeconds`. A file cut short (the start of a stream) decodes as far as it goes.
 */
export function decodeAudio(ffmpeg, filePath, { seconds = MAX_SECONDS, minSeconds = 8, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", filePath, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-t", String(seconds), "-f", "f32le", "pipe:1"];
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const limit = Math.ceil(seconds * SAMPLE_RATE) * 4;
    const chunks = [];
    let bytes = 0;
    const stop = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => {
      if (bytes >= limit) return;
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.on("error", () => {
      signal?.removeEventListener("abort", stop);
      resolve(null);
    });
    child.on("close", () => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
      const all = Buffer.concat(chunks, bytes);
      const count = Math.min(Math.floor(all.length / 4), Math.ceil(seconds * SAMPLE_RATE));
      if (count < minSeconds * SAMPLE_RATE) return resolve(null);
      // Copied out, so the samples start on a 4-byte boundary (f32le is this machine's own order).
      resolve(new Float32Array(all.buffer.slice(all.byteOffset, all.byteOffset + count * 4)));
    });
  });
}

/* ───────────────────────── printing ───────────────────────── */

const WINDOW = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const EDGES = Array.from({ length: BANDS + 1 }, (_, b) => Math.round((LOW_HZ * (HIGH_HZ / LOW_HZ) ** (b / BANDS) * FRAME) / SAMPLE_RATE));
const REVERSED = (() => {
  const bits = Math.log2(FRAME);
  const out = new Uint32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    out[i] = r;
  }
  return out;
})();
const COS = Float64Array.from({ length: FRAME / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / FRAME));
const SIN = Float64Array.from({ length: FRAME / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / FRAME));

/** In-place radix-2 FFT of (re, im), FRAME points. */
function fft(re, im) {
  for (let i = 0; i < FRAME; i++) {
    const j = REVERSED[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= FRAME; size <<= 1) {
    const half = size >>> 1;
    const step = FRAME / size;
    for (let start = 0; start < FRAME; start += size) {
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const c = COS[k * step];
        const s = SIN[k * step];
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Each frame's band energies (frames `hop` samples apart), and which frames are silent. */
function bandEnergies(samples, hop) {
  const frames = samples.length >= FRAME ? Math.floor((samples.length - FRAME) / hop) + 1 : 0;
  const energies = new Float64Array(frames * BANDS);
  const silent = new Uint8Array(frames);
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let n = 0; n < frames; n++) {
    const offset = n * hop;
    let power = 0;
    for (let i = 0; i < FRAME; i++) {
      const x = samples[offset + i];
      power += x * x;
      re[i] = x * WINDOW[i];
      im[i] = 0;
    }
    if (power / FRAME < SILENCE) {
      silent[n] = 1;
      continue;
    }
    fft(re, im);
    for (let b = 0; b < BANDS; b++) {
      let e = 0;
      for (let k = EDGES[b]; k < EDGES[b + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
      energies[n * BANDS + b] = e;
    }
  }
  return { frames, energies, silent };
}

/** One word per frame from `lag` frames on: 0 where either frame is silent (0 is never a real word). */
function words({ frames, energies, silent }, lag) {
  const out = new Uint32Array(Math.max(0, frames - lag));
  for (let n = lag; n < frames; n++) {
    if (silent[n] || silent[n - lag]) continue;
    const now = n * BANDS;
    const before = (n - lag) * BANDS;
    let word = 0;
    for (let b = 0; b < 32; b++) {
      const d = (energies[now + b] - energies[now + b + 1]) - (energies[before + b] - energies[before + b + 1]);
      if (d > 0) word |= 1 << b;
    }
    out[n - lag] = word === 0 ? 1 : word >>> 0;
  }
  return out;
}

/** A library song's fingerprint: one word every STRIDE samples. */
export function libraryPrint(samples) {
  return words(bandEnergies(samples, STRIDE), 1);
}

/** A song being checked, printed PHASES times as finely (see the top of this file). */
export function queryPrint(samples) {
  return words(bandEnergies(samples, FINE), PHASES);
}

/** A fine print's words at library spacing (phase 0), to keep as the song's own fingerprint. */
export function coarsen(fine) {
  const out = new Uint32Array(Math.ceil(fine.length / PHASES));
  for (let i = 0; i < out.length; i++) out[i] = fine[i * PHASES];
  return out;
}

/* ───────────────────────── matching ───────────────────────── */

const popcount = (v) => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** A checked song's print, split into its phases and indexed by each word's halves, ready to compare with many songs. */
export function prepareQuery(fine) {
  const phases = Array.from({ length: PHASES }, (_, p) => {
    const out = new Uint32Array(Math.ceil(Math.max(0, fine.length - p) / PHASES));
    for (let i = 0; i < out.length; i++) out[i] = fine[p + i * PHASES];
    return out;
  });
  const index = new Map();
  const add = (key, entry) => {
    const list = index.get(key);
    if (list) list.push(entry);
    else index.set(key, [entry]);
  };
  for (let m = 0; m < fine.length; m++) {
    const word = fine[m];
    if (!word) continue;
    add(word & 0xffff, m);
    add(0x10000 + (word >>> 16), m);
  }
  for (const [key, list] of index) {
    if (list.length <= MAX_KEY_REPEATS) continue;
    const step = list.length / MAX_KEY_REPEATS;
    index.set(key, Array.from({ length: MAX_KEY_REPEATS }, (_, i) => list[Math.floor(i * step)]));
  }
  return { phases, index };
}

/** The bit error rate of a phase against a library print at an offset, over their overlap and over its best stretch. */
function errorRate(phase, print, offset) {
  const window = Math.ceil(MIN_OVERLAP_SECONDS / WORD_SECONDS);
  const start = Math.max(0, -offset);
  const end = Math.min(phase.length, print.length - offset);
  const errors = [];
  let bits = 0;
  for (let i = start; i < end; i++) {
    const a = phase[i];
    const b = print[i + offset];
    if (!a || !b) continue;
    const e = popcount(a ^ b);
    errors.push(e);
    bits += e;
  }
  const frames = errors.length;
  let best = 1;
  if (frames >= window) {
    let sum = 0;
    for (let i = 0; i < frames; i++) {
      sum += errors[i];
      if (i >= window) sum -= errors[i - window];
      if (i >= window - 1) best = Math.min(best, sum / (32 * window));
    }
  }
  return { ber: frames ? bits / (32 * frames) : 1, best, frames };
}

/**
 * How well a checked song (a prepared query) matches a library print: the bit error rate where
 * they line up best, the seconds of sound compared there, and whether that makes them the same recording.
 */
export function compare(query, print) {
  const votes = new Map();
  for (let j = 0; j < print.length; j++) {
    const word = print[j];
    if (!word) continue;
    for (const key of [word & 0xffff, 0x10000 + (word >>> 16)]) {
      const list = query.index.get(key);
      if (!list) continue;
      for (const m of list) {
        const vote = (j - (m >>> 2) + 0x100000) * PHASES + (m & 3);
        votes.set(vote, (votes.get(vote) || 0) + 1);
      }
    }
  }
  const top = [...votes].sort((a, b) => b[1] - a[1]).slice(0, 6);
  let found = null;
  for (const [vote] of top) {
    const phase = vote % PHASES;
    const offset = Math.floor(vote / PHASES) - 0x100000;
    const rate = errorRate(query.phases[phase], print, offset);
    if (rate.frames * WORD_SECONDS < MIN_OVERLAP_SECONDS) continue;
    const score = Math.min(rate.ber, rate.best + (MAX_BER - MAX_WINDOW_BER));
    if (!found || score < found.score) found = { ...rate, score, offsetSeconds: offset * WORD_SECONDS - (phase * FINE) / SAMPLE_RATE };
  }
  if (!found) return null;
  return {
    ber: found.ber,
    bestWindowBer: found.best,
    overlapSeconds: found.frames * WORD_SECONDS,
    offsetSeconds: found.offsetSeconds,
    same: found.ber <= MAX_BER || found.best <= MAX_WINDOW_BER,
  };
}

/* ───────────────────────── storage ───────────────────────── */

export const toBuffer = (print) => Buffer.from(print.buffer, print.byteOffset, print.byteLength);
export function fromBuffer(buf) {
  const out = new Uint32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32LE(i * 4);
  return out;
}
