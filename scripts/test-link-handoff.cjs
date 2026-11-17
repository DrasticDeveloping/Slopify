// Checks handing slopify:// links between copies (desktop/link-handoff.cjs): node --test scripts/test-link-handoff.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { handOff, linkPipe, listenForLinks, offerLink } = require("../desktop/link-handoff.cjs");

const profile = () => fs.mkdtempSync(path.join(os.tmpdir(), "slopify-links-"));
const close = (server) => new Promise((resolve) => server.close(resolve));
const listening = (server) => new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));

test("Each profile has its own pipe", () => {
  assert.notEqual(linkPipe("C:/one/Slopify"), linkPipe("C:/one/Slopify Dev"));
  if (process.platform === "win32") assert.equal(linkPipe("C:/One/Slopify"), linkPipe("c:/one/slopify"));
});

test("A running copy takes the link it's offered", async () => {
  const dir = profile();
  const got = [];
  const server = listenForLinks(dir, (url) => { got.push(url); return true; });
  await listening(server);
  assert.equal(await offerLink(dir, "slopify://p/abcdefghijklmnop"), true);
  assert.deepEqual(got, ["slopify://p/abcdefghijklmnop"]);
  await close(server);
});

test("A copy that refuses the link doesn't count as taking it", async () => {
  const dir = profile();
  const server = listenForLinks(dir, () => false);
  await listening(server);
  assert.equal(await offerLink(dir, "slopify://nope"), false);
  await close(server);
});

test("No copy running: the link stays with the new copy", async () => {
  assert.equal(await offerLink(profile(), "slopify://p/abcdefghijklmnop"), false);
});

test("Handing off tries each profile until one takes it", async () => {
  const [missing, running] = [profile(), profile()];
  const got = [];
  const server = listenForLinks(running, (url) => { got.push(url); return true; });
  await listening(server);
  assert.equal(await handOff([missing, running], "slopify://p/abcdefghijklmnop"), true);
  assert.deepEqual(got, ["slopify://p/abcdefghijklmnop"]);
  await close(server);
});
