import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Arch, build, Platform } from "electron-builder";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { values: { dir } } = parseArgs({ options: { dir: { type: "boolean" } } });
const arch = process.arch;
if (process.platform !== "darwin" || (arch !== "arm64" && arch !== "x64")) {
  throw new Error("Build on a Mac with native Apple silicon or Intel Node.js so the bundled FFmpeg matches.");
}

await fs.access(path.join(root, "dist/index.html"));
await fs.access(path.join(root, "node_modules/ffmpeg-static/ffmpeg"), constants.X_OK);

const { version } = require("../package.json");
// Use the pinned Electron installed for this architecture, alongside its license files.
const electronDist = path.resolve(path.dirname(require("electron")), "../../..");

await build({
  projectDir: root,
  config: {
    electronDist,
    directories: { output: path.join("release", "macos", version, arch) }
  },
  targets: Platform.MAC.createTarget([dir ? "dir" : "dmg"], Arch[arch]),
  publish: "never"
});
