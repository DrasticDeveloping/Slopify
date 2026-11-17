/** On a Mac (the desktop app, or a browser), ⌘ does what Ctrl does, and Option (⌥) is Alt. */
export const onMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** A shortcut as written for Windows ("Ctrl K", "Ctrl+A", "Alt ←"), as this computer's keyboard labels it. */
export const keyLabel = (keys: string) =>
  onMac ? keys.replace(/\bCtrl\+/g, "⌘").replace(/\bCtrl /g, "⌘ ").replace(/\bAlt\+/g, "⌥").replace(/\bAlt /g, "⌥ ") : keys;
