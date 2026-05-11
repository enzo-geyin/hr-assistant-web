const SELECT_PREVIEW_SQL = `
  SELECT preview_payload, updated_at
  FROM hr_resume_previews
  WHERE candidate_id = ?
  LIMIT 1
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

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);

  const authError = verifyToken(request, env);
  if (authError) return authError;

  if (!env.DB) {
    return json({ error: "D1 数据库未绑定。请在 Cloudflare Pages 项目里添加名为 DB 的 D1 绑定。" }, 500);
  }

  const url = new URL(request.url);
  const candidateId = String(url.searchParams.get("id") || "").trim();
  if (!candidateId) return json({ error: "缺少 id 参数" }, 400);

  try {
    const row = await env.DB.prepare(SELECT_PREVIEW_SQL).bind(candidateId).first();
    if (!row?.preview_payload) {
      return json({ preview: null, updatedAt: "" });
    }
    let preview = null;
    try {
      preview = JSON.parse(row.preview_payload);
    } catch {
      preview = null;
    }
    return json({ preview, updatedAt: row.updated_at || "" });
  } catch (error) {
    return json({ error: error?.message || "读取简历快照失败" }, 500);
  }
}
