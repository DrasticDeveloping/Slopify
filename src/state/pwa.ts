import { useSyncExternalStore } from "react";
import { isNativeApp } from "../lib/native";
import { toast } from "./actions";
import { flushPersist } from "./store";

/*
 * Slopify as an installable web app: the install prompt, and updates to the
 * offline app shell (src/pwa/service-worker.js). An update downloads in the
 * background and waits; it only takes over when the listener chooses to restart.
 */

/** Chrome's install prompt event (not yet in the DOM typings). */
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PwaState {
  installed: boolean;
  /** The browser offered an install prompt we can show. */
  canInstall: boolean;
  installing: boolean;
  /** A new version is downloaded and waiting for a restart. */
  updateReady: boolean;
}

const standalone = window.matchMedia("(display-mode: standalone)");
/** Running as the installed app (iOS reports it through navigator.standalone). */
const desktop = /Electron\//.test(navigator.userAgent);
const isInstalled = () => desktop || isNativeApp || standalone.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

let state: PwaState = { installed: isInstalled(), canInstall: false, installing: false, updateReady: false };
const listeners = new Set<() => void>();
function set(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const usePwa = () => useSyncExternalStore(subscribe, () => state);

let installPrompt: InstallPrompt | null = null;
let registration: ServiceWorkerRegistration | null = null;
/** Set when the listener asked to update, so the new version's takeover reloads the page. */
let restartRequested = false;
let started = false;

export async function installApp() {
  const event = installPrompt;
  if (!event || state.installing) return;
  // A prompt can only be shown once.
  installPrompt = null;
  set({ canInstall: false, installing: true });
  try {
    await event.prompt();
    await event.userChoice;
  } catch {
    toast("Open your browser menu to install Slopify", { detail: "Choose Install app or Add to Home Screen." });
  } finally {
    set({ installing: false });
  }
}

/** Switches to the waiting version: saves first, then reloads once it has taken over. */
export function updateApp() {
  if (!registration?.waiting) return;
  flushPersist();
  restartRequested = true;
  registration.waiting.postMessage({ type: "APPLY_UPDATE" });
}

/** How to install where the browser gives us no prompt. */
export function installationHelp() {
  if (!window.isSecureContext) return "Open Slopify over HTTPS to install it on this device.";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios) return "Use Share → Add to Home Screen to install Slopify.";
  return "Use your browser's Install app option, or Add to Dock in Safari.";
}

function updateIsReady() {
  if (state.updateReady) return;
  set({ updateReady: true });
  toast("A Slopify update is ready", { detail: "Restart when you're ready to use it.", sticky: true, action: { label: "Update", run: updateApp } });
}

async function registerWorker() {
  try {
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  } catch {
    // The app still runs; it just won't open offline.
    return;
  }
  const reg = registration;
  if (reg.waiting) updateIsReady();
  reg.addEventListener("updatefound", () => {
    const worker = reg.installing;
    worker?.addEventListener("statechange", () => {
      // The first install has no controller to replace, so it isn't an update.
      if (worker.state === "installed" && navigator.serviceWorker.controller) updateIsReady();
    });
  });
  const check = () => {
    if (document.visibilityState === "visible" && navigator.onLine) void reg.update().catch(() => undefined);
  };
  window.addEventListener("online", check);
  document.addEventListener("visibilitychange", check);
  window.setInterval(check, 60 * 60_000);
}

export function startPwa() {
  if (started) return;
  started = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    // Shown from our own Install button instead of the browser's mini-bar.
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    set({ canInstall: !isInstalled() });
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    set({ installed: true, canInstall: false });
  });
  standalone.addEventListener("change", () => set({ installed: isInstalled(), canInstall: Boolean(installPrompt) && !isInstalled() }));

  // The offline shell is built by `npm run build`; the dev server has none. The phone app has its pages built in.
  if (desktop || isNativeApp || import.meta.env.DEV || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (restartRequested) location.reload();
  });
  if (document.readyState === "complete") void registerWorker();
  else window.addEventListener("load", () => void registerWorker(), { once: true });
}
