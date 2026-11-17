const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const semver = require("semver");
const { NightlyGitHubProvider } = require("../desktop/nightly-provider.cjs");
// The installed version as electron-updater gives it: from its own copy of semver.
const { SemVer: UpdaterSemVer } = require(require.resolve("semver", { paths: [require.resolve("electron-updater")] }));

/**
 * A provider reading `tags` (newest first): each a tag, or [tag, notes]. Installed: 2.0.0, or `current`.
 */
function provider(tags, allowPrerelease = true, current = "2.0.0") {
  const requested = [];
  const updater = { channel: allowPrerelease ? "nightly" : "latest", allowPrerelease, currentVersion: new UpdaterSemVer(current) };
  const releases = tags.map((entry) => (Array.isArray(entry) ? entry : [entry, "Notes"]));
  const instance = new NightlyGitHubProvider({ owner: "test", repo: "releases" }, updater, {
    platform: "win32", executor: { request: async (options) => {
      requested.push(options.path);
      // Listed newest first; the API's order doesn't matter, so it's reversed here.
      if (options.path.includes("/repos/test/releases/releases")) return JSON.stringify(releases.map(([tag, body], i) => ({ tag_name: tag, name: tag, body, draft: false, published_at: new Date(Date.UTC(2026, 9, 20) - i * 60_000).toISOString() })).reverse());
      const tag = /\/download\/(v[^/]+)\//.exec(options.path)?.[1];
      return `version: ${tag.slice(1)}\nfiles:\n  - url: Setup.exe\n    sha512: checksum\n`;
    } },
  });
  return { instance, requested };
}

test("Nightly receives a newer stable and resolves its installer", async () => {
  const { instance, requested } = provider(["v2.0.1", "v2.0.1-nightly.20261013.930"]);
  const info = await instance.getLatestVersion();
  assert.equal(info.version, "2.0.1");
  assert.ok(requested.some(path => path.endsWith("/v2.0.1/latest.yml")));
  assert.equal(instance.resolveFiles(info)[0].url.href, "https://github.com/test/releases/releases/download/v2.0.1/Setup.exe");
});

test("Nightly selects the newest published nightly and ignores other prereleases", async () => {
  const { instance, requested } = provider(["v3.0.0-alpha.1", "v2.0.1-nightly.20261013.930.2", "v2.0.1-nightly.20261013.930.1", "v2.0.0"]);
  assert.equal((await instance.getLatestVersion()).version, "2.0.1-nightly.20261013.930.2");
  assert.ok(requested.some(path => path.endsWith("nightly.yml")));
});

test("Nightly takes the newest release even when its version is lower", async () => {
  const { instance } = provider(["v0.0.1", "v2.0.1-nightly.20261021.2223.40991"]);
  assert.equal((await instance.getLatestVersion()).version, "0.0.1");
});

test("Nightly skips drafts", async () => {
  const { instance } = provider(["v0.0.2-nightly.20261022.100", "v0.0.1"]);
  const request = instance.executor.request;
  instance.executor.request = async (options) => {
    const text = await request(options);
    if (!options.path.includes("/repos/")) return text;
    return JSON.stringify(JSON.parse(text).map((r) => (r.tag_name.includes("nightly") ? { ...r, draft: true, published_at: null } : r)));
  };
  assert.equal((await instance.getLatestVersion()).version, "0.0.1");
});

test("Stable ignores nightlies", async () => {
  const { instance } = provider(["v2.0.1-nightly.20261013.930", "v2.0.0"], false);
  assert.equal((await instance.getLatestVersion()).version, "2.0.0");
});

test("Nightly works before a nightly has been published", async () => {
  assert.equal((await provider(["v2.0.0"]).instance.getLatestVersion()).version, "2.0.0");
  await assert.rejects(provider([]).instance.getLatestVersion(), /No published versions/);
});

const phoneOnly = "Notes\n\n<!-- Platforms: mobile -->";
const appsNone = "Notes\n\n<!-- Platforms: none -->";
const both = "Notes\n\n<!-- Platforms: desktop mobile -->";

test("A release that only changes the phone app is passed over for the newest one that changes this app", async () => {
  const { instance, requested } = provider([["v2.0.2-nightly.20261013.1000", phoneOnly], ["v2.0.2-nightly.20261013.940", appsNone], ["v2.0.2-nightly.20261013.930", both], "v2.0.1"]);
  assert.equal((await instance.getLatestVersion()).version, "2.0.2-nightly.20261013.930");
  assert.ok(!requested.some((path) => path.includes("20261013.1000/") || path.includes("20261013.940/")));
});

test("Stable passes over a phone-only stable release too, and ignores nightlies", async () => {
  const { instance } = provider([["v2.0.3", phoneOnly], ["v2.0.3-nightly.20261013.930", both], ["v2.0.2", "Notes\n<!-- Platforms: desktop -->"]], false);
  assert.equal((await instance.getLatestVersion()).version, "2.0.2");
});

test("Reaching the installed version first means no update, never a downgrade", async () => {
  // Installed: 2.0.1-nightly.…930. Only phone builds since; an older Windows build is further down.
  const { instance, requested } = provider([["v2.0.1-nightly.20261013.1000", phoneOnly], ["v2.0.1-nightly.20261013.930", phoneOnly], ["v2.0.1-nightly.20261013.900", both]], true, "2.0.1-nightly.20261013.930");
  const info = await instance.getLatestVersion();
  assert.equal(info.version, "2.0.1-nightly.20261013.930");
  assert.equal(requested.length, 1, "only the release list is read");
});

test("When nothing listed changes this app, the installed version is reported", async () => {
  const { instance } = provider([["v2.0.1-nightly.20261013.1000", phoneOnly]], true, "1.0.0");
  assert.equal((await instance.getLatestVersion()).version, "1.0.0");
});

test("Notes that don't say which apps count for both", async () => {
  const { instance } = provider([["v2.0.1-nightly.20261013.1000", "A nightly build of Slopify."], ["v2.0.1-nightly.20261013.930", both]]);
  assert.equal((await instance.getLatestVersion()).version, "2.0.1-nightly.20261013.1000");
});

test("Nightly versions sort chronologically below the next stable", () => {
  const versions = ["2.0.0", "2.0.1-nightly.20261013.930.1", "2.0.1-nightly.20261013.930.2", "2.0.1-nightly.20261013.931.0", "2.0.1-nightly.20261014.0.0", "2.0.1"];
  for (let i = 1; i < versions.length; i++) assert.ok(semver.gt(versions[i], versions[i - 1]));
});

test("Stored beta migrates to Nightly; switching to Stable allows downgrade", async () => {
  const handlers = new Map();
  const updater = { on() {}, checkForUpdates: async () => { assert.equal(updater.channel, "latest"); assert.equal(updater.allowPrerelease, false); assert.equal(updater.allowDowngrade, true); }, setFeedURL() {} };
  let saved;
  const sandbox = { module: { exports: {} }, process: { resourcesPath: "resources", env: {} }, setTimeout: () => ({}), setInterval: () => ({}), require(name) {
    if (name === "electron") return { app: { isPackaged: true, getVersion: () => "2.0.1-nightly.20261013.930", getPath: () => "user" }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
    if (name === "node:fs") return { readFileSync: file => file.endsWith("updates.json") ? '{"channel":"beta"}' : 'provider: github\nowner: test\nrepo: releases', writeFileSync: (_file, text) => { saved = JSON.parse(text); } };
    if (name === "electron-updater") return { autoUpdater: updater };
    if (name === "./nightly-provider.cjs") return { NightlyGitHubProvider };
    if (name === "./changelog.cjs") return require("../desktop/changelog.cjs");
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../desktop/updates.cjs"), "utf8"), sandbox);
  sandbox.module.exports.startUpdates(() => null, () => {});
  assert.equal(handlers.get("updates:get")().channel, "nightly");
  await handlers.get("updates:set-channel")(null, "stable");
  assert.equal(saved.channel, "stable");
  // Still a nightly, so a later check (after a failed one, or a restart) can still go back to Stable.
  assert.equal(updater.allowDowngrade, true);
});
