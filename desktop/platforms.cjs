/*
 * Which apps a release changes: the Windows app ("desktop"), the phone app ("mobile"), both,
 * or neither (only docs, tests, the online service or the release tooling). Each app offers
 * only the updates that change it, so a nightly with just a phone fix doesn't ask every PC to
 * update, and a Windows-only nightly leaves phones alone.
 *
 * scripts/publish-release.mjs works this out from the changes since the previous release on
 * the same channel, and records it in the release notes as a hidden `<!-- Platforms: … -->`
 * comment. A pull request labelled "mobile only" or "desktop only" counts for that app alone,
 * whatever files it touches (use it for changes in shared code, like the phone layout).
 * Otherwise its files decide, by FILE_RULES. Notes without the comment (releases from before
 * it, or when GitHub couldn't say) count for both apps.
 */

const PLATFORMS = ["desktop", "mobile"];

/** Pull request labels that say which app a change is for. */
const LABELS = { "desktop only": ["desktop"], "mobile only": ["mobile"] };

/** First match wins. Anything else (src/, server/, package.json, …) is in both apps. */
const FILE_RULES = [
  // Not part of either app: docs, the online service (deployed on its own), CI, tests, release tooling.
  [/^(docs|cloud|\.github|work)\//, []],
  [/(^|\/)[^/]+\.md$/i, []],
  [/^\.git(ignore|attributes)$/, []],
  [/^scripts\/(test-[^/]+|publish-release\.mjs)$/, []],
  // The phone app.
  [/^(ios|mobile)\//, ["mobile"]],
  [/^capacitor\.config\.json$/, ["mobile"]],
  [/^scripts\/ios-[^/]+$/, ["mobile"]],
  // The Windows app.
  [/^desktop\//, ["desktop"]],
  [/^electron-builder\.json$/, ["desktop"]],
  [/^scripts\/(package-windows|run-desktop)\.mjs$/, ["desktop"]],
];

/** The apps a changed file is part of. */
function platformsOfFile(file) {
  for (const [pattern, platforms] of FILE_RULES) if (pattern.test(file)) return platforms;
  return PLATFORMS;
}

/** The apps a pull request's labels limit it to, or null when no label says. */
function platformsOfLabels(labels) {
  const named = labels.flatMap((label) => LABELS[String(label).trim().toLowerCase()] ?? []);
  return named.length ? sorted(named) : null;
}

const sorted = (platforms) => PLATFORMS.filter((p) => platforms.includes(p));

/**
 * The apps changed between a previous release and `head`, from `commits` (GitHub's compare
 * API shape, the whole range: { sha, parents: [{ sha }], commit: { message } }). Walks the
 * branch's own history (first parents) back to the previous release, so a pull request's merge
 * counts as its whole change and a squashed or direct commit as itself. `filesOf(parent, sha)`
 * lists the files a step changed, or null if it couldn't list them all; `labelsOf(number)` a
 * pull request's labels. Null (both apps) when any step can't be told.
 */
async function platformsOfRange({ commits, head, filesOf, labelsOf }) {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const found = new Set();
  let steps = 0;
  for (let commit = bySha.get(head); commit; commit = bySha.get(commit.parents[0]?.sha)) {
    steps++;
    const subject = commit.commit.message.split("\n")[0].trim();
    const pr = /^Merge pull request #(\d+)\b/.exec(subject)?.[1] ?? /\(#(\d+)\)$/.exec(subject)?.[1];
    const labelled = pr ? platformsOfLabels(await labelsOf(Number(pr))) : null;
    if (labelled) {
      labelled.forEach((p) => found.add(p));
      continue;
    }
    if (!commit.parents[0]) return null;
    const files = await filesOf(commit.parents[0].sha, commit.sha);
    if (!files) return null;
    for (const file of files) platformsOfFile(file).forEach((p) => found.add(p));
  }
  return steps ? sorted([...found]) : null;
}

/** The hidden comment that records the apps in a release's notes. */
const platformsMarker = (platforms) => `<!-- Platforms: ${platforms.length ? sorted(platforms).join(" ") : "none"} -->`;

/** The apps a release's notes say it changes, or null when they don't say. */
function platformsOfNotes(body) {
  const listed = /<!--\s*Platforms:([\sa-z]*)-->/i.exec(String(body || ""))?.[1].trim().toLowerCase().split(/\s+/);
  if (!listed) return null;
  return sorted(listed);
}

/** Whether a release changes `platform`'s app: true when its notes don't say. */
const changesPlatform = (body, platform) => platformsOfNotes(body)?.includes(platform) ?? true;

module.exports = { PLATFORMS, platformsOfFile, platformsOfLabels, platformsOfRange, platformsMarker, platformsOfNotes, changesPlatform };
