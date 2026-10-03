export const PROVIDERS = {
  claude: {
    name: "Claude",
    color: "#d97706",
    logo: "C",
    endpoint: "https://api.anthropic.com/v1/messages",
    keyPlaceholder: "sk-ant-api03-...",
    models: [
      { id: "claude-sonnet-4-20250514", name: "Sonnet 4", note: "推荐" },
      { id: "claude-opus-4-5", name: "Opus 4.5", note: "最强" },
      { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", note: "极速" },
    ],
    pricing: {
      "claude-sonnet-4-20250514": { in: 3, out: 15 },
      "claude-opus-4-5": { in: 15, out: 75 },
      "claude-haiku-4-5-20251001": { in: 0.8, out: 4 },
    },
  },
  openai: {
    name: "ChatGPT",
    color: "#10a37f",
    logo: "G",
    endpoint: "https://api.openai.com/v1/chat/completions",
    keyPlaceholder: "sk-...",
    models: [
      { id: "gpt-4o", name: "GPT-4o", note: "旗舰" },
      { id: "gpt-4o-mini", name: "GPT-4o mini", note: "快速" },
      { id: "o1-mini", name: "o1-mini", note: "推理" },
    ],
    pricing: {
      "gpt-4o": { in: 2.5, out: 10 },
      "gpt-4o-mini": { in: 0.15, out: 0.6 },
      "o1-mini": { in: 1.1, out: 4.4 },
    },
  },
  deepseek: {
    name: "DeepSeek",
    color: "#4f46e5",
    logo: "D",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    keyPlaceholder: "sk-...",
    models: [
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", note: "快速 / 非思考" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", note: "深度推理 / 思考模式" },
    ],
    pricing: {
      "deepseek-v4-flash": { in: 0.27, out: 1.1 },
      "deepseek-v4-pro": { in: 0.55, out: 2.19 },
    },
  },
  kimi: {
    name: "KIMI",
    color: "#0ea5e9",
    logo: "K",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    keyPlaceholder: "sk-...",
    models: [
      { id: "moonshot-v1-32k", name: "Moonshot 32K", note: "推荐" },
      { id: "moonshot-v1-8k", name: "8K", note: "极速" },
      { id: "moonshot-v1-128k", name: "128K", note: "超长" },
    ],
    pricing: {
      "moonshot-v1-8k": { in: 0.012, out: 0.012 },
      "moonshot-v1-32k": { in: 0.024, out: 0.024 },
      "moonshot-v1-128k": { in: 0.06, out: 0.06 },
    },
  },
};
