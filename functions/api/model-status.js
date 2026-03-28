const PROVIDERS = [
  { id: "claude", name: "Claude", envKey: "ANTHROPIC_API_KEY", tip: "适合文件识别与复杂结构化任务" },
  { id: "openai", name: "ChatGPT / OpenAI", envKey: "OPENAI_API_KEY", tip: "适合文本、语音与通用生成任务" },
  { id: "deepseek", name: "DeepSeek", envKey: "DEEPSEEK_API_KEY", tip: "deepseek-chat = DeepSeek-V3.2；deepseek-reasoner = DeepSeek R1（V3.2 思考）" },
  { id: "kimi", name: "Kimi", envKey: "KIMI_API_KEY", tip: "适合中文长文本场景" },
];

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

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "GET") return json({ error: "Method Not Allowed" }, 405);

  const authError = verifyToken(request, env);
  if (authError) return authError;

  const providers = PROVIDERS.map(provider => {
    const configured = !!env[provider.envKey];
    return {
      ...provider,
      configured,
      status: configured ? "connected" : "missing",
      message: configured ? "已在服务端环境变量中配置" : `未配置 ${provider.envKey}`,
    };
  });

  return json({
    ok: true,
    checkedAt: new Date().toISOString(),
    providers,
  });
}
