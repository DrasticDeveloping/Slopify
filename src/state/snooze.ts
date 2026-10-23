import { next, toast, updateSettings } from "./actions";
import { getState, snoozedUntil, type AppState, type MenuItem } from "./store";

/*
 * Snoozed songs are skipped whenever playback moves on by itself (the next song
 * in a playlist, album, shuffle, autoplay or slip-ins) until their time is up.
 * Playing one yourself, or queueing it, still plays it. Snoozes are saved with
 * your settings, so they follow you to your other devices.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const SNOOZE_LENGTHS: Array<[string, number]> = [
  ["1 hour", HOUR],
  ["1 day", DAY],
  ["1 week", 7 * DAY],
  ["1 month", 30 * DAY],
  ["3 months", 91 * DAY],
];

/** When a snooze ends, as "until 4:30 pm" today or "until Tue 14 Nov" later. */
export function snoozeEnds(until: number, now = Date.now()) {
  const end = new Date(until);
  if (end.toDateString() === new Date(now).toDateString()) return `until ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  const sameYear = end.getFullYear() === new Date(now).getFullYear();
  return `until ${end.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })}`;
}

/** Your snoozes that haven't ended. */
function current(now = Date.now()) {
  return Object.fromEntries(Object.entries(getState().settings.snoozed ?? {}).filter(([, until]) => typeof until === "number" && until > now));
}

/** Snoozed songs, soonest back first. */
export function snoozedSongs(s: Pick<AppState, "settings" | "tracks">, now = Date.now()) {
  return Object.entries(s.settings.snoozed ?? {}).filter(([, until]) => typeof until === "number" && until > now).filter(([id]) => s.tracks[id]).sort((a, b) => a[1] - b[1]).map(([id, until]) => ({ id, until }));
}

/** Snoozes `ids` for `ms`. Snoozing the song that's playing skips it now. */
export function snooze(ids: string[], ms: number, length: string) {
  const s = getState();
  const songs = ids.filter((id) => s.tracks[id] && !s.tracks[id].stream);
  if (!songs.length) return;
  const before = s.settings.snoozed ?? {};
  const until = Date.now() + ms;
  updateSettings({ snoozed: { ...current(), ...Object.fromEntries(songs.map((id) => [id, until])) } });
  const skipped = s.isPlaying && s.currentId && songs.includes(s.currentId) ? s.currentId : null;
  if (skipped) next();
  const title = songs.length === 1 ? `“${s.tracks[songs[0]].title}”` : `${songs.length} songs`;
  toast(`Snoozed ${title} for ${length}`, {
    detail: `${songs.length === 1 ? "It's" : "They're"} skipped ${snoozeEnds(until)}. Play ${songs.length === 1 ? "it" : "them"} yourself any time.`,
    action: {
      label: "Undo",
      run: () => {
        const now = current();
        for (const id of songs) {
          if (typeof before[id] === "number" && before[id] > Date.now()) now[id] = before[id];
          else delete now[id];
        }
        updateSettings({ snoozed: now });
      },
    },
  });
}

/** Ends the snooze on `ids`, so they play as usual again. */
export function wake(ids: string[]) {
  const now = current();
  const woken = ids.filter((id) => now[id]);
  if (!woken.length) return;
  for (const id of woken) delete now[id];
  updateSettings({ snoozed: now });
}

/** "Snooze" with its lengths, or "Stop snoozing" when every song is snoozed already. */
export function snoozeItem(ids: string[]): MenuItem | null {
  const s = getState();
  const songs = ids.filter((id) => s.tracks[id] && !s.tracks[id].stream);
  if (!songs.length) return null;
  const now = Date.now();
  if (songs.every((id) => snoozedUntil(s, id, now))) return { label: "Stop snoozing", icon: "snooze", run: () => wake(songs) };
  return { label: "Snooze", icon: "snooze", submenu: SNOOZE_LENGTHS.map(([label, ms]) => ({ label: `For ${label}`, run: () => snooze(songs, ms, label) })) };
}
