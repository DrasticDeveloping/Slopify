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
