-- 当前项目所有候选人主体数据保存在 hr_state.payload JSON 快照中；
-- 候选人新增字段（如 scheduledAt / interviewLocation / interviewLink /
-- interviewNotes / extractedQA）都随该 JSON 一起同步，无需独立 ALTER。
-- 简历原文件和新快照保存在 R2 RESUME_ASSETS；
-- D1 只保存资产索引、候选人 active ref 和事件日志。
-- hr_resume_previews 是旧版 blob 表，仅作 legacy 读取和迁移来源。

CREATE TABLE IF NOT EXISTS hr_state (
  state_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hr_resume_previews (
  candidate_id TEXT PRIMARY KEY,
  preview_payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hr_resume_assets (
  asset_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  asset_kind TEXT NOT NULL,
  resume_signature TEXT,
  file_name TEXT,
  mime_type TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  version_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hr_resume_assets_candidate_version
ON hr_resume_assets (candidate_id, version_no DESC);

CREATE TABLE IF NOT EXISTS hr_candidate_resume_refs (
  candidate_id TEXT PRIMARY KEY,
  active_asset_id TEXT NOT NULL,
  active_version INTEGER NOT NULL,
  resume_signature TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hr_resume_asset_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  asset_id TEXT,
  event_type TEXT NOT NULL,
  event_payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hr_resume_asset_events_candidate_created
ON hr_resume_asset_events (candidate_id, created_at DESC);

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
