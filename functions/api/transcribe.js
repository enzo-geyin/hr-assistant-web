function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function handleRequest(request, env) {
  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  const token = env.HR_PROXY_TOKEN || "";
  if (token) {
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${token}`) return json({ error: "代理访问令牌无效" }, 401);
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return json({
      error: "录音转写需要服务端配置 OPENAI_API_KEY。请在 Cloudflare 环境变量中补上，或改用文本文件上传。",
    }, 500);
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return json({ error: "缺少录音文件" }, 400);

  const upstreamForm = new FormData();
  upstreamForm.append("file", file, file.name || "audio-file");
  upstreamForm.append("model", "gpt-4o-mini-transcribe");
  upstreamForm.append("language", "zh");

  const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: upstreamForm,
  });

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json({
      error: data.error?.message || data.message || `录音转写失败 ${upstream.status}`,
    }, upstream.status);
  }

  return json({
    text: normalizeText(data.text || ""),
    model: "gpt-4o-mini-transcribe",
  });
}

export async function onRequest(context) {
  return handleRequest(context.request, context.env);
}
