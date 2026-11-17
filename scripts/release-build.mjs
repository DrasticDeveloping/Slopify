import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/*
 * What the Windows and Mac packaging scripts (package-windows.mjs, package-mac.mjs)
 * share: the version a build gets, where it updates from, and how the finished files
 * are kept in release/<version>/ for sharing and publishing (publish-release.mjs).
 * Only Node's own modules, so the release workflow can ask it for a version before
 * anything is installed:
 *
 *   node scripts/release-build.mjs version --channel nightly
 */

export const root = fileURLToPath(new URL("../", import.meta.url));
export const releaseDir = path.join(root, "release");

/** Each platform's files in release/<version>/; the rest of the folder belongs to the other platform. */
export const PLATFORMS = {
  windows: {
    name: "Windows",
    /** The update files and installers the builder makes. */
    built: (name) => /\.(exe|exe\.blockmap)$/.test(name) || /^(latest|nightly)\.yml$/.test(name),
    /** The files people download, which get a .sha256 beside them. */
    shared: (name) => name.endsWith(".exe"),
    updateFile: (name) => /^(latest|nightly)\.yml$/.test(name),
  },
  mac: {
    name: "macOS",
    built: (name) => /\.(dmg|zip)(\.blockmap)?$/.test(name) || /^(latest|nightly)-mac\.yml$/.test(name),
    shared: (name) => name.endsWith(".dmg"),
    updateFile: (name) => /^(latest|nightly)-mac\.yml$/.test(name),
  },
};
export const manifestName = (platform) => `build-${platform}.json`;

/**
 * Stable builds use package.json's version. Nightly builds are numbered like T3 Code's
 * nightlies: the next patch version, then the UTC date and time of the build, so each
 * sorts after the previous nightly and before that stable release (0.0.2-nightly.20261012.930).
 * The release workflow works one out once and builds every platform with it (`override`),
 * so a release's Windows and Mac files share one version.
 */
export async function buildVersion(channel, override, now = new Date()) {
  if (!["stable", "nightly"].includes(channel)) throw new Error("--channel is stable or nightly.");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const [major, minor, patch] = pkg.version.replace(/[-+].*$/, "").split(".").map(Number);
  if (override) {
    const nightly = /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d{1,4}\.\d{1,5}$/.test(override);
    if (channel === "nightly" ? !nightly : override !== pkg.version) {
      throw new Error(`--version ${override} isn't a ${channel} version of this source (package.json says ${pkg.version}).`);
    }
    return override;
  }
  const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
  return channel === "nightly"
    ? `${major}.${minor}.${patch + 1}-nightly.${stamp}.${now.getUTCHours() * 100 + now.getUTCMinutes()}.${now.getUTCSeconds() * 1000 + now.getUTCMilliseconds()}`
    : pkg.version;
}

/**
 * Where installed copies look for updates: a GitHub repo ("owner/name") with public
 * releases. Unset, the build works normally but never checks for updates.
 */
export async function updateRepo() {
  const releaseConfig = JSON.parse(await fs.readFile(path.join(root, "release.config.json"), "utf8"));
  const repo = process.env.SLOPIFY_UPDATE_REPO || releaseConfig.updateRepo || "";
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`updateRepo should look like "owner/name", not "${repo}".`);
  return repo;
}

/**
 * Copies a finished build's files from the builder's `stage` folder into release/<version>/,
 * replacing only this platform's files there, with a checksum beside each file to share and
 * a record of the build (build-<platform>.json). release/last-build.json points at it.
 */
export async function keepBuild({ platform, stage, version, channel, updateRepo: repo, builtAt }) {
  const kind = PLATFORMS[platform];
  const versionDir = path.join(releaseDir, version);
  await fs.mkdir(versionDir, { recursive: true });
  const ours = (name) => kind.built(name) || (kind.shared(name.replace(/\.sha256$/, "")) && name.endsWith(".sha256")) || name === manifestName(platform);
  for (const name of await fs.readdir(versionDir)) {
    if (ours(name)) await fs.rm(path.join(versionDir, name), { force: true });
  }
  const files = [];
  for (const name of (await fs.readdir(stage)).filter(kind.built).sort()) {
    const destination = path.join(versionDir, name);
    await fs.copyFile(path.join(stage, name), destination);
    files.push(name);
    if (kind.shared(name)) {
      const hash = createHash("sha256").update(await fs.readFile(destination)).digest("hex");
      await fs.writeFile(destination + ".sha256", `${hash}  ${name}\n`);
      files.push(name + ".sha256");
      console.log(`Ready to share: ${destination}`);
    }
  }
  let commit = null;
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
    commit = git("rev-parse", "HEAD") + (git("status", "--porcelain") ? "-dirty" : "");
  } catch { /* Not a Git checkout. */ }
  const manifest = { platform, version, channel, updateRepo: repo || null, commit, builtAt: builtAt.toISOString(), files };
  await fs.writeFile(path.join(versionDir, manifestName(platform)), JSON.stringify(manifest, null, 2) + "\n");
  await fs.writeFile(path.join(releaseDir, "last-build.json"), JSON.stringify({ ...manifest, folder: version }, null, 2) + "\n");
  if (!repo) console.log("release.config.json has no updateRepo, so this build won't check for updates.");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { channel: { type: "string", default: "stable" } } });
  if (positionals[0] !== "version") throw new Error("Usage: node scripts/release-build.mjs version --channel stable|nightly");
  console.log(await buildVersion(values.channel));
}
