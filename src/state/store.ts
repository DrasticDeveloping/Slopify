import { useSyncExternalStore } from "react";
import { buildCatalog, hashString, paletteFromSeed } from "../data/library";
import type { HeaderInfo } from "../components/Hero";
import type { Album, Artist, ClipRange, Genre, Playlist, Track } from "../data/types";

export type Route =
  | { name: "home" }
  | { name: "search"; q: string }
  | { name: "library"; filter?: string }
  | { name: "playlists" }
  | { name: "playlist"; id: string }
  | { name: "album"; id: string }
  | { name: "artist"; id: string }
  | { name: "mix"; genre: Genre }
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
  normalize: true,
  profileName: "Daz",
  serverUrl: "https://music.slopify.local",
  uploadMode: "local_file",
  downloadMode: "verified_file_cache",
};

interface CatalogPatch {
  /** Library order, excluding session-only file imports. */
  trackIds: string[];
  /** Imported tracks plus base tracks whose storage, upload state, plays, or duration changed. */
  tracks: Record<string, Track>;
  artists: Record<string, Artist>;
  albums: Record<string, Album>;
}

type Persisted = Partial<Pick<AppState, "playlists" | "settings" | "clips" | "volume" | "muted" | "shuffle" | "repeat" | "speed" | "sidebarCollapsed" | "panel" | "listenLog" | "listens">> & { catalog?: CatalogPatch };

/** The generated catalog, used to persist only what changed. */
let base: { tracks: Record<string, Track>; artists: Record<string, Artist>; albums: Record<string, Album> } = { tracks: {}, artists: {}, albums: {} };

function catalogPatch(s: AppState): CatalogPatch {
  const tracks: Record<string, Track> = {};
  for (const id of s.trackIds) {
    const t = s.tracks[id];
    if (!t || t.fileUrl) continue;
    const b = base.tracks[id];
    if (!b || b.storage !== t.storage || b.uploaded !== t.uploaded || b.plays !== t.plays || b.duration !== t.duration) tracks[id] = t;
  }
  const artists: Record<string, Artist> = {};
  const albums: Record<string, Album> = {};
  for (const t of Object.values(tracks)) {
    if (!base.artists[t.artistId] && s.artists[t.artistId]) artists[t.artistId] = s.artists[t.artistId];
    if (!base.albums[t.albumId] && s.albums[t.albumId]) albums[t.albumId] = s.albums[t.albumId];
  }
  return { trackIds: s.trackIds.filter((id) => s.tracks[id] && !s.tracks[id].fileUrl), tracks, artists, albums };
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persisted) : {};
  } catch {
    return {};
  }
}

function initialState(): AppState {
  const catalog = buildCatalog();
  const saved = loadPersisted();
  const baseTracks = Object.fromEntries(catalog.tracks.map((t) => [t.id, t]));
  const artists = Object.fromEntries(catalog.artists.map((a) => [a.id, a]));
  const albums = Object.fromEntries(catalog.albums.map((a) => [a.id, a]));
  // Separate copies: restored imports must not leak into the base snapshot.
  base = { tracks: { ...baseTracks }, artists: { ...artists }, albums: { ...albums } };
  let tracks: Record<string, Track> = baseTracks;
  let trackIds = catalog.tracks.map((t) => t.id);
  if (saved.catalog) {
    const patch = saved.catalog;
    Object.assign(artists, patch.artists);
    Object.assign(albums, patch.albums);
    tracks = {};
    for (const id of patch.trackIds) {
      const t = patch.tracks[id] ?? baseTracks[id];
      if (t) tracks[id] = t;
    }
    trackIds = patch.trackIds.filter((id) => tracks[id]);
    // Repair saves from older builds that lost an import's artist or album.
    for (const t of Object.values(tracks)) {
      if (!artists[t.artistId]) artists[t.artistId] = { id: t.artistId, name: "Unknown artist", genre: "indie", palette: paletteFromSeed(hashString(t.artistId)), listeners: 0 };
      if (!albums[t.albumId]) albums[t.albumId] = { id: t.albumId, title: t.title, artistId: t.artistId, year: new Date(t.addedAt).getFullYear(), palette: paletteFromSeed(hashString(t.albumId)), glyph: 0 };
    }
  }
  const playlists = (saved.playlists ?? catalog.playlists).map((p) => ({ ...p, trackIds: p.trackIds.filter((id) => tracks[id]) }));
  if (!playlists.some((p) => p.id === "liked")) playlists.unshift(catalog.playlists[0]);
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
  };
}

let state: AppState = initialState();
const listeners = new Set<() => void>();

export function getState() {
  return state;
}

let persistTimer = 0;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    const s = state;
    const data: Persisted = {
      playlists: s.playlists,
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
      listens: s.listens.filter((l) => !s.tracks[l.id]?.fileUrl),
      catalog: catalogPatch(s),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Storage can be full or blocked; the session keeps working in memory.
    }
  }, 400);
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

export function resetDemo() {
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// Live audio and app state cannot be swapped in place: when this module (or anything it imports) changes, reload the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
