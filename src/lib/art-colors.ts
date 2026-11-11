import { useEffect, useState } from "react";
import type { Palette } from "../data/types";

/*
 * The Dynamic theme's colours, read from the playing song's cover. The cover is shrunk onto a small
 * canvas and its pixels grouped by hue (in OKLCH, so "how colourful" and "how light" match what you
 * see): the most vivid, plentiful hue becomes the accent, a clearly different one the second accent,
 * and the colour most of the cover is made of the deep third glow (and, mixed in, the backdrop).
 * Each is then pulled into a range that reads well on the app's dark panels, so a pale or murky
 * cover still gives usable colours, and a black-and-white one gives greys.
 */

type Lab = { L: number; a: number; b: number };

const SIZE = 48;
const BINS = 24;
const CACHE_KEY = "slopify.art-colors";
const CACHE_MAX = 60;

// sRGB <-> OKLab (https://bottosson.github.io/posts/oklab/).
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToLab(r8: number, g8: number, b8: number): Lab {
  const r = toLinear(r8 / 255), g = toLinear(g8 / 255), b = toLinear(b8 / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function labToLinear({ L, a, b }: Lab) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** OKLCH to #rrggbb, lowering chroma until it fits in sRGB (so the hue and lightness stay put). */
function lchToHex(L: number, C: number, h: number) {
  let lo = 0, hi = C;
  const at = (c: number) => labToLinear({ L, a: c * Math.cos(h), b: c * Math.sin(h) });
  const fits = (c: number) => at(c).every((v) => v >= -0.0005 && v <= 1.0005);
  if (!fits(hi)) {
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  return `#${at(hi).map((v) => Math.round(Math.max(0, Math.min(1, toGamma(Math.max(0, v)))) * 255).toString(16).padStart(2, "0")).join("")}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const hueGap = (x: number, y: number) => {
  const d = Math.abs(x - y) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
};

interface Bin { n: number; L: number; a: number; b: number; C: number }

/** The three theme colours for a cover's pixels (RGBA, as from getImageData). */
export function paletteFromPixels(data: Uint8ClampedArray): Palette | null {
  const bins: Bin[] = Array.from({ length: BINS }, () => ({ n: 0, L: 0, a: 0, b: 0, C: 0 }));
  const all = { n: 0, L: 0, a: 0, b: 0 };
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const p = rgbToLab(data[i], data[i + 1], data[i + 2]);
    all.n++;
    all.L += p.L;
    all.a += p.a;
    all.b += p.b;
    const C = Math.hypot(p.a, p.b);
    // Near-greys and near-black/white say little about a cover's colour.
    if (C < 0.035 || p.L < 0.18 || p.L > 0.96) continue;
    const h = Math.atan2(p.b, p.a);
    const bin = bins[Math.floor(((h + Math.PI) / (Math.PI * 2)) * BINS) % BINS];
    bin.n++;
    bin.L += p.L;
    bin.a += p.a;
    bin.b += p.b;
    bin.C += C;
  }
  if (!all.n) return null;

  const colourful = bins.reduce((sum, b) => sum + b.n, 0);
  const mean = (b: { n: number; L: number; a: number; b: number }) => {
    const L = b.L / b.n, a = b.a / b.n, bb = b.b / b.n;
    return { L, C: Math.hypot(a, bb), h: Math.atan2(bb, a) };
  };
  const overall = mean(all);

  // A black-and-white (or nearly) cover gets greys, faintly tinted by whatever colour it has.
  if (colourful < all.n * 0.04) {
    const h = overall.h;
    return {
      a: lchToHex(clamp(overall.L + 0.25, 0.82, 0.9), Math.min(overall.C, 0.02), h),
      b: lchToHex(clamp(overall.L, 0.6, 0.7), Math.min(overall.C, 0.025), h),
      c: lchToHex(0.27, Math.min(overall.C, 0.02), h),
    };
  }

  // Neighbouring hue bins are one colour that straddles a boundary: score each with its neighbours' help.
  const score = (i: number) => {
    const b = bins[i];
    if (!b.n) return 0;
    const near = bins[(i + 1) % BINS].n + bins[(i + BINS - 1) % BINS].n;
    // Plentiful and vivid both count; vivid counts a lot, since a small splash of colour is what the eye picks out.
    return (b.n + near * 0.35) * (b.C / b.n) ** 1.4;
  };
  const ranked = bins.map((b, i) => ({ i, s: score(i), b })).filter((x) => x.b.n > 0).sort((x, y) => y.s - x.s);
  const top = mean(ranked[0].b);
  const second = ranked.slice(1).find((x) => x.s >= ranked[0].s * 0.12 && hueGap(mean(x.b).h, top.h) >= (40 * Math.PI) / 180);
  // One-colour covers get a neighbouring hue, so the two accents still read as a pair.
  const other = second ? mean(second.b) : { L: top.L - 0.1, C: top.C, h: top.h + (32 * Math.PI) / 180 };

  // The deep glow: the colour most of the cover is, by area (vivid or not), unless it is mostly grey.
  const plentiful = [...bins].sort((x, y) => y.n - x.n)[0];
  const deep = colourful > all.n * 0.2 ? mean(plentiful) : { ...overall, C: Math.max(overall.C, top.C * 0.5), h: overall.C > 0.02 ? overall.h : top.h };

  return {
    a: lchToHex(clamp(top.L, 0.72, 0.84), clamp(top.C * 1.15, 0.1, 0.2), top.h),
    b: lchToHex(clamp(other.L, 0.58, 0.72), clamp(other.C * 1.1, 0.09, 0.2), other.h),
    c: lchToHex(clamp(deep.L * 0.6, 0.24, 0.32), clamp(deep.C, 0.05, 0.11), deep.h),
  };
}

const cache = new Map<string, Palette>();
/** Covers that couldn't be read, and when: tried again after a while (they may have been offline, not refused). */
const failed = new Map<string, number>();
const RETRY_MS = 60_000;
const recentlyFailed = (url: string) => performance.now() - (failed.get(url) ?? -Infinity) < RETRY_MS;
const pending = new Map<string, Promise<Palette | null>>();

try {
  const saved: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]");
  if (Array.isArray(saved)) for (const [url, p] of saved) if (typeof url === "string" && p && typeof p.a === "string") cache.set(url, p);
} catch {
  /* No saved colours; they're worked out again. */
}

function remember(url: string, palette: Palette | null) {
  if (!palette) {
    failed.set(url, performance.now());
    return;
  }
  failed.delete(url);
  cache.delete(url);
  cache.set(url, palette);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify([...cache]));
  } catch {
    /* Storage full or unavailable: colours just aren't kept between sessions. */
  }
}

/** The theme colours for a cover, or null if it can't be read (it didn't load, or its host doesn't allow it). */
export function coverPalette(url: string): Promise<Palette | null> {
  const known = cache.get(url);
  if (known || recentlyFailed(url)) return Promise.resolve(known ?? null);
  const inFlight = pending.get(url);
  if (inFlight) return inFlight;
  const job = new Promise<Palette | null>((resolve) => {
    const img = new Image();
    // Reading the pixels needs the host's permission (cover hosts send it; same-origin covers need none).
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx || !img.naturalWidth) return resolve(null);
        // Cropped from the middle, as covers show elsewhere (and past a video thumbnail's letterbox bars).
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const crop = side * 0.92;
        ctx.drawImage(img, (img.naturalWidth - crop) / 2, (img.naturalHeight - crop) / 2, crop, crop, 0, 0, SIZE, SIZE);
        resolve(paletteFromPixels(ctx.getImageData(0, 0, SIZE, SIZE).data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  }).then((palette) => {
    pending.delete(url);
    remember(url, palette);
    return palette;
  });
  pending.set(url, job);
  return job;
}

/**
 * The colours of the cover at `url`, falling back to `fallback` when there's no cover or it can't be read.
 * While a new cover is being read, the last colours stay, so a song change fades once instead of twice.
 */
export function useCoverPalette(url: string | undefined, fallback: Palette | undefined) {
  const [shown, setShown] = useState<{ url?: string; palette?: Palette }>(() => ({ url, palette: url ? cache.get(url) ?? fallback : fallback }));
  useEffect(() => {
    if (!url) {
      setShown({ palette: fallback });
      return;
    }
    const known = cache.get(url);
    if (known || recentlyFailed(url)) {
      setShown({ url, palette: known ?? fallback });
      return;
    }
    let live = true;
    void coverPalette(url).then((p) => {
      if (live) setShown({ url, palette: p ?? fallback });
    });
    return () => {
      live = false;
    };
  }, [url, fallback]);
  return shown.palette;
}

/** `color` mixed into the app's near-black backdrop, as #rrggbb (for the browser's theme-color). */
export function backdropTint(color: string, amount: number) {
  const n = parseInt(color.slice(1), 16);
  const c = rgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
  const base = rgbToLab(7, 7, 10);
  const L = base.L + (c.L - base.L) * amount, a = base.a + (c.a - base.a) * amount, b = base.b + (c.b - base.b) * amount;
  return lchToHex(L, Math.hypot(a, b), Math.atan2(b, a));
}
