import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { build, Platform, Arch } from "electron-builder";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { values: flags } = parseArgs({ options: { dir: { type: "boolean" }, portable: { type: "boolean" }, channel: { type: "string", default: "stable" } } });
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build Windows x64 releases on a Windows x64 machine (the bundled FFmpeg must match).");
if (flags.dir && flags.portable) throw new Error("Choose one of --dir or --portable.");
if (!["stable", "nightly"].includes(flags.channel)) throw new Error("--channel is stable or nightly.");
await fs.access(path.join(root, "dist/index.html"));

// Stable builds use package.json's version. Nightly builds are numbered like T3 Code's
// nightlies: the next patch version, then the UTC date and time of the build, so each
// sorts after the previous nightly and before that stable release (2.0.1-nightly.20261012.930).
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const [major, minor, patch] = pkg.version.replace(/[-+].*$/, "").split(".").map(Number);
const now = new Date();
const stamp = now.toISOString().slice(0, 10).replaceAll("-", "");
const version = flags.channel === "nightly"
  ? `${major}.${minor}.${patch + 1}-nightly.${stamp}.${now.getUTCHours() * 100 + now.getUTCMinutes()}.${now.getUTCSeconds() * 1000 + now.getUTCMilliseconds()}`
  : pkg.version;

// Where installed copies look for updates: a GitHub repo ("owner/name") with public
// releases. Unset, the build works normally but never checks for updates.
const releaseConfig = JSON.parse(await fs.readFile(path.join(root, "release.config.json"), "utf8"));
const updateRepo = process.env.SLOPIFY_UPDATE_REPO || releaseConfig.updateRepo || "";
if (updateRepo && !/^[\w.-]+\/[\w.-]+$/.test(updateRepo)) throw new Error(`updateRepo should look like "owner/name", not "${updateRepo}".`);

const resources = path.join(root, "build/desktop");
await fs.mkdir(resources, { recursive: true });
const pngFile = path.join(resources, "icon.png");
execFileSync(require("ffmpeg-static"), ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(root, "public/icons/icon-512.png"), "-vf", "scale=256:256", "-frames:v", "1", pngFile], { windowsHide: true });
const png = await fs.readFile(pngFile);
// Windows ICO directory containing the app's existing logo as a 256px PNG.
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await fs.writeFile(path.join(resources, "icon.ico"), Buffer.concat([header, png]));

const targets = flags.dir ? ["dir"] : flags.portable ? ["portable"] : ["portable", "nsis"];
// Use Electron's pinned local runtime. This also avoids the builder's Windows
// download/extraction rename, which can collide with file scanning locks.
const config = JSON.parse(await fs.readFile(path.join(root, "electron-builder.json"), "utf8"));
config.electronDist = path.dirname(require("electron"));
config.extraMetadata = { version };
if (updateRepo) {
  const [owner, repo] = updateRepo.split("/");
  // Writes app-update.yml into the app, and beside the installer the channel's update
  // file: nightly.yml for a nightly, latest.yml for stable (the builder doesn't infer it for GitHub).
  config.publish = [{ provider: "github", owner, repo, channel: flags.channel === "nightly" ? "nightly" : "latest" }];
}
// A server can be using this executable while we build. Reading it as a stream
// avoids Windows CopyFile's sharing conflict with that running binary.
config.afterPack = async ({ appOutDir }) => {
  const bin = path.join(appOutDir, "resources/bin");
  await fs.mkdir(bin, { recursive: true });
  await pipeline(createReadStream(path.join(root, "node_modules/ffmpeg-static/ffmpeg.exe")), createWriteStream(path.join(bin, "ffmpeg.exe")));
};
// Build into a fresh directory: an old extracted EXE may still be held open
// by a running app or Windows scanning. Finished files go to release/ below.
const stage = await fs.mkdtemp(path.join(os.tmpdir(), "slopify-build-"));
config.directories.output = stage;
await build({
  projectDir: root, config,
  targets: Platform.WINDOWS.createTarget(targets, Arch.x64), publish: "never"
});
const releaseDir = path.join(root, "release");
await fs.mkdir(releaseDir, { recursive: true });
// GitHub doesn't generate other channels automatically. Stable must also be
// offered to Nightly users, including the GitHub and generic test feeds.
if (updateRepo && flags.channel === "stable" && !flags.dir && !flags.portable) {
  await fs.copyFile(path.join(stage, "latest.yml"), path.join(stage, "nightly.yml"));
}
if (flags.dir) {
  console.log(`Unpacked app: ${path.join(stage, "win-unpacked/Slopify.exe")}`);
  await fs.writeFile(path.join(releaseDir, "unpacked-path.txt"), path.join(stage, "win-unpacked/Slopify.exe") + "\n");
} else {
  // Each version gets its own folder: the EXEs to send, plus the files a release
  // needs for updates (latest.yml or nightly.yml, and the installer's .blockmap).
  const versionDir = path.join(releaseDir, version);
  await fs.rm(versionDir, { recursive: true, force: true });
  await fs.mkdir(versionDir);
  const built = (await fs.readdir(stage)).filter((name) => /\.(exe|blockmap)$/.test(name) || /^(latest|nightly)\.yml$/.test(name));
  const files = [];
  for (const name of built) {
    const destination = path.join(versionDir, name);
    await fs.copyFile(path.join(stage, name), destination);
    files.push(name);
    if (name.endsWith(".exe")) {
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
  const manifest = { version, channel: flags.channel, updateRepo: updateRepo || null, commit, builtAt: now.toISOString(), files };
  await fs.writeFile(path.join(versionDir, "build.json"), JSON.stringify(manifest, null, 2) + "\n");
  await fs.writeFile(path.join(releaseDir, "last-build.json"), JSON.stringify({ ...manifest, folder: version }, null, 2) + "\n");
  if (!updateRepo) console.log("release.config.json has no updateRepo, so this build won't check for updates.");
}
// Retain --dir output for local QA; completed distribution builds need only
// their final files. This path was created by this invocation with mkdtemp.
if (!flags.dir) await fs.rm(stage, { recursive: true, force: true }).catch(() => {
  console.warn(`Build complete. Temporary files are still in ${stage}.`);
});
