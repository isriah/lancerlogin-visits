-- Example Module schema. Rows belong to one installation and are removed with it. Migrations are forward-only:
-- never edit a released migration; add the next numbered file and list it in reviewed.json.
CREATE TABLE example_module_notes (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  PRIMARY KEY(installation_id, id)
);
CREATE INDEX example_module_notes_recent ON example_module_notes(installation_id, created_at);
