/*
 * Time-synced lyrics in LRC form: "[01:02.34]A line", several stamps may share
 * one line ("[00:12.00][01:30.00]Chorus"), and "[offset:+250]" shifts every
 * stamp (positive means the words come sooner). A stamp with no words marks a
 * gap, so the last line doesn't stay lit through an instrumental break.
 */

export interface LyricLine {
  /** Seconds into the song. */
  time: number;
  /** Empty for a gap. */
  text: string;
}

const STAMP = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
const OFFSET = /^\[offset:\s*([+-]?\d+)\s*\]/im;

export function parseLrc(source: string): LyricLine[] {
  const offset = Number(source.match(OFFSET)?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const times: number[] = [];
    let rest = raw.trim();
    // Stamps lead the line; anything after the last one is its words.
    for (let m: RegExpExecArray | null; (m = STAMP.exec(rest)); ) {
      const seconds = Number(m[1]) * 60 + Number(m[2].replace(":", "."));
      if (Number.isFinite(seconds)) times.push(Math.max(0, seconds - offset));
      rest = rest.slice(m[0].length).trimStart();
    }
    if (!times.length) continue;
    // Word-level ("enhanced") stamps inside the line aren't used yet.
    const text = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").replace(/\s+/g, " ").trim();
    for (const time of times) lines.push({ time, text });
  }
  lines.sort((a, b) => a.time - b.time);
  // Leading gaps and repeated gaps say nothing.
  return lines.filter((line, i) => line.text || (i > 0 && lines[i - 1].text));
}

/** The line sung at `seconds` (the last one started), or -1 before the first. */
export function lineAt(lines: readonly LyricLine[], seconds: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= seconds) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
