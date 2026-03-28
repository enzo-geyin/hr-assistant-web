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
    name: "Claude",
    defaultModel: "claude-sonnet-4-20250514",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-5", "claude-haiku-4-5-20251001"],
    endpoint: "https://api.anthropic.com/v1/messages",
    envKey: "ANTHROPIC_API_KEY",
    headers: apiKey => ({
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    body: ({ model, system, user, file, maxTokens }) => ({
      model,
      max_tokens: maxTokens || (file ? 1500 : 1200),
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
    name: "ChatGPT / OpenAI",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o", "gpt-4o-mini", "o1-mini"],
    endpoint: "https://api.openai.com/v1/chat/completions",
    envKey: "OPENAI_API_KEY",
    headers: apiKey => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: ({ model, system, user, maxTokens }) => ({
      model,
      max_tokens: maxTokens || 1200,
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
    name: "DeepSeek",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    envKey: "DEEPSEEK_API_KEY",
    headers: apiKey => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: ({ model, system, user, maxTokens }) => {
      const body = {
        model,
        max_tokens: maxTokens || 1200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };
      if (model !== "deepseek-reasoner") body.response_format = { type: "json_object" };
      return body;
    },
    usage: data => ({
      input: data.usage?.prompt_tokens || 0,
      output: data.usage?.completion_tokens || 0,
    }),
    text: data => data.choices?.[0]?.message?.content || "",
  },
  kimi: {
    name: "Kimi",
    defaultModel: "moonshot-v1-32k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    envKey: "KIMI_API_KEY",
    headers: apiKey => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    }),
    body: ({ model, system, user, maxTokens }) => ({
      model,
      max_tokens: maxTokens || 1200,
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

function getConfiguredProviderIds(env) {
  return Object.entries(PROVIDERS)
    .filter(([, prov]) => !!env[prov.envKey])
    .map(([id]) => id);
}

function resolveProviderAndModel(requestedProvider, requestedModel, env, file) {
  const configuredIds = getConfiguredProviderIds(env);
  if (!configuredIds.length) {
    return {
      error: `服务端尚未配置任何模型环境变量。请至少补上 ANTHROPIC_API_KEY、OPENAI_API_KEY、DEEPSEEK_API_KEY、KIMI_API_KEY 其中之一。`,
    };
  }

  if (file) {
    if (!configuredIds.includes("claude")) {
      return {
        error: "当前任务需要直接处理 PDF / 图片文件，但服务端未配置 Claude（ANTHROPIC_API_KEY）。请先补上 Claude，或改为先提取文字再调用模型。",
      };
    }
    return {
      provider: "claude",
      model: PROVIDERS.claude.models.includes(requestedModel) ? requestedModel : PROVIDERS.claude.defaultModel,
      switched: requestedProvider !== "claude" || !PROVIDERS.claude.models.includes(requestedModel),
      reason: requestedProvider !== "claude" ? `文件识别任务已自动切换到 ${PROVIDERS.claude.name}` : "",
    };
  }

  const requestedProv = PROVIDERS[requestedProvider] ? requestedProvider : null;
  if (requestedProv && configuredIds.includes(requestedProv)) {
    return {
      provider: requestedProv,
      model: PROVIDERS[requestedProv].models.includes(requestedModel) ? requestedModel : PROVIDERS[requestedProv].defaultModel,
      switched: !PROVIDERS[requestedProv].models.includes(requestedModel),
      reason: !PROVIDERS[requestedProv].models.includes(requestedModel) ? `${PROVIDERS[requestedProv].name} 未识别到模型 ${requestedModel}，已自动切到默认模型` : "",
    };
  }

  const fallbackProvider = configuredIds[0];
  return {
    provider: fallbackProvider,
    model: PROVIDERS[fallbackProvider].defaultModel,
    switched: true,
    reason: requestedProv
      ? `${PROVIDERS[requestedProv].name} 尚未在服务端配置，已自动切换到 ${PROVIDERS[fallbackProvider].name}`
      : `已自动切换到当前服务端已配置的 ${PROVIDERS[fallbackProvider].name}`,
  };
}

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

async function requestUpstreamJSON(prov, apiKey, payload) {
  const upstream = await fetch(prov.endpoint, {
    method: "POST",
    headers: prov.headers(apiKey),
    body: JSON.stringify(prov.body(payload)),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    throw new Error(data.error?.message || data.message || `上游请求失败 ${upstream.status}`);
  }
  return {
    parsed: parseModelJSON(prov.text(data)),
    usage: prov.usage(data),
  };
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

  const { provider = "claude", model, system = "", user = "", file = null, maxTokens } = payload;
  if (!model) return json({ error: "缺少 model" }, 400);
  if (!user) return json({ error: "缺少 user prompt" }, 400);
  if (file && (!file.data || !file.mediaType)) {
    return json({ error: "文件负载不完整，缺少 data 或 mediaType" }, 400);
  }
  const resolved = resolveProviderAndModel(provider, model, env, file);
  if (resolved.error) return json({ error: resolved.error }, 500);
  const resolvedProvider = resolved.provider;
  const resolvedModel = resolved.model;
  const prov = PROVIDERS[resolvedProvider];
  const apiKey = env[prov.envKey];

  try {
    const normalizedMaxTokens = Math.max(600, Math.min(Number(maxTokens) || 1200, 3200));
    const firstPass = await requestUpstreamJSON(prov, apiKey, { model: resolvedModel, system, user, file, maxTokens: normalizedMaxTokens });
    let parsed = firstPass.parsed;
    let usage = { ...firstPass.usage, provider: resolvedProvider };
    if (resolvedProvider === "deepseek" && resolvedModel === "deepseek-reasoner" && (!parsed || typeof parsed !== "object")) {
      const fallback = await requestUpstreamJSON(prov, apiKey, {
        model: "deepseek-chat",
        system: `${system}\n\n补充要求：你现在用于结构化输出环节，必须返回稳定 JSON，不要输出思考过程、解释或代码块。`,
        user,
        file,
        maxTokens: normalizedMaxTokens,
      });
      parsed = fallback.parsed;
      usage = {
        provider: resolvedProvider,
        input: (usage.input || 0) + (fallback.usage.input || 0),
        output: (usage.output || 0) + (fallback.usage.output || 0),
      };
    }
    return json({
      data: parsed,
      usage,
      meta: {
        requestedProvider: provider,
        requestedModel: model,
        provider: resolvedProvider,
        model: resolvedModel,
        autoSwitched: !!resolved.switched,
        switchReason: resolved.reason || "",
      },
    });
  } catch (error) {
    return json({ error: error?.message || "构建上游请求失败" }, 400);
  }
}

export async function onRequest(context) {
  return handleRequest(context.request, context.env);
}
