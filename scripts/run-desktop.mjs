import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);

export function launchDesktop(overrides = {}) {
  const env = { ...process.env, ...overrides };
  // T3's CLI uses this flag for its own helpers; the app needs the GUI runtime.
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve) => {
    const child = spawn(require("electron"), [fileURLToPath(new URL("../", import.meta.url))], {
      // Electron is a GUI application: hiding its startup window can suppress
      // the first BrowserWindow.show() on Windows.
      env, stdio: "inherit"
    });
    const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
      const handler = () => child.kill(signal);
      process.once(signal, handler);
      return [signal, handler];
    });
    const finish = (code) => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      resolve(code ?? 1);
    };
    child.once("error", (error) => { console.error(error.message); finish(1); });
    child.once("exit", finish);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await launchDesktop();
}
