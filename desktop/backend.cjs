const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Run the same backend as `npm start`, inside Electron's bundled Node runtime.
// The utility process's own command-line switches aren't server arguments.
process.argv = [process.execPath, path.join(__dirname, "../server/main.mjs")];
process.parentPort.on("message", ({ data }) => {
  if (data === "shutdown") process.emit("SIGTERM");
});
import(pathToFileURL(process.argv[1]).href).catch((error) => {
  console.error(error);
  process.exit(1);
});
