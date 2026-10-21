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
  /** A release from the music catalog, by catalog id ("dz123"). */
  | { name: "release"; id: string }
  | { name: "artist"; id: string }
  | { name: "mix"; id: string }
  | { name: "storage" }
  | { name: "server" }
  | { name: "history" }
  | { name: "friends" }
  /** A playlist someone shared (src/state/social.ts), by share id. */
  | { name: "shared"; id: string };

export type Modal =
  | { type: "createPlaylist"; addIds?: string[] }
  | { type: "editPlaylist"; id: string }
  | { type: "addSongs"; playlistId: string }
  | { type: "settings"; tab?: SettingsTab }
  | { type: "listenAlong" }
  | { type: "clipEditor"; trackId?: string }
  | { type: "sharePlaylist"; id: string };

export interface RoomMember { userId: string; name: string; avatarUrl: string | null; host: boolean }

export type SettingsTab = "general" | "account" | "playback" | "recommendations" | "appearance" | "server" | "shortcuts";

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
  reduceMotion: boolean;
  /** Single-key shortcuts (M, L, S, R, Q, F, / and ?). Off for speech input and screen reader keys. */
  letterShortcuts: boolean;
  compact: boolean;
  autoplay: boolean;
  /** Also recommend songs already in the library (a shelf of their own on Home). */
  recommendLibrary: boolean;
  normalize: boolean;
  profileName: string;
  downloadMode: "verified_file_cache" | "stream_only";
  /** How often songs you've marked are slipped in between the ones you play (see slipins.ts). */
  slipIns: "off" | "rare" | "sometimes" | "often";
  /** Tone controls (dB for bass, mid and treble; −1 left to 1 right for balance). */
  tone: { bass: number; mid: number; treble: number; balance: number };
}

export interface PlaybackContext {
  label: string;
  route?: Route;
  ids: string[];
  /** Why each song was recommended, when the collection came from the recommender. */
  picks?: Record<string, ReasonKind>;
  /** Set while a web-discovery radio is playing, so it can top itself up. */
  radioKey?: string;
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
  /** The music server (this computer's Slopify backend): reachability, songs being saved on this device (progress 0–1), last library sync. */
  server: {
    status: "connected" | "connecting" | "offline";
    downloads: Record<string, number>;
    syncedAt?: number;
    /** The last sync with the signed-in Slopify account, and why the last attempt failed, if it did. */
    cloudSyncedAt?: number;
    cloudError?: string;
    /** This computer's library belongs to another Slopify account (its email or name), so account sync is off. */
    linkedElsewhere?: string;
  };
  /** Listen Along (src/state/listen.ts): the room this device is in, and who else is. */
  listen: { mode: "idle" | "connecting" | "host" | "guest"; code: string; members: RoomMember[]; host?: string };
  /** Seconds listened each day on this device. */
  listenLog: Record<string, number>;
  /** The same, on your other devices (sync.ts). */
  listenElsewhere: Record<string, number>;
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
  reduceMotion: false,
  letterShortcuts: true,
  compact: false,
  autoplay: true,
  recommendLibrary: false,
  normalize: true,
  profileName: "",
  downloadMode: "verified_file_cache",
  slipIns: "sometimes",
  tone: { bass: 0, mid: 0, treble: 0, balance: 0 },
};

interface CatalogPatch {
  /** Library order, excluding session-only file imports and streamed recommendations. */
  trackIds: string[];
  /** The library's songs (web imports), with their artists and albums. */
  tracks: Record<string, Track>;
  artists: Record<string, Artist>;
  albums: Record<string, Album>;
}

type Persisted = Partial<Pick<AppState, "playlists" | "settings" | "clips" | "volume" | "muted" | "shuffle" | "repeat" | "speed" | "sidebarCollapsed" | "panel" | "listenLog" | "listenElsewhere" | "listens" | "taste">> & { catalog?: CatalogPatch; librarySync?: unknown };
/*
 * The library sync base (see sync.ts) is saved in the same record as the app
 * data it describes. Tabs share this storage, so whichever tab saves last
 * stores its own data with its own base, and a reload never pairs one tab's
 * data with another tab's base (which made playlists look deleted).
 */
let initialSyncBase: unknown;
let syncSnapshot: (() => unknown) | undefined;
/** The sync base saved with the data this tab loaded. */
export const initialLibrarySync = () => initialSyncBase;
/** Lets sync.ts provide its current base whenever the app data is saved. */
export function connectLibrarySync(snapshot: () => unknown) {
  syncSnapshot = snapshot;
}

function catalogPatch(s: AppState): CatalogPatch {
  const trackIds = s.trackIds.filter((id) => s.tracks[id] && !s.tracks[id].fileUrl && !s.tracks[id].stream);
  const tracks: Record<string, Track> = {};
  const artists: Record<string, Artist> = {};
  const albums: Record<string, Album> = {};
  for (const id of trackIds) {
    const t = s.tracks[id];
    tracks[id] = t;
    for (const a of [t.artistId, ...(t.featuring ?? [])]) if (s.artists[a]) artists[a] = s.artists[a];
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
  initialSyncBase = saved.librarySync;
  const artists: Record<string, Artist> = {};
  const albums: Record<string, Album> = {};
  const tracks: Record<string, Track> = {};
  let trackIds: string[] = [];
  if (saved.catalog) {
    const patch = saved.catalog;
    for (const id of patch.trackIds) {
      const t = patch.tracks[id];
      // Only music you brought in is kept: the generated demo songs from older builds had no server copy.
      // Songs saved from the web before links were stored as files; they now stream from the server until this device keeps a copy.
      if (t?.serverId) tracks[id] = t.storage === "files" ? { ...t, storage: "server" } : t;
    }
    trackIds = patch.trackIds.filter((id) => tracks[id]);
    for (const t of Object.values(tracks)) {
      // Repair saves from older builds that lost an import's artist or album.
      artists[t.artistId] = patch.artists[t.artistId] ?? { id: t.artistId, name: "Unknown artist", genre: "indie", palette: paletteFromSeed(hashString(t.artistId)), listeners: 0 };
      // Saves from before other credited artists were kept drop them; the next server sync puts them back.
      for (const a of t.featuring ?? []) if (patch.artists[a]) artists[a] = patch.artists[a];
      albums[t.albumId] = patch.albums[t.albumId] ?? { id: t.albumId, title: t.title, artistId: t.artistId, palette: paletteFromSeed(hashString(t.albumId)), glyph: 0 };
    }
  }
  const playlists = (saved.playlists ?? [])
    .map((p) => ({ ...(p.id === "liked" ? likedPlaylist(p) : p), trackIds: p.trackIds.filter((id) => tracks[id]) }))
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
    // Only current settings: older builds also saved a server address and upload mode.
    settings: { ...defaultSettings, ...Object.fromEntries(Object.entries(saved.settings ?? {}).filter(([key]) => key in defaultSettings)) },
    clips: saved.clips ?? {},
    clipDraft: null,
    server: { status: "connecting", downloads: {} },
    listen: { mode: "idle", code: "", members: [] },
    listenLog: saved.listenLog ?? {},
    listenElsewhere: saved.listenElsewhere ?? {},
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
    listenElsewhere: s.listenElsewhere,
    // Session-only files and streamed recommendations are gone after a reload, so their plays are not kept.
    listens: s.listens.filter((l) => !s.tracks[l.id]?.fileUrl && !s.tracks[l.id]?.stream),
    // Session-only files are gone after a reload, so their feedback is too.
    taste: restoreTaste(s.taste, new Set(s.trackIds.filter((id) => s.tracks[id] && !s.tracks[id].fileUrl))),
    catalog: catalogPatch(s),
    // Saved with the data it describes, in one write.
    librarySync: syncSnapshot?.() ?? initialSyncBase,
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
  // Mix editions and recommended songs (recommend/ keeps its own keys; importing them here would be circular).
  localStorage.removeItem("slopify.mix-editions.v1");
  localStorage.removeItem("slopify.discovery.v1");
  location.reload();
}

// Live audio and app state cannot be swapped in place: when this module (or anything it imports) changes, reload the page.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
