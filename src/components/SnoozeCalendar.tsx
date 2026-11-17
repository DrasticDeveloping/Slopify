import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { closeMenu } from "../state/actions";
import { snoozeUntil } from "../state/snooze";
import { Icon } from "./Icon";

/** The times a snooze can end on the day you pick: morning, midday, evening and late. */
const HOURS = [8, 12, 18, 22];
/** How far ahead a day can be picked. */
const MAX_DAYS = 365;

const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const at = (d: Date, hour: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour);
const hourLabel = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" });
const dayLabel = (d: Date, now: Date) =>
  d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
/** Monday first, as a UK calendar (5 Jan 2026 was a Monday). */
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Date(2026, 0, 5 + i));

/**
 * Snooze until a day you pick: a month of days (past ones greyed out, the days it'll be skipped shaded),
 * a few times of day for it to come back, and a button that says when. Shown in the Snooze submenu,
 * in place of its lengths. Arrow keys move between days; Escape goes back to the lengths.
 */
export function SnoozeCalendar({ ids, subtitle, onBack }: { ids: string[]; subtitle?: string; onBack: () => void }) {
  // The time it's checked against; brought up to date if a picked time passes while the calendar is open.
  const [now, setNow] = useState(() => new Date());
  const today = dayOf(now);
  const last = addDays(today, MAX_DAYS);
  /** A day with a time still ahead of it (today, late at night, has none). */
  const open = (d: Date) => d >= today && d <= last && HOURS.some((hour) => at(d, hour) > now);
  const first = open(today) ? today : addDays(today, 1);
  const [pick, setPick] = useState<Date | null>(null);
  /** The time picked went by before Snooze was pressed, so it was moved on (or the day cleared). */
  const [passed, setPassed] = useState(false);
  const [hour, setHour] = useState(HOURS[0]);
  const [month, setMonth] = useState(() => new Date(first.getFullYear(), first.getMonth(), 1));
  const [cursor, setCursor] = useState(first);
  const grid = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const shown = useRef(false);

  /** The hour on `d`, or the next one still ahead when it has passed today. */
  const hourOn = (d: Date, wanted: number, time = now) => (at(d, wanted) > time ? wanted : HOURS.find((h) => at(d, h) > time) ?? wanted);
  const choose = (d: Date) => {
    setPick(d);
    setCursor(d);
    setHour((h) => hourOn(d, h));
    setPassed(false);
  };
  /** Shows another month, with the arrow keys starting from its first day that can be picked. */
  const showMonth = (step: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + step, 1);
    setMonth(next);
    const days = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    const day = Array.from({ length: days }, (_, i) => new Date(next.getFullYear(), next.getMonth(), i + 1)).find(open);
    if (day) setCursor(day);
  };
  const confirm = () => {
    if (!pick) return;
    const time = new Date();
    if (at(pick, hour) <= time) {
      // The time picked has gone by while the calendar was open: the next one that hasn't, or another day.
      setNow(time);
      setPassed(true);
      const later = HOURS.find((h) => at(pick, h) > time);
      if (later === undefined) setPick(null);
      else setHour(hourOn(pick, hour, time));
      return;
    }
    closeMenu();
    snoozeUntil(ids, at(pick, hour).getTime());
  };

  const lead = (month.getDay() + 6) % 7;
  const days = Array.from({ length: new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate() }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1));
  // One day in the month takes Tab (the cursor, or the first open one), the rest are reached with the arrows.
  const tabbable = days.find((d) => sameDay(d, cursor) && open(d)) ?? days.find(open);
  const canBack = month > new Date(first.getFullYear(), first.getMonth(), 1);
  const canForward = new Date(month.getFullYear(), month.getMonth() + 1, 1) <= last;

  useLayoutEffect(() => {
    // Into the calendar at the first day it can be snoozed to; after an arrow key, onto the day it moved to.
    // (The month buttons keep focus, so they can be pressed again.)
    if (shown.current && !moved.current) return;
    shown.current = true;
    moved.current = false;
    grid.current?.querySelector<HTMLButtonElement>("button[tabindex='0']")?.focus();
  }, [cursor, month]);

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    let next = addDays(cursor, step);
    if (next < first) next = first;
    if (next > last) next = last;
    moved.current = true;
    setCursor(next);
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  };

  const until = pick ? at(pick, hour) : null;
  const away = pick ? Math.round((pick.getTime() - today.getTime()) / 86_400_000) : 0;

  return (
    <div className="menu-panel snz">
      <div className="menu-head">
        <button type="button" className="icon-btn sm menu-back" onClick={onBack} aria-label="Back to snooze lengths">
          <Icon name="chevronLeft" size={18} />
        </button>
        <span className="menu-head-text">
          <strong>Snooze until</strong>
          {subtitle ? <small>{subtitle}</small> : null}
        </span>
      </div>
      <div className="snz-month">
        <strong aria-live="polite">{month.toLocaleDateString([], { month: "long", year: "numeric" })}</strong>
        <button type="button" className="icon-btn sm" disabled={!canBack} onClick={() => showMonth(-1)} aria-label="Previous month">
          <Icon name="chevronLeft" size={16} />
        </button>
        <button type="button" className="icon-btn sm" disabled={!canForward} onClick={() => showMonth(1)} aria-label="Next month">
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
      <div className="snz-grid" ref={grid} onKeyDown={key} role="group" aria-label="Days">
        {WEEKDAYS.map((d) => (
          <span key={d.getDay()} className="snz-wd" aria-hidden="true">{d.toLocaleDateString([], { weekday: "narrow" })}</span>
        ))}
        {Array.from({ length: lead }, (_, i) => <span key={`lead${i}`} />)}
        {days.map((d) => {
          const picked = !!pick && sameDay(d, pick);
          // The days it'll be skipped, from today to the one picked, are shaded.
          const skipped = !!pick && !sameDay(pick, today) && d >= today && d <= pick;
          return (
            <button
              key={d.getDate()}
              type="button"
              className={`snz-day${sameDay(d, today) ? " today" : ""}${skipped ? " skipped" : ""}${skipped && sameDay(d, today) ? " from" : ""}${skipped && picked ? " to" : ""}`}
              disabled={!open(d)}
              tabIndex={tabbable && sameDay(d, tabbable) ? 0 : -1}
              aria-pressed={picked}
              aria-label={dayLabel(d, now)}
              onClick={() => choose(d)}
            >
              <span>{d.getDate()}</span>
            </button>
          );
        })}
      </div>
      <div className="snz-times" role="group" aria-label="Back at">
        <span>Back at</span>
        {HOURS.map((h) => (
          <button key={h} type="button" className="snz-chip" aria-pressed={h === hour} disabled={!!pick && at(pick, h) <= now} onClick={() => {
              setHour(h);
              setPassed(false);
            }}>
            {hourLabel(h)}
          </button>
        ))}
      </div>
      <p className="snz-sum">
        {passed ? "That time has passed. " : null}
        {until && pick ? (
          <>Skipped until <b>{dayLabel(pick, now)}, {hourLabel(hour)}</b> · {away < 1 ? "later today" : away === 1 ? "tomorrow" : `in ${away} days`}</>
        ) : passed ? "Pick a later day." : "Pick the day it comes back."}
      </p>
      <button
        type="button"
        className="snz-go"
        disabled={!until}
        onClick={confirm}
      >
        {pick ? `Snooze until ${dayLabel(pick, now)}` : "Snooze"}
      </button>
    </div>
  );
}
