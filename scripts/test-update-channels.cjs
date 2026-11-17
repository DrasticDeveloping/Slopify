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
  /** Releases whose files are gone (deleted since being listed). */
  const gone = new Set();
  /** Publishes a release, newest. */
  const publish = (tag, body = "Notes") => { releases.unshift([tag, body]); };
  /** Deletes a release. */
  const unpublish = (tag) => { releases.splice(releases.findIndex(([t]) => t === tag), 1); };
  const instance = new NightlyGitHubProvider({ owner: "test", repo: "releases" }, updater, {
    platform: "win32", executor: { request: async (options) => {
      requested.push(options.path);
      const listed = releases.map(([tag, body], i) => ({ tag_name: tag, name: tag, body, draft: false, published_at: new Date(Date.UTC(2026, 9, 20) - i * 60_000).toISOString() }));
      // GitHub's latest release: the newest stable one.
      if (options.path.endsWith("/repos/test/releases/releases/latest")) {
        const latest = listed.find((r) => !semver.prerelease(r.tag_name));
        if (!latest) throw Object.assign(new Error("404 Not Found"), { statusCode: 404 });
        return JSON.stringify(latest);
      }
      // Listed newest first, a page at a time; the order within a page doesn't matter, so it's reversed here.
      if (options.path.includes("/repos/test/releases/releases?")) {
        const query = new URLSearchParams(options.path.split("?")[1]);
        const size = Number(query.get("per_page")) || 30;
        const page = Number(query.get("page")) || 1;
        return JSON.stringify(listed.slice((page - 1) * size, page * size).reverse());
      }
      const tag = /\/download\/(v[^/]+)\//.exec(options.path)?.[1];
      if (gone.has(tag)) throw Object.assign(new Error("404 Not Found"), { statusCode: 404 });
      return `version: ${tag.slice(1)}\nfiles:\n  - url: Setup.exe\n    sha512: checksum\n`;
    } },
  });
  return { instance, requested, publish, unpublish, gone };
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

test("Without its own version listed, Nightly doesn't go back to an older build for a passed-over one", async () => {
  // Installed: an unpublished build between two published ones.
  const { instance } = provider([["v2.0.1-nightly.20261013.1000", phoneOnly], ["v2.0.1-nightly.20261013.900", both]], true, "2.0.1-nightly.20261013.930");
  assert.equal((await instance.getLatestVersion()).version, "2.0.1-nightly.20261013.930");
  // A newer build for this app is still taken.
  const newer = provider([["v2.0.1-nightly.20261013.1000", phoneOnly], ["v2.0.1-nightly.20261013.950", both]], true, "2.0.1-nightly.20261013.930");
  assert.equal((await newer.instance.getLatestVersion()).version, "2.0.1-nightly.20261013.950");
});

test("Switching a nightly to Stable lands on the latest stable release, whichever app it changed", async () => {
  const { instance } = provider([["v2.0.2", phoneOnly], "v2.0.1"], false, "2.0.3-nightly.20261013.930");
  assert.equal((await instance.getLatestVersion()).version, "2.0.2");
});

test("Stable finds its release however many nightlies came after it", async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `v2.0.3-nightly.20261013.${2000 - i}`);
  const { instance, requested } = provider([...many(150), "v2.0.2"], false);
  assert.equal((await instance.getLatestVersion()).version, "2.0.2");
  assert.equal(requested.filter((path) => path.includes("/releases?")).length, 0, "GitHub's latest release was enough");
  // A phone-only latest release: the list is read further back, page by page.
  const deeper = provider([...many(150), ["v2.0.2", phoneOnly], ...many(20).map((t) => t.replace("2.0.3", "2.0.2")), "v2.0.1"], false, "2.0.0");
  assert.equal((await deeper.instance.getLatestVersion()).version, "2.0.1");
  assert.equal(deeper.requested.filter((path) => path.includes("/releases?")).length, 2);
  // However far back it is.
  const far = provider([["v2.2.0", phoneOnly], ...many(350), "v2.1.0", "v2.0.0"], false, "2.0.0");
  assert.equal((await far.instance.getLatestVersion()).version, "2.1.0");
  // Up to date: read back to the installed version, and no further.
  const upToDate = provider([["v2.2.0", phoneOnly], ...many(150), "v2.1.0", ...many(300).map((t) => t.replace("2.0.3", "2.1.0")), "v2.0.0"], false, "2.1.0");
  assert.equal((await upToDate.instance.getLatestVersion()).version, "2.1.0");
  assert.equal(upToDate.requested.filter((path) => path.includes("/releases?")).length, 2);
});

test("Past the first page, the list is read once until a release is published", async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `v2.0.3-nightly.20261013.${2000 - i}`);
  // An unpublished build, so the whole list is read.
  const { instance, requested, publish } = provider([["v2.2.0", phoneOnly], ...many(250), "v2.1.0"], false, "2.1.5");
  const pages = () => requested.filter((path) => path.includes("/releases?")).length;
  assert.equal((await instance.getLatestVersion()).version, "2.1.5");
  assert.equal(pages(), 3);
  assert.equal((await instance.getLatestVersion()).version, "2.1.5");
  assert.equal(pages(), 4, "the next check reads the first page only");
  // A new nightly moves the first page: it's all read again. A new stable for this app is found at once.
  publish("v2.2.1-nightly.20261014.100");
  await instance.getLatestVersion();
  assert.equal(pages(), 7);
  publish("v2.2.1");
  assert.equal((await instance.getLatestVersion()).version, "2.2.1");
});

test("A release found further back that has since gone is looked for again", async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `v2.0.3-nightly.20261013.${2000 - i}`);
  const { instance, requested, gone, unpublish } = provider([["v2.2.0", phoneOnly], ...many(150), "v2.1.0", "v2.0.9"], false, "2.0.0");
  assert.equal((await instance.getLatestVersion()).version, "2.1.0");
  gone.add("v2.1.0");
  await assert.rejects(instance.getLatestVersion(), /404/);
  const before = requested.filter((path) => path.includes("/releases?")).length;
  await assert.rejects(instance.getLatestVersion(), /404/);
  assert.equal(requested.filter((path) => path.includes("/releases?")).length, before + 2, "the list past page 1 is read again");
  // Once it's out of the list too, the next release for this app is found.
  unpublish("v2.1.0");
  assert.equal((await instance.getLatestVersion()).version, "2.0.9");
});

test("A lower version published later is passed over, not where the list stops", async () => {
  const { instance } = provider([["v2.2.0", phoneOnly], ["v1.9.5", both], "v2.1.0"], false, "2.0.0");
  assert.equal((await instance.getLatestVersion()).version, "2.1.0");
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
