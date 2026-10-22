const { contextBridge, ipcRenderer } = require("electron");

// What the web app can ask of the desktop app. Nothing else from Node or
// Electron reaches the page.
contextBridge.exposeInMainWorld("slopifyDesktop", {
  platform: process.platform,
  /** Closing to the tray and the Discord status (desktop/background.cjs). */
  settings: {
    get: () => ipcRenderer.invoke("desktop:get-settings"),
    set: (patch) => ipcRenderer.invoke("desktop:set-settings", patch),
  },
  /** What's playing, for the tray and Discord; null when nothing is. */
  nowPlaying: (now) => ipcRenderer.send("player:now-playing", now),
  /** Play/pause, next and previous from the tray. */
  onCommand(listener) {
    const handler = (_event, name) => listener(name);
    ipcRenderer.on("player:command", handler);
    return () => ipcRenderer.removeListener("player:command", handler);
  },
  /** Whether the window can be seen (not minimised or hidden in the tray). */
  onWindowShown(listener) {
    const handler = (_event, shown) => listener(shown);
    ipcRenderer.on("desktop:window-shown", handler);
    // As it is now, too (the page may have reloaded while hidden).
    void ipcRenderer.invoke("desktop:window-shown").then(listener);
    return () => ipcRenderer.removeListener("desktop:window-shown", handler);
  },
  /** Slopify links the app was opened with (a shared playlist's page): one now if one is waiting, then each as it comes. */
  onLink(listener) {
    const handler = (_event, link) => listener(link);
    ipcRenderer.on("desktop:link", handler);
    void ipcRenderer.invoke("desktop:links-ready");
    return () => ipcRenderer.removeListener("desktop:link", handler);
  },
  updates: {
    get: () => ipcRenderer.invoke("updates:get"),
    check: () => ipcRenderer.invoke("updates:check"),
    setChannel: (channel) => ipcRenderer.invoke("updates:set-channel", channel),
    install: () => ipcRenderer.invoke("updates:install"),
    onChange(listener) {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("updates:state", handler);
      return () => ipcRenderer.removeListener("updates:state", handler);
    },
  },
});

// Styles for the app's own title bar (see .desktop in app.css).
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("desktop", `desktop-${process.platform}`);
});
