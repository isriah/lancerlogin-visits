// The guest page's month calendar. Days with open times stand out and are the ones a guest chooses; a day whose times
// were all canceled also opens, to show the reason. Other days are disabled. The months stop at the booking horizon.
// Arrow keys move between the days that can be chosen; Tab reaches them in date order.
import { useRef, type KeyboardEvent } from "react";
import { formatShortDate } from "../shared/visits-time.ts";
import { compactTime, formatMonth, guestDayText, monthCells, type GuestDay } from "./visits-local.ts";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const steps: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

/** The id of a day's button, so the page can return focus to the chosen day. */
export const guestDayId = (calendarId: string, date: string) => `${calendarId}-day-${date}`;

export function GuestCalendar({ id, months, month, onMonth, today, days, selected, onSelect }: {
  id: string; months: readonly string[]; month: string; onMonth: (month: string) => void; today: string;
  days: ReadonlyMap<string, GuestDay>; selected: string; onSelect: (date: string) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const index = months.indexOf(month);

  function move(event: KeyboardEvent<HTMLDivElement>) {
    const step = steps[event.key];
    if (!step || !grid.current) return;
    const buttons = Array.from(grid.current.querySelectorAll<HTMLButtonElement>("button"));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    for (let next = current + step; next >= 0 && next < buttons.length; next += step) if (!buttons[next]!.disabled) { buttons[next]!.focus(); return; }
  }

  return <section className="ui-card visits-calendar" aria-labelledby={`${id}-title`}>
    <div className="visits-calendar-heading">
      <h2 id={`${id}-title`}>Choose a day</h2>
      <p className="field-help">Highlighted days have open times.</p>
    </div>
    <div className="visits-calendar-nav">
      <button className="ui-button" type="button" aria-label="Previous month" disabled={index <= 0} onClick={() => onMonth(months[index - 1]!)}><span aria-hidden="true">←</span></button>
      <h3 id={`${id}-month`} aria-live="polite">{formatMonth(month)}</h3>
      <button className="ui-button" type="button" aria-label="Next month" disabled={index < 0 || index >= months.length - 1} onClick={() => onMonth(months[index + 1]!)}><span aria-hidden="true">→</span></button>
    </div>
    <div className="visits-calendar-weekdays" aria-hidden="true">{weekdays.map((day) => <span key={day}>{day}</span>)}</div>
    <div ref={grid} className="visits-calendar-grid" role="group" aria-labelledby={`${id}-month`} onKeyDown={move}>
      {monthCells(month).map((date, cell) => {
        if (!date) return <span key={`blank-${cell}`} className="visits-calendar-blank" aria-hidden="true" />;
        const day = days.get(date);
        const choosable = day?.state === "open" || day?.state === "canceled";
        return <button key={date} id={guestDayId(id, date)} type="button" className="visits-calendar-day" data-state={day?.state ?? "none"} disabled={!choosable}
          aria-pressed={choosable ? selected === date : undefined} aria-current={date === today ? "date" : undefined}
          aria-label={`${formatShortDate(date)}: ${guestDayText(day)}`} onClick={() => onSelect(date)}>
          <span className="visits-calendar-number">{Number(date.slice(8))}</span>
          {day && day.state !== "closed" && <span className="visits-calendar-detail" aria-hidden="true">
            {day.state === "canceled" ? "Canceled" : `${compactTime(day.startTime)} to ${compactTime(day.endTime)}`}
          </span>}
          {day?.state === "open" && day.teams > 0 && <span className="visits-calendar-teams" aria-hidden="true">{day.teams} {day.teams === 1 ? "team" : "teams"}</span>}
        </button>;
      })}
    </div>
  </section>;
}
