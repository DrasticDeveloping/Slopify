import { next, nextTrackId, toast, togglePlay, updateSettings } from "./actions";
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

/** When a snooze ends, as "until 4:30 pm" today or "until Tue 14 Nov, 8:00 am" later. */
export function snoozeEnds(until: number, now = Date.now()) {
  const end = new Date(until);
  const time = end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (end.toDateString() === new Date(now).toDateString()) return `until ${time}`;
  const sameYear = end.getFullYear() === new Date(now).getFullYear();
  return `until ${end.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })}, ${time}`;
}

/** When a snooze of `ms` from now would end, short enough for a menu: "5:12 pm", "Wed 18 Nov", or "24 Nov". */
function endsNote(ms: number, now = Date.now()) {
  const end = new Date(now + ms);
  if (ms < DAY) return end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameYear = end.getFullYear() === new Date(now).getFullYear();
  return end.toLocaleDateString([], { ...(ms < 7 * DAY ? { weekday: "short" } : {}), day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Your snoozes that haven't ended. */
function current(now = Date.now()) {
  return Object.fromEntries(Object.entries(getState().settings.snoozed ?? {}).filter(([, until]) => typeof until === "number" && until > now));
}

/** Snoozed songs, soonest back first. */
export function snoozedSongs(s: Pick<AppState, "settings" | "tracks">, now = Date.now()) {
  return Object.entries(s.settings.snoozed ?? {}).filter(([, until]) => typeof until === "number" && until > now).filter(([id]) => s.tracks[id]).sort((a, b) => a[1] - b[1]).map(([id, until]) => ({ id, until }));
}

/** Snoozes `ids` for `ms`. Snoozing the song that's playing skips it now, or stops it when nothing follows. */
export function snooze(ids: string[], ms: number, length: string) {
  snoozeTill(ids, Date.now() + ms, `for ${length}`);
}

/** Snoozes `ids` until `until` (ms since 1970), a time picked on the calendar. */
export function snoozeUntil(ids: string[], until: number) {
  snoozeTill(ids, until, snoozeEnds(until), true);
}

/** `when` finishes the toast's title ("for 1 week", "until Thu 26 Nov, 8:00 am"); `exact` when it already says when it ends. */
function snoozeTill(ids: string[], until: number, when: string, exact = false) {
  const s = getState();
  const songs = ids.filter((id) => s.tracks[id] && !s.tracks[id].stream);
  if (!songs.length || until <= Date.now()) return;
  const before = s.settings.snoozed ?? {};
  updateSettings({ snoozed: { ...current(), ...Object.fromEntries(songs.map((id) => [id, until])) } });
  const skipped = s.isPlaying && s.currentId && songs.includes(s.currentId) ? s.currentId : null;
  if (skipped) {
    if (nextTrackId()) next();
    else togglePlay();
  }
  const title = songs.length === 1 ? `“${s.tracks[songs[0]].title}”` : `${songs.length} songs`;
  toast(`Snoozed ${title} ${when}`, {
    detail: `${songs.length === 1 ? "It's" : "They're"} skipped ${exact ? "till then" : snoozeEnds(until)}. Play ${songs.length === 1 ? "it" : "them"} yourself any time.`,
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

/** "Snooze" with its lengths (each with when it would end) and a calendar to pick a day,
 *  or "Stop snoozing" when every song is snoozed already. */
export function snoozeItem(ids: string[]): MenuItem | null {
  const s = getState();
  const songs = ids.filter((id) => s.tracks[id] && !s.tracks[id].stream);
  if (!songs.length) return null;
  const now = Date.now();
  if (songs.every((id) => snoozedUntil(s, id, now))) return { label: "Stop snoozing", icon: "snooze", run: () => wake(songs) };
  return {
    label: "Snooze",
    icon: "snooze",
    submenu: [
      ...SNOOZE_LENGTHS.map(([label, ms]): MenuItem => ({ label: `For ${label}`, note: endsNote(ms, now), run: () => snooze(songs, ms, label) })),
      { separator: true },
      { label: "Pick a date…", panel: { type: "snoozeUntil", ids: songs } },
    ],
  };
}
