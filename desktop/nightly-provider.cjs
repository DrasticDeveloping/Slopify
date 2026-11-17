const semver = require("semver");
const { CancellationToken, newError } = require("builder-util-runtime");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");
const { changesPlatform } = require("./platforms.cjs");

// electron-updater's GitHub provider excludes stable releases for custom channels, and
// knows nothing of releases that don't change this app. Keep its download handling, but
// choose the release from GitHub's API, which gives each release's notes and publishing time:
// - Nightly takes the release most recently published, stable or nightly, whatever its
//   version number (updates.cjs allows Nightly to "downgrade" to it). Stable takes GitHub's
//   latest release; switching a nightly to Stable always lands there.
// - Otherwise a release whose notes say it doesn't change this app (desktop/platforms.cjs) is
//   passed over for the newest one before it that does. Past the newest release, only builds
//   newer than the installed one are taken, so the list is read no further back than the
//   installed version, and a passed-over release never makes the app go back.
/** A safety limit on the pages of 100 releases read. */
const MAX_PAGES = 10;
const byPublished = (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at);

class NightlyGitHubProvider extends GitHubProvider {
  async getLatestVersion() {
    const token = new CancellationToken();
    const { owner, repo } = this.options;
    const nightly = this.updater.allowPrerelease;
    // As text: electron-updater's version object comes from its own copy of semver, which this one doesn't accept.
    const installed = String(this.updater.currentVersion);
    const switching = !nightly && Boolean(semver.prerelease(installed));
    const releasesApi = async (path) => JSON.parse(await this.httpRequest(
      new URL(this.computeGithubBasePath(`/repos/${owner}/${repo}/releases${path}`), this.baseApiUrl),
      { accept: "application/vnd.github+json" }, token) || "null");
    const eligible = (r) => Boolean(r) && !r.draft && r.published_at && semver.valid(r.tag_name)
      && (!semver.prerelease(r.tag_name) || (nightly && semver.prerelease(r.tag_name)[0] === "nightly"));

    // Releases from newest to oldest, until the answer: a release, or "none" (nothing newer changes this app).
    let newest = null;
    let answer = null;
    const seen = new Set();
    const consider = (r) => {
      if (answer || !eligible(r) || seen.has(r.tag_name)) return;
      seen.add(r.tag_name);
      const first = !newest;
      newest ??= r;
      if (semver.eq(r.tag_name, installed)) answer = "none";
      else if (first && switching) answer = r;
      else if (!first && !semver.gt(r.tag_name, installed)) answer = "none";
      else if (changesPlatform(r.body, "desktop")) answer = r;
    };
    // Stable: GitHub's latest release first, however many nightlies came after it. (None yet: the list says so.)
    if (!nightly) consider(await releasesApi("/latest").catch(() => null));
    for (let page = 1; !answer && page <= MAX_PAGES; page++) {
      const batch = (await releasesApi(`?per_page=100&page=${page}`)) || [];
      batch.filter(eligible).sort(byPublished).forEach(consider);
      if (batch.length < 100) break;
    }
    if (!newest) throw newError("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS");
    // The installed version is what electron-updater reads as "no update".
    if (!answer || answer === "none") return { version: installed, files: [], path: "", sha512: "" };
    const selected = answer;
    // Stable builds carry both files; use latest directly to support generic
    // feeds and the first stable release even before any nightly is published.
    const tag = selected.tag_name;
    const filename = semver.prerelease(tag) ? "nightly.yml" : "latest.yml";
    const url = new URL(this.getBaseDownloadPath(tag, filename), this.baseUrl);
    const info = parseUpdateInfo(await this.httpRequest(url, null, token), filename, url);
    if (!semver.eq(info.version, tag)) throw newError("Update file version does not match release tag", "ERR_UPDATER_INVALID_UPDATE_INFO");
    return {
      ...info,
      tag,
      releaseName: info.releaseName ?? selected.name ?? tag,
      releaseNotes: info.releaseNotes ?? selected.body ?? "",
    };
  }
}

module.exports = { NightlyGitHubProvider };
