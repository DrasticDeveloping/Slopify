/*
 * Assembles what the iPhone app's Node runs (ios/App/App/nodejs-project): the
 * music server (server/), the built web app it serves (dist/), and the start
 * files (mobile/node). nodejs-mobile has no ICU, so Unicode property
 * patterns (\p{L}) in the server are rewritten into plain character ranges here,
 * and unorm comes along for text normalization. Used by scripts/ios-sim.mjs.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const rewritePattern = require("regexpu-core");

/** What looks like a regular expression literal, and its flags (only ones using \p{…} are changed). */
const LITERAL = /\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+)\/([dgimsuy]*)/g;
const UNICODE_PROPERTY = /\\[pP]\{/;

const sources = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(mjs|cjs|js)$/.test(f)).map((f) => path.join(dir, f));

export function buildNodeProject(root) {
  const project = path.join(root, "ios", "App", "App", "nodejs-project");
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(root, "server"), path.join(project, "server"), { recursive: true });
  fs.cpSync(path.join(root, "dist"), path.join(project, "dist"), { recursive: true });
  // start.mjs and what it adds to Node before the server loads.
  fs.cpSync(path.join(root, "mobile", "node"), project, { recursive: true });
  fs.copyFileSync(require.resolve("unorm"), path.join(project, "unorm.cjs"));

  let rewritten = 0;
  for (const file of sources(path.join(project, "server"))) {
    const text = fs.readFileSync(file, "utf8");
    const next = text.replace(LITERAL, (literal, pattern, flags) => {
      if (!flags.includes("u") || !UNICODE_PROPERTY.test(pattern)) return literal;
      rewritten++;
      return `/${rewritePattern(pattern, flags, { unicodePropertyEscapes: "transform" })}/${flags}`;
    });
    if (next !== text) fs.writeFileSync(file, next);
  }
  // A Unicode pattern left as it was stops the server from loading at all.
  const left = sources(path.join(project, "server")).filter((f) => UNICODE_PROPERTY.test(fs.readFileSync(f, "utf8")));
  if (left.length) throw new Error(`Unicode patterns that couldn't be rewritten for the iPhone app remain in: ${left.join(", ")}`);
  return { project, rewritten };
}
