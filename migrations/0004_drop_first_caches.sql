-- Team lookup moved to Core's shared FIRST connection (services.first, module SDK 1.2.0), which keeps its own cache of
-- FIRST's answers and seasons and its own request limits. Guest Visits' copies are dropped: they were never backed up and
-- only ever held what FIRST can answer again. Dropping a table drops its indexes with it.
--
-- visits_first_credentials stays. Core applies this migration before the new code runs, so the FRC and FTC credentials
-- saved in Guest Visits must outlive it: the new code hands each one to Core with services.first.importLegacyCredential
-- on its first team search, Settings > Guest Visits read or notifications job pass, then deletes each one Core took or
-- already had. A later release drops visits_first_credentials once every installation has run this one.
DROP TABLE visits_first_requests;
DROP TABLE visits_first_teams;
DROP TABLE visits_first_seasons;
