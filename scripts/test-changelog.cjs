// Checks What's new (desktop/changelog.cjs) offline: node --test scripts/test-changelog.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildChangelog, loadChangelog, parseNotes } = require("../desktop/changelog.cjs");

/** Release notes as scripts/publish-release.mjs writes them. */
const notes = (previous, lines, extra = []) => [
  "A nightly build of Slopify: the newest changes, before they reach Stable.",
  "",
  "Download the **Setup** EXE to install Slopify (it updates itself), or the **Portable** EXE to run it without installing.",
  "",
  `### What's changed since ${previous}`,
  "",
  ...lines,
  ...extra,
  "",
  `**Full changelog:** https://github.com/o/r/compare/${previous}...abcdef123456`,
  "",
  "Source: abcdef1234567890",
].join("\n");

const release = (tag, minutesAgo, body, extra = {}) => ({
  tag_name: tag, draft: false, body,
  published_at: new Date(Date.UTC(2026, 10, 15, 12) - minutesAgo * 60_000).toISOString(),
  ...extra,
});

test("Notes become changes with their pull requests; hashes, headings and links are dropped", () => {
  const { changes, more } = parseNotes(notes("v0.0.4-nightly.1", [
    "- Right-click songs in \"Recommended for this playlist\" (#45) 1c7f44f",
    "- Fix a typo in Settings 9a8b7c6",
    "- Song menus: #41 already named here 5a16c89",
  ]));
  assert.deepEqual(changes, [
    { text: "Right-click songs in \"Recommended for this playlist\"", pr: 45 },
    { text: "Fix a typo in Settings", pr: null },
    { text: "Song menus: #41 already named here", pr: null },
  ]);
  assert.equal(more, 0);
});

test("Counted-only changes are kept as a number", () => {
  assert.deepEqual(parseNotes(notes("v1", ["- A (#1) 1111111"], ["- …and 12 more (see the full changelog)"])), { changes: [{ text: "A", pr: 1 }], more: 12 });
  assert.deepEqual(parseNotes(notes("v1", ["- 140 commits; see the full changelog."])), { changes: [], more: 140 });
});

test("Notes without a change list have no changes", () => {
  assert.deepEqual(parseNotes("Slopify release.\n\n- Download the Setup EXE"), { changes: [], more: 0 });
  assert.deepEqual(parseNotes(null), { changes: [], more: 0 });
});

test("Every nightly since the installed one is listed, newest first", () => {
  const releases = [
    release("v0.0.4-nightly.20261114.621.1", 30 * 60, notes("x", ["- Installed already (#30) 3333333"])),
    release("v0.0.4-nightly.20261115.17.1", 12 * 60, notes("x", ["- B (#43) 2222222", "- C (#42) 2222223"])),
    release("v0.0.4-nightly.20261115.638.1", 6 * 60, notes("x", ["- A (#45) 1111111"])),
    release("v0.0.3", 40 * 60, notes("x", ["- A stable change (#20) 4444444"])),
    release("v0.0.5-beta.1", 60, notes("x", ["- Not a nightly (#99) 5555555"])),
    release("v0.0.4-nightly.20261115.900.1", 3 * 60, notes("x", ["- Draft (#50) 6666666"]), { draft: true }),
  ];
  const log = buildChangelog(releases, { current: "0.0.4-nightly.20261114.621.1", target: "0.0.4-nightly.20261115.638.1", owner: "o", repo: "r" });
  assert.deepEqual(log.builds.map((b) => b.version), ["0.0.4-nightly.20261115.638.1", "0.0.4-nightly.20261115.17.1"]);
  assert.equal(log.total, 3);
  assert.equal(log.complete, true);
  assert.equal(log.url, "https://github.com/o/r/compare/v0.0.4-nightly.20261114.621.1...v0.0.4-nightly.20261115.638.1");
  assert.equal(log.repoUrl, "https://github.com/o/r");
});

test("A stable update lists stable releases only, so nightly changes aren't counted twice", () => {
  const releases = [
    release("v0.0.3", 50 * 60, notes("v0.0.2", ["- Old (#10) 1111111"])),
    release("v0.0.4-nightly.20261114.621.1", 30 * 60, notes("x", ["- Nightly (#30) 2222222"])),
    release("v0.0.4", 10, notes("v0.0.3", ["- New in stable (#30) 2222222", "- Also (#31) 3333333"])),
  ];
  const log = buildChangelog(releases, { current: "0.0.3", target: "0.0.4", owner: "o", repo: "r" });
  assert.deepEqual(log.builds.map((b) => b.version), ["0.0.4"]);
  assert.equal(log.total, 2);
  assert.equal(log.builds[0].nightly, false);
});

test("An installed nightly that isn't listed is bounded by its build time", () => {
  const releases = [
    release("v0.0.4-nightly.20261113.100.1", 4 * 24 * 60, notes("x", ["- Before the installed build (#20) 3333333"])),
    release("v0.0.4-nightly.20261115.17.1", 12 * 60, notes("x", ["- B (#43) 2222222"])),
    release("v0.0.4-nightly.20261115.638.1", 6 * 60, notes("x", ["- A (#45) 1111111"])),
  ];
  // Built 2026-11-14 06:21 UTC; its own release is gone from the list.
  const log = buildChangelog(releases, { current: "0.0.4-nightly.20261114.621.1", target: "0.0.4-nightly.20261115.638.1", owner: "o", repo: "r" });
  assert.deepEqual(log.builds.map((b) => b.version), ["0.0.4-nightly.20261115.638.1", "0.0.4-nightly.20261115.17.1"]);
  assert.equal(log.complete, false);
  assert.equal(log.url, "https://github.com/o/r/releases/tag/v0.0.4-nightly.20261115.638.1");
});

test("With no bound at all (an unlisted stable install), only the update itself is shown", () => {
  const releases = [
    release("v0.0.4-nightly.20261115.17.1", 12 * 60, notes("x", ["- B (#43) 2222222"])),
    release("v0.0.4-nightly.20261115.638.1", 6 * 60, notes("x", ["- A (#45) 1111111"])),
  ];
  const log = buildChangelog(releases, { current: "0.0.3", target: "0.0.4-nightly.20261115.638.1", owner: "o", repo: "r" });
  assert.deepEqual(log.builds.map((b) => b.version), ["0.0.4-nightly.20261115.638.1"]);
  assert.equal(log.complete, false);
});

test("A build in between whose notes have no list is left out and marks the changelog incomplete", () => {
  const releases = [
    release("v0.0.4-nightly.20261114.621.1", 30 * 60, ""),
    release("v0.0.4-nightly.20261115.17.1", 12 * 60, "A nightly build of Slopify."),
    release("v0.0.4-nightly.20261115.638.1", 6 * 60, notes("x", ["- A (#45) 1111111"])),
  ];
  const log = buildChangelog(releases, { current: "0.0.4-nightly.20261114.621.1", target: "0.0.4-nightly.20261115.638.1", owner: "o", repo: "r" });
  assert.deepEqual(log.builds.map((b) => b.version), ["0.0.4-nightly.20261115.638.1"]);
  assert.equal(log.complete, false);
});

test("An update whose own notes have no list has no changelog, even if older builds do", () => {
  const releases = [
    release("v0.0.4-nightly.20261114.621.1", 30 * 60, ""),
    release("v0.0.4-nightly.20261115.17.1", 12 * 60, notes("x", ["- B (#43) 2222222"])),
    release("v0.0.4-nightly.20261115.638.1", 6 * 60, "A nightly build of Slopify."),
  ];
  assert.equal(buildChangelog(releases, { current: "0.0.4-nightly.20261114.621.1", target: "0.0.4-nightly.20261115.638.1", owner: "o", repo: "r" }), null);
});

test("An update that isn't in the list has no changelog", () => {
  assert.equal(buildChangelog([release("v0.0.3", 10, notes("x", ["- A (#1) 1111111"]))], { current: "0.0.2", target: "0.0.4", owner: "o", repo: "r" }), null);
});

test("Loading asks GitHub's releases API, and a refusal is an error", async () => {
  const asked = [];
  const ok = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => [release("v0.0.4", 10, notes("v0.0.3", ["- A (#1) 1111111"]))] };
  };
  const log = await loadChangelog({ owner: "o", repo: "r", current: "0.0.3", target: "0.0.4", fetch: ok });
  assert.equal(log.total, 1);
  assert.match(asked[0], /^https:\/\/api\.github\.com\/repos\/o\/r\/releases\?per_page=\d+$/);
  await assert.rejects(loadChangelog({ owner: "o", repo: "r", current: "0.0.3", target: "0.0.4", fetch: async () => ({ ok: false, status: 403 }) }), /403/);
});
