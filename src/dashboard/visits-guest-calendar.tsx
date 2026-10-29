// The guest page's calendar: five weeks at a time, last week to three weeks ahead, like Core's rolling dashboard calendars,
// with arrows that move five weeks and stop at last week and at the booking horizon. Days with open times stand out and
// are the ones a guest chooses; a day whose times were all canceled also opens, to show the reason. Other days are
// disabled. On wider screens the weeks fill the window below the page title and each cell lists as much of its day as
// fits. Arrow keys move between the days that can be chosen; Tab reaches them in date order.
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatShortDate } from "../shared/visits-time.ts";
import { formatDateRange, guestCellLines, guestDayText, guestWeekDates, shortMonths, type GuestDay } from "./visits-local.ts";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const steps: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

/** The id of a day's button, so the page can return focus to the chosen day. */
export const guestDayId = (calendarId: string, date: string) => `${calendarId}-day-${date}`;

export function GuestCalendar({ id, today, view, lastView, onView, days, selected, onSelect }: {
  id: string; today: string; view: number; lastView: number; onView: (view: number) => void;
  days: ReadonlyMap<string, GuestDay>; selected: string; onSelect: (date: string) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(3);
  const shown = Math.min(Math.max(0, view), Math.max(0, lastView));
  const dates = guestWeekDates(today, shown);
  const first = shown === 0;
  const last = shown >= lastView;

  // The CSS sizes the grid from where it starts on the page to the window's bottom edge, and each cell lists as many
  // lines as its height holds. Phones hide the lines, which measures as no room. Measuring waits a frame after a resize so
  // the size it sets is not reported back in the same frame.
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    let frame = 0;
    const fit = () => {
      element.style.setProperty("--visits-calendar-top", `${Math.round(element.getBoundingClientRect().top + window.scrollY)}px`);
      const lines = element.querySelector<HTMLElement>(".visits-calendar-lines");
      const line = lines ? parseFloat(getComputedStyle(lines).lineHeight) : 0;
      setRoom(lines && line > 0 ? Math.floor(lines.clientHeight / line + 0.05) : 0);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); });
    observer.observe(element);
    observer.observe(document.body);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  function move(event: KeyboardEvent<HTMLDivElement>) {
    const step = steps[event.key];
    if (!step || !grid.current) return;
    const buttons = Array.from(grid.current.querySelectorAll<HTMLButtonElement>("button"));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    for (let next = current + step; next >= 0 && next < buttons.length; next += step) if (!buttons[next]!.disabled) { buttons[next]!.focus(); return; }
  }

  // The arrows stay focusable at either end (aria-disabled), so keyboard focus is not lost when the last view is reached.
  return <section className="ui-card visits-calendar" aria-labelledby={`${id}-title`}>
    <div className="visits-calendar-heading">
      <h2 id={`${id}-title`}>Choose a day</h2>
      <p className="field-help">Highlighted days have open times.</p>
    </div>
    <div className="visits-calendar-nav">
      <button className="ui-button" type="button" aria-label="Show previous five weeks" aria-disabled={first || undefined} onClick={() => { if (!first) onView(shown - 1); }}><span aria-hidden="true">←</span></button>
      <h3 id={`${id}-weeks`} aria-live="polite">{formatDateRange(dates[0]!, dates.at(-1)!)}</h3>
      <button className="ui-button" type="button" aria-label="Show next five weeks" aria-disabled={last || undefined} onClick={() => { if (!last) onView(shown + 1); }}><span aria-hidden="true">→</span></button>
    </div>
    <div className="visits-calendar-weekdays" aria-hidden="true">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
    <div ref={grid} className="visits-calendar-grid" role="group" aria-labelledby={`${id}-weeks`} onKeyDown={move}>
      {dates.map((date, index) => {
        const day = days.get(date);
        const choosable = day?.state === "open" || day?.state === "canceled";
        return <button key={date} id={guestDayId(id, date)} type="button" className="visits-calendar-day" data-state={day?.state ?? "none"} disabled={!choosable}
          aria-pressed={choosable ? selected === date : undefined} aria-current={date === today ? "date" : undefined}
          aria-label={`${formatShortDate(date)}: ${guestDayText(day)}`} onClick={() => onSelect(date)}>
          <span className="visits-calendar-date">
            {(index === 0 || date.endsWith("-01")) && <span className="visits-calendar-month">{shortMonths[Number(date.slice(5, 7)) - 1]}</span>}
            <span className="visits-calendar-number">{Number(date.slice(8))}</span>
          </span>
          <span className="visits-calendar-lines" aria-hidden="true">
            {guestCellLines(day, room).map((line, row) => <span key={row} data-kind={line.kind}>{line.text}</span>)}
          </span>
        </button>;
      })}
    </div>
  </section>;
}
