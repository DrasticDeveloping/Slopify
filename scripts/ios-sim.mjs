#!/usr/bin/env node
/*
 * Builds the iPhone app for the iOS Simulator on a Mac reached over SSH, and
 * installs and starts it there. For working from a Windows or Linux computer:
 * the Mac needs Xcode and key-based SSH (no password prompt), but not Node.
 *
 *   npm run build && npx cap sync ios
 *   node scripts/ios-sim.mjs --mac you@192.168.1.13 [--device "iPhone 17 Pro"]
 *
 * SLOPIFY_MAC can stand in for --mac. The app carries Slopify's music server
 * (server/) and web app (dist/) as ios/App/App/nodejs-project, run by
 * nodejs-mobile, which is downloaded to the Mac once. The project is copied to
 * ~/slopify-build there; the simulator is started if it isn't running.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildNodeProject } from "./ios-node-project.mjs";

const NODE_MOBILE = "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-ios.zip";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { mac: { type: "string" }, device: { type: "string" } } });
const mac = values.mac ?? process.env.SLOPIFY_MAC;
const device = values.device ?? "iPhone 17 Pro";
if (!mac) fail("Say which Mac to build on: --mac user@host (or SLOPIFY_MAC).");
if (!/^[\w.-]+@[\w.-]+$/.test(mac)) fail(`"${mac}" isn't a user@host address.`);
if (!/^[\w .()-]+$/.test(device)) fail(`"${device}" isn't a simulator name.`);
if (!fs.existsSync(path.join(root, "dist", "index.html"))) fail("Build the web app first: npm run build.");

// What the app's Node runs: the music server and the built web app it serves.
const { rewritten } = buildNodeProject(root);
console.log(`Packed the music server for the app (${rewritten} Unicode patterns rewritten).`);

const ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", mac];
const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

console.log(`Copying the iOS project to ${mac}…`);
const tar = spawnSync("tar", ["-czf", "-", "ios"], { cwd: root, maxBuffer: 1 << 30 });
if (tar.status !== 0) fail(`Couldn't pack ios/: ${tar.stderr}`);
run("ssh", [...ssh, "rm -rf ~/slopify-build/ios && mkdir -p ~/slopify-build && tar -xzf - -C ~/slopify-build"], tar.stdout);

console.log(`Building for the ${device} simulator…`);
const app = "~/slopify-build/ios/App/build/Build/Products/Debug-iphonesimulator/App.app";
run("ssh", [...ssh, [
  "set -e",
  "mkdir -p ~/slopify-build/vendor",
  `[ -d ~/slopify-build/vendor/NodeMobile.xcframework ] || (cd ~/slopify-build/vendor && curl -fsSL -o nodejs-mobile.zip ${quote(NODE_MOBILE)} && unzip -q nodejs-mobile.zip && rm nodejs-mobile.zip)`,
  "cp -R ~/slopify-build/vendor/NodeMobile.xcframework ~/slopify-build/ios/App/",
  "cd ~/slopify-build/ios/App",
  `xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator -destination ${quote(`platform=iOS Simulator,name=${device}`)} -derivedDataPath build CODE_SIGNING_ALLOWED=NO build -quiet`,
  `udid=$(xcrun simctl list devices available | grep -F ${quote(`${device} (`)} | head -1 | sed -E 's/.*\\(([0-9A-F-]{36})\\).*/\\1/')`,
  `[ -n "$udid" ] || { echo "No simulator called ${device}"; exit 1; }`,
  "xcrun simctl boot \"$udid\" 2>/dev/null || true",
  // Shows the simulator window when someone is signed in on the Mac; it runs either way.
  "open \"$(xcode-select -p)/Applications/Simulator.app\" 2>/dev/null || true",
  "xcrun simctl terminate \"$udid\" mov.unblocked.slopify 2>/dev/null || true",
  `xcrun simctl install "$udid" ${app}`,
  "xcrun simctl launch \"$udid\" mov.unblocked.slopify",
  "echo \"Running on $udid\"",
].join("\n")]);

function run(command, args, input) {
  const result = spawnSync(command, args, { input, stdio: [input ? "pipe" : "inherit", "inherit", "inherit"], maxBuffer: 1 << 30 });
  if (result.status !== 0) fail(`${path.basename(command)} failed (exit ${result.status}).`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
