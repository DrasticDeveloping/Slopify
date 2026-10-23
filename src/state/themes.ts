import { getState } from "./store";
import { toast, updateSettings } from "./actions";
import type { BuiltinTheme, CustomTheme, Settings } from "./store";

/*
 * Themes you make yourself (Settings → Appearance): a name, two accent colours
 * and a background. The panels and the third glow colour are mixed from those
 * in CSS (`:root[data-theme="custom"]`), so every theme stays readable on the
 * app's light text. They are saved with your settings, so they follow you to
 * your other devices.
 */

export const MAX_CUSTOM_THEMES = 12;
const HEX = /^#[0-9a-f]{6}$/i;

/** The built-in themes, with the colours a new theme starts from when one of them is chosen. */
export const builtinThemes: Array<{ id: BuiltinTheme; name: string; note: string; swatch: [string, string, string] }> = [
  { id: "dynamic", name: "Dynamic", note: "Follows the artwork", swatch: ["#ff7ab6", "#7c5cff", "#2dd4bf"] },
  { id: "midnight", name: "Midnight", note: "Violet classic", swatch: ["#8b5cf6", "#6366f1", "#14121f"] },
  { id: "ocean", name: "Ocean", note: "Deep blues", swatch: ["#38bdf8", "#2563eb", "#0b1626"] },
  { id: "forest", name: "Forest", note: "Calm greens", swatch: ["#4ade80", "#059669", "#0b1a12"] },
  { id: "sunset", name: "Sunset", note: "Warm coral", swatch: ["#fb923c", "#e11d48", "#1f0f0c"] },
  { id: "mono", name: "Mono", note: "Quiet greyscale", swatch: ["#f4f4f5", "#a1a1aa", "#18181b"] },
];

/** A theme as saved, if it is one (settings can come from older versions or other devices). */
function valid(t: unknown): t is CustomTheme {
  if (!t || typeof t !== "object") return false;
  const c = t as Record<string, unknown>;
  return typeof c.id === "string" && c.id.startsWith("custom-") && typeof c.name === "string"
    && [c.accent, c.accent2, c.background].every((v) => typeof v === "string" && HEX.test(v));
}

/** Your themes, leaving out anything malformed. */
export function customThemes(settings: Settings): CustomTheme[] {
  return Array.isArray(settings.customThemes) ? settings.customThemes.filter(valid) : [];
}

/** The theme you made that's chosen now, if one is. */
export function activeCustomTheme(settings: Settings) {
  return customThemes(settings).find((t) => t.id === settings.theme) ?? null;
}

const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
/** Relative luminance (WCAG), 0 for black to 1 for white. */
export function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = channel(hex, at);
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark text on light accents, light text on dark ones. */
export const onAccent = (accent: string) => (luminance(accent) > 0.33 ? "#0b0a10" : "#ffffff");

/** Backgrounds this light make the app's light text hard to read. */
export const tooLight = (background: string) => luminance(background) > 0.12;

const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
function hsl(h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${hex(f(0) * 255)}${hex(f(8) * 255)}${hex(f(4) * 255)}`;
}

/** A random pair of accents that go together, on a dark background with a hint of their colour. */
export function randomColours(): Pick<CustomTheme, "accent" | "accent2" | "background"> {
  const h = Math.random() * 360;
  const h2 = (h + 30 + Math.random() * 120) % 360;
  return { accent: hsl(h, 0.85, 0.66), accent2: hsl(h2, 0.75, 0.55), background: hsl(h, 0.35, 0.05) };
}

const newId = (): CustomTheme["id"] => `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Makes a new theme from the colours of the one chosen now, and switches to it. */
export function createTheme() {
  const settings = getState().settings;
  const mine = customThemes(settings);
  if (mine.length >= MAX_CUSTOM_THEMES) {
    toast(`You can keep up to ${MAX_CUSTOM_THEMES} themes`, { detail: "Delete one to make another." });
    return;
  }
  const current = activeCustomTheme(settings);
  const builtin = builtinThemes.find((t) => t.id === settings.theme && t.id !== "dynamic");
  const colours = current
    ? { accent: current.accent, accent2: current.accent2, background: current.background }
    : builtin
      ? { accent: builtin.swatch[0], accent2: builtin.swatch[1], background: builtin.swatch[2] }
      : randomColours();
  const names = new Set(mine.map((t) => t.name));
  let n = mine.length + 1;
  while (names.has(`My theme ${n}`)) n++;
  const theme: CustomTheme = { id: newId(), name: mine.length ? `My theme ${n}` : "My theme", ...colours };
  updateSettings({ customThemes: [...mine, theme], theme: theme.id });
}

export function updateTheme(id: string, patch: Partial<Omit<CustomTheme, "id">>) {
  const mine = customThemes(getState().settings);
  const clean = Object.fromEntries(Object.entries(patch).filter(([key, v]) => (key === "name" ? typeof v === "string" : typeof v === "string" && HEX.test(v))));
  if ("name" in clean) clean.name = (clean.name as string).slice(0, 32);
  updateSettings({ customThemes: mine.map((t) => (t.id === id ? { ...t, ...clean } : t)) });
}

/** Deletes a theme (with Undo); if it was chosen, Dynamic takes over. */
export function deleteTheme(id: string) {
  const settings = getState().settings;
  const mine = customThemes(settings);
  const theme = mine.find((t) => t.id === id);
  if (!theme) return;
  const wasChosen = settings.theme === id;
  updateSettings({ customThemes: mine.filter((t) => t.id !== id), ...(wasChosen ? { theme: "dynamic" as const } : {}) });
  toast(`Deleted “${theme.name}”`, {
    action: {
      label: "Undo",
      run: () => {
        const now = getState().settings;
        const kept = customThemes(now);
        if (kept.some((t) => t.id === id)) return;
        if (kept.length >= MAX_CUSTOM_THEMES) {
          toast(`Couldn't bring back “${theme.name}”`, { detail: `You already have ${MAX_CUSTOM_THEMES} themes. Delete one first.` });
          return;
        }
        const at = Math.min(mine.indexOf(theme), kept.length);
        updateSettings({ customThemes: [...kept.slice(0, at), theme, ...kept.slice(at)], ...(wasChosen ? { theme: id as Settings["theme"] } : {}) });
      },
    },
  });
}
