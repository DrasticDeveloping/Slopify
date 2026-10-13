import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Temporary files a server works with (stream previews, song files it's serving)
 * live in the library's data folder, one folder per running server, named by
 * its process id. Servers sharing a data folder leave each other's alone. A
 * server deletes its own folder when it exits; one that crashed, or was stopped
 * outright (skipping that), is cleared out by the next server to start.
 */

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just isn't ours to signal.
    return error?.code === "EPERM";
  }
}

/** Deletes the folders in `root` that belong to servers no longer running (never this server's own; runFolder empties that). */
export async function sweepRunFolders(root) {
  for (const name of await fs.readdir(root).catch(() => [])) {
    const pid = Number(name);
    if (Number.isSafeInteger(pid) && pid > 0 && (pid === process.pid || running(pid))) continue;
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Deletes folders earlier versions made in the system temp folder (named like `pattern`) and left for over two days. */
export async function sweepOldTemp(pattern) {
  const root = os.tmpdir();
  for (const name of await fs.readdir(root).catch(() => [])) {
    if (!pattern.test(name)) continue;
    const dir = path.join(root, name);
    const info = await fs.stat(dir).catch(() => null);
    if (info?.isDirectory() && Date.now() - info.mtimeMs > 2 * 86_400_000) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** This server's own folder in `root`, empty to begin with, and deleted when the server exits. */
export async function runFolder(root) {
  await sweepRunFolders(root);
  const dir = path.join(root, String(process.pid));
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A file still open: the next server to start clears it.
    }
  });
  return dir;
}
