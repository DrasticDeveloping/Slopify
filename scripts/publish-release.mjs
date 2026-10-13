import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Publishes the last Windows build (release/last-build.json) as a GitHub release
 * on its updateRepo, which installed copies of Slopify check for updates.
 * Nightly builds become pre-releases; stable builds become the latest release.
 * Uses the GitHub CLI: signed in with `gh auth login`, or GH_TOKEN in CI.
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseDir = path.join(root, "release");
let build;
try {
  build = JSON.parse(await fs.readFile(path.join(releaseDir, "last-build.json"), "utf8"));
} catch {
  fail("There's no build to publish. Run `npm run dist:win:nightly` or `npm run dist:win` first.");
}
if (!build.updateRepo) fail("This build has no update repo. Set updateRepo in release.config.json (or SLOPIFY_UPDATE_REPO), then build again.");
if (!/^[a-f0-9]{40}$/.test(build.commit || "")) fail("Publish only a clean Git build with a recorded source commit. Commit your changes and build again.");
if (!build.files.some((name) => /^(latest|nightly)\.yml$/.test(name))) fail("This build has no update file (latest.yml or nightly.yml). Build it again with an update repo set.");

const tag = `v${build.version}`;
const nightly = build.channel === "nightly";
const gh = (...args) => execFileSync("gh", args, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true,
  env: { ...process.env, ...(process.env.GITHUB_TOKEN && !process.env.GH_TOKEN ? { GH_TOKEN: process.env.GITHUB_TOKEN } : {}) },
});
try {
  gh("--version");
} catch {
  fail("Publishing needs the GitHub CLI (https://cli.github.com).");
}
const exists = (() => {
  try {
    gh("release", "view", tag, "--repo", build.updateRepo, "--json", "tagName");
    return true;
  } catch {
    return false;
  }
})();
if (exists) fail(`${tag} is already published on ${build.updateRepo}. Build again for a new version.`);
// --target creates a missing tag; it does not move an existing tag. Refuse one
// rather than accidentally publishing assets built from another commit.
const refs = JSON.parse(gh("api", `repos/${build.updateRepo}/git/matching-refs/tags/${tag}`));
if (refs.some((ref) => ref.ref === `refs/tags/${tag}`)) fail(`${tag} already exists. Choose a new version before publishing.`);

const notes = [
  nightly ? "A nightly build of Slopify: the newest changes, before they reach Stable." : "Slopify release.",
  "",
  "Download the **Setup** EXE to install Slopify (it updates itself), or the **Portable** EXE to run it without installing.",
  "",
  // The scheduled nightly build reads this to skip a build when nothing has changed.
  build.commit ? `Source: ${build.commit}` : "",
].join("\n");
const files = build.files.map((name) => path.join(releaseDir, build.folder, name));
gh("release", "create", tag, ...files,
  "--repo", build.updateRepo,
  "--target", build.commit,
  "--title", nightly ? `Slopify Nightly ${build.version}` : `Slopify ${build.version}`,
  "--notes", notes,
  ...(nightly ? ["--prerelease", "--latest=false"] : ["--latest"]));
console.log(`Published ${tag} to https://github.com/${build.updateRepo}/releases/tag/${tag}`);

function fail(message) {
  console.error(`Couldn't publish: ${message}`);
  process.exit(1);
}
