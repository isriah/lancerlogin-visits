-- Guest Visits schema. Every row belongs to one installation and is removed with it. Instants are integer epoch
-- milliseconds (columns ending in _ms) on whole minutes where people enter them; record timestamps (created_at,
-- updated_at) are ISO text. Local dates are YYYY-MM-DD and local times HH:MM in the installation time zone.
-- Migrations are forward-only: never edit a released migration; add the next numbered file and list it in reviewed.json.

-- One settings row per installation, created on first enablement.
CREATE TABLE visits_settings (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  intro_text TEXT NOT NULL DEFAULT '' CHECK(length(intro_text) <= 2000),
  reply_to TEXT NOT NULL DEFAULT '' CHECK(reply_to = '' OR (length(reply_to) BETWEEN 3 AND 254 AND instr(reply_to, '@') > 1)),
  test_email_sent_at TEXT,
  discord_enabled INTEGER NOT NULL DEFAULT 0 CHECK(discord_enabled IN (0, 1)),
  discord_channel_id TEXT CHECK(discord_channel_id IS NULL OR (length(discord_channel_id) BETWEEN 17 AND 20 AND discord_channel_id NOT GLOB '*[^0-9]*')),
  weekly_summary_enabled INTEGER NOT NULL DEFAULT 1 CHECK(weekly_summary_enabled IN (0, 1)),
  -- 0 is Sunday. The default report is Monday 12:00.
  weekly_summary_weekday INTEGER NOT NULL DEFAULT 1 CHECK(typeof(weekly_summary_weekday) = 'integer' AND weekly_summary_weekday BETWEEN 0 AND 6),
  weekly_summary_time TEXT NOT NULL DEFAULT '12:00' CHECK(weekly_summary_time GLOB '[0-2][0-9]:[0-5][0-9]' AND weekly_summary_time <= '23:59'),
  -- Report times before this instant are never due, so turning the summary on or moving it does not post a past week.
  weekly_summary_since_ms INTEGER NOT NULL CHECK(typeof(weekly_summary_since_ms) = 'integer'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  updated_at TEXT NOT NULL,
  CHECK(discord_enabled = 0 OR discord_channel_id IS NOT NULL)
);

-- A repeating availability rule. Saving it expands into dated rows in visits_windows. Bit n of weekday_mask is weekday n
-- (0 is Sunday). The range covers at most 366 dates.
CREATE TABLE visits_availability_series (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  weekday_mask INTEGER NOT NULL CHECK(typeof(weekday_mask) = 'integer' AND weekday_mask BETWEEN 1 AND 127),
  start_time TEXT NOT NULL CHECK(start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time <= '23:59'),
  end_time TEXT NOT NULL CHECK(end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time <= '23:59'),
  first_date TEXT NOT NULL CHECK(first_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(first_date) IS first_date),
  last_date TEXT NOT NULL CHECK(last_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(last_date) IS last_date),
  title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 80),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, id),
  CHECK(end_time > start_time),
  CHECK(last_date >= first_date AND julianday(last_date) - julianday(first_date) <= 365)
);

-- Dated windows guests book into. A window from a series keeps series_id; edited = 1 marks a window changed on its own,
-- which later series edits leave alone. Canceled windows stay listed with their reason and still block overlaps so they
-- can be restored; removed windows are kept only while visits refer to them and are ignored everywhere else.
CREATE TABLE visits_windows (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  series_id TEXT,
  start_ms INTEGER NOT NULL CHECK(typeof(start_ms) = 'integer' AND start_ms % 60000 = 0),
  end_ms INTEGER NOT NULL CHECK(typeof(end_ms) = 'integer' AND end_ms % 60000 = 0),
  title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 80),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'canceled', 'removed')),
  cancel_reason TEXT NOT NULL DEFAULT '' CHECK(length(cancel_reason) <= 200),
  edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, id),
  FOREIGN KEY(installation_id, series_id) REFERENCES visits_availability_series(installation_id, id),
  CHECK(end_ms > start_ms AND end_ms - start_ms <= 90000000),
  CHECK((status = 'canceled') = (cancel_reason != ''))
);
CREATE INDEX visits_windows_start ON visits_windows(installation_id, start_ms) WHERE status != 'removed';
CREATE INDEX visits_windows_series ON visits_windows(installation_id, series_id, start_ms) WHERE series_id IS NOT NULL;

-- Windows never overlap. A window lasts at most one local day (25 hours when clocks fall back), so the start bound keeps
-- the check on the start index.
CREATE TRIGGER visits_windows_no_overlap_insert BEFORE INSERT ON visits_windows
WHEN NEW.status != 'removed' AND EXISTS(
  SELECT 1 FROM visits_windows w WHERE w.installation_id = NEW.installation_id AND w.status != 'removed'
    AND w.start_ms > NEW.start_ms - 90000000 AND w.start_ms < NEW.end_ms AND w.end_ms > NEW.start_ms
)
BEGIN SELECT RAISE(ABORT, 'visits_window_overlap'); END;

CREATE TRIGGER visits_windows_no_overlap_update BEFORE UPDATE OF start_ms, end_ms, status ON visits_windows
WHEN NEW.status != 'removed' AND EXISTS(
  SELECT 1 FROM visits_windows w WHERE w.installation_id = NEW.installation_id AND w.id != NEW.id AND w.status != 'removed'
    AND w.start_ms > NEW.start_ms - 90000000 AND w.start_ms < NEW.end_ms AND w.end_ms > NEW.start_ms
)
BEGIN SELECT RAISE(ABORT, 'visits_window_overlap'); END;

-- A change guests can see moves the revision forward by exactly one, so a stale edit can never overwrite a newer one.
CREATE TRIGGER visits_windows_revision BEFORE UPDATE ON visits_windows
WHEN NEW.revision < OLD.revision OR (NEW.revision != OLD.revision + 1 AND (
  NEW.start_ms IS NOT OLD.start_ms OR NEW.end_ms IS NOT OLD.end_ms OR NEW.title IS NOT OLD.title
  OR NEW.status IS NOT OLD.status OR NEW.cancel_reason IS NOT OLD.cancel_reason
))
BEGIN SELECT RAISE(ABORT, 'visits_window_revision'); END;

-- Guest teams. Numbers are digits for FRC, FTC, Challenge and Explore and short codes for Other. Archived teams (merged
-- duplicates) keep their bookings' history but no longer claim their number.
CREATE TABLE visits_teams (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  number TEXT NOT NULL CHECK(length(number) BETWEEN 1 AND 10 AND number NOT GLOB '*[^0-9A-Z-]*'),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  program TEXT NOT NULL CHECK(program IN ('FRC', 'FTC', 'Challenge', 'Explore', 'Other')),
  outreach_team_id TEXT CHECK(outreach_team_id IS NULL OR length(outreach_team_id) BETWEEN 1 AND 100),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, id),
  CHECK(program = 'Other' OR (length(number) <= 6 AND number NOT GLOB '*[^0-9]*' AND number NOT GLOB '0*')),
  CHECK(program != 'Other' OR outreach_team_id IS NULL)
);
CREATE UNIQUE INDEX visits_teams_number ON visits_teams(installation_id, program, number) WHERE archived = 0;

-- Booked and canceled visits. Contact details and the note are visible to staff only. Staff can remove a visit: it is
-- canceled without an email and hidden from every list, and its change history stays so staff can restore it.
CREATE TABLE visits_bookings (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  window_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  contact_name TEXT NOT NULL CHECK(length(contact_name) BETWEEN 1 AND 100),
  contact_email TEXT NOT NULL CHECK(length(contact_email) BETWEEN 3 AND 254 AND instr(contact_email, '@') > 1),
  contact_phone TEXT NOT NULL DEFAULT '' CHECK(length(contact_phone) <= 40),
  arrival_ms INTEGER NOT NULL CHECK(typeof(arrival_ms) = 'integer' AND arrival_ms % 60000 = 0),
  departure_ms INTEGER NOT NULL CHECK(typeof(departure_ms) = 'integer' AND departure_ms % 60000 = 0),
  headcount INTEGER NOT NULL CHECK(typeof(headcount) = 'integer' AND headcount BETWEEN 1 AND 100),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 1000),
  status TEXT NOT NULL DEFAULT 'booked' CHECK(status IN ('booked', 'canceled')),
  removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0, 1)),
  attention TEXT NOT NULL DEFAULT 'none' CHECK(attention IN ('none', 'needed', 'handled')),
  attention_reason TEXT CHECK(attention_reason IN ('window-canceled', 'window-removed', 'window-changed', 'outreach-activity-kept')),
  outreach_activity_id TEXT CHECK(outreach_activity_id IS NULL OR length(outreach_activity_id) BETWEEN 1 AND 100),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, id),
  FOREIGN KEY(installation_id, window_id) REFERENCES visits_windows(installation_id, id),
  FOREIGN KEY(installation_id, team_id) REFERENCES visits_teams(installation_id, id),
  CHECK(departure_ms > arrival_ms AND departure_ms - arrival_ms <= 90000000),
  CHECK((attention = 'none') = (attention_reason IS NULL)),
  CHECK(removed = 0 OR status = 'canceled')
);
CREATE INDEX visits_bookings_window ON visits_bookings(installation_id, window_id, status);
CREATE INDEX visits_bookings_arrival ON visits_bookings(installation_id, arrival_ms);
CREATE INDEX visits_bookings_team ON visits_bookings(installation_id, team_id);
CREATE INDEX visits_bookings_attention ON visits_bookings(installation_id, arrival_ms) WHERE attention = 'needed';

-- Changes guests and staff can see move the revision forward by exactly one. Attention and the Outreach reference are
-- staff and job bookkeeping and leave the revision alone, so they never make a guest's edit stale.
CREATE TRIGGER visits_bookings_revision BEFORE UPDATE ON visits_bookings
WHEN NEW.revision < OLD.revision OR (NEW.revision != OLD.revision + 1 AND (
  NEW.window_id IS NOT OLD.window_id OR NEW.team_id IS NOT OLD.team_id OR NEW.contact_name IS NOT OLD.contact_name
  OR NEW.contact_email IS NOT OLD.contact_email OR NEW.contact_phone IS NOT OLD.contact_phone
  OR NEW.arrival_ms IS NOT OLD.arrival_ms OR NEW.departure_ms IS NOT OLD.departure_ms OR NEW.headcount IS NOT OLD.headcount
  OR NEW.note IS NOT OLD.note OR NEW.status IS NOT OLD.status OR NEW.removed IS NOT OLD.removed
))
BEGIN SELECT RAISE(ABORT, 'visits_booking_revision'); END;

-- Append-only change history. snapshot_json is the booking after the change, so staff can restore an earlier version.
CREATE TABLE visits_booking_revisions (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  booking_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0 AND revision < 9007199254740991),
  action TEXT NOT NULL CHECK(action IN ('created', 'updated', 'canceled', 'restored', 'removed')),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('guest', 'staff')),
  staff_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  change_json TEXT NOT NULL CHECK(json_valid(change_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, booking_id, revision),
  FOREIGN KEY(installation_id, booking_id) REFERENCES visits_bookings(installation_id, id) ON DELETE CASCADE,
  CHECK(actor_kind = 'staff' OR staff_user_id IS NULL)
);

-- History rows never change, except that deleting a dashboard account clears its user ID.
CREATE TRIGGER visits_booking_revisions_append_only BEFORE UPDATE ON visits_booking_revisions
WHEN NOT (
  OLD.staff_user_id IS NOT NULL AND NEW.staff_user_id IS NULL
  AND NEW.installation_id IS OLD.installation_id AND NEW.booking_id IS OLD.booking_id AND NEW.revision IS OLD.revision
  AND NEW.action IS OLD.action AND NEW.actor_kind IS OLD.actor_kind AND NEW.change_json IS OLD.change_json
  AND NEW.snapshot_json IS OLD.snapshot_json AND NEW.created_at IS OLD.created_at
)
BEGIN SELECT RAISE(ABORT, 'visits_booking_revisions_append_only'); END;

-- SHA-256 of each emailed manage-link token. The token itself is never stored. expires_ms follows the visit's end.
CREATE TABLE visits_manage_tokens (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  booking_id TEXT NOT NULL,
  issued_ms INTEGER NOT NULL CHECK(typeof(issued_ms) = 'integer'),
  expires_ms INTEGER NOT NULL CHECK(typeof(expires_ms) = 'integer'),
  revoked_ms INTEGER CHECK(revoked_ms IS NULL OR typeof(revoked_ms) = 'integer'),
  PRIMARY KEY(installation_id, token_hash),
  FOREIGN KEY(installation_id, booking_id) REFERENCES visits_bookings(installation_id, id) ON DELETE CASCADE
);
CREATE INDEX visits_manage_tokens_booking ON visits_manage_tokens(installation_id, booking_id);
CREATE INDEX visits_manage_tokens_expiry ON visits_manage_tokens(installation_id, expires_ms);

-- Idempotency keys for guest booking submissions: SHA-256 of the key and of the submitted booking.
CREATE TABLE visits_public_submission_keys (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL CHECK(length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
  booking_id TEXT NOT NULL,
  created_ms INTEGER NOT NULL CHECK(typeof(created_ms) = 'integer'),
  PRIMARY KEY(installation_id, key_hash),
  FOREIGN KEY(installation_id, booking_id) REFERENCES visits_bookings(installation_id, id) ON DELETE CASCADE
);
CREATE INDEX visits_public_submission_keys_created ON visits_public_submission_keys(installation_id, created_ms);

-- Emails sent to each recipient per local day. Addresses are stored only as SHA-256 of the lowercase address.
CREATE TABLE visits_email_limits (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  address_hash TEXT NOT NULL CHECK(length(address_hash) = 64 AND address_hash NOT GLOB '*[^0-9a-f]*'),
  local_day TEXT NOT NULL CHECK(local_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(local_day) IS local_day),
  sent INTEGER NOT NULL DEFAULT 0 CHECK(typeof(sent) = 'integer' AND sent >= 0),
  PRIMARY KEY(installation_id, address_hash, local_day)
);
CREATE INDEX visits_email_limits_day ON visits_email_limits(installation_id, local_day);

-- Queued email, Discord and Outreach work. A weekly summary has no booking and is keyed by its report date, so each week
-- posts at most once. A row being sent holds a lease; every other row holds none.
CREATE TABLE visits_notifications (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  channel TEXT NOT NULL CHECK(channel IN ('email', 'discord', 'outreach')),
  kind TEXT NOT NULL CHECK(kind IN ('booked', 'changed', 'canceled', 'resend', 'weekly-summary', 'outreach-record')),
  booking_id TEXT,
  summary_date TEXT CHECK(summary_date IS NULL OR (summary_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(summary_date) IS summary_date)),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'delivered', 'failed', 'paused', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer' AND attempts >= 0),
  next_attempt_ms INTEGER CHECK(next_attempt_ms IS NULL OR typeof(next_attempt_ms) = 'integer'),
  lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token) BETWEEN 16 AND 100),
  lease_expires_ms INTEGER CHECK(lease_expires_ms IS NULL OR typeof(lease_expires_ms) = 'integer'),
  external_id TEXT CHECK(external_id IS NULL OR length(external_id) <= 200),
  last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, id),
  FOREIGN KEY(installation_id, booking_id) REFERENCES visits_bookings(installation_id, id) ON DELETE CASCADE,
  CHECK(
    (channel = 'email' AND kind IN ('booked', 'changed', 'canceled', 'resend') AND booking_id IS NOT NULL AND summary_date IS NULL)
    OR (channel = 'discord' AND kind IN ('booked', 'changed', 'canceled') AND booking_id IS NOT NULL AND summary_date IS NULL)
    OR (channel = 'discord' AND kind = 'weekly-summary' AND booking_id IS NULL AND summary_date IS NOT NULL)
    OR (channel = 'outreach' AND kind = 'outreach-record' AND booking_id IS NOT NULL AND summary_date IS NULL)
  ),
  CHECK((status = 'sending') = (lease_token IS NOT NULL) AND (lease_token IS NULL) = (lease_expires_ms IS NULL)),
  CHECK(status != 'pending' OR next_attempt_ms IS NOT NULL)
);
CREATE UNIQUE INDEX visits_notifications_weekly_summary ON visits_notifications(installation_id, summary_date) WHERE kind = 'weekly-summary';
-- One waiting Outreach record per booking: queueing again while one waits changes nothing.
CREATE UNIQUE INDEX visits_notifications_outreach_pending ON visits_notifications(installation_id, booking_id) WHERE channel = 'outreach' AND status = 'pending';
CREATE INDEX visits_notifications_due ON visits_notifications(installation_id, status, next_attempt_ms);
CREATE INDEX visits_notifications_lease ON visits_notifications(installation_id, lease_expires_ms) WHERE status = 'sending';
CREATE INDEX visits_notifications_booking ON visits_notifications(installation_id, booking_id) WHERE booking_id IS NOT NULL;
