import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

// iOS keeps media outside WebKit's blob registry. The web cache remains a
// migration/backup source; these files survive page and network-process resets.
export class DeviceFiles {
  constructor(dataDir) {
    this.root = path.join(dataDir, "device-files");
    this.pending = new Map();
    // Finish crash recovery before accepting writes, so a sweep never sees a live upload as an orphan.
    this.ready = this.sweep();
  }

  async sweep() {
    await fs.mkdir(this.root, { recursive: true });
    const files = await fs.readdir(this.root);
    const referenced = new Set();
    for (const name of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(this.root, name), "utf8"));
        if (/^[a-f0-9-]+\.media$/.test(metadata.file)) referenced.add(metadata.file);
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
    for (const name of files) {
      if ((name.endsWith(".media") && !referenced.has(name)) || name.endsWith(".tmp")) {
        await fs.rm(path.join(this.root, name), { force: true });
      }
    }
  }

  mutate(id, operation) {
    const key = this.key(id);
    const task = (this.pending.get(key) || Promise.resolve()).catch(() => undefined).then(() => this.ready).then(operation);
    this.pending.set(key, task);
    return task.finally(() => { if (this.pending.get(key) === task) this.pending.delete(key); });
  }

  key(id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Object.assign(new Error("Invalid device song id."), { status: 400 });
    return createHash("sha256").update(id).digest("hex");
  }

  async get(id) {
    await this.ready;
    const key = this.key(id);
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(this.root, `${key}.json`), "utf8"));
      if (!/^[a-f0-9-]+\.media$/.test(metadata.file)) return null;
      const filePath = path.join(this.root, metadata.file);
      const stat = await fs.stat(filePath);
      return stat.size === metadata.size ? { ...metadata, filePath } : null;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  put(id, source, contentType) {
    return this.mutate(id, () => this.write(id, source, contentType));
  }

  async write(id, source, contentType) {
    const key = this.key(id);
    const type = /^(audio|video)\/[a-z0-9.+-]+$/i.test(contentType) ? contentType : "application/octet-stream";
    await fs.mkdir(this.root, { recursive: true });
    const file = `${randomUUID()}.media`;
    const filePath = path.join(this.root, file);
    const temp = path.join(this.root, `${key}.${randomUUID()}.tmp`);
    const handle = await fs.open(filePath, "wx");
    let size = 0;
    const digest = createHash("sha256");
    try {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > 512 * 1024 * 1024) throw Object.assign(new Error("Song exceeds the 512 MB device-file limit."), { status: 413 });
        digest.update(chunk);
        // FileHandle.write can write fewer bytes than requested.
        let offset = 0;
        while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
      if (!size) throw Object.assign(new Error("Empty song file."), { status: 400 });
      await handle.sync();
      await handle.close();
      // Read the manifest even if its file has the wrong size: replacing a damaged copy must free it too.
      let oldFile;
      try {
        const old = JSON.parse(await fs.readFile(path.join(this.root, `${key}.json`), "utf8"));
        if (/^[a-f0-9-]+\.media$/.test(old.file)) oldFile = path.join(this.root, old.file);
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
      const metadata = { file, size, type, sha256: digest.digest("hex") };
      await fs.writeFile(temp, JSON.stringify(metadata));
      await fs.rename(temp, path.join(this.root, `${key}.json`));
      if (oldFile) await fs.rm(oldFile, { force: true }).catch(() => undefined);
      return metadata;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  remove(id) {
    return this.mutate(id, () => this.deleteFile(id));
  }

  async deleteFile(id) {
    const key = this.key(id);
    const old = await this.get(id);
    await fs.rm(path.join(this.root, `${key}.json`), { force: true });
    if (old) await fs.rm(old.filePath, { force: true });
  }
}
