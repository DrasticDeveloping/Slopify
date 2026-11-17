// Checks which apps a release changes (desktop/platforms.cjs) offline: node --test scripts/test-platforms.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { changesPlatform, platformsMarker, platformsOfFile, platformsOfLabels, platformsOfNotes, platformsOfRange } = require("../desktop/platforms.cjs");

test("Files belong to the phone app, the Windows app, both, or neither", () => {
  const cases = {
    "ios/App/App/SceneDelegate.swift": ["mobile"],
    "mobile/node/start.mjs": ["mobile"],
    "capacitor.config.json": ["mobile"],
    "scripts/ios-sim.mjs": ["mobile"],
    "desktop/updates.cjs": ["desktop"],
    "electron-builder.json": ["desktop"],
    "scripts/package-windows.mjs": ["desktop"],
    "src/App.tsx": ["desktop", "mobile"],
    "server/api.mjs": ["desktop", "mobile"],
    "package.json": ["desktop", "mobile"],
    "scripts/build-pwa.mjs": ["desktop", "mobile"],
    "docs/cloud.md": [],
    "README.md": [],
    "cloud/src/index.ts": [],
    ".github/workflows/release.yml": [],
    "scripts/test-changelog.cjs": [],
    "scripts/publish-release.mjs": [],
  };
  for (const [file, platforms] of Object.entries(cases)) assert.deepEqual(platformsOfFile(file), platforms, file);
});

test("Labels limit a pull request to one app; other labels say nothing", () => {
  assert.deepEqual(platformsOfLabels(["Mobile only", "bug"]), ["mobile"]);
  assert.deepEqual(platformsOfLabels(["desktop only"]), ["desktop"]);
  assert.deepEqual(platformsOfLabels(["mobile only", "desktop only"]), ["desktop", "mobile"]);
  assert.equal(platformsOfLabels(["bug"]), null);
  assert.equal(platformsOfLabels([]), null);
});

test("The notes' record reads back; notes without one count for both apps", () => {
  for (const platforms of [[], ["mobile"], ["desktop"], ["desktop", "mobile"]]) {
    assert.deepEqual(platformsOfNotes(`Intro\n\n${platformsMarker(platforms)}\n\n### What's changed`), platforms);
  }
  assert.equal(platformsMarker([]), "<!-- Platforms: none -->");
  assert.equal(platformsOfNotes("A nightly build of Slopify."), null);
  assert.equal(changesPlatform("A nightly build of Slopify.", "desktop"), true);
  assert.equal(changesPlatform("<!-- Platforms: mobile -->", "desktop"), false);
  assert.equal(changesPlatform("<!-- Platforms: mobile -->", "mobile"), true);
  assert.equal(changesPlatform("<!-- Platforms: none -->", "mobile"), false);
});

/** A commit as GitHub's compare API lists it. */
const commit = (sha, parents, message) => ({ sha, parents: parents.map((p) => ({ sha: p })), commit: { message } });

/** master since the previous release (p0): #10 (phone files), #11 (labelled), a direct commit, #12 (docs). */
function history() {
  const commits = [
    commit("b1", ["p0"], "Phone swipe"),
    commit("m1", ["p0", "b1"], "Merge pull request #10 from o/phone"),
    commit("b2", ["m1"], "Phone layout in shared CSS"),
    commit("m2", ["m1", "b2"], "Merge pull request #11 from o/layout\n\nPhone layout"),
    commit("d1", ["m2"], "Fix the README"),
    commit("b3", ["d1"], "Docs"),
    commit("m3", ["d1", "b3"], "Merge pull request #12 from o/docs"),
  ];
  const files = { "p0...m1": ["ios/App/App/SceneDelegate.swift"], "m1...m2": ["src/styles/app.css", "desktop/main.cjs"], "m2...d1": ["README.md"], "d1...m3": ["docs/cloud.md"] };
  const labels = { 10: ["bug"], 11: ["mobile only"], 12: [] };
  const asked = [];
  return {
    commits, asked,
    filesOf: async (parent, sha) => { asked.push(`${parent}...${sha}`); return files[`${parent}...${sha}`]; },
    labelsOf: async (number) => labels[number],
  };
}

test("A range counts each merge as its whole change, and a label overrides the files", async () => {
  const h = history();
  assert.deepEqual(await platformsOfRange({ ...h, head: "m3" }), ["mobile"]);
  // The labelled pull request's files weren't needed; the branch commits never are.
  assert.deepEqual(h.asked, ["d1...m3", "m2...d1", "p0...m1"]);
});

test("A squashed pull request's label is read from its (#N)", async () => {
  const h = history();
  const commits = [commit("s1", ["p0"], "Phone layout (#11)"), commit("s2", ["s1"], "Tweak docs")];
  const files = { "s1...s2": ["docs/x.md"] };
  assert.deepEqual(await platformsOfRange({ ...h, commits, head: "s2", filesOf: async (p, s) => files[`${p}...${s}`] }), ["mobile"]);
});

test("A change with too many files to list, or no range at all, counts for both apps", async () => {
  const h = history();
  assert.equal(await platformsOfRange({ ...h, head: "m3", filesOf: async () => null }), null);
  assert.equal(await platformsOfRange({ ...h, head: "unknown" }), null);
  // Only docs since the previous release: neither app.
  assert.deepEqual(await platformsOfRange({ ...h, commits: h.commits.slice(4), head: "m3" }), []);
});
