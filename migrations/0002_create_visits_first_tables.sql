-- Team lookup by number in FIRST's FRC and FTC team lists. An Admin's FIRST API credentials, the seasons and answers
-- FIRST gave, and the requests sent to FIRST in the last minute. None of these tables is backed up: a restore leaves
-- them empty, and an Admin saves the credentials again.

-- One FIRST Events API credential per program. The token is encrypted with Core's credential service; only its
-- ciphertext and IV are stored. checked_at is when FIRST last accepted the credential.
CREATE TABLE visits_first_credentials (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  program TEXT NOT NULL CHECK(program IN ('FRC', 'FTC')),
  username TEXT NOT NULL CHECK(length(username) BETWEEN 1 AND 100),
  ciphertext TEXT NOT NULL CHECK(length(ciphertext) BETWEEN 1 AND 4000),
  iv TEXT NOT NULL CHECK(length(iv) BETWEEN 1 AND 200),
  checked_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, program)
);

-- Each program's current season as its API root reported it, asked again after a day.
CREATE TABLE visits_first_seasons (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  program TEXT NOT NULL CHECK(program IN ('FRC', 'FTC')),
  season INTEGER NOT NULL CHECK(typeof(season) = 'integer' AND season BETWEEN 2000 AND 2999),
  checked_ms INTEGER NOT NULL CHECK(typeof(checked_ms) = 'integer'),
  PRIMARY KEY(installation_id, program)
);

-- FIRST's answer for one team number in the current season or, failing that, the previous one, kept for seven days. A
-- NULL name records that FIRST has no such team.
CREATE TABLE visits_first_teams (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  program TEXT NOT NULL CHECK(program IN ('FRC', 'FTC')),
  number TEXT NOT NULL CHECK(length(number) BETWEEN 1 AND 6 AND number NOT GLOB '*[^0-9]*' AND number NOT GLOB '0*'),
  name TEXT CHECK(name IS NULL OR length(name) BETWEEN 1 AND 100),
  location TEXT NOT NULL DEFAULT '' CHECK(length(location) <= 200),
  checked_ms INTEGER NOT NULL CHECK(typeof(checked_ms) = 'integer'),
  PRIMARY KEY(installation_id, program, number),
  CHECK(name IS NOT NULL OR location = '')
);
CREATE INDEX visits_first_teams_checked ON visits_first_teams(installation_id, checked_ms);

-- Requests sent to FIRST, kept for a minute: uncached lookups stop at the limit so guests cannot use up the tokens.
CREATE TABLE visits_first_requests (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  requested_ms INTEGER NOT NULL CHECK(typeof(requested_ms) = 'integer'),
  PRIMARY KEY(installation_id, id)
);
CREATE INDEX visits_first_requests_time ON visits_first_requests(installation_id, requested_ms);
