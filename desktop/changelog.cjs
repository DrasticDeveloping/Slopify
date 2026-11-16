const semver = require("semver");

/*
 * What's new in an update: the changes listed in the notes of every GitHub release
 * between the installed version and the update, newest build first. The notes come
 * from scripts/publish-release.mjs: a "### What's changed since …" heading, then one
 * line per commit ("- Subject (#45) abc1234"), sometimes "- …and 12 more", then a
 * full-changelog link. Releases whose notes have no such list are left out. Reverts, and
 * what they reverted, are left out of both the notes and the list here.
 */

/** Builds shown at most; older ones are counted as left out. */
const MAX_BUILDS = 40;

const isNightly = (version) => semver.prerelease(version)?.[0] === "nightly";

/** Commits are matched by their short hash, as the notes write them. */
const short = (sha) => String(sha).slice(0, 7).toLowerCase();
/** The hashes in a hidden `<!-- Label: abc1234 def5678 -->` comment in the notes. */
const hashes = (body, label) =>
  (new RegExp(`<!--\\s*${label}:([\\s0-9a-f]*)-->`, "i").exec(String(body || ""))?.[1].trim().split(/\s+/).filter(Boolean) ?? []).map(short);

/**
 * One release's notes: its changes ([{ text, pr, sha }]), how many more it only counted,
 * whether it has a change list at all, and the commits from earlier releases that it
 * reverted or brought back (hidden comments, see publish-release.mjs).
 */
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
    const hash = /\s+([0-9a-f]{7,40})$/.exec(item);
    let text = hash ? item.slice(0, hash.index) : item;
    let pr = null;
    const numbered = /^(.*\S)\s+\(#(\d+)\)$/.exec(text);
    if (numbered) {
      text = numbered[1];
      pr = Number(numbered[2]);
    }
    if (text) changes.push({ text, pr, sha: hash ? short(hash[1]) : null });
  }
  return { changes, more, listed: listing, reverted: hashes(body, "Reverted"), restored: hashes(body, "Restored") };
}

/** The commit a revert's message names ("This reverts commit …"), or null. */
const revertTarget = (message) => /This reverts commit ([0-9a-f]{7,40})\b/i.exec(message)?.[1].toLowerCase() ?? null;

/**
 * Commits for release notes (GitHub's compare API shape: { sha, parents: [{ sha }],
 * commit: { message } }, oldest first) without reverts or the commits they undid, so a
 * change that came and went lists neither. A reverted merge takes its branch's commits
 * with it. Newest first, so reverting a revert brings the original change back.
 * `outside` names what reverts here undid in earlier releases, for the notes to record.
 */
function withoutReverts(commits) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const find = (sha) => bySha.get(sha) ?? commits.find((commit) => commit.sha.startsWith(sha));
  // The commits in the list reachable from `sha`, not walking through `stop`.
  const reachable = (sha, stop = new Set()) => {
    const seen = new Set();
    const queue = [sha];
    while (queue.length) {
      const commit = bySha.get(queue.pop());
      if (!commit || seen.has(commit.sha) || stop.has(commit.sha)) continue;
      seen.add(commit.sha);
      for (const parent of commit.parents) queue.push(parent.sha);
    }
    return seen;
  };
  const dropped = new Set();
  const outside = [];
  for (const commit of [...commits].reverse()) {
    if (dropped.has(commit.sha)) continue;
    const reverted = revertTarget(commit.commit.message);
    if (!reverted) continue;
    dropped.add(commit.sha);
    const target = find(reverted);
    if (!target) { outside.push(reverted); continue; }
    dropped.add(target.sha);
    if (target.parents.length > 1) {
      const base = reachable(target.parents[0].sha);
      for (const parent of target.parents.slice(1)) for (const sha of reachable(parent.sha, base)) dropped.add(sha);
    }
  }
  return { commits: commits.filter((commit) => !dropped.has(commit.sha)), outside };
}

/**
 * Takes reverted changes out of the builds shown (newest first), applying reverts in the
 * order they happened, so a change brought back or made again later stays. Current notes
 * record reverts of earlier releases as hidden commit lists. Older notes list reverts as
 * `Revert "Subject"` lines: those are dropped, with the earlier changes they name (same
 * subject, or the pull request of a reverted "Merge pull request #N").
 */
function dropReverted(builds) {
  const seen = [];
  const shown = new Set();
  const undone = new Map(); // a listed revert's text → the changes it hid
  for (const build of [...builds].reverse()) {
    for (const change of [...build.changes].reverse()) {
      const named = /^Revert "(.*?)"?$/.exec(change.text)?.[1];
      if (named == null) { seen.push(change); shown.add(change); continue; }
      if (undone.has(named)) { // reverting a listed revert brings back what it hid
        for (const back of undone.get(named)) shown.add(back);
        continue;
      }
      const pr = Number(/^Merge pull request #(\d+)\b/.exec(named)?.[1]) || null;
      const hid = [...shown].filter((c) => (pr ? c.pr === pr : !named.endsWith("…") && c.text === named));
      for (const c of hid) shown.delete(c);
      undone.set(change.text, hid);
    }
    // This build's reverts of earlier builds' commits, and what it brought back.
    for (const sha of build.reverted) for (const c of seen) if (c.sha === sha) shown.delete(c);
    for (const sha of build.restored) for (const c of seen) if (c.sha === sha) shown.add(c);
  }
  return builds.map(({ reverted, restored, ...build }) => ({
    ...build,
    changes: build.changes.filter((change) => shown.has(change)),
  }));
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
  const { listed: hasList, ...first } = parseNotes(usable[top].body);
  if (!hasList) return null;
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
  const listed = [{ version: target, date: usable[top].date, nightly, ...first }];
  for (const r of older.slice(0, MAX_BUILDS - 1)) {
    const { listed: hasList, ...notes } = parseNotes(r.body);
    if (!hasList) { complete = false; continue; }
    listed.push({ version: r.version, date: r.date, nightly: isNightly(r.version), ...notes });
  }
  // An older build left with nothing once reverts are gone isn't shown; the update itself always is.
  const builds = dropReverted(listed).filter((b, i) => i === 0 || b.changes.length || b.more);
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

module.exports = { parseNotes, revertTarget, withoutReverts, buildChangelog, loadChangelog };
