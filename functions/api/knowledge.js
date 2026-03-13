const CREATE_LEARNING_SAMPLES_SQL = `
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
  )
`;
const CREATE_LEARNING_SAMPLES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_learning_samples_job_created
  ON learning_samples (job_id, created_at DESC)
`;
const CREATE_RUBRIC_VERSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS rubric_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    source_sample_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    rubric_payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`;
const CREATE_RUBRIC_VERSIONS_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rubric_versions_job_version
  ON rubric_versions (job_id, version_no)
`;
const CREATE_QUESTION_BANK_VERSIONS_SQL = `
  CREATE TABLE IF NOT EXISTS question_bank_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    source_sample_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    question_bank_payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`;
const CREATE_QUESTION_BANK_VERSIONS_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_question_bank_versions_job_version
  ON question_bank_versions (job_id, version_no)
`;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function verifyToken(request, env) {
  const token = env.HR_PROXY_TOKEN || "";
  if (!token) return null;
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${token}` ? null : json({ error: "代理访问令牌无效" }, 401);
}

async function ensureKnowledgeTables(db) {
  await db.prepare(CREATE_LEARNING_SAMPLES_SQL).run();
  await db.prepare(CREATE_LEARNING_SAMPLES_INDEX_SQL).run();
  await db.prepare(CREATE_RUBRIC_VERSIONS_SQL).run();
  await db.prepare(CREATE_RUBRIC_VERSIONS_INDEX_SQL).run();
  await db.prepare(CREATE_QUESTION_BANK_VERSIONS_SQL).run();
  await db.prepare(CREATE_QUESTION_BANK_VERSIONS_INDEX_SQL).run();
}

function parseJSON(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function getLatestKnowledge(db, jobId) {
  const sampleCountRow = await db.prepare(
    `SELECT COUNT(*) AS count FROM learning_samples WHERE job_id = ?1`
  ).bind(jobId).first();

  const recentSamplesRows = await db.prepare(
    `SELECT id, job_title, candidate_name, ai_recommendation, ai_score, director_verdict,
            director_reason, screening_summary, interview_summary, mismatch_type, delta_notes,
            sample_payload, created_at
     FROM learning_samples
     WHERE job_id = ?1
     ORDER BY created_at DESC, id DESC
     LIMIT 12`
  ).bind(jobId).all();

  const rubricRow = await db.prepare(
    `SELECT version_no, source_sample_count, summary, rubric_payload, created_at
     FROM rubric_versions
     WHERE job_id = ?1
     ORDER BY version_no DESC
     LIMIT 1`
  ).bind(jobId).first();

  const questionBankRow = await db.prepare(
    `SELECT version_no, source_sample_count, summary, question_bank_payload, created_at
     FROM question_bank_versions
     WHERE job_id = ?1
     ORDER BY version_no DESC
     LIMIT 1`
  ).bind(jobId).first();

  return {
    jobId,
    sampleCount: Number(sampleCountRow?.count) || 0,
    recentSamples: Array.isArray(recentSamplesRows?.results)
      ? recentSamplesRows.results.map(row => ({
          id: row.id,
          jobTitle: row.job_title,
          candidateName: row.candidate_name,
          aiRecommendation: row.ai_recommendation,
          aiScore: row.ai_score,
          directorVerdict: row.director_verdict,
          directorReason: row.director_reason,
          screeningSummary: row.screening_summary,
          interviewSummary: row.interview_summary,
          mismatchType: row.mismatch_type,
          deltaNotes: row.delta_notes,
          samplePayload: parseJSON(row.sample_payload, null),
          createdAt: row.created_at,
        }))
      : [],
    rubricVersion: rubricRow?.version_no || null,
    rubricSummary: rubricRow?.summary || "",
    rubric: parseJSON(rubricRow?.rubric_payload, null),
    rubricUpdatedAt: rubricRow?.created_at || "",
    questionBankVersion: questionBankRow?.version_no || null,
    questionBankSummary: questionBankRow?.summary || "",
    questionBank: parseJSON(questionBankRow?.question_bank_payload, null),
    questionBankUpdatedAt: questionBankRow?.created_at || "",
  };
}

async function archivePreviousVersions(db, tableName, jobId) {
  await db.prepare(`UPDATE ${tableName} SET status = 'archived' WHERE job_id = ?1 AND status = 'active'`)
    .bind(jobId)
    .run();
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const authError = verifyToken(request, env);
  if (authError) return authError;

  if (!env.DB) {
    return json({ error: "D1 数据库未绑定。请在 Cloudflare 项目里添加名为 DB 的 D1 绑定。" }, 500);
  }

  try {
    await ensureKnowledgeTables(env.DB);
  } catch (error) {
    return json({ error: error?.message || "初始化学习数据表失败" }, 500);
  }

  if (request.method === "GET") {
    const url = new URL(request.url);
    const jobId = Number(url.searchParams.get("jobId"));
    if (!jobId) return json({ error: "缺少 jobId" }, 400);
    try {
      return json(await getLatestKnowledge(env.DB, jobId));
    } catch (error) {
      return json({ error: error?.message || "读取学习数据失败" }, 500);
    }
  }

  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "请求体不是合法 JSON" }, 400);

  const { action } = body;

  if (action === "recordSample") {
    const sample = body.sample || {};
    const jobId = Number(sample.jobId);
    if (!jobId) return json({ error: "学习样本缺少 jobId" }, 400);
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO learning_samples (
          job_id, candidate_id, job_title, candidate_name, ai_recommendation, ai_score,
          director_verdict, director_reason, screening_summary, interview_summary,
          mismatch_type, delta_notes, sample_payload, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
      ).bind(
        jobId,
        sample.candidateId || null,
        sample.jobTitle || "",
        sample.candidateName || "",
        sample.aiRecommendation || "",
        sample.aiScore ?? null,
        sample.directorVerdict || "",
        sample.directorReason || "",
        sample.screeningSummary || "",
        sample.interviewSummary || "",
        sample.mismatchType || "",
        sample.deltaNotes || "",
        JSON.stringify(sample.samplePayload || {}),
        now
      ).run();
      const latest = await getLatestKnowledge(env.DB, jobId);
      return json({ ok: true, sampleCount: latest.sampleCount, recentSamples: latest.recentSamples });
    } catch (error) {
      return json({ error: error?.message || "记录学习样本失败" }, 500);
    }
  }

  if (action === "saveKnowledge") {
    const jobId = Number(body.jobId);
    if (!jobId) return json({ error: "缺少 jobId" }, 400);
    const now = new Date().toISOString();
    try {
      const rubricVersionRow = await env.DB.prepare(
        `SELECT COALESCE(MAX(version_no), 0) AS max_version FROM rubric_versions WHERE job_id = ?1`
      ).bind(jobId).first();
      const questionBankVersionRow = await env.DB.prepare(
        `SELECT COALESCE(MAX(version_no), 0) AS max_version FROM question_bank_versions WHERE job_id = ?1`
      ).bind(jobId).first();

      const nextRubricVersion = (Number(rubricVersionRow?.max_version) || 0) + 1;
      const nextQuestionBankVersion = (Number(questionBankVersionRow?.max_version) || 0) + 1;

      await archivePreviousVersions(env.DB, "rubric_versions", jobId);
      await archivePreviousVersions(env.DB, "question_bank_versions", jobId);

      await env.DB.prepare(
        `INSERT INTO rubric_versions (
          job_id, version_no, status, source_sample_count, summary, rubric_payload, created_at
        ) VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?6)`
      ).bind(
        jobId,
        nextRubricVersion,
        Number(body.sourceSampleCount) || 0,
        body.rubricSummary || "",
        JSON.stringify(body.rubric || {}),
        now
      ).run();

      await env.DB.prepare(
        `INSERT INTO question_bank_versions (
          job_id, version_no, status, source_sample_count, summary, question_bank_payload, created_at
        ) VALUES (?1, ?2, 'active', ?3, ?4, ?5, ?6)`
      ).bind(
        jobId,
        nextQuestionBankVersion,
        Number(body.sourceSampleCount) || 0,
        body.questionBankSummary || "",
        JSON.stringify(body.questionBank || {}),
        now
      ).run();

      return json({
        ok: true,
        rubricVersion: nextRubricVersion,
        questionBankVersion: nextQuestionBankVersion,
        updatedAt: now,
      });
    } catch (error) {
      return json({ error: error?.message || "保存规则与题库版本失败" }, 500);
    }
  }

  return json({ error: `不支持的 action: ${action}` }, 400);
}
