const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const semver = require("semver");
const { NightlyGitHubProvider } = require("../desktop/nightly-provider.cjs");

function provider(tags, allowPrerelease = true, { platform = "win32", assets = null } = {}) {
  const requested = [];
  const updater = { channel: allowPrerelease ? "nightly" : "latest", allowPrerelease, currentVersion: new semver.SemVer("2.0.0") };
  const instance = new NightlyGitHubProvider({ owner: "test", repo: "releases" }, updater, {
    platform, executor: { request: async (options) => {
      requested.push(options.path);
      // Stable reads the releases feed (electron-updater's own provider).
      if (options.path.includes(".atom")) return `<feed>${tags.map(tag => `<entry><link href="https://github.com/test/releases/releases/tag/${tag}"/><title>${tag}</title><content>Notes</content></entry>`).join("")}</feed>`;
      // `tags` are listed newest first; the API's order doesn't matter, so it's reversed here.
      if (options.path.includes("/repos/test/releases/releases")) return JSON.stringify(tags.map((tag, i) => ({ tag_name: tag, name: tag, body: "Notes", draft: false, published_at: new Date(Date.UTC(2026, 9, 20) - i * 60_000).toISOString(), ...(assets ? { assets: assets(tag).map((name) => ({ name })) } : {}) })).reverse());
      if (options.path.endsWith("/latest")) return JSON.stringify({ tag_name: "v2.0.0" });
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

test("A Mac reads the Mac update files", async () => {
  const nightly = provider(["v2.0.1-nightly.20261013.930", "v2.0.0"], true, { platform: "darwin" });
  assert.equal((await nightly.instance.getLatestVersion()).version, "2.0.1-nightly.20261013.930");
  assert.ok(nightly.requested.some(path => path.endsWith("/v2.0.1-nightly.20261013.930/nightly-mac.yml")));
  const stable = provider(["v2.0.1", "v2.0.1-nightly.20261013.930"], true, { platform: "darwin" });
  assert.equal((await stable.instance.getLatestVersion()).version, "2.0.1");
  assert.ok(stable.requested.some(path => path.endsWith("/v2.0.1/latest-mac.yml")));
});

test("Nightly passes over a release without this platform's update file", async () => {
  // The newest release was published from a Windows-only build.
  const assets = (tag) => tag === "v2.0.1-nightly.20261014.100" ? ["nightly.yml"] : ["nightly.yml", "nightly-mac.yml", "latest.yml", "latest-mac.yml"];
  const tags = ["v2.0.1-nightly.20261014.100", "v2.0.1-nightly.20261013.930"];
  assert.equal((await provider(tags, true, { platform: "darwin", assets }).instance.getLatestVersion()).version, "2.0.1-nightly.20261013.930");
  assert.equal((await provider(tags, true, { platform: "win32", assets }).instance.getLatestVersion()).version, "2.0.1-nightly.20261014.100");
});

test("A Mac downloads the zip for its own kind of Mac", () => {
  const load = (arch, rosetta = false) => {
    const sandbox = { module: { exports: {} }, process: { arch }, require(name) {
      if (name === "electron") return { app: { runningUnderARM64Translation: rosetta }, net: {} };
      return require(name);
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve("../desktop/mac-update.cjs"), "utf8"), sandbox);
    return sandbox.module.exports.zipFor;
  };
  const files = [
    { url: "Slopify-2.0.1-x64-mac.zip" }, { url: "Slopify-2.0.1-arm64-mac.zip" },
    { url: "Slopify-2.0.1-arm64.dmg" }, { url: "Slopify-2.0.1-x64.dmg" },
  ];
  assert.equal(load("arm64")(files).url, "Slopify-2.0.1-arm64-mac.zip");
  assert.equal(load("x64")(files).url, "Slopify-2.0.1-x64-mac.zip");
  // The Intel app on Apple silicon moves to the native one.
  assert.equal(load("x64", true)(files).url, "Slopify-2.0.1-arm64-mac.zip");
  // An Apple silicon Mac can run the Intel one when that's all there is; an Intel Mac can't run arm64.
  assert.equal(load("arm64")([files[0]]).url, "Slopify-2.0.1-x64-mac.zip");
  assert.equal(load("x64")([files[1]]), null);
});
