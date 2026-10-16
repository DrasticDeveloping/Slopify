/*
 * Where the iPhone app's Node starts (ios/App/App/NodeServer.swift), before
 * the music server loads. nodejs-mobile is Node 18 built for iOS, which lacks a
 * few things the server uses:
 * - fetch: Node's needs WebAssembly, which iOS doesn't allow here (./fetch.mjs);
 * - text normalization, without ICU (so "Beyoncé" still matches "Beyonce");
 * - AbortSignal.any, from Node 20.
 * Unicode patterns such as \p{L} are rewritten when the app is built
 * (scripts/ios-node-project.mjs).
 */
import { createRequire } from "node:module";
import { fetch, Headers } from "./fetch.mjs";

for (const [name, value] of Object.entries({ fetch, Headers })) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, enumerable: false, value });
}

function normalizes() {
  try {
    return "é".normalize("NFD") === "é" && "ﬁ".normalize("NFKC") === "fi";
  } catch {
    return false;
  }
}

if (!normalizes()) {
  const unorm = createRequire(import.meta.url)("./unorm.cjs");
  const forms = { NFC: unorm.nfc, NFD: unorm.nfd, NFKC: unorm.nfkc, NFKD: unorm.nfkd };
  Object.defineProperty(String.prototype, "normalize", {
    configurable: true,
    writable: true,
    value(form = "NFC") {
      const convert = forms[String(form)];
      if (!convert) throw new RangeError("The normalization form should be one of NFC, NFD, NFKC, NFKD.");
      return convert(String(this));
    },
  });
}

if (!AbortSignal.any) {
  AbortSignal.any = (signals) => {
    const controller = new AbortController();
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true, signal: controller.signal });
    }
    return controller.signal;
  };
}

await import("./server/main.mjs");
