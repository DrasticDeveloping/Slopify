// Preload for a dry run of scripts/publish-release.mjs: every read-only `gh` call goes to the
// real GitHub; the calls that check for or create the release are answered here instead, and
// the notes it would publish are written to DRY_RUN_NOTES. Nothing is published.
// usage: node --import ./dry-run-publish.mjs scripts/publish-release.mjs
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const real = childProcess.execFileSync;
childProcess.execFileSync = function (file, args = [], options) {
  if (file === "gh") {
    const [a, b] = args;
    if (a === "release" && b === "view") throw new Error("dry run: not published yet");
    if (a === "api" && /\/git\/matching-refs\/tags\//.test(b)) return "[]";
    if (a === "release" && b === "create") {
      const notesFile = args[args.indexOf("--notes-file") + 1];
      fs.writeFileSync(process.env.DRY_RUN_NOTES, fs.readFileSync(notesFile, "utf8"));
      process.stderr.write(`dry run: would create ${args[2]} (${args.filter((x) => x.startsWith("--")).join(" ")})\n`);
      return "";
    }
    process.stderr.write(`gh ${args.slice(0, 2).join(" ")}\n`);
  }
  return real.call(this, file, args, options);
};
syncBuiltinESMExports();
