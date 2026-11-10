import type { Track } from "../data/types";

/**
 * Each song's all-time plays: its play counter, or its plays in the listening history if that has more
 * (songs found online count only there). Home and Your stats rank from this, so they agree.
 */
export function allTimePlays(tracks: Record<string, Track>, listens: ReadonlyArray<{ trackId: string }>) {
  const logged = new Map<string, number>();
  for (const l of listens) logged.set(l.trackId, (logged.get(l.trackId) ?? 0) + 1);
  const plays = new Map<string, number>();
  for (const t of Object.values(tracks)) plays.set(t.id, Math.max(t.plays, logged.get(t.id) ?? 0));
  return plays;
}

/** Artists by all-time plays of their songs, most first, with the counts (artists never played are left out). */
export function topArtistPlays(tracks: Record<string, Track>, plays: Map<string, number>, limit: number) {
  const byArtist: Record<string, number> = {};
  for (const t of Object.values(tracks)) byArtist[t.artistId] = (byArtist[t.artistId] ?? 0) + (plays.get(t.id) ?? 0);
  return Object.entries(byArtist).filter(([id, n]) => n > 0 && id !== "ar_local").sort((a, b) => b[1] - a[1]).slice(0, limit);
}
