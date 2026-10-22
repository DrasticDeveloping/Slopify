const semver = require("semver");
const { CancellationToken, parseXml, newError } = require("builder-util-runtime");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
const { parseUpdateInfo } = require("electron-updater/out/providers/Provider");

// electron-updater's GitHub provider excludes stable releases for custom channels.
// Keep its download handling, but for Nightly take the newest release published on
// GitHub, stable or nightly, whatever its version number. (The release feed lists
// the newest first; updates.cjs allows Nightly to "downgrade" to it.)
class NightlyGitHubProvider extends GitHubProvider {
  async getLatestVersion() {
    if (!this.updater.allowPrerelease) return super.getLatestVersion();
    const token = new CancellationToken();
    const xml = await this.httpRequest(new URL(`${this.basePath}.atom`, this.baseUrl), {
      accept: "application/atom+xml",
    }, token);
    const entries = parseXml(xml).getElements("entry");
    const candidates = entries.flatMap((entry) => {
      const tag = /\/tag\/(v?[^/]+)$/.exec(entry.element("link").attribute("href"))?.[1];
      if (!tag || !semver.valid(tag)) return [];
      const prerelease = semver.prerelease(tag);
      return !prerelease || prerelease[0] === "nightly" ? [{ tag, entry }] : [];
    });
    const selected = candidates[0];
    if (!selected) throw newError("No published versions on GitHub", "ERR_UPDATER_NO_PUBLISHED_VERSIONS");
    // Stable builds carry both files; use latest directly to support generic
    // feeds and the first stable release even before any nightly is published.
    const filename = semver.prerelease(selected.tag) ? "nightly.yml" : "latest.yml";
    const url = new URL(this.getBaseDownloadPath(selected.tag, filename), this.baseUrl);
    const info = parseUpdateInfo(await this.httpRequest(url, null, token), filename, url);
    if (!semver.eq(info.version, selected.tag)) throw newError("Update file version does not match release tag", "ERR_UPDATER_INVALID_UPDATE_INFO");
    return {
      ...info,
      tag: selected.tag,
      releaseName: info.releaseName ?? selected.entry.elementValueOrEmpty("title"),
      releaseNotes: info.releaseNotes ?? selected.entry.elementValueOrEmpty("content"),
    };
  }
}

module.exports = { NightlyGitHubProvider };
