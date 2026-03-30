const STATE_KEY = "default";
const SCHEMA_VERSION = 1;
const CREATE_STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS hr_state (
    state_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;
const SELECT_STATE_SQL = `
  SELECT payload, schema_version, updated_at
  FROM hr_state
  WHERE state_key = ?
  LIMIT 1
`;
const UPSERT_STATE_SQL = `
  INSERT INTO hr_state (state_key, payload, schema_version, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT(state_key) DO UPDATE SET
    payload = excluded.payload,
    schema_version = excluded.schema_version,
    updated_at = excluded.updated_at
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

async function ensureStateTable(db) {
  await db.prepare(CREATE_STATE_TABLE_SQL).run();
}

function verifyToken(request, env) {
  const token = env.HR_PROXY_TOKEN || "";
  if (!token) return null;
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${token}` ? null : json({ error: "代理访问令牌无效" }, 401);
}

function normalizeStatePayload(raw) {
  const state = raw?.state && typeof raw.state === "object" ? raw.state : raw;
  return {
    schemaVersion: Number(state?.schemaVersion) || SCHEMA_VERSION,
    cfg: state?.cfg && typeof state.cfg === "object" ? state.cfg : {},
    jobs: Array.isArray(state?.jobs) ? state.jobs : [],
    cands: Array.isArray(state?.cands) ? state.cands : [],
    usageLogs: Array.isArray(state?.usageLogs) ? state.usageLogs : [],
    deletedCandidateIds: normalizeDeletedIds(state?.deletedCandidateIds),
  };
}

function normalizeDuplicateField(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function normalizeDeletedIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(id => String(id || "").trim()).filter(Boolean))];
}

function mergeDeletedIds(left = [], right = []) {
  return normalizeDeletedIds([...(left || []), ...(right || [])]);
}

function filterDeletedCandidates(cands = [], deletedCandidateIds = []) {
  const deletedSet = new Set(normalizeDeletedIds(deletedCandidateIds));
  if (!deletedSet.size) return Array.isArray(cands) ? cands : [];
  return (Array.isArray(cands) ? cands : []).filter(candidate => !deletedSet.has(String(candidate?.id || "").trim()));
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildResumeSignature(text) {
  return normalizeExtractedText(text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 1600);
}

function entityTime(entity) {
  const value = entity?.updatedAt || entity?.createdAt || "";
  const ts = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ts) ? ts : 0;
}

function pickRicherValue(preferred, fallback) {
  if (preferred == null || preferred === "") return fallback;
  if (Array.isArray(preferred) && !preferred.length) return fallback;
  if (typeof preferred === "object" && !Array.isArray(preferred) && !Object.keys(preferred).length) return fallback;
  return preferred;
}

function sanitizeCandidateForCloud(candidate) {
  if (!candidate || typeof candidate !== "object") return candidate;
  return { ...candidate, resumePreview: null };
}

function mergeCandidateRecord(left, right) {
  const newer = entityTime(left) > entityTime(right) ? left : right;
  const older = newer === left ? right : left;
  const mergedTime = Math.max(entityTime(left), entityTime(right));
  const manualStatusRecord = [left, right]
    .filter(item => item?.statusSource === "manual" && item?.status)
    .sort((a, b) => entityTime(b) - entityTime(a))[0];
  return sanitizeCandidateForCloud({
    ...older,
    ...newer,
    name: pickRicherValue(newer?.name, older?.name),
    jobId: newer?.jobId ?? older?.jobId ?? null,
    status: manualStatusRecord?.status || pickRicherValue(newer?.status, older?.status) || "pending",
    statusSource: manualStatusRecord ? "manual" : (pickRicherValue(newer?.statusSource, older?.statusSource) || "system"),
    resume: pickRicherValue(newer?.resume, older?.resume),
    resumeSignature: pickRicherValue(newer?.resumeSignature, older?.resumeSignature || buildResumeSignature(newer?.resume || older?.resume || "")),
    resumeFileName: pickRicherValue(newer?.resumeFileName, older?.resumeFileName),
    screening: pickRicherValue(newer?.screening, older?.screening),
    questions: pickRicherValue(newer?.questions, older?.questions) || null,
    interviews: pickRicherValue(newer?.interviews, older?.interviews) || [],
    scheduledAt: pickRicherValue(newer?.scheduledAt, older?.scheduledAt) || null,
    interviewRound: pickRicherValue(newer?.interviewRound, older?.interviewRound) || null,
    directorVerdict: pickRicherValue(newer?.directorVerdict, older?.directorVerdict) || null,
    updatedAt: (mergedTime ? new Date(mergedTime) : new Date()).toISOString(),
  });
}

function mergeJobsById(localJobs = [], remoteJobs = []) {
  const map = new Map();
  [...remoteJobs, ...localJobs].forEach(job => {
    if (!job?.id) return;
    const existing = map.get(job.id);
    if (!existing) {
      map.set(job.id, job);
      return;
    }
    map.set(job.id, entityTime(job) > entityTime(existing) ? { ...existing, ...job } : { ...job, ...existing });
  });
  return [...map.values()];
}

function mergeCandidates(localCands = [], remoteCands = []) {
  const map = new Map();
  [...remoteCands, ...localCands].forEach(candidate => {
    if (!candidate) return;
    const signature = candidate.resumeSignature || buildResumeSignature(candidate.resume || "");
    const key = candidate.id
      ? `id:${candidate.id}`
      : signature
        ? `sig:${signature}`
        : `name:${normalizeDuplicateField(candidate.name)}|file:${normalizeDuplicateField(candidate.resumeFileName)}`;
    const enriched = sanitizeCandidateForCloud(signature ? { ...candidate, resumeSignature: signature } : candidate);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, enriched);
      return;
    }
    map.set(key, mergeCandidateRecord(existing, enriched));
  });
  return [...map.values()].sort((a, b) => entityTime(b) - entityTime(a));
}

function mergeUsageLogs(localLogs = [], remoteLogs = []) {
  const map = new Map();
  [...remoteLogs, ...localLogs].forEach(log => {
    if (!log?.date || !log?.provider) return;
    const key = `${log.date}-${log.provider}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, log);
      return;
    }
    map.set(key, {
      ...existing,
      ...log,
      input: Math.max(Number(existing.input) || 0, Number(log.input) || 0),
      output: Math.max(Number(existing.output) || 0, Number(log.output) || 0),
      calls: Math.max(Number(existing.calls) || 0, Number(log.calls) || 0),
    });
  });
  return [...map.values()].sort((a, b) => `${a.date}-${a.provider}`.localeCompare(`${b.date}-${b.provider}`));
}

function mergeStatePayloads(incoming, existing) {
  const deletedCandidateIds = mergeDeletedIds(incoming?.deletedCandidateIds, existing?.deletedCandidateIds);
  return {
    schemaVersion: Math.max(Number(existing?.schemaVersion) || SCHEMA_VERSION, Number(incoming?.schemaVersion) || SCHEMA_VERSION),
    cfg: { ...(existing?.cfg || {}), ...(incoming?.cfg || {}) },
    jobs: mergeJobsById(incoming?.jobs || [], existing?.jobs || []),
    cands: filterDeletedCandidates(mergeCandidates(incoming?.cands || [], existing?.cands || []), deletedCandidateIds),
    usageLogs: mergeUsageLogs(incoming?.usageLogs || [], existing?.usageLogs || []),
    deletedCandidateIds,
  };
}

async function readState(db) {
  const row = await db.prepare(SELECT_STATE_SQL).bind(STATE_KEY).first();
  if (!row?.payload) return { state: null, updatedAt: "" };
  let parsed = null;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    parsed = null;
  }
  return {
    state: parsed,
    updatedAt: row.updated_at || "",
    schemaVersion: row.schema_version || SCHEMA_VERSION,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const authError = verifyToken(request, env);
  if (authError) return authError;

  if (!env.DB) {
    return json({ error: "D1 数据库未绑定。请在 Cloudflare Pages / Workers 项目里添加名为 DB 的 D1 绑定。" }, 500);
  }

  try {
    await ensureStateTable(env.DB);
  } catch (error) {
    return json({ error: error?.message || "初始化 D1 数据表失败" }, 500);
  }

  if (request.method === "GET") {
    try {
      return json(await readState(env.DB));
    } catch (error) {
      return json({ error: error?.message || "读取云端状态失败" }, 500);
    }
  }

  if (request.method === "PUT") {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "请求体不是合法 JSON" }, 400);

    const normalized = normalizeStatePayload(body);
    const now = new Date().toISOString();
    try {
      const existing = await readState(env.DB);
      const merged = mergeStatePayloads(normalized, normalizeStatePayload(existing?.state || {}));
      await env.DB.prepare(UPSERT_STATE_SQL)
        .bind(
          STATE_KEY,
          JSON.stringify(merged),
          merged.schemaVersion || SCHEMA_VERSION,
          now,
          now
        )
        .run();
      return json({ ok: true, updatedAt: now, state: merged });
    } catch (error) {
      return json({ error: error?.message || "保存云端状态失败" }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}
