const { app, net } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);

/*
 * Installing updates on a Mac. electron-updater installs them through Squirrel.Mac,
 * which only takes apps signed with an Apple Developer ID, and Slopify's Mac builds
 * are signed ad hoc (scripts/package-mac.mjs). So updates.cjs still finds updates
 * with electron-updater, and this does what Squirrel would: it downloads the update's
 * zip for this kind of Mac, checks it against the SHA-512 in the release's update file
 * (latest-mac.yml or nightly-mac.yml), unpacks it and checks its signature. Once
 * Slopify has quit, a small shell script puts it in place of the app and, when asked,
 * opens it again.
 */

/** Where an update is unpacked, in Slopify's own folder; cleared each time Slopify starts. */
const stageDir = () => path.join(app.getPath("userData"), "update");
/** Written by the install script when it couldn't install an update: that version's version number. */
const failedFile = () => path.join(app.getPath("userData"), "update-failed");
/** A download that receives nothing for this long has stalled, and is given up (to be tried again). */
const STALLED = 60_000;
/** Slopify.app, the bundle that's running. */
const bundlePath = () => path.resolve(process.execPath, "../../..");

/*
 * Waits for Slopify to quit (for up to a minute), moves the running app aside, moves the
 * update into its place, and deletes the old one; if the update can't be moved in, the old
 * app goes back. Then opens whichever is there, if asked. When the update wasn't installed,
 * it notes the version in `failed`, so Slopify offers it as a download instead of trying
 * the same install at every start.
 */
const SWAP = `
pid="$1" app="$2" next="$3" old="$4" reopen="$5" version="$6" failed="$7"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 300 ]; then
    echo "[updates] Slopify didn't quit, so $version wasn't installed"
    echo "$version" > "$failed"
    exit 1
  fi
  sleep 0.2
done
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$next" "$app"; then
    rm -rf "$old"
    echo "[updates] installed $version"
  else
    mv "$old" "$app"
    echo "[updates] couldn't move $version into place, so the old version stays"
    echo "$version" > "$failed"
  fi
else
  echo "[updates] couldn't move the old version aside, so $version wasn't installed"
  echo "$version" > "$failed"
fi
if [ "$reopen" = 1 ]; then open "$app"; fi
`;

/**
 * Whether this copy can replace itself: a packaged app in a folder this user can change.
 * Not when it's still on its disk image, or run from Downloads before being moved (macOS
 * then runs it from a hidden read-only copy), or in /Applications for an account that
 * isn't an administrator. Nor on another disk than Slopify's own folder, where the
 * update is unpacked: moving it across would be a slow copy, not one quick step.
 */
function canInstall() {
  const bundle = bundlePath();
  if (!app.isPackaged || !bundle.endsWith(".app") || bundle.includes("/AppTranslocation/")) return false;
  try {
    fs.accessSync(bundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return fs.statSync(path.dirname(bundle)).dev === fs.statSync(app.getPath("userData")).dev;
  } catch {
    return false;
  }
}

/**
 * The update's zip for this Mac: the arm64 one on Apple silicon (even when this is the
 * Intel app running under Rosetta, so it moves to the native one), the Intel one otherwise.
 */
function zipFor(files) {
  const zips = (files || []).filter((file) => /\.zip$/i.test(file?.url || ""));
  const arm = process.arch === "arm64" || app.runningUnderARM64Translation;
  const intel = zips.find((file) => !/arm64/i.test(file.url)) || null;
  return arm ? zips.find((file) => /arm64/i.test(file.url)) || intel : intel;
}

const bundleId = async (bundle) =>
  (await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")])).stdout.trim();

function createMacInstaller(log) {
  /** The update unpacked and checked, waiting to be put in place. */
  let ready = null;
  let installOnQuit = false;
  let reopen = false;
  let swapping = false;
  // An update unpacked by the version before this one (installed, or never put in place),
  // and the version an install failed for, if one did.
  try {
    fs.rmSync(stageDir(), { recursive: true, force: true });
  } catch (error) {
    log(`[updates] couldn't clear ${stageDir()}: ${error}\n`);
  }
  // Kept until that version runs (downloaded by hand), so it isn't tried again at every start.
  let failed = null;
  try {
    failed = fs.readFileSync(failedFile(), "utf8").trim() || null;
    if (failed === app.getVersion()) {
      fs.rmSync(failedFile(), { force: true });
      failed = null;
    } else if (failed) {
      log(`[updates] installing ${failed} didn't work, so it's offered as a download\n`);
    }
  } catch { /* None did. */ }

  /** Downloads and unpacks `info`'s update, from release files under `base` (ending in "/"). */
  async function download(info, base, onProgress) {
    const file = zipFor(info.files);
    if (!file) throw new Error(`Slopify ${info.version} has no download for this Mac.`);
    if (!file.sha512) throw new Error(`Slopify ${info.version}'s update file has no checksum.`);
    const url = /^https?:\/\//i.test(file.url) ? file.url : new URL(file.url, base).href;
    ready = null;
    const dir = path.join(stageDir(), info.version);
    fs.rmSync(stageDir(), { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, "update.zip");
    log(`[updates] downloading ${url}\n`);

    // Given up when nothing arrives for a minute, so a stalled connection can't hold up updates.
    const abort = new AbortController();
    let stalled;
    const waiting = () => {
      clearTimeout(stalled);
      stalled = setTimeout(() => abort.abort(new Error(`The download of Slopify ${info.version} stalled.`)), STALLED);
    };
    waiting();
    const out = fs.createWriteStream(zip);
    const hash = crypto.createHash("sha512");
    try {
      const response = await net.fetch(url, { cache: "no-store", signal: abort.signal });
      if (!response.ok || !response.body) throw new Error(`Couldn't download ${url} (HTTP ${response.status}).`);
      const total = Number(response.headers.get("content-length")) || file.size || 0;
      let received = 0;
      let shown = -1;
      for await (const chunk of response.body) {
        waiting();
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await once(out, "drain");
        const percent = total ? Math.min(99, Math.floor((received * 100) / total)) : 0;
        if (percent !== shown) onProgress((shown = percent));
      }
    } catch (error) {
      throw abort.signal.aborted ? abort.signal.reason : error;
    } finally {
      clearTimeout(stalled);
      await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    }
    if (hash.digest("base64") !== file.sha512) throw new Error(`The download of Slopify ${info.version} doesn't match its checksum.`);

    const unpacked = path.join(dir, "unpacked");
    await run("/usr/bin/ditto", ["-x", "-k", zip, unpacked]);
    fs.rmSync(zip, { force: true });
    const name = fs.readdirSync(unpacked).find((entry) => entry.endsWith(".app"));
    if (!name) throw new Error(`The download of Slopify ${info.version} has no app in it.`);
    const next = path.join(unpacked, name);
    if ((await bundleId(next)) !== (await bundleId(bundlePath()))) throw new Error(`The download of Slopify ${info.version} is a different app.`);
    // Its signature covers every file in it, so this also catches a damaged or altered download.
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", next]);
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", next]).catch(() => undefined);
    ready = { app: next, version: info.version };
    log(`[updates] ${info.version} is ready to install\n`);
  }

  /** Starts the script that puts the update in place once Slopify has quit. */
  function swap() {
    if (swapping || !ready) return;
    swapping = true;
    let output = "ignore";
    try {
      output = fs.openSync(path.join(app.getPath("userData"), "desktop.log"), "a");
    } catch { /* Installs without a log. */ }
    const old = path.join(stageDir(), "previous.app");
    spawn("/bin/sh", ["-c", SWAP, "slopify-update", String(process.pid), bundlePath(), ready.app, old, reopen ? "1" : "0", ready.version, failedFile()], {
      detached: true, stdio: ["ignore", output, output],
    }).unref();
    log(`[updates] installing ${ready.version} once Slopify quits${reopen ? ", then reopening it" : ""}\n`);
  }
  // Last thing before quitting: main.cjs's before-quit has stopped the music server by then.
  app.on("will-quit", () => {
    if (installOnQuit || reopen) swap();
  });

  return {
    canInstall,
    /** Whether installing `version` failed before, so it's downloaded by hand instead. */
    failedBefore: (version) => version === failed,
    download,
    /** Whether quitting installs the downloaded update (like electron-updater's autoInstallOnAppQuit). */
    setInstallOnQuit(on) {
      installOnQuit = on;
    },
    /** Quits, installs the downloaded update and reopens Slopify. */
    quitAndInstall() {
      if (!ready) return;
      reopen = true;
      app.quit();
    },
  };
}

module.exports = { createMacInstaller, zipFor };
