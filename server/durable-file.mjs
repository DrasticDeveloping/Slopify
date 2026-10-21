import fs from "node:fs/promises";

/*
 * Library files that survive a full disk, a crash or a power cut.
 *
 * Writing a temporary file and renaming it over the old one isn't enough on its
 * own: the rename can reach the disk before the new file's contents do. When
 * the disk then fills up or the computer stops, Windows can leave the file at
 * its full size but all zeros (that's how library-state.json was lost once).
 * So the new contents are flushed to the disk before the rename, and the
 * previous version is kept as `<file>.bak` to fall back on.
 */

const backupOf = (file) => `${file}.bak`;

/** Removes `file` and its backup. */
export async function removeDurably(file) {
  await fs.rm(file, { force: true });
  await fs.rm(backupOf(file), { force: true });
}

/** Replaces `file` with `text`: flushed to the disk first, keeping the previous version as `<file>.bak`. `beforeReplace` may throw to cancel. */
export async function writeDurably(file, text, beforeReplace = () => {}) {
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let handle = null;
  try {
    handle = await fs.open(temp, "w");
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = null;
    beforeReplace();
    // The current file was read back successfully (or the write would have been refused), so it's a good backup.
    await fs.rename(file, backupOf(file)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await fs.rename(temp, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Whether `text` holds nothing at all: empty, or only zero bytes and spaces (what a lost write leaves). */
const blank = (text) => !text.replace(/[\0\s]/g, "");

/**
 * Reads and checks a JSON library file, falling back on its backup when the file
 * is missing or damaged. Returns `{ value, from }` ("file" or "backup"), or null
 * when neither exists. Throws `damaged(file)` when the file is damaged and there's
 * no good backup, so a real library is never overwritten, unless the damaged file
 * is blank and `blankIsEmpty` says starting afresh loses nothing (then it's moved
 * aside and null is returned).
 */
export async function readDurably(file, { valid = () => true, damaged, blankIsEmpty = false }) {
  const attempt = async (path) => {
    let text;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { missing: true };
      throw error;
    }
    try {
      const value = JSON.parse(text);
      return valid(value) ? { value } : { bad: true, blank: false };
    } catch {
      return { bad: true, blank: blank(text) };
    }
  };
  const main = await attempt(file);
  if ("value" in main) return { value: main.value, from: "file" };
  const backup = await attempt(backupOf(file));
  if ("value" in backup) {
    if (main.bad) {
      console.warn(`[slopify] ${file} is damaged; using its backup (${backupOf(file)}). The damaged file is kept beside it.`);
      await fs.rename(file, `${file}.damaged-${Date.now()}`).catch(() => undefined);
    }
    return { value: backup.value, from: "backup" };
  }
  // A fresh start only when there's nothing at all: no file and no backup.
  if (main.missing && backup.missing) return null;
  // Blank files hold nothing to lose: where that's allowed, they're moved aside and it starts afresh.
  const blankOrMissing = (r) => r.missing || (r.bad && r.blank);
  if (blankIsEmpty && blankOrMissing(main) && blankOrMissing(backup)) {
    console.warn(`[slopify] ${file} was blank (lost in an interrupted write); starting it afresh. It's kept as ${file}.damaged-*.`);
    const at = Date.now();
    if (!main.missing) await fs.rename(file, `${file}.damaged-${at}`);
    if (!backup.missing) await fs.rename(backupOf(file), `${backupOf(file)}.damaged-${at}`);
    return null;
  }
  throw damaged(main.missing ? backupOf(file) : file);
}
