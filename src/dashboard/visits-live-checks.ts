// Live field checks for the Guest Visits forms. A field is checked when the person leaves it, not on every keystroke;
// once it shows a problem it is checked again as the value changes, and the message goes as soon as the value is right.
// Submitting still checks the whole form and shows the result with setErrors, and a Worker refusal stays until its field
// changes. The rules are the forms' own (checkBookingField, checkVisitField, checkStaffVisitField) and the state changes
// are plain functions in visits-forms.ts; this hook only keeps them.
import { useState, type FocusEvent } from "react";
import { liveBlur, liveChange, liveCheckState, liveShow, type FieldCheck, type FieldErrors, type FieldSources, type LiveCheckState } from "./visits-forms.ts";

export type LiveChecks = {
  /** The errors to show, by field, for Field and fieldAria. */
  readonly errors: FieldErrors;
  /** A field's onBlur handler: `onBlur={live.blur("contactEmail")}`. */
  readonly blur: (field: string) => (event: FocusEvent<HTMLElement>) => void;
  /** Show these errors in place of the others, as a submit or a refused request does. */
  readonly setErrors: (errors: FieldErrors) => void;
  /** Remove these fields' errors. */
  readonly clear: (...fields: string[]) => void;
};

const sameDraft = (left: object, right: object) => {
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length && entries.every(([key, value]) => Object.is(value, (right as Record<string, unknown>)[key]));
};

/** Pressing submit checks the whole form, and a message appearing first could move the button out from under the pointer. */
const toSubmit = (target: EventTarget | null) => target instanceof HTMLButtonElement && target.type === "submit";

/**
 * Live checks for a form's draft. `check` gives one field's problem; `sources` names fields held under another draft key
 * (the booking form passes bookingFieldSources). Replaces the form's own errors state.
 */
export function useLiveChecks<Draft extends object>(draft: Draft, check: FieldCheck<Draft>, sources?: FieldSources): LiveChecks {
  const [state, setState] = useState<LiveCheckState<Draft>>(() => liveCheckState(draft));
  // Follow the draft while rendering, as React advises for state that tracks a value, so a corrected field never shows
  // its old message for a frame. Equal drafts are skipped, so a draft rebuilt on every render cannot loop.
  let current = state;
  if (state.draft !== draft && !sameDraft(state.draft, draft)) { current = liveChange(state, draft, check, sources); setState(current); }
  return {
    errors: current.errors,
    blur: (field) => (event) => { if (!toSubmit(event.relatedTarget)) setState((latest) => liveBlur(latest, field, check)); },
    setErrors: (errors) => setState((latest) => liveShow(latest, errors)),
    clear: (...fields) => setState((latest) => fields.some((field) => latest.errors[field]) ? liveShow(latest, Object.fromEntries(Object.entries(latest.errors).filter(([field]) => !fields.includes(field)))) : latest),
  };
}
