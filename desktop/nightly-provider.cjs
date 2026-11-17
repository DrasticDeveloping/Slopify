const semver = require("semver");
const { CancellationToken, newError } = require("builder-util-runtime");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");

// electron-updater's GitHub provider excludes stable releases for custom channels.
// Keep its download handling, but for Nightly take the release most recently
// published on GitHub, stable or nightly, whatever its version number (updates.cjs
// allows Nightly to "downgrade" to it). The releases feed isn't in publishing order,
// so this asks GitHub's API, which gives each release's publishing time. A release
// without this platform's update file (one published from a Windows-only build, say)
// is passed over, so it can't leave Macs without updates.
class NightlyGitHubProvider extends GitHubProvider {
  async getLatestVersion() {
    if (!this.updater.allowPrerelease) return super.getLatestVersion();
    const token = new CancellationToken();
    const { owner, repo } = this.options;
    const list = new URL(this.computeGithubBasePath(`/repos/${owner}/${repo}/releases?per_page=30`), this.baseApiUrl);
    const releases = JSON.parse(await this.httpRequest(list, { accept: "application/vnd.github+json" }, token) || "[]");
    // Stable builds carry both files; use latest directly to support generic
    // feeds and the first stable release even before any nightly is published.
    // (nightly-mac.yml and latest-mac.yml on a Mac.)
    const updateFile = (tag) => `${this.getCustomChannelName(semver.prerelease(tag) ? "nightly" : "latest")}.yml`;
    const selected = releases
      .filter((r) => !r.draft && r.published_at && semver.valid(r.tag_name) && (!semver.prerelease(r.tag_name) || semver.prerelease(r.tag_name)[0] === "nightly"))
      .filter((r) => !Array.isArray(r.assets) || r.assets.some((asset) => asset?.name === updateFile(r.tag_name)))
      .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
    if (!selected) throw newError("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS");
    const tag = selected.tag_name;
    const filename = updateFile(tag);
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
