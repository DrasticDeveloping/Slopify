/*
 * Draws the Mac app's pictures from their SVGs, with Electron's own renderer:
 * the app icon (assets/icon-mac.svg, which package-mac.mjs turns into the .icns)
 * and the menu bar icon (assets/tray-mac.svg, a template image macOS tints).
 * The PNGs are kept in the repository, so run this only after changing an SVG:
 *
 *   npx electron scripts/render-mac-icons.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const jobs = [
  ["assets/icon-mac.svg", 1024, "assets/icon-mac.png"],
  ["assets/tray-mac.svg", 18, "desktop/icons/trayTemplate.png"],
  ["assets/tray-mac.svg", 36, "desktop/icons/trayTemplate@2x.png"],
];

app.disableHardwareAcceleration();
app.dock?.hide();
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1024, height: 1024, useContentSize: true, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  await window.loadURL("data:text/html,<html><body style='margin:0;background:transparent;overflow:hidden'></body></html>");
  for (const [source, size, output] of jobs) {
    const svg = fs.readFileSync(path.join(root, source)).toString("base64");
    // Offscreen pages draw at 1:1, so the picture is exactly `size` pixels.
    await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const img = new Image(${size}, ${size});
      img.style.display = "block";
      img.onload = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
      img.src = "data:image/svg+xml;base64,${svg}";
      document.body.replaceChildren(img);
    })`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const { width, height } = image.getSize();
    if (width !== size || height !== size) throw new Error(`${output} came out ${width}x${height}, not ${size}x${size}.`);
    fs.writeFileSync(path.join(root, output), image.toPNG());
    console.log(`${output} (${size}x${size})`);
  }
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
