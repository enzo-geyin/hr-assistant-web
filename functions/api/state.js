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
      await env.DB.prepare(UPSERT_STATE_SQL)
        .bind(
          STATE_KEY,
          JSON.stringify(normalized),
          normalized.schemaVersion || SCHEMA_VERSION,
          now,
          now
        )
        .run();
      return json({ ok: true, updatedAt: now });
    } catch (error) {
      return json({ error: error?.message || "保存云端状态失败" }, 500);
    }
  }

  return json({ error: "Method Not Allowed" }, 405);
}
