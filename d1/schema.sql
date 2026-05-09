-- 线上 D1 如存在独立 candidates 表，需要手动执行以下 3 条增量 ALTER：
-- ALTER TABLE candidates ADD COLUMN interview_location TEXT;
-- ALTER TABLE candidates ADD COLUMN interview_link TEXT;
-- ALTER TABLE candidates ADD COLUMN interview_notes TEXT;
--
-- 当前项目的候选人主体数据保存在 hr_state.payload JSON 快照中；
-- 上述字段会随 candidates JSON 一起同步，不会影响历史数据。

CREATE TABLE IF NOT EXISTS hr_state (
  state_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learning_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  candidate_id INTEGER,
  job_title TEXT,
  candidate_name TEXT,
  ai_recommendation TEXT,
  ai_score REAL,
  director_verdict TEXT NOT NULL,
  director_reason TEXT NOT NULL,
  screening_summary TEXT,
  interview_summary TEXT,
  mismatch_type TEXT,
  delta_notes TEXT,
  sample_payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learning_samples_job_created
ON learning_samples (job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rubric_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_sample_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  rubric_payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rubric_versions_job_version
ON rubric_versions (job_id, version_no);

CREATE TABLE IF NOT EXISTS question_bank_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_sample_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  question_bank_payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_question_bank_versions_job_version
ON question_bank_versions (job_id, version_no);
