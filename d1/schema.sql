CREATE TABLE IF NOT EXISTS hr_state (
  state_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
