const { app, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/*
 * Updates for the desktop app, with two channels like T3 Code's nightly builds:
 * "stable" follows normal releases, "nightly" also takes the frequent nightly builds
 * (versions like 0.0.2-nightly.20261012.930). Builds come from GitHub Releases on
 * the repo set when the app was packaged (release.config.json); a build without
 * one has no app-update.yml and never checks.
 *
 * The installed app checks as it starts and installs what it finds straight away,
 * then reopens (unless music is already playing by then). Updates found later
 * download in the background and install on restart, or on the next start. The
 * portable EXE can't replace itself, so it links to the download.
 */

const CHECK_EVERY = 4 * 60 * 60_000;
/** How long the "Installing" banner shows before the app closes to install. */
const INSTALL_NOTICE = 1500;
/** An install that hasn't closed the app by then has failed. */
const INSTALL_TIMEOUT = 30_000;
const settingsFile = () => path.join(app.getPath("userData"), "updates.json");
const feedFile = () => path.join(process.resourcesPath, "app-update.yml");
const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);

const defaultChannel = () => (/-nightly\./.test(app.getVersion()) ? "nightly" : "stable");

function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    if (saved && typeof saved === "object") return saved;
  } catch { /* First run, or an unreadable file. */ }
  return {};
}
const saveSettings = (patch) => fs.writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }));

function readChannel() {
  const { channel } = readSettings();
  if (channel === "beta") return "nightly"; // Saved by earlier development builds.
  if (channel === "stable" || channel === "nightly") return channel;
  return defaultChannel(); // Use the build's own channel.
}

/** The GitHub repo this build was packaged to update from, or null. */
function readFeed() {
  try {
    const text = fs.readFileSync(feedFile(), "utf8");
    const field = (name) => new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(text)?.[1];
    return field("provider") === "github" ? { owner: field("owner"), repo: field("repo") } : null;
  } catch {
    return null;
  }
}

function startUpdates(getWindow, log, { isPlaying = () => false } = {}) {
  const feed = app.isPackaged ? readFeed() : null;
  // Test override: a folder of release files served over HTTP (see docs/windows-releases.md).
  const testFeed = feed && process.env.SLOPIFY_UPDATE_FEED_URL;
  /** status: unsupported | idle | checking | none | available | downloading | ready | installing | error */
  let state = {
    version: app.getVersion(),
    channel: readChannel(),
    status: feed ? "idle" : "unsupported",
    portable,
    available: null,
    progress: 0,
    error: null,
    checkedAt: null,
  };
  const send = (patch) => {
    state = { ...state, ...patch };
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("updates:state", state);
  };

  ipcMain.handle("updates:get", () => state);
  if (!feed) {
    // Nothing to check or install: every request just reports that.
    for (const name of ["updates:check", "updates:set-channel", "updates:install"]) ipcMain.handle(name, () => state);
    return;
  }
  ipcMain.handle("updates:check", () => check("manual"));
  ipcMain.handle("updates:set-channel", (_event, channel) => setChannel(channel));
  ipcMain.handle("updates:install", () => install());

  // Loaded only in packaged builds that have a feed.
  const { autoUpdater } = require("electron-updater");
  autoUpdater.logger = { info: (m) => log(`[updates] ${m}\n`), warn: (m) => log(`[updates] ${m}\n`), error: (m) => log(`[updates] ${m}\n`), debug() {} };
  // Downloads start only for a check made on the channel chosen now (see update-available).
  autoUpdater.autoDownload = false;
  // Turned on only once a download for the chosen channel is waiting (see update-downloaded).
  autoUpdater.autoInstallOnAppQuit = false;
  let checking = null;
  /** Bumped by every channel change, so a check made before it can't speak for the new channel. */
  let generation = 0;
  /** The generation the check under way was made for. */
  let checkingFor = 0;
  const stale = () => checkingFor !== generation;
  /** The channel the current download was found on. */
  let downloadingFor = null;
  /** The check under way is the one made at startup, so what it finds installs as soon as it's downloaded. */
  let installWhenReady = false;

  const useChannel = (channel) => {
    // "nightly" reads nightly.yml from the newest release (a nightly or a stable one),
    // "latest" reads latest.yml from the newest stable release.
    autoUpdater.channel = channel === "nightly" ? "nightly" : "latest";
    autoUpdater.allowPrerelease = channel === "nightly";
    // Nightly follows the newest release, even one numbered lower. A nightly on Stable goes
    // back to the newest stable release, even an older version, for as long as it's still
    // a nightly (a failed check or a restart doesn't lose this).
    autoUpdater.allowDowngrade = channel === "nightly" || /-/.test(app.getVersion());
  };
  if (testFeed) autoUpdater.setFeedURL({ provider: "generic", url: testFeed });
  else autoUpdater.setFeedURL({ provider: "custom", ...feed, updateProvider: require("./nightly-provider.cjs").NightlyGitHubProvider });
  useChannel(state.channel);

  autoUpdater.on("checking-for-update", () => send({ status: "checking", error: null }));
  autoUpdater.on("update-not-available", () => {
    if (!stale()) send({ status: "none", available: null, checkedAt: Date.now() });
  });
  autoUpdater.on("update-available", (info) => {
    // Found for the channel chosen before a switch: ignored, and checked again for the new one.
    if (stale()) return;
    downloadingFor = state.channel;
    send({ status: portable ? "available" : "downloading", available: info.version, progress: 0, checkedAt: Date.now() });
    if (!portable) autoUpdater.downloadUpdate().catch(() => undefined); // Failures arrive as "error".
  });
  autoUpdater.on("download-progress", (p) => send({ status: "downloading", progress: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => {
    // A download from before a channel switch (a nightly, after choosing Stable) is never installed.
    const wanted = downloadingFor === state.channel && (state.channel === "nightly" || !/-/.test(info.version));
    autoUpdater.autoInstallOnAppQuit = wanted;
    const now = installWhenReady;
    installWhenReady = false;
    if (!wanted) return send({ status: "idle", available: null, progress: 0 });
    // Found at startup: install it now (after a moment's notice; see autoInstall).
    if (now && !isPlaying() && readSettings().autoInstalled !== info.version) {
      send({ status: "installing", available: info.version, progress: 100 });
      setTimeout(() => autoInstall(info.version), INSTALL_NOTICE);
      return;
    }
    send({ status: "ready", available: info.version, progress: 100 });
  });
  autoUpdater.on("error", (error) => {
    log(`[updates] ${error?.stack || error}\n`);
    // An install that failed is offered again, to retry with Restart.
    if (state.status === "installing") return send({ status: "ready", progress: 100 });
    // A download already waiting to install is still good, and a check for the old channel doesn't matter.
    if (state.status !== "ready" && !(checking && stale())) send({ status: "error", error: friendlyError(error) });
  });

  /**
   * Installs the update found at startup, unless music started during the notice (then
   * it waits for a restart). Each version is tried once, so an install that fails (and
   * reopens the old version) doesn't go round again; it stays offered instead.
   */
  function autoInstall(version) {
    if (state.status !== "installing") return;
    const offer = () => send({ status: "ready", available: version, progress: 100 });
    if (isPlaying()) return offer();
    try {
      saveSettings({ autoInstalled: version });
    } catch (error) {
      log(`[updates] couldn't note the install: ${error}\n`);
      return offer();
    }
    install();
    // Still running a while later: the install never started, so it's offered again.
    setTimeout(() => { if (state.status === "installing") offer(); }, INSTALL_TIMEOUT).unref?.();
  }

  function check(reason) {
    if (state.status === "ready" || state.status === "downloading" || state.status === "installing") return state;
    if (!checking) {
      checkingFor = generation;
      installWhenReady = reason === "startup" && !portable;
      checking = autoUpdater.checkForUpdates()
        .catch(() => undefined) // Reported through the "error" event.
        .finally(() => { checking = null; });
    }
    log(`[updates] checking (${reason}, ${state.channel})\n`);
    return checking.then(() => state);
  }

  async function setChannel(channel) {
    if (channel !== "stable" && channel !== "nightly") throw new Error("Unknown update channel.");
    if (channel === state.channel) return state;
    // Switching mid-download would race the old channel's download (the UI disables this too).
    if (state.status === "downloading" || state.status === "installing") throw new Error("Wait for the download to finish before changing channel.");
    saveSettings({ channel });
    generation++;
    installWhenReady = false;
    useChannel(channel);
    // An update downloaded for the old channel no longer installs on quit.
    autoUpdater.autoInstallOnAppQuit = false;
    send({ channel, status: "idle", available: null, error: null });
    // A check still under way is for the old channel: let it finish unheard, then check this one.
    if (checking) await checking;
    await check("channel");
    return state;
  }

  function install() {
    if (portable && state.available) {
      void shell.openExternal(testFeed || `https://github.com/${feed.owner}/${feed.repo}/releases/tag/v${state.available}`);
      return state;
    }
    if (state.status !== "ready" && state.status !== "installing") return state;
    // Installs silently, with no setup wizard, then reopens the app. Quitting lets
    // before-quit stop the music server first.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return state;
  }

  setTimeout(() => void check("startup"), 3_000).unref?.();
  setInterval(() => void check("poll"), CHECK_EVERY).unref?.();
}

function friendlyError(error) {
  const text = String(error?.message || error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|net::/i.test(text)) return "Couldn't reach the update server. Check your connection.";
  if (/404|No published versions|Cannot find .*\.yml/i.test(text)) return "No releases are published for this channel yet.";
  return "Couldn't check for updates. Details are in desktop.log.";
}

module.exports = { startUpdates };
