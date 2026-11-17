const semver = require("semver");
const { CancellationToken, newError } = require("builder-util-runtime");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");
const { changesPlatform } = require("./platforms.cjs");

// electron-updater's GitHub provider excludes stable releases for custom channels, and
// knows nothing of releases that don't change this app. Keep its download handling, but
// choose the release from GitHub's API, which gives each release's notes and publishing time:
// - Nightly takes the release most recently published, stable or nightly, whatever its
//   version number (updates.cjs allows Nightly to "downgrade" to it). Stable takes the most
//   recently published stable release.
// - Either way, a release whose notes say it only changes the phone app (desktop/platforms.cjs)
//   is passed over for the newest one before it that changes this app. Reaching the installed
//   version first means there's nothing new for it, so a skipped release never "downgrades".
class NightlyGitHubProvider extends GitHubProvider {
  async getLatestVersion() {
    const token = new CancellationToken();
    const { owner, repo } = this.options;
    const nightly = this.updater.allowPrerelease;
    const list = new URL(this.computeGithubBasePath(`/repos/${owner}/${repo}/releases?per_page=50`), this.baseApiUrl);
    const releases = JSON.parse(await this.httpRequest(list, { accept: "application/vnd.github+json" }, token) || "[]")
      .filter((r) => !r.draft && r.published_at && semver.valid(r.tag_name) && (!semver.prerelease(r.tag_name) || (nightly && semver.prerelease(r.tag_name)[0] === "nightly")))
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
    if (!releases.length) throw newError("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS");
    // As text: electron-updater's version object comes from its own copy of semver, which this one doesn't accept.
    const installed = String(this.updater.currentVersion);
    const selected = releases.find((r) => semver.eq(r.tag_name, installed) || changesPlatform(r.body, "desktop"));
    // Nothing newer changes this app: report the installed version, which electron-updater reads as "no update".
    if (!selected || semver.eq(selected.tag_name, installed)) return { version: installed, files: [], path: "", sha512: "" };
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
