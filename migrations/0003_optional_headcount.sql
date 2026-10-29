-- Headcount becomes optional: a visit's headcount is NULL when the guest did not give one, and 1 to 100 when given. An
-- Admin can require it on the guest page with visits_settings.headcount_required (off by default).
--
-- SQLite cannot change a column's constraint in place, and rebuilding visits_bookings is not an option: dropping it would
-- cascade-delete its history, manage links, submission keys and notifications, and renaming it would repoint their
-- foreign keys. So the column is replaced within the table: add the new column, copy every value, drop the old column
-- and give the new one its name. Existing rows keep their headcount. The revision trigger names headcount, so it is
-- dropped first (a column a trigger names cannot be dropped) and created again unchanged. The whole migration is one
-- atomic batch, so no write sees the table without its trigger.

DROP TRIGGER visits_bookings_revision;

ALTER TABLE visits_bookings ADD COLUMN headcount_given INTEGER CHECK(headcount_given IS NULL OR (typeof(headcount_given) = 'integer' AND headcount_given BETWEEN 1 AND 100));
UPDATE visits_bookings SET headcount_given = headcount;
ALTER TABLE visits_bookings DROP COLUMN headcount;
ALTER TABLE visits_bookings RENAME COLUMN headcount_given TO headcount;

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

-- Whether guests must give a headcount to book. Off: the booking form marks it optional.
ALTER TABLE visits_settings ADD COLUMN headcount_required INTEGER NOT NULL DEFAULT 0 CHECK(headcount_required IN (0, 1));
