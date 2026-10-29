// The HTTP contract between the Guest Visits dashboard and its Worker routes. Both sides import these paths and shapes so
// they cannot drift. Local dates are YYYY-MM-DD and local times HH:MM in the installation time zone; `*Ms` fields are the
// same moments as epoch milliseconds. Errors are `{ error, field? }` with a 4xx status. Import-free apart from siblings.
import type { Attention, FieldChange, PublicWindow, TeamIdentity, VisitProgram } from "./visits-booking.ts";
import type { WindowStatus } from "./visits-schedule.ts";

/** Public routes: no sign-in, dashboard origin required for POST. */
export const publicVisitsRoutes = {
  /** GET: the guest page's open and canceled windows for the coming weeks. */
  calendar: "/public/visits/calendar",
  /** GET `?program=&number=`: the saved team name for a known team, so the form can fill it in. */
  team: "/public/visits/team",
  /**
   * GET `?number=`: `PublicTeamSearch`, the teams with that number in FIRST's FRC and FTC team lists (this season and the
   * previous one) and in this installation's guest teams, so the form can confirm the program and name.
   */
  teamSearch: "/public/visits/team-search",
  /** POST `PublicBookingRequest`: book a visit. Replaying the same `submissionKey` returns the first result. */
  bookings: "/public/visits/bookings",
  /** POST `{ token }`: the booking an emailed link manages. */
  manage: "/public/visits/manage",
  /** POST `{ token, edit }`: change the booking. */
  manageUpdate: "/public/visits/manage/update",
  /** POST `{ token, revision }`: cancel the booking. */
  manageCancel: "/public/visits/manage/cancel",
} as const;

/** Setup routes: Admin only, before the workspace is ready. */
export const setupVisitsRoutes = {
  /** GET: `VisitsSetupStatus`. */
  status: "/module-setup/visits/status",
  /** POST `{ to }`: send a test email through Core's Resend connection and record that it worked. */
  testEmail: "/module-setup/visits/test-email",
  /** POST `SeriesRequest`: the first repeating availability. */
  series: "/module-setup/visits/series",
  /** POST `WindowRequest`: the first one-off availability. */
  windows: "/module-setup/visits/windows",
} as const;

/** Workspace routes: Admins, and Operators assigned Guest Visits. Settings routes are Admin only. */
export const adminVisitsRoutes = {
  /** GET `?from=&to=` (local dates, at most 120 days): `StaffOverview`. */
  overview: "/admin/visits/overview",
  /** GET: `StaffSeries[]`. POST `SeriesRequest`: create a series and its windows. */
  series: "/admin/visits/series",
  /** PUT `SeriesRequest & { revision }`: change a series' future, not individually edited windows. DELETE: remove the series and those windows. */
  seriesItem: (id: string) => `/admin/visits/series/${encodeURIComponent(id)}`,
  /** POST `WindowRequest`: a one-off window. */
  windows: "/admin/visits/windows",
  /** PUT `WindowRequest & { revision }`: edit one window. DELETE `?revision=`: remove it (its visits need attention). */
  window: (id: string) => `/admin/visits/windows/${encodeURIComponent(id)}`,
  /** POST `{ reason, revision }`. */
  windowCancel: (id: string) => `/admin/visits/windows/${encodeURIComponent(id)}/cancel`,
  /** POST `{ revision }`. */
  windowRestore: (id: string) => `/admin/visits/windows/${encodeURIComponent(id)}/restore`,
  /**
   * GET `?scope=upcoming|past|removed|attention`: `StaffBooking[]`. Removed visits are listed only under `removed`, most
   * recent visit first, so staff can open their history and restore them.
   */
  bookings: "/admin/visits/bookings",
  /** GET: `StaffBookingDetail`. PUT `StaffBookingEdit`. DELETE `?revision=`: remove the visit (kept in history, hidden from lists). */
  booking: (id: string) => `/admin/visits/bookings/${encodeURIComponent(id)}`,
  /** POST `{ revision }`: cancel as staff (the team gets an email). */
  bookingCancel: (id: string) => `/admin/visits/bookings/${encodeURIComponent(id)}/cancel`,
  /** POST `{ revisionId, revision }`: put the visit back as it was at that history entry. */
  bookingRestore: (id: string) => `/admin/visits/bookings/${encodeURIComponent(id)}/restore`,
  /** POST: send the confirmation again with a fresh link. */
  bookingResend: (id: string) => `/admin/visits/bookings/${encodeURIComponent(id)}/resend`,
  /** POST: mark its attention handled. */
  bookingHandled: (id: string) => `/admin/visits/bookings/${encodeURIComponent(id)}/handled`,
  /**
   * POST `OutreachRecordRequest`: Record in Outreach. With an Admin's grant, or the staff member's own Outreach access,
   * records booked visits right away and answers `OutreachRecordResponse`; otherwise 409.
   */
  recordOutreach: "/admin/visits/outreach",
  /** GET: `StaffTeam[]`. */
  teams: "/admin/visits/teams",
  /** PUT `{ name, revision }`. */
  team: (id: string) => `/admin/visits/teams/${encodeURIComponent(id)}`,
  /** POST `{ intoId }`: move this team's visits to another team with the same program and archive it. */
  teamMerge: (id: string) => `/admin/visits/teams/${encodeURIComponent(id)}/merge`,
  /** GET: `VisitsStatus`. */
  status: "/admin/visits/status",
  /** GET: `VisitsSettings`. PUT `VisitsSettingsUpdate`. Admin only. */
  settings: "/admin/visits/settings",
  /** POST `{ to }`: Admin only. */
  settingsTestEmail: "/admin/visits/settings/test-email",
  /**
   * GET: `FirstApiStatus`. PUT `FirstApiCredentialRequest`: check the credential with FIRST, then save it encrypted.
   * DELETE `?program=FRC|FTC`: forget it. Admin only.
   */
  firstApi: "/admin/visits/settings/first-api",
} as const;

export type ApiError = { readonly error: string; readonly field?: string };

// Public shapes.
export type PublicCalendar = {
  readonly timeZone: string;
  /** The host team's name from settings, such as "FRC 321 Lancers", or empty when none is set. */
  readonly hostName: string;
  readonly introText: string;
  /** How far ahead guests may book, in days. */
  readonly horizonDays: number;
  readonly windows: readonly PublicWindow[];
};
export type PublicTeamLookup = { readonly team: TeamIdentity | null };
/** A team with the searched number. `location` is "City, State" (or "City, Country") from FIRST, or empty. */
export type TeamMatch = TeamIdentity & { readonly location: string; readonly source: "first" | "saved" };
export type PublicTeamSearch = {
  /** Distinct by program: FIRST's name wins over a saved guest team's, FRC first, then FTC, then the rest. */
  readonly matches: readonly TeamMatch[];
  /**
   * False when FIRST was not asked for every program it covers (no credential for a program, a provider failure or the
   * lookup limit), so a missing match may only mean "unknown"; the guest can still enter the team by hand.
   */
  readonly complete: boolean;
};
/** The programs FIRST's APIs can look up. FIRST LEGO League teams are entered by hand. */
export type FirstApiProgram = "FRC" | "FTC";
export type FirstApiStatus = { readonly [Program in FirstApiProgram]: { readonly configured: boolean; readonly username: string; readonly checkedAt: string | null } };
export type FirstApiCredentialRequest = { readonly program: FirstApiProgram; readonly username: string; readonly token: string };
export type PublicBookingRequest = {
  readonly teamNumber: string;
  readonly teamName: string;
  readonly program: VisitProgram;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone?: string;
  readonly date: string;
  readonly arrival: string;
  readonly departure: string;
  readonly headcount: number;
  readonly note?: string;
  readonly submissionKey: string;
};
/** The booking page never receives the manage link; only the inbox owner does. */
export type PublicBookingResult = { readonly booked: true; readonly emailTo: string; readonly visit: LocalVisitTimes & { readonly windowTitle: string } };
export type LocalVisitTimes = { readonly date: string; readonly arrival: string; readonly departure: string; readonly arrivalMs: number; readonly departureMs: number };
export type ManageView = {
  readonly timeZone: string;
  /** The host team's name from settings, or empty when none is set. */
  readonly hostName: string;
  readonly booking: LocalVisitTimes & {
    readonly id: string;
    readonly revision: number;
    readonly status: "booked" | "canceled";
    readonly team: TeamIdentity;
    readonly windowTitle: string;
    readonly headcount: number;
    readonly note: string;
    readonly contactName: string;
    readonly contactPhone: string;
    readonly contactEmail: string;
  };
  /** Open windows the visit may move to. */
  readonly windows: readonly PublicWindow[];
  readonly horizonDays: number;
};
export type ManageEditRequest = {
  readonly revision: number;
  readonly date?: string;
  readonly arrival?: string;
  readonly departure?: string;
  readonly headcount?: number;
  readonly note?: string;
  readonly contactName?: string;
  readonly contactPhone?: string;
};

// Staff shapes.
export type SeriesRequest = { readonly weekdays: readonly number[]; readonly startTime: string; readonly endTime: string; readonly firstDate: string; readonly lastDate: string; readonly title?: string };
export type WindowRequest = { readonly date: string; readonly startTime: string; readonly endTime: string; readonly title?: string };
export type StaffSeries = SeriesRequest & { readonly id: string; readonly revision: number; readonly title: string; readonly windowCount: number };
export type StaffWindow = {
  readonly id: string;
  readonly seriesId: string | null;
  readonly revision: number;
  readonly date: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly title: string;
  readonly status: WindowStatus;
  readonly cancelReason: string;
  readonly edited: boolean;
  readonly bookedCount: number;
  readonly teamCount: number;
};
/**
 * The state of a visit's latest email. paused: a backup restore stopped it before it was sent, and nothing sends it; staff
 * resend the confirmation.
 */
export type EmailState = "none" | "pending" | "sent" | "failed" | "capped" | "paused";
export type StaffBooking = LocalVisitTimes & {
  readonly id: string;
  readonly revision: number;
  readonly status: "booked" | "canceled";
  /** Removed by staff: canceled without an email and hidden from every list but `removed`. Restore it from its history. */
  readonly removed: boolean;
  readonly team: TeamIdentity & { readonly id: string };
  readonly windowId: string;
  readonly windowTitle: string;
  readonly headcount: number;
  readonly note: string;
  readonly contactName: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
  readonly attention: Attention;
  readonly email: EmailState;
  /** Null when Outreach is not involved for this visit. */
  readonly outreach: { readonly state: "pending" | "recorded" | "failed"; readonly activityId: string | null; readonly error?: string } | null;
  readonly createdMs: number;
  readonly updatedMs: number;
};
/** At most `maximumOutreachRecordBatch` (50) visits are recorded per request; with a grant the rest are queued for the job. */
export type OutreachRecordRequest = { readonly bookingIds: readonly string[] };
/**
 * One visit's result. recorded: Outreach has its Team Support activity. pending: queued, or retrying after a provider
 * failure, for the notifications job. failed: Outreach refused it (`error` says why). skipped: not recorded, because the
 * visit is canceled, removed, missing or of program Other, or was beyond this request's limit without a grant.
 */
export type OutreachRecordResult = {
  readonly bookingId: string;
  readonly state: "recorded" | "pending" | "failed" | "skipped";
  readonly activityId: string | null;
  readonly error?: string;
};
export type OutreachRecordResponse = { readonly results: readonly OutreachRecordResult[] };
export type StaffBookingEdit = ManageEditRequest & { readonly contactEmail?: string; readonly teamId?: string };
export type BookingHistoryEntry = {
  readonly id: string;
  readonly atMs: number;
  readonly actor: { readonly kind: "guest" } | { readonly kind: "staff"; readonly name: string | null };
  readonly action: string;
  readonly changes: readonly FieldChange[];
};
export type StaffBookingDetail = StaffBooking & { readonly history: readonly BookingHistoryEntry[] };
export type StaffOverview = { readonly timeZone: string; readonly windows: readonly StaffWindow[]; readonly bookings: readonly StaffBooking[] };
export type StaffTeam = TeamIdentity & { readonly id: string; readonly revision: number; readonly archived: boolean; readonly visitCount: number; readonly outreachTeamId: string | null };

export type VisitsStatus = {
  readonly timeZone: string;
  readonly guestPagePath: "/visit";
  readonly email: { readonly ready: boolean };
  readonly discord: { readonly ready: boolean; readonly enabled: boolean };
  /**
   * `available`: Outreach can be used now, through an Admin's grant or the signed-in staff member's own Outreach access.
   * `granted`: an Admin's grant lets Guest Visits record on its own, so bookings and date changes are recorded
   * automatically. The notifications job checks the grant every five minutes, so a new grant shows within one pass.
   */
  readonly outreach: { readonly available: boolean; readonly granted: boolean };
  readonly attentionCount: number;
  readonly failedNotifications: number;
};
export type VisitsSettings = {
  readonly revision: number;
  /**
   * The host team's name as guests read it, for example "FRC 321 Lancers", at most 80 characters. Guest emails and the
   * guest page use it; empty means they say "our team".
   */
  readonly hostName: string;
  readonly introText: string;
  readonly replyTo: string;
  readonly testEmailSentMs: number | null;
  readonly discordEnabled: boolean;
  readonly discordChannelId: string;
  readonly weeklySummaryEnabled: boolean;
  /** 0 is Sunday. */
  readonly weeklySummaryWeekday: number;
  readonly weeklySummaryTime: string;
};
export type VisitsSettingsUpdate = Partial<Omit<VisitsSettings, "revision" | "testEmailSentMs">> & { readonly revision: number };
export type VisitsSetupStatus = { readonly emailReady: boolean; readonly testEmailSentMs: number | null; readonly windowCount: number; readonly timeZone: string };
