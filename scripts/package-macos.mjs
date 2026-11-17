import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Arch, build, Platform } from "electron-builder";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) {
  throw new Error("Build the macOS app on an Apple silicon or Intel Mac.");
}

const root = fileURLToPath(new URL("../", import.meta.url));
// FFmpeg is installed for the build machine. Refuse stale dependencies from another Mac.
execFileSync("lipo", ["node_modules/ffmpeg-static/ffmpeg", "-verify_arch", process.arch === "arm64" ? "arm64" : "x86_64"], { cwd: root });
await build({
  projectDir: root,
  config: {
    extends: "./electron-builder.json",
    directories: { output: "release/macos" },
  },
  targets: Platform.MAC.createTarget(["dmg"], Arch[process.arch]),
  publish: "never",
});
