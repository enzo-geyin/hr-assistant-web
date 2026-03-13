#!/usr/bin/env node

const http = require("node:http");

const PORT = Number(process.env.PORT || 8787);
const PROXY_TOKEN = process.env.HR_PROXY_TOKEN || "";

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

function send(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end(JSON.stringify(payload));
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function handleAI(req, res) {
  if (PROXY_TOKEN) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${PROXY_TOKEN}`) {
      return send(res, 401, { error: "代理访问令牌无效" });
    }
  }

  const payload = await readJson(req);
  const { provider = "claude", model, system = "", user = "" } = payload;
  const prov = PROVIDERS[provider];
  if (!prov) return send(res, 400, { error: `不支持的 provider: ${provider}` });
  if (!model) return send(res, 400, { error: "缺少 model" });
  if (!user) return send(res, 400, { error: "缺少 user prompt" });

  const apiKey = process.env[prov.envKey];
  if (!apiKey) {
    return send(res, 500, { error: `服务端环境变量 ${prov.envKey} 未设置` });
  }

  const upstream = await fetch(prov.endpoint, {
    method: "POST",
    headers: prov.headers(apiKey),
    body: JSON.stringify(prov.body({ model, system, user })),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return send(res, upstream.status, {
      error: data.error?.message || data.message || `上游请求失败 ${upstream.status}`,
    });
  }

  return send(res, 200, {
    data: parseModelJSON(prov.text(data)),
    usage: { ...prov.usage(data), provider },
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST" || req.url !== "/api/ai") {
    return send(res, 404, { error: "Not Found" });
  }
  try {
    await handleAI(req, res);
  } catch (error) {
    return send(res, 500, { error: error.message || "代理服务异常" });
  }
});

server.listen(PORT, () => {
  console.log(`HR AI proxy listening on http://localhost:${PORT}/api/ai`);
});
