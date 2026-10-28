// Small pieces every Guest Visits page shares: labelled fields with associated help and errors, status notices, badges
// and dialogs that trap focus with the SDK's useModalFocus, all built on Core's shared classes.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useModalFocus, type DashboardNavigate } from "@lancerlogin/module-sdk/dashboard";
import type { Badge, Tone } from "./visits-labels.ts";
import type { FieldErrors } from "./visits-forms.ts";

/** Field IDs for one form: `ids("teamNumber")`. */
export function useFieldIds(): (field: string) => string {
  const prefix = useId();
  return (field: string) => `${prefix}${field}`;
}

/** The id, `aria-invalid` and `aria-describedby` of a control with optional help and error text. */
export function fieldAria(id: string, error?: string, help?: boolean) {
  const describedBy = [help ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return { id, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy || undefined } as const;
}

/** A label above its control, then help and error text the control describes itself with (see `fieldAria`). */
export function Field({ id, label, optional, help, error, children, className = "" }: { id: string; label: ReactNode; optional?: boolean; help?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return <div className={`visits-field ${className}`.trim()} data-invalid={error ? "true" : undefined}>
    <label htmlFor={id}>{label}{optional && <span className="visits-optional"> (optional)</span>}</label>
    {children}
    {help && <span id={`${id}-help`} className="field-help">{help}</span>}
    {error && <span id={`${id}-error`} className="field-help visits-field-error">{error}</span>}
  </div>;
}

/** The first field with a problem, in form order, then any other. */
export function firstProblem(errors: FieldErrors, order: readonly string[]): string | undefined {
  return order.find((field) => errors[field]) ?? Object.keys(errors)[0];
}

/** Focus an element by id after React renders it. */
export function useFocusRequest(): (id: string | undefined) => void {
  const [request, setRequest] = useState<{ id: string; count: number }>();
  useEffect(() => { if (request) document.getElementById(request.id)?.focus(); }, [request]);
  return (id) => { if (id) setRequest((current) => ({ id, count: (current?.count ?? 0) + 1 })); };
}

/** Follow a link with in-place navigation, leaving modified clicks (new tab, new window) to the browser. */
export function inPageLink(navigate: DashboardNavigate, path: string) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(path);
  };
}

/** Enter in a single-line field does not submit the form, as on Core's public forms; buttons and text areas keep Enter. */
export function preventImplicitSubmission(event: KeyboardEvent<HTMLFormElement>): void {
  if (event.key !== "Enter" || !(event.target instanceof HTMLElement)) return;
  if (event.target.tagName !== "TEXTAREA" && event.target.tagName !== "BUTTON" && event.target.tagName !== "A") event.preventDefault();
}

export type NoticeValue = { readonly tone: Tone; readonly text: string };

/** A status line. Errors are alerts and take focus so keyboard and screen reader users meet them at once. */
export function Notice({ notice, className = "" }: { notice: NoticeValue | undefined | null; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (notice?.tone === "error") ref.current?.focus(); }, [notice]);
  if (!notice) return null;
  return <p ref={ref} tabIndex={-1} className={`ui-status settings-notice visits-notice ${className}`.trim()} data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>;
}

export function Badges({ badges }: { badges: readonly Badge[] }) {
  if (!badges.length) return null;
  return <ul className="visits-badges">{badges.map((badge) => <li key={badge.label}><span className="ui-status visits-badge" data-tone={badge.tone}>{badge.label}</span></li>)}</ul>;
}

/** A modal dialog with Core's dialog classes. Escape and the close button call `onClose` unless `busy`. */
export function VisitsDialog({ title, description, busy = false, onClose, children, wide = false }: { title: string; description?: ReactNode; busy?: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const dialog = useRef<HTMLElement>(null);
  const id = useId();
  const close = () => { if (!busy) onClose(); };
  useModalFocus(dialog, true, busy, close);
  return <div className="dialog-backdrop">
    <section ref={dialog} className={`meeting-management-dialog ui-dialog visits-dialog${wide ? " visits-dialog--wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${id}title`} aria-describedby={description ? `${id}description` : undefined} tabIndex={-1}>
      <div className="dialog-heading">
        <div><h2 id={`${id}title`}>{title}</h2>{description && <p id={`${id}description`}>{description}</p>}</div>
        <button className="ui-button" type="button" aria-label={`Close ${title}`} disabled={busy} onClick={close}><span aria-hidden="true">×</span></button>
      </div>
      {children}
    </section>
  </div>;
}

/** A confirmation for a consequential action. The confirm button is the dialog's only primary or danger action. */
export function ConfirmDialog({ title, children, confirmLabel, cancelLabel = "Keep it", danger = false, busy, error, onConfirm, onClose }: {
  title: string; children: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean; busy: boolean; error?: string; onConfirm: () => void; onClose: () => void;
}) {
  return <VisitsDialog title={title} busy={busy} onClose={onClose}>
    <div className="visits-stack">
      {children}
      {error && <p className="ui-status settings-notice" data-tone="error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="ui-button" type="button" disabled={busy} onClick={onClose} data-modal-initial-focus>{cancelLabel}</button>
        <button className={`ui-button ${danger ? "ui-button--danger" : "ui-button--primary"}`} type="button" disabled={busy} onClick={onConfirm}>{busy ? "Working..." : confirmLabel}</button>
      </div>
    </div>
  </VisitsDialog>;
}

/** A loading or failure line for a section, with Try again after a failure. */
export function LoadState({ loading, error, label, onRetry }: { loading: boolean; error: string; label: string; onRetry: () => void }) {
  if (error) return <div className="visits-load-error"><p className="ui-status settings-notice" data-tone="error" role="alert">{error}</p><button className="ui-button" type="button" onClick={onRetry}>Try again</button></div>;
  if (loading) return <p className="ui-status settings-notice" role="status">Loading {label}...</p>;
  return null;
}
