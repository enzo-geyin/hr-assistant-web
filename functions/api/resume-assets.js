const CREATE_RESUME_ASSETS_SQL = `
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
  )
`;
const CREATE_RESUME_ASSETS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_hr_resume_assets_candidate_version
  ON hr_resume_assets (candidate_id, version_no DESC)
`;
const CREATE_RESUME_REFS_SQL = `
  CREATE TABLE IF NOT EXISTS hr_candidate_resume_refs (
    candidate_id TEXT PRIMARY KEY,
    active_asset_id TEXT NOT NULL,
    active_version INTEGER NOT NULL,
    resume_signature TEXT,
    updated_at TEXT NOT NULL
  )
`;
const CREATE_RESUME_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS hr_resume_asset_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id TEXT NOT NULL,
    asset_id TEXT,
    event_type TEXT NOT NULL,
    event_payload TEXT,
    created_at TEXT NOT NULL
  )
`;
const CREATE_RESUME_EVENTS_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_hr_resume_asset_events_candidate_created
  ON hr_resume_asset_events (candidate_id, created_at DESC)
`;
const SELECT_REF_SQL = `
  SELECT active_asset_id, active_version, resume_signature, updated_at
  FROM hr_candidate_resume_refs
  WHERE candidate_id = ?
  LIMIT 1
`;
const SELECT_LEGACY_PREVIEW_SQL = `
  SELECT preview_payload FROM hr_resume_previews WHERE candidate_id = ? LIMIT 1
`;
const INSERT_ASSET_SQL = `
  INSERT INTO hr_resume_assets (
    asset_id, candidate_id, asset_kind, resume_signature, file_name,
    mime_type, r2_key, sha256, size_bytes, version_no, status, created_at, updated_at
  )
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
`;
const UPSERT_REF_SQL = `
  INSERT INTO hr_candidate_resume_refs (candidate_id, active_asset_id, active_version, resume_signature, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT(candidate_id) DO UPDATE SET
    active_asset_id = excluded.active_asset_id,
    active_version = excluded.active_version,
    resume_signature = excluded.resume_signature,
    updated_at = excluded.updated_at
`;
const INSERT_EVENT_SQL = `
  INSERT INTO hr_resume_asset_events (candidate_id, asset_id, event_type, event_payload, created_at)
  VALUES (?1, ?2, ?3, ?4, ?5)
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
  if (!token) {
    return json({ error: "服务端未设置 HR_PROXY_TOKEN，请在 Cloudflare 环境变量中配置后重试" }, 503);
  }
  const auth = request.headers.get("Authorization") || "";
  return auth === `Bearer ${token}` ? null : json({ error: "代理访问令牌无效" }, 401);
}

async function ensureAssetTables(db) {
  await db.prepare(CREATE_RESUME_ASSETS_SQL).run();
  await db.prepare(CREATE_RESUME_ASSETS_INDEX_SQL).run();
  await db.prepare(CREATE_RESUME_REFS_SQL).run();
  await db.prepare(CREATE_RESUME_EVENTS_SQL).run();
  await db.prepare(CREATE_RESUME_EVENTS_INDEX_SQL).run();
}

function sanitizeId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96);
}

function sanitizeFileName(value, fallback = "resume") {
  return String(value || fallback).trim().replace(/[^\w.\-\u4e00-\u9fa5]+/g, "-").slice(0, 120) || fallback;
}

function normalizeExpectedVersion(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function uint8ArrayToHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const buffer = value instanceof ArrayBuffer ? value : await value.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return uint8ArrayToHex(new Uint8Array(digest));
}

function nowIso() {
  return new Date().toISOString();
}

async function parseRequest(request) {
  const url = new URL(request.url);
  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    const rawPreview = form.get("preview");
    return {
      candidateId: String(form.get("candidateId") || url.searchParams.get("id") || "").trim(),
      expectedVersion: normalizeExpectedVersion(form.get("expectedVersion") || url.searchParams.get("expectedVersion")),
      resumeSignature: String(form.get("resumeSignature") || "").trim(),
      migrateLegacy: form.get("migrateLegacy") === "true",
      file: file && typeof file !== "string" ? file : null,
      preview: typeof rawPreview === "string" ? JSON.parse(rawPreview || "null") : null,
    };
  }
  const body = await request.json().catch(() => null);
  return {
    candidateId: String(body?.candidateId || url.searchParams.get("id") || "").trim(),
    expectedVersion: normalizeExpectedVersion(body?.expectedVersion ?? url.searchParams.get("expectedVersion")),
    resumeSignature: String(body?.resumeSignature || "").trim(),
    migrateLegacy: body?.migrateLegacy === true,
    file: null,
    preview: body?.preview || null,
  };
}

function previewBytes(preview) {
  const text = JSON.stringify(preview || {});
  return new TextEncoder().encode(text);
}

async function putR2(bucket, key, value, contentType, metadata = {}) {
  await bucket.put(key, value, {
    httpMetadata: { contentType },
    customMetadata: metadata,
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!["POST", "PUT"].includes(request.method)) return json({ error: "Method Not Allowed" }, 405);

  const authError = verifyToken(request, env);
  if (authError) return authError;
  if (!env.DB) return json({ error: "D1 数据库未绑定。请添加名为 DB 的 D1 绑定。" }, 500);
  if (!env.RESUME_ASSETS) return json({ error: "R2 bucket 未绑定。请添加名为 RESUME_ASSETS 的 R2 绑定。" }, 500);

  try {
    await ensureAssetTables(env.DB);
  } catch (error) {
    return json({ error: error?.message || "初始化简历资产表失败" }, 500);
  }

  let payload = null;
  try {
    payload = await parseRequest(request);
  } catch {
    return json({ error: "请求体不是合法表单或 JSON" }, 400);
  }

  const candidateId = payload?.candidateId;
  if (!candidateId) return json({ error: "缺少 candidateId / id 参数" }, 400);
  if (payload.expectedVersion == null) return json({ error: "缺少 expectedVersion，拒绝可能来自旧页面的覆盖写入" }, 409);

  const safeCandidateId = sanitizeId(candidateId);
  const now = nowIso();

  try {
    const existing = await env.DB.prepare(SELECT_REF_SQL).bind(candidateId).first();
    const activeVersion = Number(existing?.active_version) || 0;
    if (payload.migrateLegacy && existing) {
      return json({ error: "此候选人已有 R2 资产版本，旧快照不能覆盖当前版本", activeVersion }, 409);
    }
    if (activeVersion !== payload.expectedVersion) {
      await env.DB.prepare(INSERT_EVENT_SQL)
        .bind(
          candidateId,
          existing?.active_asset_id || null,
          "stale_write_rejected",
          JSON.stringify({ expectedVersion: payload.expectedVersion, activeVersion }),
          now
        )
        .run();
      return json({ error: "简历资产已有更新版本，已拒绝旧页面覆盖", activeVersion }, 409);
    }
    if (existing && !payload.file) {
      return json({ error: "已有简历资产，图片补传不能替换当前版本；请重新上传原始简历", activeVersion }, 409);
    }

    const legacyRow = await env.DB.prepare(SELECT_LEGACY_PREVIEW_SQL).bind(candidateId).first().catch(error => {
      if (String(error?.message || "").includes("no such table")) return null;
      throw error;
    });
    if (!payload.migrateLegacy && !payload.file && activeVersion === 0 && legacyRow?.preview_payload) {
      return json({ error: "此候选人已有旧云端快照，请先迁移旧快照后再更新预览" }, 409);
    }
    if (payload.migrateLegacy) {
      try {
        payload.preview = JSON.parse(legacyRow?.preview_payload || "null");
      } catch {
        payload.preview = null;
      }
      if (!payload.preview?.src) return json({ error: "旧版 D1 快照不存在或内容无效" }, 404);
    }
    if (!payload.preview?.src) return json({ error: "缺少简历预览内容" }, 400);

    const version = activeVersion + 1;
    const prefix = `resumes/${safeCandidateId}/v${version}/${crypto.randomUUID()}`;
    const previewAssetId = `${safeCandidateId}-preview-v${version}`;
    const previewKey = `${prefix}/preview.json`;
    const previewByteArray = previewBytes(payload.preview);
    const previewHash = await sha256Hex(previewByteArray.buffer);
    await putR2(env.RESUME_ASSETS, previewKey, previewByteArray, "application/json; charset=utf-8", {
      candidateId,
      version: String(version),
      kind: "preview",
      sha256: previewHash,
    });

    const statements = [
      env.DB.prepare(INSERT_ASSET_SQL).bind(
        previewAssetId,
        candidateId,
        "preview",
        payload.resumeSignature || existing?.resume_signature || "",
        payload.preview?.name || "",
        "application/json; charset=utf-8",
        previewKey,
        previewHash,
        previewByteArray.byteLength,
        version,
        "active",
        now,
        now
      ),
      env.DB.prepare(UPSERT_REF_SQL).bind(
        candidateId,
        previewAssetId,
        version,
        payload.resumeSignature || existing?.resume_signature || "",
        now
      ),
      env.DB.prepare(INSERT_EVENT_SQL).bind(
        candidateId,
        previewAssetId,
        payload.migrateLegacy ? "migrate_legacy" : activeVersion ? "replace" : "upload",
        JSON.stringify({ version, previewKey, previewBytes: previewByteArray.byteLength }),
        now
      ),
    ];

    if (payload.file) {
      const originalBuffer = await payload.file.arrayBuffer();
      const originalHash = await sha256Hex(originalBuffer);
      const originalAssetId = `${safeCandidateId}-original-v${version}`;
      const originalName = sanitizeFileName(payload.file.name || payload.preview?.name || "resume");
      const originalKey = `${prefix}/original-${originalName}`;
      await putR2(env.RESUME_ASSETS, originalKey, originalBuffer, payload.file.type || "application/octet-stream", {
        candidateId,
        version: String(version),
        kind: "original",
        sha256: originalHash,
      });
      statements.push(
        env.DB.prepare(INSERT_ASSET_SQL).bind(
          originalAssetId,
          candidateId,
          "original",
          payload.resumeSignature || existing?.resume_signature || "",
          payload.file.name || "",
          payload.file.type || "application/octet-stream",
          originalKey,
          originalHash,
          originalBuffer.byteLength,
          version,
          "active",
          now,
          now
        ),
        env.DB.prepare(INSERT_EVENT_SQL).bind(
          candidateId,
          originalAssetId,
          "original_upload",
          JSON.stringify({ version, originalKey, originalBytes: originalBuffer.byteLength }),
          now
        )
      );
    }

    await env.DB.batch(statements);
    return json({
      ok: true,
      candidateId,
      assetId: previewAssetId,
      version,
      updatedAt: now,
    });
  } catch (error) {
    const current = await env.DB.prepare(SELECT_REF_SQL).bind(candidateId).first().catch(() => null);
    const activeVersion = Number(current?.active_version) || 0;
    if (activeVersion !== payload.expectedVersion) {
      return json({ error: "简历资产版本已变化，已拒绝并发覆盖", activeVersion }, 409);
    }
    return json({ error: error?.message || "保存简历资产失败" }, 500);
  }
}
