// The dates the Add availability card starts from and keeps: the day picked on the availability calendar, and the date
// typed in one Repeats choice carried over to the other. Plain functions, so the tests run without React or Core.
import { isLocalDate } from "../shared/visits-time.ts";
import { availabilityDraft, type AvailabilityDraft } from "./visits-forms.ts";

/** The day Add availability starts on: the calendar's selected day in calendar view, otherwise today. Past days too. */
export function addAvailabilityDate(today: string, view: "calendar" | "table", selectedDate: string | undefined): string {
  return view === "calendar" && isLocalDate(selectedDate) ? selectedDate : today;
}

/** A new draft on `date`: the one date and the first date are that day, and the last date is the usual range after it. */
export function availabilityDraftOn(today: string, date: string | undefined): AvailabilityDraft {
  return availabilityDraft(isLocalDate(date) ? date : today);
}

/** Switch between Every week and One date and keep the date typed. The one date becomes the first date and back; the last
 *  date stays while it is still after the first date, otherwise it becomes the first date plus the usual range. Times,
 *  title and weekdays stay as typed. A date left empty keeps the other choice's date as it was. */
export function switchRepeats(draft: AvailabilityDraft, repeating: boolean): AvailabilityDraft {
  if (draft.repeating === repeating) return draft;
  if (!repeating) return { ...draft, repeating, date: draft.firstDate || draft.date };
  const firstDate = draft.date || draft.firstDate;
  const keepLast = isLocalDate(firstDate) && isLocalDate(draft.lastDate) && draft.lastDate > firstDate;
  return { ...draft, repeating, firstDate, lastDate: keepLast || !isLocalDate(firstDate) ? draft.lastDate : availabilityDraft(firstDate).lastDate };
}
