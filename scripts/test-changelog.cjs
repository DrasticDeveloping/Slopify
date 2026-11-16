// Checks What's new (desktop/changelog.cjs) offline: node --test scripts/test-changelog.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildChangelog, loadChangelog, parseNotes, withoutReverts } = require("../desktop/changelog.cjs");

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
    { text: "Right-click songs in \"Recommended for this playlist\"", pr: 45, sha: "1c7f44f" },
    { text: "Fix a typo in Settings", pr: null, sha: "9a8b7c6" },
    { text: "Song menus: #41 already named here", pr: null, sha: "5a16c89" },
  ]);
  assert.equal(more, 0);
});

test("Counted-only changes are kept as a number", () => {
  const counted = parseNotes(notes("v1", ["- A (#1) 1111111"], ["- …and 12 more (see the full changelog)"]));
  assert.deepEqual([counted.changes, counted.more], [[{ text: "A", pr: 1, sha: "1111111" }], 12]);
  const only = parseNotes(notes("v1", ["- 140 commits; see the full changelog."]));
  assert.deepEqual([only.changes, only.more, only.listed], [[], 140, true]);
});

test("Notes without a change list have no changes", () => {
  const none = { changes: [], more: 0, listed: false, reverted: [], restored: [] };
  assert.deepEqual(parseNotes("Slopify release.\n\n- Download the Setup EXE"), none);
  assert.deepEqual(parseNotes(null), none);
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

/** A commit as GitHub's compare API lists it. */
const commit = (sha, parents, message) => ({ sha: sha.padEnd(40, "0"), parents: parents.map((p) => ({ sha: p.padEnd(40, "0") })), commit: { message } });
const subjects = (commits) => commits.filter((c) => c.parents.length < 2).map((c) => c.commit.message.split("\n")[0]);

test("A reverted pull request and its revert both stay out of the notes", () => {
  // Pull request #52 (with master merged into it), then #54 reverting it, then #55.
  const commits = [
    commit("9c04cb", ["657d29"], "Blur account emails until clicked"),
    commit("a7fb87", ["657d29", "9c04cb"], "Merge pull request #51 from o/blur"),
    commit("0cfbe0", ["39646c"], "Paste a whole Spotify playlist and get every song"),
    commit("b78237", ["0cfbe0", "a7fb87"], "Merge master into fix-spotify"),
    commit("54acd3", ["a7fb87", "b78237"], "Merge pull request #52 from o/fix-spotify"),
    commit("b35eef", ["54acd3"], `Revert "Merge pull request #52 from o/fix-spotify"\n\nThis reverts commit ${"54acd3".padEnd(40, "0")}, reversing\nchanges made to ${"a7fb87".padEnd(40, "0")}.`),
    commit("287f0f", ["54acd3", "b35eef"], "Merge pull request #54 from o/revert-pr-52"),
    commit("16a7ea", ["287f0f"], "Artist page headers: just the counts"),
  ];
  const { commits: kept, outside } = withoutReverts(commits);
  assert.deepEqual(subjects(kept), ["Blur account emails until clicked", "Artist page headers: just the counts"]);
  assert.deepEqual(outside, []);
});

test("Reverting a plain commit drops both; a revert of something released earlier drops only itself", () => {
  const commits = [
    commit("aaaaaa", ["000001"], "Add a thing"),
    commit("bbbbbb", ["aaaaaa"], "Keep this"),
    commit("cccccc", ["bbbbbb"], 'Revert "Add a thing"\n\nThis reverts commit aaaaaa0.'),
    commit("dddddd", ["cccccc"], 'Revert "Something from last week"\n\nThis reverts commit 1234567890abcdef1234567890abcdef12345678.'),
  ];
  const { commits: kept, outside } = withoutReverts(commits);
  assert.deepEqual(subjects(kept), ["Keep this"]);
  assert.deepEqual(outside, ["1234567890abcdef1234567890abcdef12345678"]);
});

test("Reverting a revert brings the original change back", () => {
  const commits = [
    commit("aaaaaa", ["000001"], "Add a thing"),
    commit("bbbbbb", ["aaaaaa"], `Revert "Add a thing"\n\nThis reverts commit ${"aaaaaa".padEnd(40, "0")}.`),
    commit("cccccc", ["bbbbbb"], `Revert "Revert "Add a thing""\n\nThis reverts commit ${"bbbbbb".padEnd(40, "0")}.`),
  ];
  assert.deepEqual(subjects(withoutReverts(commits).commits), ["Add a thing"]);
});

test("Older notes' revert lines are hidden, with the changes they name", () => {
  const releases = [
    release("v0.0.4-nightly.20261114.621.1", 30 * 60, notes("x", ["- Installed (#30) 3333333"])),
    release("v0.0.4-nightly.20261115.17.1", 12 * 60, notes("x", ["- Add a thing 1111111", "- Spotify playlists (#52) 2222222"])),
    release("v0.0.4-nightly.20261115.300.1", 9 * 60, notes("x", ['- Revert "Add a thing" (#53) 4444444'])),
    release("v0.0.4-nightly.20261115.638.1", 6 * 60, notes("x", [
      '- Revert "Merge pull request #52 from o/fix-spotify" (#54) 5555555',
      "- Artist page headers (#55) 6666666",
    ])),
  ];
  const log = buildChangelog(releases, { current: "0.0.4-nightly.20261114.621.1", target: "0.0.4-nightly.20261115.638.1", owner: "o", repo: "r" });
  // The build that only reverted is gone; the one whose changes were all reverted too.
  assert.deepEqual(log.builds.map((b) => b.changes.map((c) => c.text)), [["Artist page headers"]]);
  assert.equal(log.total, 1);
  assert.equal(log.complete, true);
});

const nightlies = (bodies) => bodies.map((body, i) => release(`v0.0.4-nightly.2026111${5 + Math.floor(i / 9)}.${100 + i}.1`, (bodies.length - i) * 60, body));
const changelogOf = (releases) => buildChangelog(releases, {
  current: releases[0].tag_name.slice(1), target: releases.at(-1).tag_name.slice(1), owner: "o", repo: "r",
});
const texts = (log) => log.builds.map((b) => b.changes.map((c) => c.text));

test("A revert of an earlier release's change hides it there, and reverting the revert brings it back", () => {
  const base = [
    notes("x", ["- Installed (#1) 0000001"]),
    notes("x", ["- Add feature (#2) aaaaaaa", "- Branch work bbbbbbb"]),
    notes("x", ["- Keep this (#4) ccccccc"], ["", "<!-- Reverted: aaaaaaa bbbbbbb -->"]),
  ];
  assert.deepEqual(texts(changelogOf(nightlies(base))), [["Keep this"]]);
  const back = changelogOf(nightlies([...base, notes("x", ["- Later (#6) ddddddd"], ["", "<!-- Restored: aaaaaaa bbbbbbb -->"])]));
  assert.deepEqual(texts(back), [["Later"], ["Keep this"], ["Add feature", "Branch work"]]);
});

test("A build whose changes were all reverted still has a list, with nothing on it", () => {
  const log = changelogOf(nightlies([notes("x", ["- Installed (#1) 0000001"]), notes("x", ["Nothing new to list."])]));
  assert.deepEqual(texts(log), [[]]);
  assert.equal(log.total, 0);
  assert.equal(log.complete, true);
});

test("Older notes' revert lines apply in order: a reverted revert or a later redo stays", () => {
  const restored = changelogOf(nightlies([
    notes("x", ["- Installed (#1) 0000001"]),
    notes("x", ["- Add feature 1111111"]),
    notes("x", ['- Revert "Add feature" 2222222']),
    notes("x", ['- Revert "Revert "Add feature"" 3333333']),
  ]));
  // The update itself only reverted the revert, so it lists nothing; the change is back below.
  assert.deepEqual(texts(restored), [[], ["Add feature"]]);
  const redone = changelogOf(nightlies([
    notes("x", ["- Installed (#1) 0000001"]),
    notes("x", ["- Add feature 1111111"]),
    // Notes list newest first: the redo came after the revert.
    notes("x", ["- Add feature 3333333", '- Revert "Add feature" 2222222']),
  ]));
  assert.deepEqual(texts(redone), [["Add feature"]]);
});

test("A change hidden by an older notes' revert line comes back when a later build restores it", () => {
  const log = changelogOf(nightlies([
    notes("x", ["- Installed (#1) 0000001"]),
    notes("x", ["- Feature aaaaaaa"]),
    notes("x", ['- Revert "Feature" bbbbbbb']),
    notes("x", ["- Later (#6) ddddddd"], ["", "<!-- Restored: aaaaaaa -->"]),
  ]));
  assert.deepEqual(texts(log), [["Later"], ["Feature"]]);
});
