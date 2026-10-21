import { useSyncExternalStore } from "react";
import { engine } from "../audio/engine";
import { dismissToast, navigate, next as nextSong, previous, toast, togglePlay } from "./actions";
import { flushPersist, getState, subscribe as subscribeApp } from "./store";

/*
 * The desktop app's updates (desktop/updates.cjs), reached through the bridge in
 * desktop/preload.cjs. In a browser there is no bridge and none of this shows.
 */

export type UpdateChannel = "stable" | "nightly";

export interface DesktopUpdates {
  version: string;
  channel: UpdateChannel;
  status: "unsupported" | "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error";
  /** The portable EXE can't replace itself; its updates are downloaded by hand. */
  portable: boolean;
  /** The newer version found, if any. */
  available: string | null;
  progress: number;
  error: string | null;
  checkedAt: number | null;
}

/** Desktop-only behaviour (desktop/background.cjs). */
export interface DesktopSettings {
  /** Closing the window keeps Slopify playing in the tray. */
  closeToTray: boolean;
  /** Show what's playing on Discord. */
  discord: boolean;
  /** This build has a Discord application id to show as. */
  discordAvailable: boolean;
}

interface NowPlaying { title: string; artist?: string; album?: string; artwork?: string; duration: number; position: number; playing: boolean }

interface Bridge {
  platform: string;
  settings: { get(): Promise<DesktopSettings>; set(patch: Partial<DesktopSettings>): Promise<DesktopSettings> };
  nowPlaying(now: NowPlaying | null): void;
  onCommand(listener: (name: string) => void): () => void;
  onLink?(listener: (link: { type: "shared"; id: string }) => void): () => void;
  updates: {
    get(): Promise<DesktopUpdates>;
    check(): Promise<DesktopUpdates>;
    setChannel(channel: UpdateChannel): Promise<DesktopUpdates>;
    install(): Promise<DesktopUpdates>;
    onChange(listener: (state: DesktopUpdates) => void): () => void;
  };
}

const bridge = (window as Window & { slopifyDesktop?: Bridge }).slopifyDesktop ?? null;
export const isDesktopApp = Boolean(bridge);

let state: DesktopUpdates | null = null;
/** The "update ready" toast on screen, if any. */
let offerToast: number | null = null;
const listeners = new Set<() => void>();
function set(next: DesktopUpdates) {
  const was = state;
  state = next;
  listeners.forEach((l) => l());
  // Say so once, when an update becomes ready (or found, for the portable copy), without interrupting what's playing.
  const offer = (u: DesktopUpdates | null) => Boolean(u?.available && (u.status === "ready" || (u.portable && u.status === "available")));
  // An offer that no longer stands (the channel changed, say) takes its toast with it.
  if (!offer(next) && offerToast !== null) {
    dismissToast(offerToast);
    offerToast = null;
  }
  if (offer(next) && !(offer(was) && was?.available === next.available)) {
    if (offerToast !== null) dismissToast(offerToast);
    offerToast = toast(`Slopify ${next.available} is ready`, {
      detail: next.portable ? "Download it to update this copy." : "Restart when you're ready to use it.",
      sticky: true,
      action: { label: next.portable ? "Download" : "Restart", run: installUpdate },
    });
  }
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const useDesktopUpdates = () => useSyncExternalStore(subscribe, () => state);

export function startDesktopUpdates() {
  if (!bridge || state) return;
  bridge.updates.onChange(set);
  void bridge.updates.get().then((s) => (state ? undefined : set(s)));
  void bridge.settings.get().then(setSettings);
  startNowPlaying(bridge);
  // A shared playlist's link (slopify://p/<id>) opens the playlist.
  bridge.onLink?.((link) => {
    if (link.type === "shared" && /^[a-z0-9]{16}$/.test(link.id)) navigate({ name: "shared", id: link.id });
  });
}

/* ───────────────────────── tray and Discord ───────────────────────── */

let settings: DesktopSettings | null = null;
const settingsListeners = new Set<() => void>();
function setSettings(next: DesktopSettings) {
  settings = next;
  settingsListeners.forEach((l) => l());
}
export const useDesktopSettings = () =>
  useSyncExternalStore((l) => (settingsListeners.add(l), () => void settingsListeners.delete(l)), () => settings);

export function setDesktopSetting(patch: Partial<Pick<DesktopSettings, "closeToTray" | "discord">>) {
  void bridge?.settings.set(patch).then(setSettings);
}

/** Tells the desktop app what's playing (for the tray and Discord), and takes its play/pause, next and previous. */
function startNowPlaying(b: Bridge) {
  b.onCommand((name) => {
    if (name === "toggle") togglePlay();
    else if (name === "next") nextSong();
    else if (name === "previous") previous();
  });
  let sent = "";
  let sentAt = 0;
  const publish = (force = false) => {
    const s = getState();
    const t = s.currentId ? s.tracks[s.currentId] : null;
    const album = t ? s.albums[t.albumId] : undefined;
    const now: NowPlaying | null = t ? {
      title: t.title,
      artist: s.artists[t.artistId]?.name,
      album: album?.title,
      artwork: album?.artworkUrl?.startsWith("https://") ? album.artworkUrl : undefined,
      duration: t.duration || 0,
      position: engine.position || 0,
      playing: s.isPlaying,
    } : null;
    // Position is left out of the comparison: it changes every moment, and only a jump (a seek) matters.
    const key = JSON.stringify(now && { ...now, position: 0 });
    const expected = now && now.playing ? (Date.now() - sentAt) / 1000 : 0;
    const jumped = Boolean(now?.playing && Math.abs(now.position - (lastPosition + expected)) > 3);
    if (!force && key === sent && !jumped) return;
    sent = key;
    sentAt = Date.now();
    lastPosition = now?.position ?? 0;
    b.nowPlaying(now);
  };
  let lastPosition = 0;
  subscribeApp(() => publish());
  // Catches seeks, which don't change the app state.
  window.setInterval(() => publish(), 5000);
}

export function checkForUpdates() {
  void bridge?.updates.check().then(set);
}

export function setUpdateChannel(channel: UpdateChannel) {
  void bridge?.updates.setChannel(channel).then(set, (error: Error) => toast("Couldn't change the update channel", { detail: error.message.replace(/^.*Error: /, "") }));
}

export function installUpdate() {
  // Save playlists and settings before the app closes to install.
  flushPersist();
  void bridge?.updates.install();
}
