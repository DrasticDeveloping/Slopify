const semver = require("semver");

/*
 * What's new in an update: the changes listed in the notes of every GitHub release
 * between the installed version and the update, newest build first. The notes come
 * from scripts/publish-release.mjs: a "### What's changed since …" heading, then one
 * line per commit ("- Subject (#45) abc1234"), sometimes "- …and 12 more", then a
 * full-changelog link. Releases whose notes have no such list are left out.
 */

/** Builds shown at most; older ones are counted as left out. */
const MAX_BUILDS = 40;

const isNightly = (version) => semver.prerelease(version)?.[0] === "nightly";

/** The changes in one release's notes: [{ text, pr }], plus how many more it only counted. */
function parseNotes(body) {
  const changes = [];
  let more = 0;
  let listing = false;
  for (const raw of String(body || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#{2,4}\s+What's changed/i.test(line)) { listing = true; continue; }
    if (!listing) continue;
    if (/^#{1,4}\s/.test(line) || line.startsWith("**")) break;
    if (!line.startsWith("- ")) continue;
    const item = line.slice(2).trim();
    // "…and 12 more (see the full changelog)", or "140 commits; see the full changelog."
    const counted = /^(?:…|\.\.\.)?\s*and (\d+) more\b/i.exec(item) ?? /^(\d+) commits?; see the full changelog/i.exec(item);
    if (counted) { more += Number(counted[1]); continue; }
    let text = item.replace(/\s+[0-9a-f]{7,40}$/, "");
    let pr = null;
    const numbered = /^(.*\S)\s+\(#(\d+)\)$/.exec(text);
    if (numbered) {
      text = numbered[1];
      pr = Number(numbered[2]);
    }
    if (text) changes.push({ text, pr });
  }
  return { changes, more };
}

/**
 * The changelog from `current` (installed) to `target`, from GitHub's releases list
 * (any order). Null when the target isn't listed or its own notes have no change list
 * (then the release page is the place to look). `complete` is false when some builds in
 * between couldn't be listed (too many, or notes without a list).
 */
function buildChangelog(releases, { current, target, owner, repo }) {
  const usable = releases
    .filter((r) => !r.draft && r.published_at && semver.valid(r.tag_name) && (!semver.prerelease(r.tag_name) || isNightly(r.tag_name)))
    .map((r) => ({ version: semver.clean(r.tag_name), tag: r.tag_name, date: r.published_at, body: r.body }))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const top = usable.findIndex((r) => r.version === target);
  if (top < 0) return null;
  const first = parseNotes(usable[top].body);
  if (!first.changes.length && !first.more) return null;
  const installed = usable.find((r) => r.version === current);
  // Older builds count while they're newer than the installed one: by its release, or, if that
  // isn't listed, by a nightly's build time. With neither, only the update itself is shown.
  const since = installed ? Date.parse(installed.date) : stampTime(current);
  const nightly = isNightly(target);
  // ...and only builds of the same kind: a nightly's notes list changes since the last nightly,
  // a stable release's since the last stable one, so mixing them would list changes twice.
  const older = since == null ? [] : usable.slice(top + 1).filter((r) =>
    isNightly(r.version) === nightly && r.version !== current && Date.parse(r.date) > since);
  let complete = Boolean(installed) && older.length < MAX_BUILDS;
  const builds = [{ version: target, date: usable[top].date, nightly, ...first }];
  for (const r of older.slice(0, MAX_BUILDS - 1)) {
    const { changes, more } = parseNotes(r.body);
    if (!changes.length && !more) { complete = false; continue; }
    builds.push({ version: r.version, date: r.date, nightly: isNightly(r.version), changes, more });
  }
  const base = `https://github.com/${owner}/${repo}`;
  const targetTag = usable[top].tag;
  return {
    builds,
    total: builds.reduce((sum, b) => sum + b.changes.length + b.more, 0),
    complete,
    repoUrl: base,
    url: installed ? `${base}/compare/${installed.tag}...${targetTag}` : `${base}/releases/tag/${targetTag}`,
  };
}

/** When a nightly was built, from its version (0.0.4-nightly.20261115.638.…: UTC date and HHMM); null for others. */
function stampTime(version) {
  const stamp = /-nightly\.(\d{4})(\d{2})(\d{2})\.(\d{1,4})\b/.exec(version);
  if (!stamp) return null;
  const hhmm = Number(stamp[4]);
  return Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]), Math.floor(hhmm / 100), hhmm % 100);
}

/** Fetches and builds the changelog; null if GitHub can't be reached or doesn't list the update. */
async function loadChangelog({ owner, repo, current, target, fetch }) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=60`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "Slopify" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return buildChangelog(await response.json(), { current, target, owner, repo });
}

module.exports = { parseNotes, buildChangelog, loadChangelog };
