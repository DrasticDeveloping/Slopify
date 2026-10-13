const { app, ipcMain, Menu, nativeImage, Tray } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { createDiscordPresence } = require("./discord.cjs");

/*
 * What the desktop app does beyond its window, like Discord: closing the window
 * keeps Slopify playing in the system tray (until Quit), and what's playing can
 * show on your Discord profile. Both are switched in Settings → General and kept
 * in userData/desktop-settings.json.
 */

const DEFAULTS = { closeToTray: true, discord: true };
const settingsFile = () => path.join(app.getPath("userData"), "desktop-settings.json");

function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return { closeToTray: saved.closeToTray !== false, discord: saved.discord !== false };
  } catch {
    return { ...DEFAULTS };
  }
}

/** The Discord application id this build shows as (release.config.json, or SLOPIFY_DISCORD_CLIENT_ID). */
function discordClientId() {
  let id = process.env.SLOPIFY_DISCORD_CLIENT_ID;
  if (!id) {
    try {
      id = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "release.config.json"), "utf8")).discordClientId;
    } catch { /* No config: no Discord status. */ }
  }
  return /^\d{15,25}$/.test(id ?? "") ? id : null;
}

function startBackground({ getWindow, show, log }) {
  let settings = readSettings();
  let nowPlaying = null;
  let tray = null;
  let toldAboutTray = false;
  let closed = false;
  const clientId = discordClientId();
  const discord = clientId ? createDiscordPresence(clientId, log) : null;
  discord?.setEnabled(settings.discord);

  const command = (name) => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send("player:command", name);
  };

  function buildTray() {
    if (closed) return;
    if (!tray) {
      const icon = nativeImage.createFromPath(path.join(app.getAppPath(), "dist/icons/icon-512.png")).resize({ width: 16, height: 16, quality: "best" });
      tray = new Tray(icon);
      tray.on("click", show);
    }
    const playing = nowPlaying?.title ? `${nowPlaying.title}${nowPlaying.artist ? ` · ${nowPlaying.artist}` : ""}` : null;
    tray.setToolTip(playing ? `Slopify: ${playing}`.slice(0, 127) : "Slopify");
    tray.setContextMenu(Menu.buildFromTemplate([
      ...(playing ? [{ label: playing.slice(0, 60), enabled: false }, { type: "separator" }] : []),
      { label: "Show Slopify", click: show },
      { label: nowPlaying?.playing ? "Pause" : "Play", enabled: Boolean(nowPlaying), click: () => command("toggle") },
      { label: "Next", enabled: Boolean(nowPlaying), click: () => command("next") },
      { label: "Previous", enabled: Boolean(nowPlaying), click: () => command("previous") },
      { type: "separator" },
      { label: "Quit Slopify", click: () => app.quit() },
    ]));
  }
  buildTray();

  ipcMain.handle("desktop:get-settings", () => ({ ...settings, discordAvailable: Boolean(discord) }));
  ipcMain.handle("desktop:set-settings", (_event, patch) => {
    const next = { ...settings };
    if (typeof patch?.closeToTray === "boolean") next.closeToTray = patch.closeToTray;
    if (typeof patch?.discord === "boolean") next.discord = patch.discord;
    settings = next;
    try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch (error) { log(`[desktop] settings: ${error}\n`); }
    discord?.setEnabled(settings.discord);
    return { ...settings, discordAvailable: Boolean(discord) };
  });
  ipcMain.on("player:now-playing", (_event, now) => {
    nowPlaying = now && typeof now === "object" && typeof now.title === "string" ? now : null;
    buildTray();
    discord?.setNowPlaying(nowPlaying);
  });

  return {
    /** Whether closing the window should hide it to the tray instead of quitting. */
    keepInTray: () => settings.closeToTray,
    hidden() {
      if (toldAboutTray || process.platform !== "win32") return;
      toldAboutTray = true;
      tray?.displayBalloon({ title: "Slopify is still running", content: "It keeps playing here. Right-click the icon to quit.", iconType: "none" });
    },
    close() {
      closed = true;
      discord?.close();
      tray?.destroy();
      tray = null;
    },
  };
}

module.exports = { startBackground };
