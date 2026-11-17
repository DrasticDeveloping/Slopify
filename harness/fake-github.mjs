// A stand-in for api.github.com and github.com, for recording PR #70's proof.
// Serves a few test releases of DrasticDeveloping/Slopify; the app reaches it through
// Chromium's --host-resolver-rules. Logs every request. Scenario: GET /__scenario/<name>.
// usage: node fake-github.mjs <port> <installed version> <log file>
import https from "node:https";
import fs from "node:fs";
import path from "node:path";

const [port, installed, logFile] = process.argv.slice(2);
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const repo = "/repos/DrasticDeveloping/Slopify";
const base = installed.split("-")[0];
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString().replace(/\.\d+Z$/, "Z");

/** Release notes as scripts/publish-release.mjs writes them. */
const notes = (previous, platforms, line, changes) => [
  "A nightly build of Slopify: the newest changes, before they reach Stable.",
  "",
  "Download the **Setup** EXE to install Slopify (it updates itself), or the **Portable** EXE to run it without installing.",
  "",
  ...(line ? [line, ""] : []),
  `<!-- Platforms: ${platforms} -->`,
  "",
  `### What's changed since ${previous}`,
  "",
  ...changes,
  "",
  `**Full changelog:** https://github.com/DrasticDeveloping/Slopify/compare/${previous}...abcdef123456`,
  "",
].join("\n");

const v = (tag) => `v${tag}`;
const phone = `${base}-nightly.20261118.100.1`;
const desktop = `${base}-nightly.20261118.700.1`;
const release = (version, published, body) => ({
  tag_name: v(version), name: `Slopify Nightly ${version}`, draft: false, prerelease: true, published_at: published, body,
  html_url: `https://github.com/DrasticDeveloping/Slopify/releases/tag/${v(version)}`,
});
const installedRelease = release(installed, minutesAgo(180), notes("v0.0.4-nightly.20261117.943.52774", "desktop mobile", null, ["- What this copy was built from 1111111"]));
const phoneRelease = release(phone, minutesAgo(60), notes(v(installed), "mobile", "Only changes the phone app, so the Windows app doesn't offer it.", [
  "- iPhone: back swipes show the previous page sliding in (#67) 2222222",
]));
const desktopRelease = release(desktop, minutesAgo(5), notes(v(phone), "desktop mobile", null, [
  "- Phone-only nightlies stop showing the update notification on PCs (#70) 3333333",
  "- Friends page shows what your friends are playing, front and centre (#64) 4444444",
]));
const scenarios = {
  phone: [phoneRelease, installedRelease],
  desktop: [desktopRelease, phoneRelease, installedRelease],
};
let scenario = "phone";

const log = (line) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

https.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) }, (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.pathname.startsWith("/__scenario/")) {
    scenario = url.pathname.split("/")[2];
    log(`--- scenario: ${scenario} (${scenarios[scenario].map((r) => r.tag_name).join(", ")})`);
    return send(res, 200, { scenario });
  }
  log(`${req.headers.host} ${req.method} ${url.pathname}${url.search} [scenario ${scenario}]`);
  const listed = scenarios[scenario];
  if (url.pathname === `${repo}/releases`) return send(res, 200, Number(url.searchParams.get("page") || 1) > 1 ? [] : listed);
  if (url.pathname === `${repo}/releases/latest`) return send(res, 404, { message: "Not Found" });
  const download = /^\/DrasticDeveloping\/Slopify\/releases\/download\/v([^/]+)\/(nightly|latest)\.yml$/.exec(url.pathname);
  if (download) {
    const version = download[1];
    return send(res, 200, [
      `version: ${version}`,
      "files:",
      `  - url: Slopify-${version}-x64-Setup.exe`,
      "    sha512: bm90IGEgcmVhbCBpbnN0YWxsZXI=",
      "    size: 1",
      `path: Slopify-${version}-x64-Setup.exe`,
      "sha512: bm90IGEgcmVhbCBpbnN0YWxsZXI=",
      `releaseDate: '${listed.find((r) => r.tag_name === v(version))?.published_at}'`,
      "",
    ].join("\n"), "text/yaml");
  }
  send(res, 404, { message: "Not Found" });
}).listen(Number(port), "127.0.0.1", () => log(`fake GitHub listening on ${port}; installed ${installed}; phone-only ${phone}; desktop ${desktop}`));
