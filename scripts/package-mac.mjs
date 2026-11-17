import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parseArgs } from "node:util";
import { build, Platform, Arch } from "electron-builder";
import { buildVersion, keepBuild, releaseDir, root, updateRepo as readUpdateRepo } from "./release-build.mjs";

/*
 * Builds the Mac app: a DMG to install from and a zip for updates, for Apple silicon
 * (arm64) and Intel (x64) Macs, with the music server and FFmpeg inside. Like the
 * Windows build (package-windows.mjs), finished files go to release/<version>/.
 *
 *   node scripts/package-mac.mjs [--channel stable|nightly] [--version <v>] [--arch arm64,x64] [--dir]
 *
 * (npm run dist:mac, dist:mac:nightly, and dist:mac:unpacked for a quick test build of the app alone.)
 *
 * Without an Apple Developer ID (CSC_LINK or CSC_NAME, which electron-builder reads), the
 * app is signed ad hoc: it runs on any Mac once allowed in Privacy & Security, and it
 * updates itself (desktop/mac-update.cjs). With one, electron-builder signs it with that,
 * and notarizes it when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are set.
 */

const require = createRequire(import.meta.url);
const { values: flags } = parseArgs({ options: {
  dir: { type: "boolean" }, arch: { type: "string" },
  channel: { type: "string", default: "stable" }, version: { type: "string" },
} });
if (process.platform !== "darwin") throw new Error("Build the Mac app on a Mac (it uses Apple's iconutil, codesign and hdiutil).");
// Releases have both; a quick unpacked build (--dir) just this Mac's.
const archs = [...new Set((flags.arch || (flags.dir ? process.arch : "arm64,x64")).split(",").map((a) => a.trim()))];
if (!archs.length || archs.some((a) => a !== "arm64" && a !== "x64")) throw new Error("--arch is arm64, x64, or both (arm64,x64).");
await fs.access(path.join(root, "dist/index.html"));

const now = new Date();
const version = await buildVersion(flags.channel, flags.version, now);
const updateRepo = await readUpdateRepo();
const resources = path.join(root, "build/desktop");
await fs.mkdir(resources, { recursive: true });

// The app icon, from the picture drawn on Apple's icon grid (scripts/render-mac-icons.cjs).
const iconset = path.join(resources, "icon.iconset");
await fs.rm(iconset, { recursive: true, force: true });
await fs.mkdir(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = String(size * scale);
    const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
    execFileSync("sips", ["-z", px, px, path.join(root, "assets/icon-mac.png"), "--out", path.join(iconset, name)], { stdio: "ignore" });
  }
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(resources, "icon.icns")]);

/*
 * FFmpeg for each kind of Mac. npm installed the one for this Mac; the other comes
 * from the same ffmpeg-static release, kept in build/desktop/ between builds.
 */
const ffmpegDir = path.dirname(require.resolve("ffmpeg-static/package.json"));
const ffmpegRelease = process.env.FFMPEG_BINARY_RELEASE || require("ffmpeg-static/package.json")["ffmpeg-static"]["binary-release-tag"];
const machArch = { arm64: "arm64", x64: "x86_64" };
function checkArch(binary, arch) {
  const kind = execFileSync("file", ["-b", binary], { encoding: "utf8" });
  if (!kind.includes("Mach-O") || !kind.includes(machArch[arch])) throw new Error(`${binary} isn't FFmpeg for ${arch} Macs (${kind.trim()}).`);
}
async function download(url, file, gunzip = false) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download ${url} (${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), ...(gunzip ? [createGunzip()] : []), createWriteStream(file + ".part"));
  await fs.rename(file + ".part", file);
}
async function ffmpegFor(arch) {
  const local = { binary: path.join(ffmpegDir, "ffmpeg"), license: path.join(ffmpegDir, "ffmpeg.LICENSE"), readme: path.join(ffmpegDir, "ffmpeg.README") };
  if (arch === process.arch && existsSync(local.binary)) {
    checkArch(local.binary, arch);
    return local;
  }
  const dir = path.join(resources, `ffmpeg-darwin-${arch}-${ffmpegRelease}`);
  const files = { binary: path.join(dir, "ffmpeg"), license: path.join(dir, "ffmpeg.LICENSE"), readme: path.join(dir, "ffmpeg.README") };
  if (!existsSync(files.binary)) {
    console.log(`Downloading FFmpeg for ${arch} Macs (ffmpeg-static ${ffmpegRelease})…`);
    await fs.mkdir(dir, { recursive: true });
    const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${ffmpegRelease}`;
    await download(`${base}/darwin-${arch}.LICENSE`, files.license);
    await download(`${base}/darwin-${arch}.README`, files.readme);
    await download(`${base}/ffmpeg-darwin-${arch}.gz`, files.binary, true);
    await fs.chmod(files.binary, 0o755);
  }
  checkArch(files.binary, arch);
  return files;
}
const ffmpeg = Object.fromEntries(await Promise.all(archs.map(async (arch) => [arch, await ffmpegFor(arch)])));

const config = JSON.parse(await fs.readFile(path.join(root, "electron-builder.json"), "utf8"));
config.extraMetadata = { version };
if (!process.env.CSC_LINK && !process.env.CSC_NAME) {
  // No Developer ID: signed ad hoc, which Apple silicon needs to run it at all. (The hardened
  // runtime is only for notarizing, and would refuse Electron's ad hoc signed frameworks.)
  config.mac = { ...config.mac, identity: "-", hardenedRuntime: false };
  console.log("No Developer ID (CSC_LINK or CSC_NAME): signing ad hoc.");
}
if (updateRepo) {
  const [owner, repo] = updateRepo.split("/");
  // Writes app-update.yml into the app, and beside the zips the channel's update
  // file: nightly-mac.yml for a nightly, latest-mac.yml for stable.
  config.publish = [{ provider: "github", owner, repo, channel: flags.channel === "nightly" ? "nightly" : "latest" }];
}
// FFmpeg for the Mac being packaged, beside the app's resources (main.cjs's FFMPEG_BIN). This
// runs before signing, so the signature covers it too.
config.afterPack = async ({ appOutDir, arch, packager }) => {
  const files = ffmpeg[Arch[arch]];
  if (!files) throw new Error(`No FFmpeg for ${Arch[arch]}.`);
  const contents = path.join(appOutDir, `${packager.appInfo.productFilename}.app/Contents/Resources`);
  await fs.mkdir(path.join(contents, "bin"), { recursive: true });
  await fs.copyFile(files.binary, path.join(contents, "bin/ffmpeg"));
  await fs.chmod(path.join(contents, "bin/ffmpeg"), 0o755);
  await fs.mkdir(path.join(contents, "licenses"), { recursive: true });
  await fs.copyFile(files.license, path.join(contents, "licenses/FFmpeg-LICENSE.txt"));
  await fs.copyFile(files.readme, path.join(contents, "licenses/FFmpeg-build-and-source.txt"));
};

const stage = await fs.mkdtemp(path.join(os.tmpdir(), "slopify-mac-build-"));
config.directories.output = stage;
await build({
  projectDir: root, config,
  targets: Platform.MAC.createTarget(flags.dir ? ["dir"] : ["dmg", "zip"], ...archs.map((a) => Arch[a])), publish: "never",
});

// Each app is checked as built: intact signature, and FFmpeg that runs on its Mac.
const apps = archs.map((arch) => path.join(stage, arch === "x64" ? "mac" : `mac-${arch}`, "Slopify.app"));
for (const app of apps) {
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", path.join(app, "Contents/Resources/bin/ffmpeg")], { stdio: "inherit" });
}

await fs.mkdir(releaseDir, { recursive: true });
if (flags.dir) {
  for (const app of apps) console.log(`Unpacked app: ${app}`);
  await fs.writeFile(path.join(releaseDir, "unpacked-path.txt"), apps.join("\n") + "\n");
} else {
  // Stable is offered to Nightly users too (see package-windows.mjs).
  if (updateRepo && flags.channel === "stable") await fs.copyFile(path.join(stage, "latest-mac.yml"), path.join(stage, "nightly-mac.yml"));
  await keepBuild({ platform: "mac", stage, version, channel: flags.channel, updateRepo, builtAt: now });
  await fs.rm(stage, { recursive: true, force: true }).catch(() => console.warn(`Build complete. Temporary files are still in ${stage}.`));
}
