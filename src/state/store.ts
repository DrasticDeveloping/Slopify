import { useSyncExternalStore } from "react";
import { hashString, likedPlaylist, paletteFromSeed } from "../data/library";
import type { HeaderInfo } from "../components/Hero";
import type { Album, Artist, ClipRange, Playlist, Track } from "../data/types";
import { restoreTaste, type ReasonKind, type TasteState } from "../recommend/taste";

export type Route =
  | { name: "home" }
  | { name: "search"; q: string }
  | { name: "library"; filter?: string }
  | { name: "playlists" }
  | { name: "playlist"; id: string }
  | { name: "album"; id: string }
  | { name: "artist"; id: string }
  | { name: "storage" }
  | { name: "server" }
  | { name: "history" };

export type Modal =
  | { type: "createPlaylist"; addIds?: string[] }
  | { type: "editPlaylist"; id: string }
  | { type: "addSongs"; playlistId: string }
  | { type: "settings"; tab?: SettingsTab }
  | { type: "listenAlong" }
  | { type: "import" }
  | { type: "clipEditor"; trackId?: string };

export type SettingsTab = "general" | "playback" | "appearance" | "server" | "shortcuts";

export interface MenuItem {
  label?: string;
  icon?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  run?: () => void;
  submenu?: MenuItem[];
}

export interface MenuState {
  x: number;
  y: number;
  title?: string;
  subtitle?: string;
  items: MenuItem[];
}

export interface Toast {
  id: number;
  message: string;
  detail?: string;
  tone?: "default" | "success" | "error";
  progress?: number;
  action?: { label: string; run: () => void };
  sticky?: boolean;
}

export type Theme = "dynamic" | "midnight" | "ocean" | "forest" | "sunset" | "mono";
export type RepeatMode = "off" | "all" | "one";

export interface Settings {
  theme: Theme;
  crossfade: boolean;
  crossfadeSeconds: number;
  runInBackground: boolean;
  discord: boolean;
  reduceMotion: boolean;
  compact: boolean;
  autoplay: boolean;
  /** Also recommend songs already in the library (a shelf of their own on Home). */
  recommendLibrary: boolean;
  normalize: boolean;
  profileName: string;
  serverUrl: string;
  uploadMode: "local_file" | "link" | "off";
  downloadMode: "verified_file_cache" | "stream_only";
}

export interface PlaybackContext {
  label: string;
  route?: Route;
  ids: string[];
  /** Why each song was recommended, when the collection came from the recommender. */
  picks?: Record<string, ReasonKind>;
}

export interface AppState {
  artists: Record<string, Artist>;
  albums: Record<string, Album>;
  tracks: Record<string, Track>;
  trackIds: string[];
  playlists: Playlist[];

  route: Route;
  back: Route[];
  forward: Route[];

  currentId: string | null;
  isPlaying: boolean;
  context: PlaybackContext | null;
  order: string[];
  index: number;
  upNext: string[];
  history: string[];
  shuffle: boolean;
  repeat: RepeatMode;
  volume: number;
  muted: boolean;
  speed: number;

  panel: "queue" | "details" | null;
  fullPlayer: boolean;
  modal: Modal | null;
  menu: MenuState | null;
  toasts: Toast[];
  sidebarCollapsed: boolean;
  selection: string[];
  searchFocusNonce: number;
  header: HeaderInfo | null;

  settings: Settings;
  clips: Record<string, ClipRange>;
  clipDraft: ({ trackId: string } & ClipRange) | null;
  server: { status: "connected" | "connecting" | "offline"; downloads: Record<string, number> };
  listen: { mode: "idle" | "connecting" | "host" | "guest"; code: string; people: string[]; host?: string };
  listenLog: Record<string, number>;
  /** Timestamped play starts, newest first, for the chronological history view. */
  listens: Array<{ id: string; at: number }>;
  /** Likes, saves, listening and feedback the recommender learns from. */
  taste: TasteState;
  /** A streamed recommendation whose audio is still being fetched. */
  buffering: string | null;
}

const STORAGE_KEY = "resonance.remastered.v1";

export const defaultSettings: Settings = {
  theme: "dynamic",
  crossfade: false,
  crossfadeSeconds: 6,
  runInBackground: true,
  discord: false,
  reduceMotion: false,
  compact: false,
  autoplay: true,
  recommendLibrary: false,
  normalize: true,
  profileName: "Daz",
  serverUrl: "https://music.slopify.local",
  uploadMode: "local_file",
  downloadMode: "verified_file_cache",
};

interface CatalogPatch {
  /** Library order, excluding session-only file imports and streamed recommendations. */
  trackIds: string[];
  /** The library's songs (web imports), with their artists and albums. */
  tracks: Record<string, Track>;
  artists: Record<string, Artist>;
  albums: Record<string, Album>;
}

type Persisted = Partial<Pick<AppState, "playlists" | "settings" | "clips" | "volume" | "muted" | "shuffle" | "repeat" | "speed" | "sidebarCollapsed" | "panel" | "listenLog" | "listens" | "taste">> & { catalog?: CatalogPatch };

function catalogPatch(s: AppState): CatalogPatch {
  const trackIds = s.trackIds.filter((id) => s.tracks[id] && !s.tracks[id].fileUrl && !s.tracks[id].stream);
  const tracks: Record<string, Track> = {};
  const artists: Record<string, Artist> = {};
  const albums: Record<string, Album> = {};
  for (const id of trackIds) {
    const t = s.tracks[id];
    tracks[id] = t;
    if (s.artists[t.artistId]) artists[t.artistId] = s.artists[t.artistId];
    if (s.albums[t.albumId]) albums[t.albumId] = s.albums[t.albumId];
  }
  return { trackIds, tracks, artists, albums };
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : {};
  } catch {
    return {};
  }
}

/** Playlists the old demo created. They go once they hold none of your songs. */
const STARTER_PLAYLISTS = new Set(["p1", "p2", "p3", "p4", "p5"]);

function initialState(): AppState {
  const saved = loadPersisted();
  const artists: Record<string, Artist> = {};
  const albums: Record<string, Album> = {};
  const tracks: Record<string, Track> = {};
  let trackIds: string[] = [];
  if (saved.catalog) {
    const patch = saved.catalog;
    for (const id of patch.trackIds) {
      const t = patch.tracks[id];
      // Only music you brought in is kept: the generated demo songs from older builds had no server copy.
      if (t?.serverId) tracks[id] = t;
    }
    trackIds = patch.trackIds.filter((id) => tracks[id]);
    for (const t of Object.values(tracks)) {
      // Repair saves from older builds that lost an import's artist or album.
      artists[t.artistId] = patch.artists[t.artistId] ?? { id: t.artistId, name: "Unknown artist", genre: "indie", palette: paletteFromSeed(hashString(t.artistId)), listeners: 0 };
      albums[t.albumId] = patch.albums[t.albumId] ?? { id: t.albumId, title: t.title, artistId: t.artistId, year: new Date(t.addedAt).getFullYear(), palette: paletteFromSeed(hashString(t.albumId)), glyph: 0 };
    }
  }
  const playlists = (saved.playlists ?? [])
    .map((p) => ({ ...p, trackIds: p.trackIds.filter((id) => tracks[id]) }))
    .filter((p) => p.system || p.trackIds.length || !STARTER_PLAYLISTS.has(p.id));
  if (!playlists.some((p) => p.id === "liked")) playlists.unshift(likedPlaylist());
  return {
    artists,
    albums,
    tracks,
    trackIds,
    playlists,
    route: { name: "home" },
    back: [],
    forward: [],
    currentId: null,
    isPlaying: false,
    context: null,
    order: [],
    index: 0,
    upNext: [],
    history: [],
    shuffle: saved.shuffle ?? false,
    repeat: saved.repeat ?? "off",
    volume: saved.volume ?? 0.72,
    muted: saved.muted ?? false,
    speed: saved.speed ?? 1,
    // The side panel is a full-screen drawer on small screens, so start closed there.
    panel: window.matchMedia("(max-width: 1240px)").matches ? null : saved.panel !== undefined ? saved.panel : "details",
    fullPlayer: false,
    modal: null,
    menu: null,
    toasts: [],
    sidebarCollapsed: saved.sidebarCollapsed ?? false,
    selection: [],
    searchFocusNonce: 0,
    header: null,
    // Older saves still point at the pre-rename demo server address.
    settings: { ...defaultSettings, ...saved.settings, ...(saved.settings?.serverUrl === "https://music.resonance.local" ? { serverUrl: defaultSettings.serverUrl } : {}) },
    clips: saved.clips ?? {},
    clipDraft: null,
    server: { status: "connected", downloads: {} },
    listen: { mode: "idle", code: "", people: [] },
    listenLog: saved.listenLog ?? {},
    listens: (saved.listens ?? []).filter((l) => tracks[l.id]),
    taste: restoreTaste(saved.taste, new Set(trackIds)),
    buffering: null,
  };
}

let state: AppState = initialState();
const listeners = new Set<() => void>();

export function getState() {
  return state;
}

let persistTimer = 0;
let persistenceStopped = false;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(flushPersist, 400);
}

/** Saves now instead of after the usual short delay (e.g. when the page is closing). */
export function flushPersist() {
  clearTimeout(persistTimer);
  if (persistenceStopped) return;
  const s = state;
  const data: Persisted = {
    // Streamed recommendations are never saved, so they never belong in a saved playlist.
    playlists: s.playlists.map((p) => (p.trackIds.some((id) => s.tracks[id]?.stream) ? { ...p, trackIds: p.trackIds.filter((id) => !s.tracks[id]?.stream) } : p)),
    settings: s.settings,
    clips: s.clips,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    speed: s.speed,
    sidebarCollapsed: s.sidebarCollapsed,
    panel: s.panel,
    listenLog: s.listenLog,
    // Session-only files and streamed recommendations are gone after a reload, so their plays are not kept.
    listens: s.listens.filter((l) => !s.tracks[l.id]?.fileUrl && !s.tracks[l.id]?.stream),
    // Session-only files are gone after a reload, so their feedback is too.
    taste: restoreTaste(s.taste, new Set(s.trackIds.filter((id) => s.tracks[id] && !s.tracks[id].fileUrl))),
    catalog: catalogPatch(s),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage can be full or blocked; the session keeps working in memory.
  }
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  schedulePersist();
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/** Clears this device's saved app state. Songs imported from the web stay in the import service and come back on reload. */
export function resetAppData() {
  // A save on the way out (pagehide) would bring the old data back.
  persistenceStopped = true;
  clearTimeout(persistTimer);
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// Live audio and app state cannot be swapped in place: when this module (or anything it imports) changes, reload the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
