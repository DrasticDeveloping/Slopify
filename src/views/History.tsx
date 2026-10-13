import { useMemo, useState, type CSSProperties } from "react";
import { Art, TrackArt } from "../components/Artwork";
import { recentDays } from "../data/library";
import { formatLongDuration, plural, todayKey } from "../lib/format";
import { navigate, playList } from "../state/actions";
import { Empty } from "./Collection";
import { useStore } from "../state/store";

const RANGES = [7, 30, 90] as const;

function niceMax(v: number) {
  const step = v > 120 ? 60 : v > 60 ? 30 : 15;
  return Math.max(step, Math.ceil(v / step) * step);
}

/** Monday first. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString("en", { hour: "numeric" });
const minutesText = (seconds: number) => (seconds < 60 && seconds > 0 ? "under 1 min" : `${Math.round(seconds / 60)} min`);

/** A small bar chart of listening minutes (by hour of the day, or by weekday). */
function Breakdown({ title, labels, seconds, labelEvery = 1, describe }: { title: string; labels: string[]; seconds: number[]; labelEvery?: number; describe: (i: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...seconds.map((s) => s / 60)));
  return (
    <section className="panel chart-panel" aria-label={title}>
      <div className="chart-head">
        <h2>{title}</h2>
      </div>
      <div className="chart compact" style={{ "--n": seconds.length } as CSSProperties}>
        <div className="chart-grid" aria-hidden="true">
          {[1, 0.5, 0].map((f) => (
            <div key={f} className="gridline" style={{ "--y": f } as CSSProperties}>
              <span>{Math.round(max * f)}</span>
            </div>
          ))}
        </div>
        <div className="bars" onPointerLeave={() => setHover(null)}>
          {seconds.map((s, i) => (
            <button
              key={labels[i]}
              type="button"
              className={`bar${hover === i ? " hot" : ""}${hover !== null && hover !== i ? " dim" : ""}`}
              style={{ "--h": s / 60 / max } as CSSProperties}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${describe(i)}: ${minutesText(s)}`}
            >
              <i />
              {hover === i ? (
                <span className={`bar-tip${i > seconds.length * 0.75 ? " left" : i < seconds.length * 0.25 ? " right" : ""}`} role="tooltip">
                  <strong>{minutesText(s)}</strong>
                  <span>{describe(i)}</span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="x-axis" aria-hidden="true">
          {labels.map((l, i) => <span key={l}>{i % labelEvery === 0 ? l : ""}</span>)}
        </div>
      </div>
    </section>
  );
}

function RecentListens() {
  const listens = useStore((s) => s.listens);
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const currentId = useStore((s) => s.currentId);
  const groups = useMemo(() => {
    const out: Array<{ day: string; items: Array<{ id: string; at: number }> }> = [];
    for (const l of listens) {
      if (!tracks[l.id]) continue;
      const day = new Date(l.at).toLocaleDateString("en", { weekday: "long", month: "long", day: "numeric" });
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(l);
      else out.push({ day, items: [l] });
    }
    return out;
  }, [listens, tracks]);

  if (!groups.length) {
    return <Empty icon="history" title="No listening history yet" body="Every song you start shows up here, newest first." />;
  }
  const ids = listens.map((l) => l.id).filter((id) => tracks[id]);
  return (
    <div className="listen-history">
      {groups.map((g) => (
        <section key={g.day} className="panel">
          <h2 className="panel-title">{g.day === new Date().toLocaleDateString("en", { weekday: "long", month: "long", day: "numeric" }) ? "Today" : g.day}</h2>
          <ol className="rank-list">
            {g.items.map((l) => {
              const t = tracks[l.id];
              return (
                <li key={`${l.id}-${l.at}`}>
                  <span className="listen-time">{new Date(l.at).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" })}</span>
                  <button type="button" className="rank-hit" onClick={() => playList(ids, l.id, { label: "Listening history", route: { name: "history" } })} aria-label={`Play ${t.title}`} />
                  <TrackArt trackId={t.id} className="row-art" />
                  <span className="title-text">
                    <span className={`t-name${currentId === t.id ? " accent" : ""}`}>{t.title}</span>
                    <span className="t-sub">{artists[t.artistId]?.name}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function HistoryView() {
  const [tab, setTab] = useState<"stats" | "history">("stats");
  return (
    <div className="view">
      <header className="page-head">
        <div>
          <span className="eyebrow">Listening history</span>
          <h1>{tab === "stats" ? "Your stats" : "Recently played"}</h1>
        </div>
        <div className="segmented" role="group" aria-label="History view">
          <button type="button" className={tab === "stats" ? "on" : ""} aria-pressed={tab === "stats"} onClick={() => setTab("stats")}>Stats</button>
          <button type="button" className={tab === "history" ? "on" : ""} aria-pressed={tab === "history"} onClick={() => setTab("history")}>History</button>
        </div>
      </header>
      {tab === "stats" ? <StatsView /> : <RecentListens />}
    </div>
  );
}

function StatsView() {
  const log = useStore((s) => s.listenLog);
  const tracks = useStore((s) => s.tracks);
  const artists = useStore((s) => s.artists);
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [hover, setHover] = useState<number | null>(null);

  // Recomputed per day, so a tab left open past midnight shows the new day once listening updates the log.
  const today = todayKey();
  const days = useMemo(() => {
    // Only real listening: the minutes the player logged each day.
    const merged = recentDays(90).map((date) => ({ date, minutes: Math.round((log[date] ?? 0) / 60) }));
    return merged.slice(-range);
  }, [log, range, today]);

  const total = days.reduce((n, d) => n + d.minutes, 0);
  const active = days.filter((d) => d.minutes > 0).length;
  const peak = days.reduce((m, d) => (d.minutes > m.minutes ? d : m), days[0]);
  let streak = 0;
  for (let i = days.length - 1; i >= 0 && days[i].minutes > 0; i--) streak++;
  const max = niceMax(peak.minutes);

  // When and what: each play's heard time in the chosen range (the history keeps the latest 500 plays).
  const listens = useStore((s) => s.taste.listens);
  const since = new Date(`${days[0].date}T00:00:00`).getTime();
  const detail = useMemo(() => {
    const hours = Array<number>(24).fill(0);
    const weekdays = Array<number>(7).fill(0);
    const songs = new Map<string, { plays: number; seconds: number }>();
    for (const l of listens) {
      if (l.at < since || !tracks[l.trackId]) continue;
      // A play's time runs on from its start, so one crossing the hour (or midnight) is split between them.
      let left = l.heard;
      for (let t = l.at; left > 0; ) {
        const at = new Date(t);
        const hourEnd = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() + 1).getTime();
        const part = Math.min(left, (hourEnd - t) / 1000);
        hours[at.getHours()] += part;
        weekdays[at.getDay()] += part;
        left -= part;
        t = hourEnd;
      }
      const song = songs.get(l.trackId) ?? { plays: 0, seconds: 0 };
      song.plays++;
      song.seconds += l.heard;
      songs.set(l.trackId, song);
    }
    const bySong = [...songs].sort((a, b) => b[1].seconds - a[1].seconds || b[1].plays - a[1].plays).slice(0, 10);
    return { hours, weekdays: WEEKDAYS.map((d) => weekdays[d]), bySong, capped: listens.length >= 500 && listens[listens.length - 1].at > since };
  }, [listens, tracks, since]);
  const busiestHour = detail.hours.indexOf(Math.max(...detail.hours));
  const maxSong = detail.bySong[0]?.[1].seconds || 1;

  const topTracks = useMemo(() => Object.values(tracks).sort((a, b) => b.plays - a.plays).slice(0, 5), [tracks]);
  const topArtists = useMemo(() => {
    const plays: Record<string, number> = {};
    for (const t of Object.values(tracks)) plays[t.artistId] = (plays[t.artistId] ?? 0) + t.plays;
    return Object.entries(plays).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [tracks]);
  const maxArtistPlays = topArtists[0]?.[1] || 1;

  const fmtDay = (iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) => new Date(`${iso}T12:00:00`).toLocaleDateString("en", opts);
  const labelEvery = range === 7 ? 1 : range === 30 ? 7 : 15;

  return (
    <>
      <div className="stats-bar">
        <p className="muted">{fmtDay(days[0].date)} – {fmtDay(days[days.length - 1].date)}</p>
        <div className="segmented sm" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r} type="button" className={range === r ? "on" : ""} aria-pressed={range === r} onClick={() => setRange(r)}>
              {r} days
            </button>
          ))}
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><span>Listening time</span><strong>{formatLongDuration(total * 60)}</strong><small>{plural(active, "active day")}</small></div>
        <div className="kpi"><span>Daily average</span><strong>{Math.round(total / days.length)} min</strong><small>across {range} days</small></div>
        <div className="kpi"><span>Current streak</span><strong>{plural(streak, "day")}</strong><small>{streak ? "Keep it going" : "Play something today"}</small></div>
        <div className="kpi"><span>Biggest day</span><strong>{peak.minutes} min</strong><small>{fmtDay(peak.date, { weekday: "long", month: "short", day: "numeric" })}</small></div>
      </div>

      <section className="panel chart-panel" aria-labelledby="minutes-title">
        <div className="chart-head">
          <h2 id="minutes-title">Minutes listened per day</h2>
          <span className="muted small">Hover or focus a bar for details</span>
        </div>
        <div className="chart" style={{ "--n": days.length } as CSSProperties}>
          <div className="chart-grid" aria-hidden="true">
            {[1, 0.5, 0].map((f) => (
              <div key={f} className="gridline" style={{ "--y": f } as CSSProperties}>
                <span>{Math.round(max * f)}</span>
              </div>
            ))}
          </div>
          <div className="bars" onPointerLeave={() => setHover(null)}>
            {days.map((d, i) => (
              <button
                key={d.date}
                type="button"
                className={`bar${hover === i ? " hot" : ""}${hover !== null && hover !== i ? " dim" : ""}`}
                style={{ "--h": d.minutes / max } as CSSProperties}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                aria-label={`${fmtDay(d.date, { weekday: "long", month: "long", day: "numeric" })}: ${d.minutes} minutes`}
              >
                <i />
                {hover === i ? (
                  <span className={`bar-tip${i > days.length * 0.75 ? " left" : i < days.length * 0.25 ? " right" : ""}`} role="tooltip">
                    <strong>{d.minutes} min</strong>
                    <span>{fmtDay(d.date, { weekday: "short", month: "short", day: "numeric" })}</span>
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="x-axis" aria-hidden="true">
            {days.map((d, i) => (
              <span key={d.date}>{(days.length - 1 - i) % labelEvery === 0 ? fmtDay(d.date, range === 7 ? { weekday: "short" } : { month: "short", day: "numeric" }) : ""}</span>
            ))}
          </div>
        </div>
        <table className="sr-only">
          <caption>Minutes listened per day</caption>
          <thead><tr><th>Date</th><th>Minutes</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.minutes}</td></tr>)}</tbody>
        </table>
      </section>

      {detail.bySong.length ? (
        <>
          <p className="muted small stats-note">
            {detail.hours[busiestHour] > 0 ? `Most of your listening happens around ${hourLabel(busiestHour)}.` : ""}
            {detail.capped ? " Hours, weekdays and songs below count your latest 500 plays." : ""}
          </p>
          <div className="two-col">
            <Breakdown
              title="By time of day"
              labels={Array.from({ length: 24 }, (_, h) => hourLabel(h))}
              seconds={detail.hours}
              labelEvery={6}
              describe={(h) => `${hourLabel(h)} – ${hourLabel((h + 1) % 24)}`}
            />
            <Breakdown
              title="By day of the week"
              labels={WEEKDAYS.map((d) => new Date(2024, 0, d === 0 ? 7 : d).toLocaleDateString("en", { weekday: "short" }))}
              seconds={detail.weekdays}
              describe={(i) => new Date(2024, 0, WEEKDAYS[i] === 0 ? 7 : WEEKDAYS[i]).toLocaleDateString("en", { weekday: "long" })}
            />
          </div>
          <section className="panel stats-songs" aria-labelledby="song-time-title">
            <h2 className="panel-title" id="song-time-title">Songs by listening time</h2>
            <ol className="rank-list">
              {detail.bySong.map(([id, song], i) => {
                const t = tracks[id];
                return (
                  <li key={id}>
                    <span className="rank">{i + 1}</span>
                    <button type="button" className="rank-hit" onClick={() => playList(detail.bySong.map(([x]) => x), id, { label: "Songs by listening time", route: { name: "history" } })} aria-label={`Play ${t.title}`} />
                    <TrackArt trackId={id} className="row-art" />
                    <span className="title-text">
                      <span className="t-name">{t.title}</span>
                      <span className="mini-bar"><i style={{ "--w": song.seconds / maxSong } as CSSProperties} /></span>
                    </span>
                    <span className="muted small">{plural(song.plays, "play")} · {formatLongDuration(Math.round(song.seconds))}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        </>
      ) : null}

      <div className="two-col">
        <section className="panel">
          <h2 className="panel-title">Top songs</h2>
          <ol className="rank-list">
            {topTracks.map((t, i) => (
              <li key={t.id}>
                <span className="rank">{i + 1}</span>
                <button type="button" className="rank-hit" onClick={() => playList(topTracks.map((x) => x.id), t.id, { label: "Top songs", route: { name: "history" } })} aria-label={`Play ${t.title}`} />
                <TrackArt trackId={t.id} className="row-art" />
                <span className="title-text">
                  <span className="t-name">{t.title}</span>
                  <span className="t-sub">{artists[t.artistId]?.name}</span>
                </span>
                <span className="muted small">{plural(t.plays, "play")}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="panel">
          <h2 className="panel-title">Top artists</h2>
          <ol className="rank-list">
            {topArtists.map(([id, plays], i) => {
              const a = artists[id];
              if (!a) return null;
              return (
                <li key={id}>
                  <span className="rank">{i + 1}</span>
                  <button type="button" className="rank-hit" onClick={() => navigate({ name: "artist", id })} aria-label={`Open ${a.name}`} />
                  <Art palette={a.palette} glyph={4} round className="row-art" />
                  <span className="title-text">
                    <span className="t-name">{a.name}</span>
                    <span className="mini-bar"><i style={{ "--w": plays / maxArtistPlays } as CSSProperties} /></span>
                  </span>
                  <span className="muted small">{plural(plays, "play")}</span>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </>
  );
}
