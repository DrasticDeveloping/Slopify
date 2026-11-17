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
//   latest release.
// - Either way, a release whose notes say it only changes the phone app (desktop/platforms.cjs)
//   is passed over for the newest one before it that changes this app. Reaching the installed
//   version first means there's nothing new for it; so does, on Nightly, a build that isn't
//   newer than the installed one. A passed-over release never makes Nightly go back.
/** Pages of 100 releases read at most, looking for one that changes this app. */
const MAX_PAGES = 3;
const byPublished = (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at);

class NightlyGitHubProvider extends GitHubProvider {
  async getLatestVersion() {
    const token = new CancellationToken();
    const { owner, repo } = this.options;
    const nightly = this.updater.allowPrerelease;
    // As text: electron-updater's version object comes from its own copy of semver, which this one doesn't accept.
    const installed = String(this.updater.currentVersion);
    const releasesApi = async (path) => JSON.parse(await this.httpRequest(
      new URL(this.computeGithubBasePath(`/repos/${owner}/${repo}/releases${path}`), this.baseApiUrl),
      { accept: "application/vnd.github+json" }, token) || "null");
    const eligible = (r) => Boolean(r) && !r.draft && r.published_at && semver.valid(r.tag_name)
      && (!semver.prerelease(r.tag_name) || (nightly && semver.prerelease(r.tag_name)[0] === "nightly"));
    const forThisApp = (r) => semver.eq(r.tag_name, installed) || changesPlatform(r.body, "desktop");

    let newest = null;
    let selected = null;
    // Stable: GitHub's latest release, however many nightlies came after it. (None yet: the list says so.)
    if (!nightly) {
      const latest = await releasesApi("/latest").catch(() => null);
      if (eligible(latest)) [newest, selected] = [latest, forThisApp(latest) ? latest : null];
    }
    // Otherwise the list, newest first, until a release that changes this app (or the installed one).
    const listed = [];
    for (let page = 1; !selected && page <= MAX_PAGES; page++) {
      const batch = (await releasesApi(`?per_page=100&page=${page}`)) || [];
      listed.push(...batch.filter(eligible));
      listed.sort(byPublished);
      selected = listed.find(forThisApp) ?? null;
      if (batch.length < 100) break;
    }
    newest ??= listed[0] ?? null;
    if (!newest) throw newError("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS");
    // Nothing newer changes this app: report the installed version, which electron-updater reads as "no update".
    const none = { version: installed, files: [], path: "", sha512: "" };
    if (!selected || semver.eq(selected.tag_name, installed)) return none;
    if (nightly && selected.tag_name !== newest.tag_name && !semver.gt(selected.tag_name, installed)) return none;
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
