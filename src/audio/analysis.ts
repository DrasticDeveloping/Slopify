/* Read a song's own file for the clip editor, without keeping whole decoded songs. */
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_SECONDS = 20 * 60;
const SAMPLE_RATE = 8000;
const CACHE_BYTES = 8 * 1024 * 1024;
const CACHE_ENTRIES = 32;

// Only finished, small results are kept. A cancelled caller never owns another caller's work.
const cache = new Map<string, { value: unknown; bytes: number }>();
let cacheBytes = 0;
let decoding: Promise<unknown> = Promise.resolve();
function check(signal?: AbortSignal) { signal?.throwIfAborted(); }
async function remember<T>(key: string, signal: AbortSignal | undefined, load: () => Promise<T>, size: (value: T) => number): Promise<T> {
  check(signal);
  const saved = cache.get(key);
  if (saved) {
    cache.delete(key);
    cache.set(key, saved);
    return saved.value as T;
  }
  const value = await load();
  check(signal);
  const bytes = size(value);
  if (bytes <= CACHE_BYTES) {
    const previous = cache.get(key);
    if (previous) cacheBytes -= previous.bytes;
    cache.delete(key);
    cache.set(key, { value, bytes });
    cacheBytes += bytes;
    while (cacheBytes > CACHE_BYTES || cache.size > CACHE_ENTRIES) {
      const oldest = cache.keys().next().value!;
      cacheBytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
  }
  return value;
}

/** Metadata prevents very long compressed recordings from expanding unchecked in the decoder. */
function durationOf(url: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    check(signal);
    const audio = new Audio();
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      audio.onloadedmetadata = audio.onerror = null;
      const duration = audio.duration;
      audio.removeAttribute("src");
      audio.load();
      if (error) reject(error);
      else if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS) reject(new Error("The song is too long to draw."));
      else resolve(duration);
    };
    const abort = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => finish(new Error("The song took too long to read.")), 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    audio.onloadedmetadata = () => finish();
    audio.onerror = () => finish(new Error("The song's duration couldn't be read."));
    audio.preload = "metadata";
    audio.src = url;
  });
}

async function readFile(url: string, signal?: AbortSignal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`The song's file couldn't be read (HTTP ${res.status}).`);
  if (Number(res.headers.get("Content-Length")) > MAX_BYTES) {
    await res.body?.cancel();
    throw new Error("The song's file is too large to draw.");
  }
  // Content-Length can be missing or describe compressed transfer bytes. Bound the bytes actually read too.
  if (!res.body) {
    const data = await res.arrayBuffer();
    if (data.byteLength > MAX_BYTES) throw new Error("The song's file is too large to draw.");
    return data;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      check(signal);
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("The song's file is too large to draw.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) { data.set(chunk, at); at += chunk.byteLength; }
  return data.buffer;
}

/** decodeAudioData cannot be interrupted. Keep only one decoder alive, then discard obsolete output immediately. */
function withAudio<T>(url: string, signal: AbortSignal | undefined, use: (audio: AudioBuffer) => Promise<T>): Promise<T> {
  const task = decoding.then(async () => {
    check(signal);
    await durationOf(url, signal);
    check(signal);
    const data = await readFile(url, signal);
    check(signal);
    const audio = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(data);
    check(signal);
    if (audio.length * audio.numberOfChannels * Float32Array.BYTES_PER_ELEMENT > MAX_DECODED_BYTES || audio.duration > MAX_SECONDS) {
      throw new Error("The decoded song is too large to draw.");
    }
    return use(audio);
  });
  decoding = task.catch(() => undefined);
  return task;
}
const yieldWork = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The loudest level in each of `bars` equal parts of the file, from 0 to 1. */
export function wavePeaks(url: string, bars: number, signal?: AbortSignal): Promise<number[]> {
  return remember(`peaks|${url}|${bars}`, signal, () => withAudio(url, signal, async (audio) => {
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    const size = Math.max(1, Math.floor(audio.length / bars));
    const levels: number[] = [];
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      const end = Math.min(audio.length, (i + 1) * size);
      for (let n = i * size; n < end; n++) {
        if (n % 32768 === 0) { await yieldWork(); check(signal); }
        let v = 0;
        for (const ch of channels) v += Math.abs(ch[n]);
        sum += (v / channels.length) ** 2;
      }
      levels.push(Math.sqrt(sum / Math.max(1, end - i * size)));
    }
    const loudest = Math.max(...levels) || 1;
    return levels.map((v) => v / loudest);
  }), (value) => value.length * 8);
}

export const DETAIL_RATE = 200;
export interface WaveDetail {
  fine: Float32Array;
  onsets: number[];
}

export function waveDetail(url: string, signal?: AbortSignal): Promise<WaveDetail> {
  return remember(`detail|${url}`, signal, () => withAudio(url, signal, async (audio) => {
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    const size = Math.max(1, Math.round(SAMPLE_RATE / DETAIL_RATE));
    const count = Math.ceil(audio.length / size);
    const fine = new Float32Array(count);
    let loudest = 0;
    for (let i = 0; i < count; i++) {
      if (i % 1024 === 0) { await yieldWork(); check(signal); }
      let sum = 0;
      const end = Math.min(audio.length, (i + 1) * size);
      for (let n = i * size; n < end; n++) {
        let v = 0;
        for (const ch of channels) v += Math.abs(ch[n]);
        sum += (v / channels.length) ** 2;
      }
      fine[i] = Math.sqrt(sum / Math.max(1, end - i * size));
      if (fine[i] > loudest) loudest = fine[i];
    }
    if (loudest) for (let i = 0; i < count; i++) fine[i] /= loudest;
    const onsets: number[] = [];
    const back = Math.round(DETAIL_RATE * 0.1);
    let last = -Infinity;
    for (let i = back; i < count - 2; i++) {
      if (i % 4096 === 0) { await yieldWork(); check(signal); }
      let before = 0;
      for (let k = i - back; k < i; k++) before += fine[k];
      before /= back;
      const rise = fine[i] - before;
      if (rise > 0.12 && fine[i] >= fine[i + 1] && fine[i] >= fine[i - 1]) {
        let start = i;
        while (start > i - back && fine[start - 1] < fine[start]) start--;
        const t = start / DETAIL_RATE;
        if (t - last >= 0.12) { onsets.push(t); last = t; }
      }
    }
    return { fine, onsets };
  }), (value) => value.fine.byteLength + value.onsets.length * 8);
}

/** Small JPEG frames spread across a video. Closing the editor releases its media immediately. */
export function videoFrames(url: string, count: number, signal?: AbortSignal): Promise<string[]> {
  return remember(`frames|${url}|${count}`, signal, () => new Promise<string[]>((resolve, reject) => {
    check(signal);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    const canvas = document.createElement("canvas");
    const out: string[] = [];
    let finished = false;
    const timer = setTimeout(() => finish(new Error("The video took too long to read.")), 60_000);
    const abort = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      video.removeEventListener("loadedmetadata", metadata);
      video.removeEventListener("seeked", frame);
      video.removeEventListener("error", failed);
      video.pause();
      video.removeAttribute("src");
      video.load();
      canvas.width = canvas.height = 0;
      if (error) reject(error);
      else resolve(out);
    };
    const next = () => {
      if (out.length >= count) return finish();
      video.currentTime = ((out.length + 0.5) / count) * video.duration;
    };
    const metadata = () => {
      if (!video.duration || !Number.isFinite(video.duration) || !video.videoWidth) return finish(new Error("This file has no pictures to show."));
      canvas.height = 72;
      canvas.width = Math.min(512, Math.round((video.videoWidth / video.videoHeight) * canvas.height) || 128);
      next();
    };
    const frame = () => {
      if (finished || signal?.aborted) return;
      try {
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        out.push(canvas.toDataURL("image/jpeg", 0.7));
        next();
      } catch (error) { finish(error); }
    };
    const failed = () => finish(new Error("The video couldn't be read."));
    signal?.addEventListener("abort", abort, { once: true });
    video.addEventListener("loadedmetadata", metadata);
    video.addEventListener("seeked", frame);
    video.addEventListener("error", failed);
    video.src = url;
  }), (value) => value.reduce((bytes, frame) => bytes + frame.length * 2, 0));
}
