-- FIRST credentials saved in Guest Visits before team lookup moved to Core's shared FIRST connection (services.first) are
-- dropped. Guest Visits 0.3.0 moved each one into Core (Settings > Integrations > FIRST) at run time, after its migration
-- 0004, and deleted every copy Core took or already had. What can remain is a credential Core could not read with its
-- integration key, which an Admin saves again in Settings > Integrations > FIRST.
--
-- Migrations run before any of a release's code, so an installation that skipped 0.3.0 would lose its credentials here.
-- package.json lists 0004_drop_first_caches.sql in lancerlogin.upgradeRequiresMigrations: Core refuses to upgrade an
-- installation to this release until 0.3.0's migration, and with it the move, has run. A new installation runs every
-- migration in order and never had a credential here. The table was never backed up, so the backup version is unchanged.
DROP TABLE visits_first_credentials;
