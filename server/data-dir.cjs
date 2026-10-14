/*
 * Where a checkout (a clone or worktree, not an installed copy) keeps its library.
 *
 * Normally every checkout shares one library, beside the desktop app's dev
 * profile (%APPDATA%\Slopify Dev\library on Windows), so songs saved while
 * running one worktree are there in the next. The first time, the shared
 * library starts as a copy of this checkout's own data/ folder, if that has songs.
 *
 * Isolated mode (SLOPIFY_ISOLATED_DATA=1; `npm run desktop:isolated`,
 * `npm run dev:isolated`, `node server/main.mjs --isolated`) uses this
 * checkout's data/ folder instead, and a desktop profile of its own, for
 * trying changes without touching your real library.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function appDataDir() {
  if (process.platform === "win32") return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

const isIsolated = () => /^(1|true|yes)$/i.test(process.env.SLOPIFY_ISOLATED_DATA || "");

/** The desktop profile checkouts share (an installed copy uses "Slopify" instead). */
const sharedProfileDir = () => path.join(appDataDir(), "Slopify Dev");

function songCount(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, "songs.json"), "utf8"));
    const songs = Array.isArray(value) ? value : value?.songs;
    return Array.isArray(songs) ? songs.length : 0;
  } catch {
    return 0;
  }
}

/** Starts the shared library from this checkout's own, once, so no songs go missing. */
function seed(shared, own) {
  if (fs.existsSync(path.join(shared, "songs.json")) || !songCount(own)) return;
  const skip = ["previews", "desktop-profile"].map((name) => path.join(own, name));
  fs.mkdirSync(shared, { recursive: true });
  fs.cpSync(own, shared, { recursive: true, filter: (src) => !skip.some((dir) => src === dir || src.startsWith(dir + path.sep)) });
  console.log(`Started the shared library (${shared}) from ${own}.`);
}

/** The library folder for the checkout at `appDir`. */
function checkoutDataDir(appDir) {
  const own = path.join(appDir, "data");
  if (isIsolated()) return own;
  const shared = path.join(sharedProfileDir(), "library");
  seed(shared, own);
  return shared;
}

/** The desktop app's profile (window state, local storage) for the checkout at `appDir`. */
function checkoutProfileDir(appDir) {
  return isIsolated() ? path.join(appDir, "data", "desktop-profile") : sharedProfileDir();
}

module.exports = { checkoutDataDir, checkoutProfileDir, isIsolated };
