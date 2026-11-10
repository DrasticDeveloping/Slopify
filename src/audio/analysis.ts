/*
 * What a song actually looks like, for the clip editor: the loudness of its
 * audio across its length, and (for videos) still frames along the way. Both are
 * read from the song's own file, once per file this session.
 */

/** Files bigger than this aren't read whole just to draw them. */
const MAX_BYTES = 400 * 1024 * 1024;
/** Decoding at a low sample rate keeps a whole song small in memory; loudness doesn't need more. */
const SAMPLE_RATE = 8000;

const peaks = new Map<string, Promise<number[]>>();
const frames = new Map<string, Promise<string[]>>();

function remember<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) {
  let task = cache.get(key);
  if (!task) {
    task = load();
    // A failure isn't kept, so the next look tries again.
    task.catch(() => cache.delete(key));
    cache.set(key, task);
  }
  return task;
}

/** The loudest level in each of `bars` equal parts of the file's audio, from 0 to 1 (the loudest part is 1). */
export function wavePeaks(url: string, bars: number): Promise<number[]> {
  return remember(peaks, `${url}|${bars}`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`The song's file couldn't be read (HTTP ${res.status}).`);
    if (Number(res.headers.get("Content-Length")) > MAX_BYTES) throw new Error("The song's file is too large to draw.");
    const data = await res.arrayBuffer();
    const audio = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(data);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    const size = Math.max(1, Math.floor(audio.length / bars));
    const levels = Array.from({ length: bars }, (_, i) => {
      let sum = 0;
      const end = Math.min(audio.length, (i + 1) * size);
      for (let n = i * size; n < end; n++) {
        let v = 0;
        for (const ch of channels) v += Math.abs(ch[n]);
        sum += (v / channels.length) ** 2;
      }
      // Loudness (RMS) of the part, which follows what you hear better than its single highest sample.
      return Math.sqrt(sum / Math.max(1, end - i * size));
    });
    const loudest = Math.max(...levels) || 1;
    return levels.map((v) => v / loudest);
  });
}

const details = new Map<string, Promise<WaveDetail>>();

/** Readings per second in a song's fine detail: enough to see a drum hit when zoomed right in. */
export const DETAIL_RATE = 200;

export interface WaveDetail {
  /** Loudness every 1/DETAIL_RATE of a second, 0–1 (the loudest reading is 1). */
  fine: Float32Array;
  /** Where sounds start (seconds): sharp rises in loudness, for snapping a clip's edges to a clean point. */
  onsets: number[];
}

/**
 * A song's loudness in fine detail, and where its sounds start, read from its file once (the clip editor zooms
 * into this, trims silence by it, and snaps edges to its onsets). Decoded at a low sample rate, like wavePeaks.
 */
export function waveDetail(url: string): Promise<WaveDetail> {
  return remember(details, url, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`The song's file couldn't be read (HTTP ${res.status}).`);
    if (Number(res.headers.get("Content-Length")) > MAX_BYTES) throw new Error("The song's file is too large to draw.");
    const audio = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await res.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    const size = Math.max(1, Math.round(SAMPLE_RATE / DETAIL_RATE));
    const count = Math.ceil(audio.length / size);
    const fine = new Float32Array(count);
    let loudest = 0;
    for (let i = 0; i < count; i++) {
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
    // Onsets: a reading well above the average of the 100ms before it, that's the peak of its own rise.
    const onsets: number[] = [];
    const back = Math.round(DETAIL_RATE * 0.1);
    let last = -Infinity;
    for (let i = back; i < count - 2; i++) {
      let before = 0;
      for (let k = i - back; k < i; k++) before += fine[k];
      before /= back;
      const rise = fine[i] - before;
      if (rise > 0.12 && fine[i] >= fine[i + 1] && fine[i] >= fine[i - 1]) {
        // The start of the rise (where a cut sounds clean), at most once every 120ms.
        let start = i;
        while (start > i - back && fine[start - 1] < fine[start]) start--;
        const t = start / DETAIL_RATE;
        if (t - last >= 0.12) {
          onsets.push(t);
          last = t;
        }
      }
    }
    return { fine, onsets };
  });
}

/** `count` still frames spread across a video, as small JPEG data URLs. */
export function videoFrames(url: string, count: number): Promise<string[]> {
  return remember(frames, `${url}|${count}`, () => new Promise<string[]>((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    const canvas = document.createElement("canvas");
    const out: string[] = [];
    const timer = window.setTimeout(() => finish(new Error("The video took too long to read.")), 60_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      if (error && !out.length) reject(error);
      else resolve(out);
    };
    const next = () => {
      if (out.length >= count) return finish();
      // The middle of each part, so the first frame isn't a black fade-in.
      video.currentTime = ((out.length + 0.5) / count) * video.duration;
    };
    video.addEventListener("loadedmetadata", () => {
      if (!video.duration || !Number.isFinite(video.duration) || !video.videoWidth) return finish(new Error("This file has no pictures to show."));
      canvas.height = 72;
      canvas.width = Math.round((video.videoWidth / video.videoHeight) * canvas.height) || 128;
      next();
    });
    video.addEventListener("seeked", () => {
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      out.push(canvas.toDataURL("image/jpeg", 0.7));
      next();
    });
    video.addEventListener("error", () => finish(new Error("The video couldn't be read.")));
    video.src = url;
  }));
}
