import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.join(root, "dist");
async function list(dir, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await list(path.join(dir, entry.name), `${relative}/`));
    else if (entry.isFile() && !relative.endsWith(".map") && relative !== "sw.js") files.push(relative);
  }
  return files.sort();
}

const files = await list(dist);
if (!files.includes("index.html") || !files.includes("manifest.webmanifest")) throw new Error("Build the app before preparing its offline shell.");
const template = await fs.readFile(path.join(root, "src/pwa/service-worker.js"), "utf8");
const hash = createHash("sha256").update(template);
for (const file of files) hash.update(file).update(await fs.readFile(path.join(dist, file)));
const config = JSON.stringify({ cache: `slopify-app-${hash.digest("hex").slice(0, 16)}`, assets: files.map((f) => `/${f}`) });
const marker = "__PWA_CONFIG__";
if (template.split(marker).length !== 2) throw new Error("The service worker must contain one build configuration marker.");
await fs.writeFile(path.join(dist, "sw.js"), template.replace(marker, config));
console.log(`Prepared Slopify's offline shell (${files.length} assets).`);
