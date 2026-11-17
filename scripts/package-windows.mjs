import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { build, Platform, Arch } from "electron-builder";
import { buildVersion, keepBuild, releaseDir, root, updateRepo as readUpdateRepo } from "./release-build.mjs";

const require = createRequire(import.meta.url);
const { values: flags } = parseArgs({ options: { dir: { type: "boolean" }, portable: { type: "boolean" }, channel: { type: "string", default: "stable" }, version: { type: "string" } } });
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build Windows x64 releases on a Windows x64 machine (the bundled FFmpeg must match).");
if (flags.dir && flags.portable) throw new Error("Choose one of --dir or --portable.");
await fs.access(path.join(root, "dist/index.html"));

// package.json's version, or a nightly's own (see release-build.mjs). --version gives the
// one the release workflow chose, so the Windows and Mac builds of a release match.
const now = new Date();
const version = await buildVersion(flags.channel, flags.version, now);
const updateRepo = await readUpdateRepo();

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
  await keepBuild({ platform: "windows", stage, version, channel: flags.channel, updateRepo, builtAt: now });
}
// Retain --dir output for local QA; completed distribution builds need only
// their final files. This path was created by this invocation with mkdtemp.
if (!flags.dir) await fs.rm(stage, { recursive: true, force: true }).catch(() => {
  console.warn(`Build complete. Temporary files are still in ${stage}.`);
});
