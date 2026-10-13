const { app, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

/*
 * Updates for the desktop app, with two channels like T3 Code's nightly builds:
 * "stable" follows normal releases, "nightly" also takes the frequent nightly builds
 * (versions like 2.0.1-nightly.20261012.930). Builds come from GitHub Releases on
 * the repo set when the app was packaged (release.config.json); a build without
 * one has no app-update.yml and never checks.
 *
 * The installed app downloads updates in the background and installs them on
 * restart. The portable EXE can't replace itself, so it links to the download.
 */

const CHECK_EVERY = 4 * 60 * 60_000;
const settingsFile = () => path.join(app.getPath("userData"), "updates.json");
const feedFile = () => path.join(process.resourcesPath, "app-update.yml");
const portable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);

const defaultChannel = () => (/-nightly\./.test(app.getVersion()) ? "nightly" : "stable");

function readChannel() {
  try {
    const { channel } = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    if (channel === "beta") return "nightly"; // Saved by earlier development builds.
    if (channel === "stable" || channel === "nightly") return channel;
  } catch { /* First run, or an unreadable file: use the build's own channel. */ }
  return defaultChannel();
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

function startUpdates(getWindow, log) {
  const feed = app.isPackaged ? readFeed() : null;
  // Test override: a folder of release files served over HTTP (see docs/windows-releases.md).
  const testFeed = feed && process.env.SLOPIFY_UPDATE_FEED_URL;
  /** status: unsupported | idle | checking | none | available | downloading | ready | error */
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
  autoUpdater.autoDownload = !portable;
  // Turned on only once a download for the chosen channel is waiting (see update-downloaded).
  autoUpdater.autoInstallOnAppQuit = false;
  let checking = null;
  /** The channel the current download was found on. */
  let downloadingFor = null;

  const useChannel = (channel) => {
    // "nightly" reads nightly.yml from the newest release (a nightly or a stable one),
    // "latest" reads latest.yml from the newest stable release.
    autoUpdater.channel = channel === "nightly" ? "nightly" : "latest";
    autoUpdater.allowPrerelease = channel === "nightly";
    autoUpdater.allowDowngrade = false;
  };
  if (testFeed) autoUpdater.setFeedURL({ provider: "generic", url: testFeed });
  else autoUpdater.setFeedURL({ provider: "custom", ...feed, updateProvider: require("./nightly-provider.cjs").NightlyGitHubProvider });
  useChannel(state.channel);

  autoUpdater.on("checking-for-update", () => send({ status: "checking", error: null }));
  autoUpdater.on("update-not-available", () => send({ status: "none", available: null, checkedAt: Date.now() }));
  autoUpdater.on("update-available", (info) => {
    downloadingFor = state.channel;
    send({ status: portable ? "available" : "downloading", available: info.version, progress: 0, checkedAt: Date.now() });
  });
  autoUpdater.on("download-progress", (p) => send({ status: "downloading", progress: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => {
    // A download from before a channel switch (a nightly, after choosing Stable) is never installed.
    const wanted = downloadingFor === state.channel && (state.channel === "nightly" || !/-/.test(info.version));
    autoUpdater.autoInstallOnAppQuit = wanted;
    if (wanted) send({ status: "ready", available: info.version, progress: 100 });
    else send({ status: "idle", available: null, progress: 0 });
  });
  autoUpdater.on("error", (error) => {
    log(`[updates] ${error?.stack || error}\n`);
    // A download already waiting to install is still good.
    if (state.status !== "ready") send({ status: "error", error: friendlyError(error) });
  });

  function check(reason) {
    if (state.status === "ready" || state.status === "downloading") return state;
    checking ??= autoUpdater.checkForUpdates()
      .catch(() => undefined) // Reported through the "error" event.
      .finally(() => { checking = null; });
    log(`[updates] checking (${reason}, ${state.channel})\n`);
    return checking.then(() => state);
  }

  async function setChannel(channel) {
    if (channel !== "stable" && channel !== "nightly") throw new Error("Unknown update channel.");
    if (channel === state.channel) return state;
    // Switching mid-download would race the old channel's download (the UI disables this too).
    if (state.status === "downloading") throw new Error("Wait for the download to finish before changing channel.");
    fs.writeFileSync(settingsFile(), JSON.stringify({ channel }));
    useChannel(channel);
    // Leaving nightly goes back to the newest stable release, even if it's an older version.
    autoUpdater.allowDowngrade = channel === "stable";
    // An update downloaded for the old channel no longer installs on quit.
    autoUpdater.autoInstallOnAppQuit = false;
    send({ channel, status: "idle", available: null, error: null });
    try {
      await check("channel");
    } finally {
      autoUpdater.allowDowngrade = false;
    }
    return state;
  }

  function install() {
    if (portable && state.available) {
      void shell.openExternal(testFeed || `https://github.com/${feed.owner}/${feed.repo}/releases/tag/v${state.available}`);
      return state;
    }
    if (state.status !== "ready") return state;
    // Installs silently, with no setup wizard, then reopens the app. Quitting lets
    // before-quit stop the music server first.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return state;
  }

  setTimeout(() => void check("startup"), 10_000).unref?.();
  setInterval(() => void check("poll"), CHECK_EVERY).unref?.();
}

function friendlyError(error) {
  const text = String(error?.message || error);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|net::/i.test(text)) return "Couldn't reach the update server. Check your connection.";
  if (/404|No published versions|Cannot find .*\.yml/i.test(text)) return "No releases are published for this channel yet.";
  return "Couldn't check for updates. Details are in desktop.log.";
}

module.exports = { startUpdates };
