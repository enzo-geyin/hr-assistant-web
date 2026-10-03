const STATE_KEY = "default";
const SELECT_STATE_SQL = `
  SELECT payload, updated_at
  FROM hr_state
  WHERE state_key = ?
  LIMIT 1
`;
const SELECT_LEGACY_PREVIEWS_SQL = `
  SELECT candidate_id, updated_at
  FROM hr_resume_previews
`;
const SELECT_REFS_SQL = `
  SELECT candidate_id, active_asset_id, active_version, resume_signature, updated_at
  FROM hr_candidate_resume_refs
`;
const SELECT_ASSETS_SQL = `
  SELECT asset_id, candidate_id, asset_kind, r2_key, sha256, size_bytes, version_no, status, updated_at
  FROM hr_resume_assets
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

function base64ToUint8Array(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gunzipBase64ToText(value) {
  const bytes = base64ToUint8Array(value);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

async function parseStatePayload(payload) {
  let parsed = null;
  try {
    parsed = JSON.parse(payload || "null");
  } catch {
    throw new Error("云端状态 JSON 无法解析，审计已停止");
  }
  if (parsed?.encoding === "gzip-base64" && parsed?.compressedState) {
    const text = await gunzipBase64ToText(parsed.compressedState);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("云端压缩状态无法解析，审计已停止");
    }
  }
  return parsed || {};
}

async function readAll(db, sql) {
  try {
    const result = await db.prepare(sql).all();
    return Array.isArray(result?.results) ? result.results : [];
  } catch (error) {
    if (String(error?.message || "").includes("no such table")) return [];
    throw error;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);

  const authError = verifyToken(request, env);
  if (authError) return authError;
  if (!env.DB) return json({ error: "D1 数据库未绑定。请添加名为 DB 的 D1 绑定。" }, 500);

  let state = {};
  let legacyRows = [];
  let refRows = [];
  let assetRows = [];
  try {
    const stateRow = await env.DB.prepare(SELECT_STATE_SQL).bind(STATE_KEY).first();
    state = await parseStatePayload(stateRow?.payload || "");
    [legacyRows, refRows, assetRows] = await Promise.all([
      readAll(env.DB, SELECT_LEGACY_PREVIEWS_SQL),
      readAll(env.DB, SELECT_REFS_SQL),
      readAll(env.DB, SELECT_ASSETS_SQL),
    ]);
  } catch (error) {
    return json({ error: error?.message || "读取简历资产盘点数据失败" }, 500);
  }
  const cands = Array.isArray(state?.cands) ? state.cands : [];
  const deletedSet = new Set((Array.isArray(state?.deletedCandidateIds) ? state.deletedCandidateIds : []).map(id => String(id)));
  const candidateIds = new Set(cands.map(candidate => String(candidate?.id || "")).filter(Boolean));

  const legacyIds = new Set(legacyRows.map(row => String(row.candidate_id || "")).filter(Boolean));
  const refIds = new Set(refRows.map(row => String(row.candidate_id || "")).filter(Boolean));
  const assetById = new Map(assetRows.map(row => [String(row.asset_id || ""), row]));
  const ready = [];
  const legacyOnly = [];
  const missing = [];
  const missingObjects = [];
  const unverified = [];
  const stale = [];

  for (const candidate of cands) {
    const id = String(candidate?.id || "");
    if (!id || deletedSet.has(id)) continue;
    const ref = refRows.find(row => String(row.candidate_id) === id);
    const legacy = legacyIds.has(id);
    const activeAsset = assetById.get(String(ref?.active_asset_id || ""));
    let objectExists = false;
    let checkFailed = false;
    if (activeAsset?.r2_key) {
      if (!env.RESUME_ASSETS) {
        checkFailed = true;
      } else {
        try {
          objectExists = Boolean(await env.RESUME_ASSETS.head(activeAsset.r2_key));
        } catch {
          checkFailed = true;
        }
      }
      if (!objectExists && !checkFailed) {
        missingObjects.push({ candidateId: id, assetId: ref.active_asset_id, r2Key: activeAsset.r2_key });
      }
      if (checkFailed) {
        unverified.push({ candidateId: id, assetId: ref.active_asset_id });
      }
    }
    if (objectExists) {
      ready.push({ candidateId: id, assetId: ref.active_asset_id, version: Number(ref.active_version) || 0 });
    } else if (legacy && !ref) {
      legacyOnly.push({ candidateId: id, expectedVersion: Number(ref?.active_version) || 0 });
    } else if (!checkFailed && !activeAsset?.r2_key) {
      missing.push({ candidateId: id, name: candidate?.name || "", fileName: candidate?.resumeFileName || "" });
    }
    const activeVersion = Number(ref?.active_version) || 0;
    if (activeVersion && Number(candidate?.resumeAssetVersion || 0) > activeVersion) {
      stale.push({ candidateId: id, stateVersion: Number(candidate.resumeAssetVersion), activeVersion });
    }
  }

  const orphanedLegacy = legacyRows
    .filter(row => !candidateIds.has(String(row.candidate_id || "")))
    .map(row => ({ candidateId: row.candidate_id, updatedAt: row.updated_at || "" }));
  const orphanedAssets = assetRows
    .filter(row => !candidateIds.has(String(row.candidate_id || "")))
    .map(row => ({ candidateId: row.candidate_id, assetId: row.asset_id, r2Key: row.r2_key }));
  const deleted = [...deletedSet].filter(Boolean);

  return json({
    checkedAt: new Date().toISOString(),
    r2Bound: Boolean(env.RESUME_ASSETS),
    counts: {
      candidates: cands.length,
      activeCandidates: cands.filter(candidate => !deletedSet.has(String(candidate?.id || ""))).length,
      ready: ready.length,
      legacyOnly: legacyOnly.length,
      missing: missing.length,
      missingObjects: missingObjects.length,
      unverified: unverified.length,
      orphanedLegacy: orphanedLegacy.length,
      orphanedAssets: orphanedAssets.length,
      deleted: deleted.length,
      stale: stale.length,
    },
    ready,
    legacyOnly,
    missing,
    missingObjects,
    unverified,
    orphanedLegacy,
    orphanedAssets,
    deleted,
    stale,
  });
}
