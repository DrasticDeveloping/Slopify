/*
 * The Slopify iPhone app (ios/). It runs Slopify's own music server inside the
 * app (nodejs-mobile, started by ios/App/App/NodeServer.swift) and shows these
 * same pages from it, so everything works as it does on a computer. The app
 * marks its web view's user agent so the pages can tell (capacitor.config.json).
 */

/** Running inside the iPhone app, rather than a browser or the desktop app. */
export const isNativeApp = /\bSlopifyiOS\b/.test(navigator.userAgent);

/** What the app calls the device it's on, as in "Your library stays on this iPhone." */
export const thisDevice = isNativeApp ? "this iPhone" : "this computer";
export const ThisDevice = isNativeApp ? "This iPhone" : "This computer";

/** Optional UI feedback; older app builds and browsers simply omit it. */
export function nativeFeedback(kind: "selection" | "light" = "selection") {
  if (!isNativeApp) return;
  const handler = (window as Window & { webkit?: { messageHandlers?: { slopifyFeedback?: { postMessage(value: string): void } } } }).webkit?.messageHandlers?.slopifyFeedback;
  try { handler?.postMessage(kind); } catch { /* Feedback must never block an action. */ }
}

/** Activating AVAudioSession is separate from choosing WebKit's session type. */
export async function activateNativeAudio() {
  if (!isNativeApp) return;
  const handler = (window as Window & { webkit?: { messageHandlers?: { slopifyAudio?: { postMessage(value: string): Promise<unknown> } } } }).webkit?.messageHandlers?.slopifyAudio;
  if (!handler) throw new Error("The iPhone audio service is unavailable.");
  await handler.postMessage("activate");
}
