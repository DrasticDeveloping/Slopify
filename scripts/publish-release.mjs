import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
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
  ...changesSincePreviousRelease(),
  // The scheduled nightly build reads this to skip a build when nothing has changed.
  build.commit ? `Source: ${build.commit}` : "",
].join("\n");
const files = build.files.map((name) => path.join(releaseDir, build.folder, name));
// From a file: long notes would overrun Windows' command-line limit.
const notesDir = await fs.mkdtemp(path.join(os.tmpdir(), "slopify-notes-"));
const notesFile = path.join(notesDir, "notes.md");
await fs.writeFile(notesFile, notes);
try {
  gh("release", "create", tag, ...files,
    "--repo", build.updateRepo,
    "--target", build.commit,
    "--title", nightly ? `Slopify Nightly ${build.version}` : `Slopify ${build.version}`,
    "--notes-file", notesFile,
    ...(nightly ? ["--prerelease", "--latest=false"] : ["--latest"]));
} finally {
  await fs.rm(notesDir, { recursive: true, force: true });
}
console.log(`Published ${tag} to https://github.com/${build.updateRepo}/releases/tag/${tag}`);

/*
 * The commits since the previous release on the same channel (the last Nightly for a
 * Nightly, the last Stable for a Stable), as Markdown lines for the release notes.
 * Merge commits are left out; a commit that was a pull request's last commit is
 * marked with that pull request. Asks GitHub rather than local Git, because CI
 * checkouts are shallow. If GitHub can't answer, the notes go out without the list.
 */
function changesSincePreviousRelease() {
  const shown = 100;
  const longest = 200;
  try {
    const releases = JSON.parse(gh("release", "list", "--repo", build.updateRepo, "--limit", "1000",
      "--exclude-drafts", "--json", "tagName,isPrerelease"));
    const previous = releases.find((release) => nightly
      ? release.isPrerelease && release.tagName.includes("-nightly.")
      : !release.isPrerelease)?.tagName;
    if (!previous) return [];
    // GitHub lists the commits oldest first, 100 to a page. Read up to 1,000 of them.
    const comparePage = (page) => JSON.parse(gh("api",
      `repos/${build.updateRepo}/compare/${encodeURIComponent(previous)}...${build.commit}?per_page=100&page=${page}`));
    const first = comparePage(1);
    if (first.status !== "ahead" || !first.total_commits) return [];
    const commits = [...first.commits];
    for (let page = 2; commits.length < first.total_commits && page <= 10; page++) {
      const next = comparePage(page).commits;
      if (!next.length) break;
      commits.push(...next);
    }
    // A pull request's merge commit has the pull request's last commit as its second parent.
    const pullRequests = new Map();
    for (const commit of commits) {
      const number = commit.parents.length > 1 && commit.commit.message.match(/^Merge pull request #(\d+)/)?.[1];
      if (number) pullRequests.set(commit.parents[1].sha, number);
    }
    // Commits past the first 1,000 are newer than those read, so a long gap lists none rather than old ones.
    const changes = commits.length < first.total_commits ? [] : commits.filter((commit) => commit.parents.length < 2).reverse();
    const lines = changes.slice(0, shown).map((commit) => {
      let subject = commit.commit.message.split("\n")[0].trim();
      if (subject.length > longest) subject = `${subject.slice(0, longest - 1)}…`;
      const pullRequest = pullRequests.get(commit.sha);
      const alreadyNamed = pullRequest && subject.includes(`#${pullRequest}`);
      return `- ${subject}${pullRequest && !alreadyNamed ? ` (#${pullRequest})` : ""} ${commit.sha.slice(0, 7)}`;
    });
    const more = changes.length - lines.length;
    return [
      `### What's changed since ${previous}`,
      "",
      ...(lines.length ? lines : [`- ${first.total_commits} commits; see the full changelog.`]),
      ...(more > 0 ? [`- …and ${more} more (see the full changelog)`] : []),
      "",
      `**Full changelog:** https://github.com/${build.updateRepo}/compare/${previous}...${build.commit.slice(0, 12)}`,
      "",
    ];
  } catch {
    console.warn("Couldn't list the changes since the previous release; publishing without them.");
    return [];
  }
}

function fail(message) {
  console.error(`Couldn't publish: ${message}`);
  process.exit(1);
}
