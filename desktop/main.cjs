const { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { startUpdates } = require("./updates.cjs");
const { startBackground } = require("./background.cjs");
const { handOff, listenForLinks } = require("./link-handoff.cjs");

app.setName("Slopify");
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";
if (isWindows) {
  app.setAppUserModelId("com.drasticdeveloping.slopify");
  // The Windows hardware overlay can freeze the picture after the video controls fade out.
  app.commandLine.appendSwitch("disable-direct-composition-video-overlays");
}
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
const icon = path.join(app.getAppPath(), "dist/icons/icon-512.png");
const origin = `http://127.0.0.1:${port}`;
let window;
let backend;
let ready = false;
let quitting = false;
/** Set once the app is really quitting (Quit in the tray, an update), so closing the window isn't just hiding it. */
let exiting = false;
let background;

function showWindow() {
  if (exiting) return;
  if (!window) {
    if (isMac && ready) createWindow();
    return;
  }
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
  const createdWindow = new BrowserWindow({
    title: "Slopify", width: 1320, height: 900, minWidth: 420, minHeight: 600,
    backgroundColor: "#08080c", show: false,
    icon,
    // The app draws its own title bar; Windows and Linux keep their native buttons over it.
    titleBarStyle: "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: 11 } }
      : { titleBarOverlay: { color: "#00000000", symbolColor: "#c8c8d4", height: TITLE_BAR } }),
    // Playback (crossfades, the next song) keeps time while the window is hidden in the tray.
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  window = createdWindow;
  // Like Discord: closing the window keeps Slopify playing in the tray, unless Settings turns that off.
  createdWindow.on("close", (event) => {
    if (exiting || !background?.keepInTray()) return;
    event.preventDefault();
    createdWindow.hide();
    background.hidden();
  });
  createdWindow.on("closed", () => {
    window = undefined;
    linksReady = false;
    if (isMac) background?.clearNowPlaying();
  });
  // The page always counts as visible (backgroundThrottling: false), so it's told when the window really is,
  // and stops drawing while it's minimised or in the tray.
  const tellShown = () => {
    if (!createdWindow.isDestroyed()) createdWindow.webContents.send("desktop:window-shown", createdWindow.isVisible() && !createdWindow.isMinimized());
  };
  for (const event of ["show", "hide", "minimize", "restore"]) createdWindow.on(event, tellShown);
  if (!isMac) createdWindow.setMenuBarVisibility(false);
  createdWindow.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  createdWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); external(url); }
  });
  // Only Slopify's own page may copy to the clipboard (its Copy buttons); everything else is refused.
  createdWindow.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    let own = false;
    try {
      own = new URL(details.requestingUrl).origin === origin;
    } catch { /* No page: refused. */ }
    callback(own && permission === "clipboard-sanitized-write");
  });
  createdWindow.once("ready-to-show", () => createdWindow.show());
  createdWindow.loadURL(origin).catch(fail);
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
      FFMPEG_BIN: fromCheckout
        ? require("ffmpeg-static")
        : path.join(process.resourcesPath, "bin", isWindows ? "ffmpeg.exe" : "ffmpeg")
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

/*
 * Slopify links (slopify://p/<share id>): a shared playlist's web page opens
 * them and the OS delivers the link to the registered copy. On macOS this is
 * the packaged app, whose Info.plist declares the scheme. If started by a link,
 * the app first offers it to another open copy (see link-handoff.cjs).
 */
const LINK = /^slopify:\/\/p\/([a-z0-9]{16})\/?$/i;
if (!fromCheckout) app.setAsDefaultProtocolClient("slopify");
else if (!isMac) app.setAsDefaultProtocolClient("slopify", process.execPath, [path.resolve(app.getAppPath())]);
/** A link that came before the page was ready for it. */
let pendingLink = null;
let linksReady = false;
const linkIn = (argv) => argv.find((arg) => typeof arg === "string" && arg.toLowerCase().startsWith("slopify://"));
/** Opens a slopify:// link in this copy; false if it isn't one. */
function openLink(url) {
  const match = LINK.exec(url || "");
  if (!match || exiting) return false;
  const link = { type: "shared", id: match[1].toLowerCase() };
  if (linksReady && window) {
    window.webContents.send("desktop:link", link);
    showWindow();
    // A link handed over from another copy arrives in the background, and Windows won't let a
    // background app take focus; going always-on-top and back still lifts the window above the browser.
    if (isWindows && !window.isAlwaysOnTop()) {
      window.setAlwaysOnTop(true);
      window.setAlwaysOnTop(false);
    }
  } else {
    pendingLink = link;
    if (!window) showWindow();
  }
  return true;
}
/** The profiles of the other copies a link could be meant for: the installed one and the checkouts' shared one. */
function otherProfiles() {
  const same = (a, b) => isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
  return ["Slopify", "Slopify Dev"].map((name) => path.join(app.getPath("appData"), name))
    .filter((dir) => !same(path.resolve(dir), path.resolve(profileDir)));
}
ipcMain.handle("desktop:window-shown", () => Boolean(window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()));
ipcMain.handle("desktop:links-ready", (event) => {
  if (event.sender !== window?.webContents) return;
  linksReady = true;
  if (pendingLink) event.sender.send("desktop:link", pendingLink);
  pendingLink = null;
});
// macOS hands links over this way, even before the app is ready.
app.on("open-url", (event, url) => {
  event.preventDefault();
  openLink(url);
});
openLink(linkIn(process.argv));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    showWindow();
    openLink(linkIn(argv));
  });
  app.on("activate", showWindow);
  app.whenReady().then(async () => {
    // Started by a link while another Slopify is open: that one shows it, and this one isn't needed.
    // Links clicked meanwhile (second-instance, open-url) replace pendingLink, so they're handed over too.
    let handed = false;
    while (pendingLink) {
      const link = pendingLink;
      if (!(await handOff(otherProfiles(), `slopify://p/${link.id}`))) break;
      handed = true;
      if (pendingLink === link) pendingLink = null;
    }
    if (handed && !pendingLink) {
      app.quit();
      return;
    }
    listenForLinks(profileDir, openLink);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SLOPIFY_DESKTOP_PORT.");
    await startBackend();
    if (exiting) return;
    if (isMac && fromCheckout) app.dock?.setIcon(icon);
    createWindow();
    background = startBackground({ getWindow: () => window, show: showWindow, log });
    startUpdates(() => window, log, { isPlaying: () => Boolean(background?.isPlaying()) });
  }).catch(fail);
}
app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
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
