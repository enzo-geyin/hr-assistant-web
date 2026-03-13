function buildClaudeUserContent(user, file) {
  if (!file) return user;
  const mediaType = String(file.mediaType || "");
  const data = String(file.data || "");
  if (!mediaType || !data) throw new Error("文件内容不完整");
  if (mediaType === "application/pdf") {
    return [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
      { type: "text", text: user },
    ];
  }
  if (mediaType.startsWith("image/")) {
    return [
      { type: "image", source: { type: "base64", media_type: mediaType, data } },
      { type: "text", text: user },
    ];
  }
  throw new Error("当前代理仅支持 PDF 或图片文件识别");
}

const PROVIDERS = {
  claude: {
    endpoint: "https://api.anthropic.com/v1/messages",
    envKey: "ANTHROPIC_API_KEY",
    headers: apiKey => ({
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    body: ({ model, system, user, file }) => ({
      model,
      max_tokens: file ? 1500 : 1200,
      system,
      messages: [{ role: "user", content: buildClaudeUserContent(user, file) }],
    }),
    usage: data => ({
      input: data.usage?.input_tokens || 0,
      output: data.usage?.output_tokens || 0,
    }),
    text: data => data.content?.[0]?.text || "",
  },
  openai: {
    endpoint: "https://api.openai.com/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
    headers: apiKey => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: ({ model, system, user }) => ({
      model,
      max_tokens: 1200,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    usage: data => ({
      input: data.usage?.prompt_tokens || 0,
      output: data.usage?.completion_tokens || 0,
    }),
    text: data => data.choices?.[0]?.message?.content || "",
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    envKey: "DEEPSEEK_API_KEY",
    headers: apiKey => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: ({ model, system, user }) => ({
      model,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    usage: data => ({
      input: data.usage?.prompt_tokens || 0,
      output: data.usage?.completion_tokens || 0,
    }),
    text: data => data.choices?.[0]?.message?.content || "",
  },
  kimi: {
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    envKey: "KIMI_API_KEY",
    headers: apiKey => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: ({ model, system, user }) => ({
      model,
      max_tokens: 1200,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    usage: data => ({
      input: data.usage?.prompt_tokens || 0,
      output: data.usage?.completion_tokens || 0,
    }),
    text: data => data.choices?.[0]?.message?.content || "",
  },
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function stripModelNoise(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractBalancedJson(text) {
  const src = String(text || "");
  const firstBrace = src.indexOf("{");
  const firstBracket = src.indexOf("[");
  const starts = [firstBrace, firstBracket].filter(idx => idx >= 0);
  if (!starts.length) return "";
  const start = Math.min(...starts);

  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const last = stack[stack.length - 1];
      if ((ch === "}" && last === "{") || (ch === "]" && last === "[")) {
        stack.pop();
        if (!stack.length) return src.slice(start, i + 1);
      }
    }
  }
  return "";
}

function parseModelJSON(text) {
  const cleaned = stripModelNoise(text);
  const candidates = [cleaned, extractBalancedJson(cleaned)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return cleaned;
}

async function handleRequest(request, env) {
  if (request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  const token = env.HR_PROXY_TOKEN || "";
  if (token) {
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${token}`) return json({ error: "代理访问令牌无效" }, 401);
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return json({ error: "请求体不是合法 JSON" }, 400);

  const { provider = "claude", model, system = "", user = "", file = null } = payload;
  const prov = PROVIDERS[provider];
  if (!prov) return json({ error: `不支持的 provider: ${provider}` }, 400);
  if (!model) return json({ error: "缺少 model" }, 400);
  if (!user) return json({ error: "缺少 user prompt" }, 400);
  if (file && provider !== "claude") {
    return json({ error: "当前代理模式下，文件识别仅支持 Claude。请切换到 Claude，或先上传 Word/文本文件。" }, 400);
  }
  if (file && (!file.data || !file.mediaType)) {
    return json({ error: "文件负载不完整，缺少 data 或 mediaType" }, 400);
  }

  const apiKey = env[prov.envKey];
  if (!apiKey) return json({ error: `环境变量 ${prov.envKey} 未设置` }, 500);

  let upstream;
  try {
    upstream = await fetch(prov.endpoint, {
      method: "POST",
      headers: prov.headers(apiKey),
      body: JSON.stringify(prov.body({ model, system, user, file })),
    });
  } catch (error) {
    return json({ error: error?.message || "构建上游请求失败" }, 400);
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json(
      { error: data.error?.message || data.message || `上游请求失败 ${upstream.status}` },
      upstream.status
    );
  }

  return json({
    data: parseModelJSON(prov.text(data)),
    usage: { ...prov.usage(data), provider },
  });
}

export async function onRequest(context) {
  return handleRequest(context.request, context.env);
}
