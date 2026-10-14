const { app, BrowserWindow, dialog, shell, utilityProcess } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startUpdates } = require("./updates.cjs");
const { startBackground } = require("./background.cjs");

app.setName("Slopify");
app.setAppUserModelId("com.drasticdeveloping.slopify");
// Once the video controls fade out, nothing covers the video and Chromium hands it to a
// Windows hardware overlay, where the picture can freeze while the sound carries on.
app.commandLine.appendSwitch("disable-direct-composition-video-overlays");
// Running from a checkout (`npm run desktop`, T3's Launch) uses the library and profile
// all checkouts share (or this checkout's own, isolated: see server/data-dir.cjs) and
// its own port, so it can run beside an installed copy.
const fromCheckout = !app.isPackaged;
const checkout = fromCheckout ? require("../server/data-dir.cjs") : null;
const profileDir = process.env.SLOPIFY_DESKTOP_DATA_DIR
  ? path.resolve(process.env.SLOPIFY_DESKTOP_DATA_DIR)
  : checkout ? checkout.checkoutProfileDir(app.getAppPath()) : path.join(app.getPath("appData"), "Slopify");
fs.mkdirSync(profileDir, { recursive: true });
app.setPath("userData", profileDir);
const port = Number(process.env.SLOPIFY_DESKTOP_PORT || (fromCheckout ? 5197 : 5198));
const TITLE_BAR = 36;
const origin = `http://127.0.0.1:${port}`;
let window;
let backend;
let ready = false;
let quitting = false;
/** Set once the app is really quitting (Quit in the tray, an update), so closing the window isn't just hiding it. */
let exiting = false;
let background;

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function fail(error) {
  dialog.showErrorBox("Slopify couldn't start", error.message);
  app.quit();
}

function external(url) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => {});
}

function createWindow() {
  window = new BrowserWindow({
    title: "Slopify", width: 1320, height: 900, minWidth: 420, minHeight: 600,
    backgroundColor: "#08080c", show: false,
    icon: path.join(app.getAppPath(), "dist/icons/icon-512.png"),
    // The app draws its own title bar; Windows and Linux keep their native buttons over it.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: 11 } }
      : { titleBarOverlay: { color: "#00000000", symbolColor: "#c8c8d4", height: TITLE_BAR } }),
    // Playback (crossfades, the next song) keeps time while the window is hidden in the tray.
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  // Like Discord: closing the window keeps Slopify playing in the tray, unless Settings turns that off.
  window.on("close", (event) => {
    if (exiting || !background?.keepInTray()) return;
    event.preventDefault();
    window.hide();
    background.hidden();
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); external(url); }
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once("ready-to-show", () => window.show());
  window.loadURL(origin).catch(fail);
}

const logFile = path.join(profileDir, "desktop.log");
const log = (chunk) => { try { fs.appendFileSync(logFile, chunk); } catch { /* Logging never stops the app. */ } };

async function startBackend() {
  const userData = app.getPath("userData");
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + ".previous");
  backend = utilityProcess.fork(path.join(__dirname, "backend.cjs"), [], {
    stdio: "pipe", serviceName: "Slopify music server",
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port),
      SLOPIFY_DATA_DIR: process.env.SLOPIFY_DATA_DIR || (checkout ? checkout.checkoutDataDir(app.getAppPath()) : path.join(userData, "library")),
      FFMPEG_BIN: app.isPackaged ? path.join(process.resourcesPath, "bin/ffmpeg.exe") : require("ffmpeg-static")
    }
  });
  let output = "";
  let errors = "";
  backend.stderr.on("data", (chunk) => { log(chunk); errors = (errors + chunk).slice(-4000); });
  backend.on("exit", (code) => {
    if (ready && !quitting) fail(new Error(`The music server stopped (code ${code}). Restart Slopify.\n\n${errors}`));
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`The music server didn't start. See ${logFile}.`)), 15000);
    backend.once("exit", (code) => { clearTimeout(timeout); reject(new Error(errors || `Music server exited with code ${code}.`)); });
    backend.stdout.on("data", (chunk) => {
      log(chunk);
      output = (output + chunk).slice(-4000);
      if (output.includes(`Slopify is running at ${origin}`)) { clearTimeout(timeout); resolve(); }
    });
  });
  ready = true;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.whenReady().then(async () => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SLOPIFY_DESKTOP_PORT.");
    await startBackend();
    createWindow();
    background = startBackground({ getWindow: () => window, show: showWindow, log });
    startUpdates(() => window, log);
  }).catch(fail);
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  exiting = true;
  background?.close();
  background = null;
  if (quitting || !backend?.pid) return;
  quitting = true;
  event.preventDefault();
  // Quit for real afterwards (not app.exit), so an update waiting to install runs on the way out.
  const timeout = setTimeout(() => { backend.kill(); app.quit(); }, 4000);
  backend.once("exit", () => { clearTimeout(timeout); app.quit(); });
  backend.postMessage("shutdown");
});
