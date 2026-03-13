const PROVIDERS = {
  claude: {
    endpoint: "https://api.anthropic.com/v1/messages",
    envKey: "ANTHROPIC_API_KEY",
    headers: apiKey => ({
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    body: ({ model, system, user }) => ({
      model,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: user }],
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

function parseModelJSON(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return cleaned;
  }
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

  const { provider = "claude", model, system = "", user = "" } = payload;
  const prov = PROVIDERS[provider];
  if (!prov) return json({ error: `不支持的 provider: ${provider}` }, 400);
  if (!model) return json({ error: "缺少 model" }, 400);
  if (!user) return json({ error: "缺少 user prompt" }, 400);

  const apiKey = env[prov.envKey];
  if (!apiKey) return json({ error: `环境变量 ${prov.envKey} 未设置` }, 500);

  const upstream = await fetch(prov.endpoint, {
    method: "POST",
    headers: prov.headers(apiKey),
    body: JSON.stringify(prov.body({ model, system, user })),
  });
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
