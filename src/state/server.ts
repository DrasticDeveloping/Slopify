import { dismissToast, toast, updateToast } from "./actions";
import { keepOnDevice, restoreDeviceFiles } from "./device";
import { releaseSong, songFileUrl } from "./song-api";
import { getState, setState } from "./store";

/*
 * The music server, as this device sees it: whether it can be reached, and
 * bringing saved songs' files onto this device. The server is Slopify's own
 * backend on this computer (server/api.mjs).
 */

/* ───────────────────────── connection ───────────────────────── */

const RETRY = 15_000;
const CHECK = 60_000;
let chosenOffline = false;
let timer = 0;
let attempt = 0;
let onConnected: () => unknown = () => undefined;
let started = false;

const setStatus = (status: "connected" | "connecting" | "offline") => setState((s) => (s.server.status === status ? {} : { server: { ...s.server, status } }));

async function reachable() {
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const health = res.ok ? ((await res.json()) as { ok?: boolean; presence?: boolean } | null) : null;
    if (health?.presence) stayPresent();
    return Boolean(health?.ok);
  } catch {
    return false;
  }
}

/*
 * Tells a server that stops when its last window closes (`npm start` on this
 * computer) that this window is open: it checks in every 20 seconds, and says
 * when it closes (or goes into the back/forward cache).
 */
const PAGE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let present = false;
const checkIn = (closing = false) => {
  const body = JSON.stringify({ page: PAGE, closing });
  if (closing) navigator.sendBeacon("/api/presence", body);
  else void fetch("/api/presence", { method: "POST", body, keepalive: true }).catch(() => undefined);
};
function stayPresent() {
  if (present) return;
  present = true;
  checkIn();
  window.setInterval(() => checkIn(), 20_000);
  window.addEventListener("pagehide", () => checkIn(true));
  window.addEventListener("pageshow", (event) => event.persisted && checkIn());
}

/** Checks the server now; while it can't be reached, keeps checking every 15 seconds. */
export async function connect({ announce = false } = {}) {
  chosenOffline = false;
  clearTimeout(timer);
  const mine = ++attempt;
  const was = getState().server.status;
  if (was !== "connected") setStatus("connecting");
  const ok = await reachable();
  // A newer connect or disconnect wins.
  if (mine !== attempt || chosenOffline) return;
  setStatus(ok ? "connected" : "offline");
  timer = window.setTimeout(() => void connect(), ok ? CHECK : RETRY);
  if (ok && was !== "connected") {
    if (announce) toast("Connected to the music server", { tone: "success", detail: location.origin });
    void onConnected();
  } else if (!ok && announce) {
    toast("Couldn't reach the music server", { tone: "error", detail: "Songs on this device still play." });
  }
}

/** Stops using the server: only songs kept on this device play until you reconnect. */
export function disconnect() {
  chosenOffline = true;
  attempt++;
  clearTimeout(timer);
  cancelDownloads({ quiet: true });
  setStatus("offline");
  toast("Disconnected from the music server", { detail: "Only songs kept on this device will play." });
}

/**
 * Starts the music server connection once: brings back this device's kept song
 * files, then connects, running `whenConnected` (library sync) on every connect.
 */
export async function startMusicServer(whenConnected: () => unknown) {
  if (started) return;
  started = true;
  onConnected = whenConnected;
  await restoreDeviceCopies();
  window.addEventListener("online", () => !chosenOffline && void connect());
  void connect();
}

/** Loads the files this device keeps; songs whose file has gone (browser data cleared) stream again. */
async function restoreDeviceCopies() {
  const s = getState();
  const ids = s.trackIds.filter((id) => s.tracks[id]?.storage === "downloads");
  const kept = await restoreDeviceFiles(ids);
  const lost = ids.filter((id) => !kept.has(id));
  if (!lost.length) return;
  setState((st) => {
    const tracks = { ...st.tracks };
    for (const id of lost) if (tracks[id]?.storage === "downloads") tracks[id] = { ...tracks[id], storage: "server" };
    return { tracks };
  });
}

/* ───────────────────────── files on this device ───────────────────────── */

/** Songs fetched at once; the rest wait their turn. */
const PARALLEL = 2;
const transfers = new Map<string, AbortController>();
const queue: string[] = [];
let transferToast = 0;
let quietBatch = false;
/** When each song last failed to download (this session), so automatic downloads don't retry it on every sync. */
const failedAt = new Map<string, number>();
const RETRY_FAILED = 6 * 3600_000;

function setProgress(id: string, progress: number | null) {
  setState((s) => {
    const downloads = { ...s.server.downloads };
    if (progress === null) delete downloads[id];
    else downloads[id] = progress;
    return { server: { ...s.server, downloads } };
  });
  refreshToast();
}

function refreshToast() {
  if (quietBatch) return;
  const d = getState().server.downloads;
  const ids = Object.keys(d);
  if (!ids.length) {
    if (transferToast) updateToast(transferToast, { message: "Songs saved on this device", detail: "They play even without the server.", progress: undefined, tone: "success", sticky: false }, 2600);
    transferToast = 0;
    return;
  }
  const average = ids.reduce((sum, id) => sum + d[id], 0) / ids.length;
  const detail = `${ids.length} remaining · ${Math.round(average * 100)}%`;
  if (!transferToast) transferToast = toast("Saving songs on this device", { detail, progress: average, sticky: true });
  else updateToast(transferToast, { detail, progress: average });
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Fetches one song's file, checks it is complete and exactly the server's, and keeps it on this device. */
async function fetchToDevice(id: string, serverId: string, signal: AbortSignal) {
  const res = await fetch(songFileUrl(serverId), { cache: "no-store", signal });
  if (!res.ok || !res.body) throw new Error(`The music server couldn't provide this song (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total) setProgress(id, Math.min(0.99, received / total));
  }
  const blob = new Blob(chunks as BlobPart[], { type: res.headers.get("content-type") || "application/octet-stream" });
  if (total && blob.size !== total) throw new Error("The download was incomplete.");
  const expected = res.headers.get("x-content-sha256");
  if (expected && hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())) !== expected.toLowerCase()) {
    throw new Error("The downloaded file didn't match the server's copy.");
  }
  await keepOnDevice(id, blob);
  return blob.size;
}

async function runQueue() {
  while (transfers.size < PARALLEL && queue.length) {
    const id = queue.shift()!;
    const t = getState().tracks[id];
    if (!t?.serverId || t.storage !== "server") {
      setProgress(id, null);
      continue;
    }
    const controller = new AbortController();
    transfers.set(id, controller);
    void fetchToDevice(id, t.serverId, controller.signal)
      .then((size) => {
        setState((s) => (s.tracks[id] ? { tracks: { ...s.tracks, [id]: { ...s.tracks[id], storage: "downloads", size } } } : {}));
        // The device's verified copy lets the server drop any copy of its own.
        void releaseSong(t.serverId!).catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) failedAt.set(id, Date.now());
        if (!controller.signal.aborted && !quietBatch) toast(`Couldn't save “${t.title}” on this device`, { tone: "error", detail: error instanceof Error ? error.message : undefined });
      })
      .finally(() => {
        transfers.delete(id);
        setProgress(id, null);
        if (!transfers.size && !queue.length) quietBatch = false;
        void runQueue();
      });
  }
}

/**
 * Keeps these server songs on this device. `quiet` hides progress, for files
 * fetched automatically (a song just saved, or one the server is handing over).
 */
export function downloadTracks(ids: string[], { quiet = false } = {}) {
  const s = getState();
  if (s.server.status !== "connected") {
    if (!quiet) toast("The music server is offline", { tone: "error", detail: "Reconnect in Settings → Server." });
    return;
  }
  if (s.settings.downloadMode !== "verified_file_cache") {
    if (!quiet) toast("Downloads are off", { detail: "Turn on the offline cache in Settings → Server." });
    return;
  }
  const targets = ids.filter((id) => s.tracks[id]?.storage === "server" && s.tracks[id].serverId && !transfers.has(id) && !queue.includes(id));
  if (!targets.length) return;
  if (!quiet) {
    // Asked for: these are kept on the device from now on.
    if (targets.some((id) => s.tracks[id].onlyStream)) {
      setState((st) => ({ tracks: { ...st.tracks, ...Object.fromEntries(targets.filter((id) => st.tracks[id]).map((id) => { const { onlyStream: _onlyStream, ...t } = st.tracks[id]; return [id, t]; })) } }));
    }
    quietBatch = false;
  }
  else if (!transfers.size && !queue.length) quietBatch = true;
  queue.push(...targets);
  setState((st) => ({ server: { ...st.server, downloads: { ...st.server.downloads, ...Object.fromEntries(targets.map((id) => [id, 0])) } } }));
  refreshToast();
  void runQueue();
}

/**
 * Keeps every music-server song in the library on this device (with the
 * offline cache on), including ones saved on your other devices, except songs
 * you removed from it. One that couldn't be fetched waits a while before trying again.
 */
export function keepLibraryOnDevice() {
  const s = getState();
  const now = Date.now();
  const ids = s.trackIds.filter((id) => {
    const t = s.tracks[id];
    return t?.storage === "server" && t.serverId && !t.onlyStream && !(now - (failedAt.get(id) ?? 0) < RETRY_FAILED);
  });
  if (ids.length) downloadTracks(ids, { quiet: true });
}

export function cancelDownloads({ quiet = false } = {}) {
  queue.length = 0;
  for (const controller of transfers.values()) controller.abort();
  setState((s) => ({ server: { ...s.server, downloads: {} } }));
  if (transferToast) dismissToast(transferToast);
  transferToast = 0;
  if (!quiet) toast("Downloads cancelled");
}
