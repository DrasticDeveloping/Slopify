import { useEffect, useState } from "react";
import { getState, setState, subscribe, useStore, type AppState } from "../state/store";
import { parseLrc, type LyricLine } from "./lrc";

/*
 * A song's lyrics, looked up through the music server (server/lyrics.mjs) and
 * kept on this device in Cache Storage (beside the song files, see device.ts,
 * and out of localStorage, whose small quota the app's own state needs).
 * Songs kept on the device get theirs saved ahead of time (see
 * startLyricsSaver), so they show offline too; others are looked up when shown.
 * The cache key is what was looked up (title, artist, album, length), not the
 * song's id, so correcting a song's details looks again.
 */

export type Lyrics =
  | { status: "synced"; lines: LyricLine[]; plain?: string }
  | { status: "plain"; plain: string }
  | { status: "instrumental" }
  | { status: "none" };

export type LyricsState =
  | { status: "loading" }
  | { status: "offline" }
  /** `retrying`: the lyrics library was busy, and it's asked again by itself shortly. */
  | { status: "failed"; message: string; retrying: boolean }
  | { status: "ready"; lyrics: Lyrics };

interface Query { title: string; artist: string; album: string; duration: number }
interface Answer { status: "synced" | "plain" | "instrumental" | "none"; lrc?: string; plain?: string }
interface Saved { at: number; value: Answer }

const DAY = 86_400_000;
const FOUND_TTL = 30 * DAY;
const MISSING_TTL = DAY;
const CACHE = "slopify-lyrics-v1";
const cacheKey = (q: Query) => JSON.stringify([q.title, q.artist, q.album, Math.round(q.duration)]).toLowerCase();
const cacheUrl = (key: string) => new URL(`/__lyrics/${encodeURIComponent(key)}`, location.origin).href;

/** Where Cache Storage isn't available (an insecure origin), answers last for this visit. */
const memory = new Map<string, Saved>();

async function readSaved(key: string): Promise<Saved | null> {
  try {
    if (!("caches" in window)) return memory.get(key) ?? null;
    const res = await (await caches.open(CACHE)).match(cacheUrl(key));
    const entry = res ? ((await res.json()) as Saved) : null;
    // A save that didn't fit (storage full) is still kept for this visit.
    return entry?.value?.status ? entry : (memory.get(key) ?? null);
  } catch {
    return memory.get(key) ?? null;
  }
}

async function writeSaved(key: string, value: Answer) {
  const entry: Saved = { at: Date.now(), value: { status: value.status, lrc: value.lrc, plain: value.plain } };
  memory.set(key, entry);
  try {
    if ("caches" in window) await (await caches.open(CACHE)).put(cacheUrl(key), new Response(JSON.stringify(entry), { headers: { "Content-Type": "application/json" } }));
  } catch {
    // Kept for this visit only.
  }
}

/** A saved answer still worth using: anything offline, otherwise one that hasn't expired. */
const fresh = (entry: Saved | null, offline: boolean) => {
  if (!entry) return null;
  const ttl = entry.value.status === "none" ? MISSING_TTL : FOUND_TTL;
  return offline || entry.at > Date.now() - ttl ? entry.value : null;
};

/** Synced lines that don't parse fall back to the plain words. */
function toLyrics(answer: Answer): Lyrics {
  if (answer.status === "synced" && answer.lrc) {
    const lines = parseLrc(answer.lrc);
    if (lines.some((l) => l.text)) return { status: "synced", lines, plain: answer.plain };
  }
  if ((answer.status === "synced" || answer.status === "plain") && answer.plain) return { status: "plain", plain: answer.plain };
  return answer.status === "instrumental" ? { status: "instrumental" } : { status: "none" };
}

/** Lookups in flight, shared by every view asking for the same song (and the saver). */
const pending = new Map<string, Promise<Answer>>();

/** A lookup that failed because the lyrics library was busy or unreachable, so asking again later may work. */
class Busy extends Error {}
/** How long to wait before asking again by itself, after each busy answer in a row. */
const AUTO_RETRY = [8_000, 20_000, 45_000, 90_000];

function lookup(key: string, query: Query): Promise<Answer> {
  let task = pending.get(key);
  if (!task) {
    task = fetch("/api/metadata/lyrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(40_000),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        const message = body?.error?.message || "Couldn't look up lyrics.";
        if ([502, 503, 504].includes(res.status)) throw new Busy(message);
        if (!res.ok || !body?.ok || !body.result?.status) throw new Error(message);
        const answer = body.result as Answer;
        await writeSaved(key, answer);
        return answer;
      })
      .finally(() => pending.delete(key));
    pending.set(key, task);
  }
  return task;
}

/** What a song is looked up by, or null without a title and artist. */
function queryOf(trackId: string, s: AppState = getState()): Query | null {
  const t = s.tracks[trackId];
  const title = t?.title ?? "";
  const artist = (t && s.artists[t.artistId]?.name) || "";
  const album = (t && s.albums[t.albumId]?.title) || "";
  return t && title && artist ? { title, artist, album: album === title ? "" : album, duration: t.duration } : null;
}

function useQuery(trackId: string): Query | null {
  // One string, so the hook re-renders only when what's looked up changes.
  const json = useStore((s) => JSON.stringify(queryOf(trackId, s)));
  return JSON.parse(json) as Query | null;
}

export function useLyrics(trackId: string) {
  const query = useQuery(trackId);
  const key = query ? cacheKey(query) : "";
  const [state, setLyricsState] = useState<{ key: string; value: LyricsState }>({ key: "", value: { status: "loading" } });
  /** "Try again" asks the server even if this browser has an answer, for that song only. */
  const [retry, setRetry] = useState({ key: "", n: 0, auto: 0 });
  const forced = retry.key === key && retry.n > 0;
  const autoTries = retry.key === key ? retry.auto : 0;
  const offline = useStore((s) => s.server.status === "offline");

  useEffect(() => {
    if (!query) return setLyricsState({ key, value: { status: "ready", lyrics: { status: "none" } } });
    let live = true;
    let timer = 0;
    setLyricsState({ key, value: { status: "loading" } });
    void (async () => {
      const hit = fresh(await readSaved(key), offline);
      if (!live) return;
      if (hit && (!forced || offline)) return setLyricsState({ key, value: { status: "ready", lyrics: toLyrics(hit) } });
      if (offline) return setLyricsState({ key, value: { status: "offline" } });
      try {
        const answer = await lookup(key, query);
        if (live) setLyricsState({ key, value: { status: "ready", lyrics: toLyrics(answer) } });
      } catch (error) {
        if (!live) return;
        // A busy lyrics library usually recovers soon: ask again by itself, waiting longer each time.
        const wait = error instanceof Busy ? AUTO_RETRY[autoTries] : undefined;
        setLyricsState({ key, value: { status: "failed", message: error instanceof Error ? error.message : "Couldn't look up lyrics.", retrying: wait !== undefined } });
        if (wait !== undefined) timer = window.setTimeout(() => setRetry((r) => ({ key, n: (r.key === key ? r.n : 0) + 1, auto: autoTries + 1 })), wait);
      }
    })();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `query` is captured through `key`, which changes whenever it does.
  }, [key, offline, forced, retry.n]);

  // A result for an earlier song never shows for this one.
  const value: LyricsState = state.key === key ? state.value : { status: "loading" };
  // Asking by hand starts the automatic tries over.
  return { state: value, retry: () => setRetry((r) => ({ key, n: r.key === key ? r.n + 1 : 1, auto: 0 })) };
}

/* ───────────────────────── timing ───────────────────────── */

const MAX_ADJUST = 30;

/** Seconds this song's lyrics are moved; positive shows them sooner. Saved with your settings. */
export const useLyricsAdjust = (trackId: string) => useStore((s) => s.settings.lyricsOffsets?.[trackId] ?? 0);

export function setLyricsAdjust(trackId: string, seconds: number) {
  const value = Math.round(Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, seconds)) * 10) / 10;
  const s = getState();
  const { [trackId]: _old, ...rest } = s.settings.lyricsOffsets ?? {};
  void _old;
  setState({ settings: { ...s.settings, lyricsOffsets: value ? { ...rest, [trackId]: value } : rest } });
}

/* ───────────────────────── saving ahead ───────────────────────── */

/** Songs whose lyrics this visit has already saved or checked. */
const checked = new Set<string>();
let saving = false;

/** Saves lyrics for songs kept on this device (downloaded, or files from this computer) that don't have them yet. */
async function saveMissing() {
  if (saving) return;
  saving = true;
  try {
    for (;;) {
      const s = getState();
      if (s.server.status !== "connected") return;
      const next = s.trackIds.find((id) => {
        const t = s.tracks[id];
        return t && !t.stream && (t.storage === "downloads" || t.storage === "files") && !checked.has(id);
      });
      if (!next) return;
      checked.add(next);
      const query = queryOf(next, s);
      if (!query) continue;
      const key = cacheKey(query);
      if (fresh(await readSaved(key), false)) continue;
      // One at a time, and gently: this runs behind whatever you're doing.
      // A failed lookup is tried again the next time the saver runs.
      const ok = await lookup(key, query).then(() => true, () => false);
      if (!ok) {
        checked.delete(next);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } finally {
    saving = false;
  }
}

/**
 * Saves the lyrics of songs kept on this device while the music server can be
 * reached, so they're there offline. Picks up newly downloaded songs as they come.
 */
export function startLyricsSaver() {
  let timer = 0;
  let { tracks, server } = getState();
  const soon = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void saveMissing(), 5000);
  };
  subscribe(() => {
    const s = getState();
    if (s.tracks === tracks && s.server.status === server.status) return;
    tracks = s.tracks;
    server = s.server;
    if (server.status === "connected") soon();
  });
  if (server.status === "connected") soon();
}
