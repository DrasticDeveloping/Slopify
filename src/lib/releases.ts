/*
 * Words for Slopify versions in the update banner and What's new. Nightly versions
 * look like 0.0.4-nightly.20261115.638.45286: the version, then the UTC date, HHMM
 * and seconds+milliseconds of the build. Times are shown in local time.
 */

export const isNightly = (version: string) => /-nightly\./.test(version);

/** "0.0.4" from "0.0.4-nightly.…". */
export const baseVersion = (version: string) => version.split("-")[0];

/** When a version was built: its release date if known, otherwise read from a nightly's version. */
export function builtAt(version: string, releaseDate?: string | null): Date | null {
  const known = releaseDate ? new Date(releaseDate) : null;
  if (known && !Number.isNaN(known.getTime())) return known;
  const stamp = /-nightly\.(\d{4})(\d{2})(\d{2})\.(\d{1,4})\b/.exec(version);
  if (!stamp) return null;
  const [, y, mo, d, hhmm] = stamp;
  const t = Number(hhmm);
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Math.floor(t / 100), t % 100));
}

const time = (date: Date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "today", "yesterday", or "Nov 12" (with the year when it isn't this year), in local time. */
function day(date: Date, now: Date) {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "today", "Nov 12" */
export const dayOf = (date: Date, now = new Date()) => day(date, now);

/** "today at 06:38" */
export const whenBuilt = (date: Date, now = new Date()) => `${day(date, now)} at ${time(date)}`;

/** "Today, 06:38" */
export const buildLabel = (date: Date, now = new Date()) => `${capital(day(date, now))}, ${time(date)}`;

/** "Nov 14, 06:21" */
export const shortStamp = (date: Date) => `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time(date)}`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
