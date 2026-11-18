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
//   newer than the installed one are taken, so a passed-over release never makes the app go
//   back. The list is read back to the installed version (or its end): past the first page,
//   once each time a release is published rather than at every check.
/** A safety limit on the pages of 100 releases read. */
const MAX_PAGES = 50;
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
      else if ((first || semver.gt(r.tag_name, installed)) && changesPlatform(r.body, "desktop")) answer = r;
    };
    const readPage = async (page) => {
      const batch = (await releasesApi(`?per_page=100&page=${page}`)) || [];
      batch.filter(eligible).sort(byPublished).forEach(consider);
      return batch;
    };
    // Stable: GitHub's latest release first, however many nightlies came after it. (None yet: the list says so.)
    if (!nightly) consider(await releasesApi("/latest").catch(() => null));
    const page1 = answer ? [] : await readPage(1);
    // Further back (a long run of releases that don't change this app): what's there only changes when a
    // release is published, which moves the first page's last one, so it's read once rather than at every check.
    if (!answer && page1.length === 100) {
      const key = [nightly, installed, newest?.tag_name, page1.at(-1).tag_name].join(" ");
      if (this.further?.key !== key) {
        for (let page = 2, batch = page1; !answer && batch.length === 100 && page <= MAX_PAGES; page++) batch = await readPage(page);
        this.further = { key, answer, newest };
      }
      ({ answer, newest } = this.further);
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
    // A release found further back that can't be fetched (deleted since, say) is looked for again next time.
    const text = await this.httpRequest(url, null, token).catch((error) => { this.further = null; throw error; });
    const info = parseUpdateInfo(text, filename, url);
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
