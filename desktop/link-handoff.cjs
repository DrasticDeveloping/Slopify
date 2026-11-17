/*
 * Handing a Slopify link to the Slopify that's already open.
 *
 * The single-instance lock only covers copies sharing a profile, so an installed
 * Slopify and a checkout run (`npm run desktop`, profile "Slopify Dev") don't see
 * each other. Windows sends a link to whichever copy registered slopify:// last
 * (and every installer update re-registers the installed one), so clicking a
 * link could start a second Slopify beside the one in use. Instead, each copy
 * listens on a local pipe named after its profile, and a copy started by a link
 * first offers it to the others; if one takes it, the new copy quits.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const MAX_LINE = 512;

/** The pipe (Windows) or socket (elsewhere) the copy using `profileDir` listens on. */
function linkPipe(profileDir) {
  const resolved = path.resolve(profileDir);
  if (process.platform !== "win32") return path.join(resolved, "links.sock");
  const key = crypto.createHash("sha256").update(resolved.toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\slopify-links-${key}`;
}

/** Takes links from other copies, passing each line to `onLink`. Returns the server. */
function listenForLinks(profileDir, onLink) {
  const pipe = linkPipe(profileDir);
  // A socket file left by a copy that crashed; only one copy per profile gets this far (the lock).
  if (process.platform !== "win32") fs.rmSync(pipe, { force: true });
  const server = net.createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      text += chunk;
      const end = text.indexOf("\n");
      if (end < 0) {
        if (text.length > MAX_LINE) socket.destroy();
        return;
      }
      const accepted = onLink(text.slice(0, end).trim()) !== false;
      socket.end(accepted ? "ok\n" : "no\n");
    });
  });
  server.on("error", () => {}); // Without the pipe, links still reach this copy the usual way.
  server.listen(pipe);
  return server;
}

/** Offers `url` to the copy using `profileDir`; true if one is running and took it. */
function offerLink(profileDir, url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect(linkPipe(profileDir));
    let reply = "";
    const done = (taken) => { socket.destroy(); resolve(taken); };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write(url + "\n"));
    socket.on("data", (chunk) => {
      reply += chunk;
      if (reply.includes("\n")) done(reply.startsWith("ok"));
    });
    socket.on("end", () => done(reply.startsWith("ok")));
  });
}

/** Offers `url` to each profile in turn; true once one takes it. */
async function handOff(profileDirs, url) {
  for (const dir of profileDirs) if (await offerLink(dir, url)) return true;
  return false;
}

module.exports = { linkPipe, listenForLinks, offerLink, handOff };
