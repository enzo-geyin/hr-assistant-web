import { useState, useEffect, useRef } from "react";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

// ─── PERSIST ─────────────────────────────────────────────────
const load = (k,d)=>{ try{const v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch{return d;}};
const save = (k,v)=>{ try{localStorage.setItem(k,JSON.stringify(v));}catch{}};
const ENV_PROXY_URL=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_PROXY_URL?import.meta.env.VITE_HR_PROXY_URL:"/api/ai";
const ENV_PROXY_TOKEN=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_PROXY_TOKEN?import.meta.env.VITE_HR_PROXY_TOKEN:"";
const ENV_STATE_URL=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_STATE_URL?import.meta.env.VITE_HR_STATE_URL:"/api/state";
const ENV_KNOWLEDGE_URL=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_KNOWLEDGE_URL?import.meta.env.VITE_HR_KNOWLEDGE_URL:"/api/knowledge";
const CLOUD_SCHEMA_VERSION = 1;
const KNOWLEDGE_MIN_SAMPLES = 2;

const DEFAULT_CFG = {
  mode:"proxy",
  provider:"claude",
  model:"claude-sonnet-4-20250514",
  apiKeys:{},
  theme:"light",
  proxyUrl:ENV_PROXY_URL,
  proxyToken:ENV_PROXY_TOKEN,
};
const normalizeCfg = cfg => ({
  ...DEFAULT_CFG,
  ...(cfg||{}),
  apiKeys:{...DEFAULT_CFG.apiKeys,...(cfg?.apiKeys||{})},
});

const buildCloudHeaders = token => {
  const headers = {};
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
};

const pickCloudCfg = cfg => ({
  mode: cfg?.mode || DEFAULT_CFG.mode,
  provider: cfg?.provider || DEFAULT_CFG.provider,
  model: cfg?.model || DEFAULT_CFG.model,
  theme: cfg?.theme || DEFAULT_CFG.theme,
  proxyUrl: cfg?.proxyUrl || DEFAULT_CFG.proxyUrl,
});

const buildCloudSnapshot = (cfg, jobs, cands, usageLogs) => ({
  schemaVersion: CLOUD_SCHEMA_VERSION,
  cfg: pickCloudCfg(cfg),
  jobs: Array.isArray(jobs) ? jobs : [],
  cands: Array.isArray(cands) ? cands : [],
  usageLogs: Array.isArray(usageLogs) ? usageLogs : [],
});

const normalizeCloudState = payload => {
  const state = payload && typeof payload === "object" && "state" in payload ? payload.state : payload;
  return {
    cfg: state?.cfg && typeof state.cfg === "object" ? state.cfg : {},
    jobs: Array.isArray(state?.jobs) ? state.jobs : [],
    cands: Array.isArray(state?.cands) ? state.cands : [],
    usageLogs: Array.isArray(state?.usageLogs) ? state.usageLogs : [],
    updatedAt: state?.updatedAt || payload?.updatedAt || "",
  };
};

const fmtCloudTime = value => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString("zh-CN", { hour12: false });
};

async function fetchCloudState(token = "") {
  const res = await fetch(ENV_STATE_URL, { headers: buildCloudHeaders(token) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `云端读取失败 ${res.status}`);
  return data;
}

async function pushCloudState(token = "", state) {
  const res = await fetch(ENV_STATE_URL, {
    method: "PUT",
    headers: { ...buildCloudHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `云端保存失败 ${res.status}`);
  return data;
}

async function fetchKnowledgeState(token = "", jobId) {
  if (!jobId) return { sampleCount: 0, recentSamples: [], rubric: null, questionBank: null };
  const url = `${ENV_KNOWLEDGE_URL}?jobId=${encodeURIComponent(jobId)}`;
  const res = await fetch(url, { headers: buildCloudHeaders(token) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `学习数据读取失败 ${res.status}`);
  return data;
}

async function postKnowledgeAction(token = "", payload) {
  const res = await fetch(ENV_KNOWLEDGE_URL, {
    method: "POST",
    headers: { ...buildCloudHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `学习数据写入失败 ${res.status}`);
  return data;
}

// ─── PROVIDERS ───────────────────────────────────────────────
const PROVIDERS = {
  claude:   {name:"Claude",  color:"#d97706",logo:"C",endpoint:"https://api.anthropic.com/v1/messages",          keyPlaceholder:"sk-ant-api03-...",models:[{id:"claude-sonnet-4-20250514",name:"Sonnet 4",note:"推荐"},{id:"claude-opus-4-5",name:"Opus 4.5",note:"最强"},{id:"claude-haiku-4-5-20251001",name:"Haiku 4.5",note:"极速"}],pricing:{"claude-sonnet-4-20250514":{in:3,out:15},"claude-opus-4-5":{in:15,out:75},"claude-haiku-4-5-20251001":{in:0.8,out:4}}},
  openai:   {name:"ChatGPT", color:"#10a37f",logo:"G",endpoint:"https://api.openai.com/v1/chat/completions",      keyPlaceholder:"sk-...",           models:[{id:"gpt-4o",name:"GPT-4o",note:"旗舰"},{id:"gpt-4o-mini",name:"GPT-4o mini",note:"快速"},{id:"o1-mini",name:"o1-mini",note:"推理"}],pricing:{"gpt-4o":{in:2.5,out:10},"gpt-4o-mini":{in:0.15,out:0.6},"o1-mini":{in:1.1,out:4.4}}},
  deepseek: {name:"DeepSeek",color:"#4f46e5",logo:"D",endpoint:"https://api.deepseek.com/v1/chat/completions",    keyPlaceholder:"sk-...",           models:[{id:"deepseek-chat",name:"DeepSeek V3",note:"低成本"},{id:"deepseek-reasoner",name:"DeepSeek R1",note:"深度推理"}],pricing:{"deepseek-chat":{in:0.27,out:1.1},"deepseek-reasoner":{in:0.55,out:2.19}}},
  kimi:     {name:"KIMI",    color:"#0ea5e9",logo:"K",endpoint:"https://api.moonshot.cn/v1/chat/completions",     keyPlaceholder:"sk-...",           models:[{id:"moonshot-v1-32k",name:"Moonshot 32K",note:"推荐"},{id:"moonshot-v1-8k",name:"8K",note:"极速"},{id:"moonshot-v1-128k",name:"128K",note:"超长"}],pricing:{"moonshot-v1-8k":{in:0.012,out:0.012},"moonshot-v1-32k":{in:0.024,out:0.024},"moonshot-v1-128k":{in:0.06,out:0.06}}},
};

// ─── 总监判断 → AI 上下文 ────────────────────────────────────
const buildDirCtx = (cands, jobs) => {
  const done = cands.filter(c=>c.directorVerdict?.verdict && c.directorVerdict.reason);
  if (done.length < 2) return "";
  const hired    = done.filter(c=>["录用","通过"].includes(c.directorVerdict.verdict));
  const rejected = done.filter(c=>c.directorVerdict.verdict==="淘汰");
  let ctx = "【总监历史人才判断参考 — 请将以下标准融入本次评估】\n";
  if (hired.length) {
    ctx += `✅ 总监认可的候选人(${hired.length}人)：\n`;
    hired.slice(-6).forEach(c=>{const j=jobs.find(j=>j.id===c.jobId);ctx+=`  · ${c.name||"候选人"}(${j?.title||""}) AI评${c.screening?.overallScore?.toFixed(1)||"?"}分 → "${c.directorVerdict.reason}"\n`;});
  }
  if (rejected.length) {
    ctx += `❌ 总监淘汰的候选人(${rejected.length}人)：\n`;
    rejected.slice(-6).forEach(c=>{const j=jobs.find(j=>j.id===c.jobId);ctx+=`  · ${c.name||"候选人"}(${j?.title||""}) AI评${c.screening?.overallScore?.toFixed(1)||"?"}分 → "${c.directorVerdict.reason}"\n`;});
  }
  ctx += "请据此调整评分标准，使其更贴近该总监的用人偏好。\n";
  return ctx;
};

const JOB_PARSE_SYSTEM = "你是资深HR招聘运营助手，负责从JD文档中拆分所有岗位并结构化整理。必须严格返回JSON，不要输出markdown或解释。";
const JOB_PARSE_PROMPT = `请识别这份JD文件中的全部岗位，返回 JSON：
{"jobs":[{"title":"职位名称","department":"所属部门","level":"级别/序列","salary":"薪资范围","summary":"岗位一句话概述","requirements":["规整后的岗位职责/任职要求，6-12条"],"t0":["硬性必须条件，3-8条"],"t1":["核心评估维度，5-8条"]}]}
要求：
1. 文档里有几个岗位，就返回几个 jobs 对象，不要把多个岗位合并成一个。
2. title 必须简短明确，只保留岗位名，不要带大段描述。
3. requirements 要去重、去广告词、去排版噪音，整理成清晰条目。
4. t0 只保留必须满足的硬门槛，例如年限、学历、证书、工具、行业经验。
5. t1 只保留评估候选人的核心能力维度，例如目标导向、数据分析、沟通协作。
6. 缺失字段返回空字符串或空数组。`;
const LEARNING_SYSTEM = "你是招聘策略学习助手。请从历史筛选、面试和总监判断中提炼岗位判断规则与高质量面试题库。必须严格输出 JSON，不要输出 markdown、解释或多余文本。";

const stripModelNoise = text => String(text || "")
  .replace(/<think>[\s\S]*?<\/think>/gi, "")
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/i, "")
  .trim();

const extractBalancedJson = text => {
  const src = String(text || "");
  const start = Math.min(
    ...["{", "["].map(ch => {
      const idx = src.indexOf(ch);
      return idx === -1 ? Number.POSITIVE_INFINITY : idx;
    })
  );
  if (!Number.isFinite(start)) return "";

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
};

const parseJsonResponse = text => {
  const cleaned = stripModelNoise(text);
  const candidates = [cleaned, extractBalancedJson(cleaned)].filter(Boolean);
  for (const candidate of candidates) {
    try{return JSON.parse(candidate);}
    catch{}
  }
  return{error:"JSON解析失败",raw:text};
};

const OCR_LANG = "chi_sim+eng";
const normalizeExtractedText = text => String(text || "")
  .replace(/\u0000/g, " ")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const normalizeLooseListText = text => normalizeExtractedText(String(text || "")
  .replace(/([0-9]{1,2}\s*[\.、\)])\s*/g, "\n$1 ")
  .replace(/[•·●▪◦▸►]/g, "\n")
  .replace(/岗位职责[:：]/g, "\n岗位职责：")
  .replace(/任职要求[:：]/g, "\n任职要求：")
);

const cleanListLine = line => String(line || "")
  .replace(/^\s*[0-9]{1,2}\s*[\.、\)]\s*/g, "")
  .replace(/^\s*[-—–*•·●▪◦▸►]+\s*/g, "")
  .replace(/^\s*[（(]?\s*[一二三四五六七八九十]+\s*[）)]?[、\.\s]*/g, "")
  .replace(/\s+/g, " ")
  .trim();

const dedupeLines = lines => {
  const seen = new Set();
  return lines.filter(line => {
    const key = line.toLowerCase();
    if (!line || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const toLineArray = (value, limit = 12) => {
  const raw = Array.isArray(value)
    ? value.flatMap(item => String(item || "").split(/\n+/))
    : normalizeLooseListText(value).split(/\n+/);
  return dedupeLines(raw.map(cleanListLine)).slice(0, limit);
};

const formatRequirementsText = (summary, requirements) => {
  const blocks = [];
  if (summary) blocks.push(`岗位概述：${summary}`);
  if (requirements.length) {
    blocks.push("岗位职责与任职要求：");
    requirements.forEach((item, index) => blocks.push(`${index + 1}. ${item}`));
  }
  return blocks.join("\n");
};

const normalizeJobDraft = (job, index = 0) => {
  const title = cleanListLine(job?.title || "") || `岗位 ${index + 1}`;
  const department = cleanListLine(job?.department || "");
  const level = cleanListLine(job?.level || "");
  const salary = cleanListLine(job?.salary || "");
  const summary = cleanListLine(job?.summary || "");
  const requirements = toLineArray(job?.requirements, 12);
  const t0Lines = toLineArray(job?.t0, 8);
  const t1Lines = toLineArray(job?.t1, 8);
  return {
    title,
    department,
    level,
    salary,
    summary,
    requirementsList: requirements,
    requirements: formatRequirementsText(summary, requirements),
    t0: t0Lines.join("\n"),
    t1: t1Lines.join("\n"),
  };
};

const normalizeJobParseResult = result => {
  const rawJobs = Array.isArray(result?.jobs) ? result.jobs : [result];
  return rawJobs
    .map((job, index) => normalizeJobDraft(job, index))
    .filter(job => job.title || job.requirementsList.length || job.t0 || job.t1)
    .filter(job => job.requirements || job.t0 || job.t1);
};

const formatRubricContext = knowledge => {
  const summary = cleanListLine(knowledge?.rubricSummary || "");
  const rubric = knowledge?.rubric;
  if (!rubric && !summary) return "";
  const lines = ["【岗位学习规则】"];
  if (summary) lines.push(`规则摘要：${summary}`);
  const hardRequirements = toLineArray(rubric?.hardRequirements, 8);
  if (hardRequirements.length) lines.push(`最新硬门槛：${hardRequirements.join("；")}`);
  const dimensions = Array.isArray(rubric?.coreDimensions)
    ? rubric.coreDimensions
        .map(item => `${cleanListLine(item?.dimension)}(${cleanListLine(item?.weight || "中")})${cleanListLine(item?.note) ? `：${cleanListLine(item.note)}` : ""}`)
        .filter(Boolean)
    : [];
  if (dimensions.length) lines.push(`重点评估维度：${dimensions.join("；")}`);
  const passSignals = toLineArray(rubric?.passSignals, 6);
  if (passSignals.length) lines.push(`优先录用信号：${passSignals.join("；")}`);
  const redFlags = toLineArray(rubric?.redFlags, 6);
  if (redFlags.length) lines.push(`高风险信号：${redFlags.join("；")}`);
  const tips = toLineArray(rubric?.calibrationTips, 6);
  if (tips.length) lines.push(`评分校准建议：${tips.join("；")}`);
  return lines.join("\n");
};

const formatQuestionBankContext = knowledge => {
  const summary = cleanListLine(knowledge?.questionBankSummary || "");
  const bank = knowledge?.questionBank;
  if (!bank && !summary) return "";
  const lines = ["【学习后的面试题库偏好】"];
  if (summary) lines.push(`题库摘要：${summary}`);
  const dynamicSections = [
    ["highSignalQuestions", "高价值题"],
    ["questionPatterns", "优先提问模式"],
    ["followUpPatterns", "高价值追问模式"],
    ["avoidQuestions", "应少问/淘汰题"],
  ];
  let hasDynamicSections = false;
  dynamicSections.forEach(([key, label]) => {
    const items = Array.isArray(bank?.[key]) ? bank[key].slice(0, 3) : [];
    if (!items.length) return;
    hasDynamicSections = true;
    lines.push(`${label}：${items.map(item => {
      const question = cleanListLine(item?.question || item?.pattern || "");
      const targetSignal = cleanListLine(item?.targetSignal || item?.useWhen || item?.reason || "");
      return targetSignal ? `${question}（${targetSignal}）` : question;
    }).filter(Boolean).join("；")}`);
  });
  if (hasDynamicSections) return lines.join("\n");
  const sections = [
    ["mustAsk", "必问题"],
    ["behavioral", "行为题"],
    ["technical", "专业题"],
    ["redFlagChecks", "红旗排查题"],
    ["followUps", "高价值追问"],
  ];
  sections.forEach(([key, label]) => {
    const items = Array.isArray(bank?.[key]) ? bank[key].slice(0, 3) : [];
    if (!items.length) return;
    lines.push(`${label}：${items.map(item => {
      const question = cleanListLine(item?.question || "");
      const targetDimension = cleanListLine(item?.targetDimension || "");
      return targetDimension ? `${question}（考察 ${targetDimension}）` : question;
    }).filter(Boolean).join("；")}`);
  });
  return lines.join("\n");
};

const normalizeMatchText = text => cleanListLine(String(text || "").toLowerCase()).replace(/[，。！？、；：,.!?;:（）()\[\]\s]/g, "");
const scoreQuestionBankSource = (questionText, sourceText) => {
  const q = normalizeMatchText(questionText);
  const s = normalizeMatchText(sourceText);
  if (!q || !s) return 0;
  if (q.includes(s) || s.includes(q)) return Math.min(q.length, s.length) + 10;
  let score = 0;
  const seen = new Set();
  for (let i = 0; i < s.length - 1; i += 1) {
    const gram = s.slice(i, i + 2);
    if (seen.has(gram)) continue;
    seen.add(gram);
    if (q.includes(gram)) score += 2;
  }
  return score;
};

const getQuestionBankSourceMeta = (question, knowledge) => {
  const bank = knowledge?.questionBank;
  if (!bank) return null;
  const candidates = [
    ...(Array.isArray(bank.highSignalQuestions) ? bank.highSignalQuestions.map(item => ({ kind: "高价值题", text: item?.question, hint: item?.targetSignal || item?.purpose || "" })) : []),
    ...(Array.isArray(bank.questionPatterns) ? bank.questionPatterns.map(item => ({ kind: "优先提问模式", text: item?.pattern, hint: item?.useWhen || item?.why || "" })) : []),
    ...(Array.isArray(bank.followUpPatterns) ? bank.followUpPatterns.map(item => ({ kind: "高价值追问模式", text: item?.pattern, hint: item?.why || item?.useWhen || "" })) : []),
    ...(Array.isArray(bank.avoidQuestions) ? bank.avoidQuestions.map(item => ({ kind: "应少问/淘汰题", text: item?.question, hint: item?.reason || "" })) : []),
  ].filter(item => item.text);
  let best = null;
  candidates.forEach(item => {
    const score = scoreQuestionBankSource(question?.question || "", item.text);
    if (!best || score > best.score) best = { ...item, score };
  });
  return best && best.score >= 4 ? best : null;
};

const buildJobOptionsContext = jobs => {
  const items = (jobs || []).map(job => {
    const lines = [
      `- 岗位名称：${cleanListLine(job?.title || "")}`,
      job?.department ? `  部门：${cleanListLine(job.department)}` : "",
      job?.requirements ? `  岗位要求：${normalizeLooseListText(job.requirements).replace(/\n+/g, "；")}` : "",
      job?.t0 ? `  T0：${normalizeLooseListText(job.t0).replace(/\n+/g, "；")}` : "",
      job?.t1 ? `  T1：${normalizeLooseListText(job.t1).replace(/\n+/g, "；")}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  }).filter(Boolean);
  return items.length ? `候选岗位列表：\n${items.join("\n")}` : "";
};

const extractRoleKeywords = text => {
  const src = String(text || "").toLowerCase();
  const groups = [
    ["店铺运营", /(店铺运营|店务运营|店铺管理|店铺后台|电商运营|淘系运营|快手店铺|抖音店铺|商品运营|店铺店务|商城运营)/g],
    ["短视频编导", /(编导|短视频|脚本|选题|内容策划|导演|内容组)/g],
    ["剪辑后期", /(剪辑|后期|pr|ae|剪映|达芬奇|包装|调色)/g],
    ["拍摄执行", /(拍摄|摄影|机位|打光|收音|器材)/g],
    ["信息流投放", /(信息流|投流|投放|优化师|买量|roi|cpm|ctr|cvr|账户|出价|人群包|计划)/g],
    ["直播运营", /(直播运营|中控|场控|直播间|主播|排品|千川|直播投流)/g],
    ["内容运营", /(内容运营|内容增长|新媒体|种草|小红书|公众号|社媒运营)/g],
  ];
  return groups
    .filter(([, re]) => re.test(src))
    .map(([label]) => label);
};

const scoreJobMatch = (job, screening = {}, resumeText = "") => {
  const title = cleanListLine(job?.title || "").toLowerCase();
  const pool = `${job?.title||""}\n${job?.requirements||""}\n${job?.t0||""}\n${job?.t1||""}`.toLowerCase();
  const matchedTitle = cleanListLine(screening?.matchedJobTitle || "").toLowerCase();
  const matchedReason = String(screening?.matchedJobReason || "").toLowerCase();
  const roleDirection = String(screening?.roleDirection || "").toLowerCase();
  const sourceText = `${matchedTitle}\n${matchedReason}\n${roleDirection}\n${resumeText}`.toLowerCase();

  let score = 0;
  if (matchedTitle && title === matchedTitle) score += 100;
  else if (matchedTitle && (title.includes(matchedTitle) || matchedTitle.includes(title))) score += 60;

  const jobKeywords = extractRoleKeywords(pool);
  const candidateKeywords = extractRoleKeywords(sourceText);
  jobKeywords.forEach(keyword => {
    if (candidateKeywords.includes(keyword)) score += 18;
    else if (sourceText.includes(keyword.toLowerCase())) score += 10;
  });

  const titleTokens = title.split(/[·/\-\s]+/).map(cleanListLine).filter(Boolean);
  titleTokens.forEach(token => {
    if (token.length < 2) return;
    if (sourceText.includes(token)) score += 8;
  });

  if (matchedReason && title && matchedReason.includes(title)) score += 14;
  return score;
};

const resolveMatchedJob = (jobs, screening = {}, resumeText = "") => {
  if (!Array.isArray(jobs) || !jobs.length) return null;
  const matchedTitle = cleanListLine(screening?.matchedJobTitle || "").toLowerCase();
  if (matchedTitle) {
    const exact = jobs.find(job => cleanListLine(job?.title || "").toLowerCase() === matchedTitle);
    if (exact) return exact;
    const fuzzy = jobs.find(job => {
      const title = cleanListLine(job?.title || "").toLowerCase();
      return title && (title.includes(matchedTitle) || matchedTitle.includes(title));
    });
    if (fuzzy) return fuzzy;
  }
  const ranked = jobs
    .map(job => ({ job, score: scoreJobMatch(job, screening, resumeText) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].job : null;
};

const getEffectiveCandidateJob = (jobs, cand) => {
  const bound = (jobs || []).find(job => job.id === cand?.jobId);
  if (bound) return bound;
  return resolveMatchedJob(jobs, cand?.screening || {}, cand?.resume || "");
};

const buildScreeningPrompt = (job, resume, learningCtx="", jobOptions=[]) => {
  const t0=job?.t0?.split("\n").filter(Boolean).map(l=>`"${l.trim()}"`).join(",")||"";
  const t1=job?.t1?.split("\n").filter(Boolean).map(l=>`"${l.trim()}"`).join(",")||"";
  const genericJobMatching = !job?.title && !job?.requirements && jobOptions.length
    ? `当前尚未指定岗位。请先在候选岗位列表里判断候选人最匹配哪个岗位；如果候选人与所有岗位都不匹配，matchedJobTitle 返回空字符串。若简历里明确出现“店铺运营 / 店铺店务 / 店铺管理 / 店铺电商运营 / 店铺后台运营 / 淘系店铺 / 快手店铺运营”等表述，要优先匹配店铺运营类岗位。`
    : "";
  const genericHint = !job?.title && !job?.requirements
    ? "当前尚未指定岗位，请先把简历规整成结构化人才画像，再按通用互联网招聘标准完成首轮潜力评分。重点识别候选人的职业方向、经验年限、核心技能、行业相关性、稳定性与风险项。"
    : "";
  return `岗位：${job?.title||"待分配岗位"} 部门：${job?.department||""} 要求：${job?.requirements||""}
${t0?`T0硬性条件：[${t0}]`:"请自行从要求中提取T0硬性条件"}
${t1?`T1核心维度：[${t1}]`:"请自行提取T1核心评估维度(6-8个)"}
${genericHint?`\n${genericHint}`:""}
${genericJobMatching?`\n${genericJobMatching}`:""}
${!job?.title && !job?.requirements && jobOptions.length?`\n${buildJobOptionsContext(jobOptions)}`:""}
${learningCtx?`\n${learningCtx}`:""}
薪酬：${job?.salary||"不限"} 简历：${resume}
输出JSON：{"candidateName":"候选人姓名（如能识别）","roleDirection":"候选人更偏向的岗位方向，例如店铺运营/短视频编导/信息流投放/剪辑后期","matchedJobTitle":"最匹配的岗位名称；若都不匹配则留空","matchedJobReason":"为什么匹配这个岗位，或为什么不匹配任何岗位","matchedJobConfidence":"高|中|低","summary":"2-3句综合评价","recommendation":"建议通过|待定|建议淘汰","overallScore":4.5,
"t0":{"score":4.2,"items":[{"requirement":"条件","level":"高|中|低","score":4,"maxScore":5,"note":"说明"}]},
"t1":{"items":[{"dimension":"维度","note":"依据","score":4,"maxScore":5}]},
"t2":{"items":[{"item":"加分项","has":true,"note":"依据"}]},
"fineScreen":{"education":{"score":3,"maxScore":5,"note":""},"industryRisk":{"score":3,"maxScore":5,"note":""},"tenureMatch":{"score":4,"maxScore":5,"note":""},"salaryReason":{"score":5,"maxScore":5,"note":""}},
"risks":["风险1"]}
要求：
1. roleDirection 必须根据候选人过去真实做过的岗位来判断，不能泛泛写成“运营”。
2. 如果候选人更偏内容/编导/剪辑，就不要匹配到投流岗；如果更偏店铺运营，就不要误匹配到内容岗。
3. matchedJobReason 要明确说明你是根据哪些经历、产品、工具、产出和结果做出的岗位判断。`;
};

const INTERVIEW_RULES_PROMPT = `【面试题生成准则】
1. 只用过去看未来：所有问题都必须锚定候选人过去真实做过的项目、结果、冲突、失败、复盘，不允许使用“如果你入职后打算怎么做”这类假设性问题。
2. 先打假显性指标：如果简历里写了业绩、带队、爆款、投放消耗、ROI、管理经验，必须通过执行细节追问，区分他到底是核心操盘手、协同推进者，还是只是参与执行。
3. 要挖隐性指标：除了硬技能，还要考察概念能力、品格、人际沟通、倾听抓取、失败归因、复盘质量。
4. 必须保留压力测试：对于年资较深、表达成熟、明显会包装的候选人，至少安排1道带质疑的压力测试题，观察其情绪稳定性、事实感和沟通方式。
5. 必须覆盖过去公司的组织架构：不要只听 title，要通过部门规模、汇报关系、带人情况、KPI 制定方式，判断其真实生态位。
6. 必须覆盖过去做过的产品、人群、流量选择：追问他做过什么产品、打什么人群、选什么流量、为什么这么选、效果如何复盘。`;

const buildRoleBaselinePrompt = (job, cand) => {
  const corpus = `${job?.title||""}\n${job?.requirements||""}\n${cand?.screening?.roleDirection||""}\n${cand?.resume||""}`.toLowerCase();
  const blocks = [];
  const hasTrafficKeywords = /(投流|投手|信息流|优化师|买量|roi|cpm|ctr|cvr|消耗|投放)/.test(corpus);
  const hasContentKeywords = /(编导|剪辑|短视频|脚本|拍摄|pr|ae|剪映|达芬奇|内容策划|素材)/.test(corpus);

  if (hasTrafficKeywords) {
    blocks.push(`【该岗位基础问题池：信息流/投手方向】
- 必问“五维数据链”：消耗、CPM、CTR、CVR、ROI，要求候选人还原一条真实计划的数据区间，并解释这些指标之间的逻辑闭环。
- 必问异常排查：当消耗涨了但 ROI 掉到 1 以下时，如何按五维数据链拆解原因，优先排查素材、人群、出价还是转化承接。
- 必问素材与人群匹配：跑量最好的素材框架是什么，前3秒怎么抓人，核心人群包画像是什么，为什么这个素材能打中这群人。
- 必问跨部门协同：和内容组、设计组、直播组或产品组在跑量不佳时如何复盘，谁主导修改，如何用数据说服对方。
- 必问组织架构：团队人数、直接汇报对象、是否真正带人、如何定 KPI、是否能主导预算与策略。`);
  }

  if (hasContentKeywords) {
    blocks.push(`【该岗位基础问题池：短视频编导/剪辑方向】
- 必问内容基因：过去主要产出的是信息流效果短视频、自然流种草、IP人设包装还是品牌TVC，避免形式基因错配。
- 必问个人技能栈：脚本、拍摄、打光、收音、剪辑、包装分别哪些是亲手独立完成的，熟练使用哪些器材和软件（PR / AE / 剪映 / 达芬奇）。
- 必问爆款拆解：挑一条真实跑出来的视频，还原选题、前三秒钩子、信息密度、节奏设计、转化动作和复盘动作。
- 必问协同与修改：当投流反馈跑不动时，如何根据数据修改脚本、镜头、节奏和卖点，而不是只做被动执行。`);
  }

  if (!blocks.length) {
    blocks.push(`【该岗位基础问题池：通用业务岗位】
- 必问过去项目中最能代表其真实能力的案例，拆解目标、动作、结果、复盘。
- 必问组织架构、汇报线、带人情况、协同对象，判断其真实生态位。
- 必问失败案例与复盘，观察其归因方式、情绪稳定性与学习能力。`);
  }

  return blocks.join("\n\n");
};

const buildCandidateBiasPrompt = cand => {
  const resume = String(cand?.resume || "");
  const text = resume.toLowerCase();
  const hits = [];
  const hasTrafficKeywords = /(投流|投放|信息流|roi|cpm|ctr|cvr|消耗|账户|出价|人群包|计划)/.test(text);
  const hasContentKeywords = /(编导|剪辑|脚本|拍摄|pr|ae|剪映|达芬奇|镜头|选题|前三秒|素材)/.test(text);

  if (/(主管|负责人|组长|leader|带团队|管理|汇报|kpi|考核|招聘|培养)/i.test(resume)) {
    hits.push(`【候选人特征：管理/组织生态位】
- 追加追问组织架构、真实带人规模、直接汇报关系、KPI制定方式、是否真正主导资源分配。
- 对所有“主管/负责人/总监”类 title 保持审慎，优先通过具体管理动作核验，而不是相信头衔。`);
  }

  if (hasTrafficKeywords) {
    hits.push(`【候选人特征：投流/效果广告经历明显】
- 专业题优先围绕“五维数据链”、计划诊断、素材与人群适配、异常排查 SOP。
- 必须至少有1题让他还原真实计划的数据区间，至少有1题让他解释 ROI 下滑时的排查顺序。`);
  }

  if (hasContentKeywords) {
    hits.push(`【候选人特征：内容/编导经历明显】
- 专业题优先围绕内容基因、选题、前三秒、节奏设计、脚本、拍摄与后期的真实个人技能栈。
- 必须至少有1题逼他拆解一条真实内容作品，而不是泛泛谈方法论。`);
    if (!hasTrafficKeywords) {
      hits.push(`【候选人特征：偏内容而非投流】
- 不要强行追问计划级投流数据，例如整条计划的 CPM / CTR / CVR / ROI 闭环。
- 如需追问数据，优先问素材层数据和判断依据，例如前三秒留存、完播、点击、互动、转化素材差异，以及如何判断一条素材值得继续放量或修改。`);
    }
  }

  if (/(跨部门|协同|对接|产品|设计|直播|运营|销售|商务)/.test(text)) {
    hits.push(`【候选人特征：跨部门协同经历明显】
- 行为题要重点考察他如何在内容组、投放组、产品组之间推进协同，尤其是目标冲突和复盘分歧时的处理方式。`);
  }

  if (/(\d{4}\.\d{1,2}|\d{4}-\d{1,2}|\d{4}\/\d{1,2})/.test(resume) || /(年以上|多年|资深|高级)/.test(resume)) {
    hits.push(`【候选人特征：年资较深/可能较会包装】
- 至少安排1道对抗性压力测试题，直接质疑其经验深度、平台适配、薪资匹配或跳槽稳定性，观察其被质疑后的反应。`);
  }

  if (!hits.length) {
    hits.push(`【候选人特征：信息不足】
- 优先用组织架构、代表项目、失败案例、跨团队协同和复盘能力来判断其真实水平。`);
  }

  return hits.join("\n\n");
};

const CONTENT_ROLE_RE = /(编导|剪辑|短视频|脚本|拍摄|内容策划|内容组|素材|导演|摄影|后期|视频)/i;
const TRAFFIC_ROLE_RE = /(投流|投放|信息流|投手|优化师|买量|roi|cpm|ctr|cvr|消耗|账户|出价|人群包|计划)/i;
const PLAN_METRIC_QUESTION_RE = /(cpm|ctr|cvr|roi|投放计划|计划数据|计划的|计划层|出价|人群包|账户消耗|整条计划|五维数据链)/i;

const isContentRole = (job, cand) => CONTENT_ROLE_RE.test(`${job?.title||""}\n${job?.requirements||""}\n${cand?.resume||""}`);
const isTrafficRole = (job, cand) => TRAFFIC_ROLE_RE.test(`${job?.title||""}\n${job?.requirements||""}\n${cand?.resume||""}`);

const rewriteToContentMetricsQuestion = question => ({
  ...question,
  tag: question?.tag || "专业能力",
  subTag: "素材数据判断",
  principle: question?.principle || "内容岗位匹配",
  question: "请回忆一条你过去主导的素材，具体看哪些数据判断它值得继续放量或修改？这些数据分别说明了什么？",
  purpose: "核验内容岗是否真的懂素材层数据与判断逻辑，而不是套投放计划指标",
  goodAnswer: "能结合真实素材说明前三秒、完播、点击、互动或转化差异，以及对应修改动作",
  okAnswer: "知道会看部分素材数据，但判断逻辑和修改动作不够完整",
  badAnswer: "只会泛谈 ROI、CPM 等计划指标，说不清素材层数据",
  redFlag: "把内容岗问题答成投流计划复盘，缺少素材判断与优化动作",
  followUp: "追问某条素材从初版到优化版，具体哪组数据变化让你决定继续放量或改脚本",
});

const normalizeGeneratedQuestionsForRole = (questions, job, cand) => {
  const contentOnly = isContentRole(job, cand) && !isTrafficRole(job, cand);
  if (!contentOnly) return questions;
  return (questions || []).map(question => {
    if (!PLAN_METRIC_QUESTION_RE.test(String(question?.question || ""))) return question;
    return rewriteToContentMetricsQuestion(question);
  });
};

function mergeQuestionFeedbackHistory(history = [], questions = []) {
  const existing = Array.isArray(history) ? history : [];
  const map = new Map(existing.map(item => [normalizeMatchText(item?.question || ""), item]));
  (questions || []).forEach(item => {
    if (!item?.question || !item?.feedbackTag) return;
    const key = normalizeMatchText(item.question);
    if (!key) return;
    map.set(key, {
      question: item.question,
      feedbackTag: item.feedbackTag,
      feedbackNote: item.feedbackNote || "",
      principle: item.principle || "",
      resumeEvidence: item.resumeEvidence || "",
      updatedAt: new Date().toISOString(),
    });
  });
  return Array.from(map.values())
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())
    .slice(0, 30);
}

function buildQuestionFeedbackGuardrails(cand, knowledge) {
  const history = mergeQuestionFeedbackHistory(cand?.questionFeedbackHistory, cand?.questions || []);
  const avoidFromHistory = history
    .filter(item => ["duplicate", "invalid"].includes(item.feedbackTag))
    .slice(0, 6);
  const highValue = history
    .filter(item => item.feedbackTag === "high_value")
    .slice(0, 4);
  const avoidFromKnowledge = Array.isArray(knowledge?.questionBank?.avoidQuestions)
    ? knowledge.questionBank.avoidQuestions.slice(0, 4)
    : [];
  const noteHints = history
    .filter(item => item.feedbackNote)
    .slice(0, 4)
    .map(item => `${item.question}：${item.feedbackNote}`);

  const lines = [];
  if (highValue.length || avoidFromHistory.length || avoidFromKnowledge.length || noteHints.length) {
    lines.push("【当前题目反馈修正】");
  }
  if (highValue.length) {
    lines.push(`保留这类高价值问法：${highValue.map(item => cleanListLine(item.question)).join("；")}`);
  }
  if (avoidFromHistory.length) {
    lines.push(`本候选人已明确判定为重复/无效，不要再问相近问题：${avoidFromHistory.map(item => cleanListLine(item.question)).join("；")}`);
  }
  if (avoidFromKnowledge.length) {
    lines.push(`岗位题库里已标记应少问/淘汰的问题：${avoidFromKnowledge.map(item => cleanListLine(item?.question || "")).filter(Boolean).join("；")}`);
  }
  if (noteHints.length) {
    lines.push(`面试官补充反馈：${noteHints.join("；")}`);
  }
  if (avoidFromHistory.length || avoidFromKnowledge.length) {
    lines.push("对于已判定为重复、无效或不适配的问题，不要只换个说法继续问，必须换成新的鉴别角度。");
  }
  return lines.join("\n");
}

const getInterviewRulesText = job => {
  const custom = String(job?.interviewRules || "").trim();
  return custom || INTERVIEW_RULES_PROMPT;
};

const buildQuestionPrompt = (job, cand, knowledge) => {
  const roleLabel = job?.title || cand?.screening?.roleDirection || "待识别岗位";
  const rubricCtx = formatRubricContext(knowledge);
  const bankCtx = formatQuestionBankContext(knowledge);
  const feedbackGuardrails = buildQuestionFeedbackGuardrails(cand, knowledge);
  const roleBaselineCtx = buildRoleBaselinePrompt(job, cand);
  const candidateBiasCtx = buildCandidateBiasPrompt(cand);
  const interviewRules = getInterviewRulesText(job);
  return `岗位：${roleLabel} 要求：${job?.requirements||""}
简历摘要：${cand.resume?.slice(0,500)} 筛选结论：${cand.screening?.summary}
风险：${JSON.stringify(cand.screening?.risks||[])}
${rubricCtx?`${rubricCtx}\n`:""}${bankCtx?`${bankCtx}\n`:""}${feedbackGuardrails?`${feedbackGuardrails}\n`:""}${interviewRules}
${roleBaselineCtx}
${candidateBiasCtx}
生成10道结构化面试题，返回JSON：
{"questions":[{"step":1,"stepName":"开场破冰","tag":"破冰","subTag":"综合观察","principle":"命中的准则名称","resumeEvidence":"对应简历锚点","question":"问题","purpose":"目的","goodAnswer":"好的回答...","okAnswer":"一般回答...","badAnswer":"差的回答...","redFlag":"红旗回答...","followUp":"追问方向..."}]}
步骤建议：1.开场破冰 2.自我介绍 3.离职动机 4.经历深挖(4-5题) 5.关键鉴别题(2-3题) 6.反问
要求：
1. 优先覆盖学习后的重点维度和高风险点，避免重复和空泛问题。
2. 必须返回合法 JSON，只能有一个顶层对象，顶层键名固定为 questions。
3. 每道题都要明确写出它命中的准则（principle）和对应的简历锚点（resumeEvidence）。
4. 所有问题必须指向候选人的真实过往案例，默认使用“请回忆一次你过去...” “你当时具体怎么做的...” 这样的问法。
5. 每个字段都用简洁中文，单个字段尽量控制在 40 字以内，避免输出过长导致 JSON 被截断。
6. 不要为了凑分类强行区分行为题、专业题，优先输出真正高区分度、便于追问、能从面试笔记里持续优化的问题。
7. 如果某个字段不适合展开，也必须返回空字符串，不要省略字段。
8. 如果候选人更偏内容/编导，而不是投流优化师，禁止生成计划级投放数据题；必须改问素材层数据、素材判断依据和内容优化动作。`;
};

const normalizeQuestionsPayload = payload => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.questions)) return payload.questions;
  if (Array.isArray(payload?.data?.questions)) return payload.data.questions;
  if (Array.isArray(payload?.result?.questions)) return payload.result.questions;
  return [];
};

const normalizeInterviewAssessmentPayload = payload => {
  const candidates = [payload, payload?.assessment, payload?.data, payload?.result, payload?.interviewAssessment].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && (candidate.decision || candidate.jdMatch || Array.isArray(candidate.dimensions))) {
      return candidate;
    }
  }
  return null;
};

const QUESTION_FEEDBACK_OPTIONS = [
  { id: "high_value", label: "高价值", color: "#059669", bg: "#ecfdf5" },
  { id: "normal", label: "一般", color: "#2563eb", bg: "#eff6ff" },
  { id: "duplicate", label: "重复", color: "#d97706", bg: "#fffbeb" },
  { id: "invalid", label: "无效", color: "#dc2626", bg: "#fef2f2" },
];
const getQuestionFeedbackOption = id => QUESTION_FEEDBACK_OPTIONS.find(option => option.id === id) || null;

const summarizeQuestionFeedback = questions => {
  const rated = (questions || []).filter(q => q?.feedbackTag);
  if (!rated.length) return "";
  const counts = QUESTION_FEEDBACK_OPTIONS.map(option => {
    const total = rated.filter(q => q.feedbackTag === option.id).length;
    return total ? `${option.label}${total}题` : "";
  }).filter(Boolean);
  const highlights = rated
    .filter(q => q.feedbackTag === "high_value")
    .slice(0, 3)
    .map(q => q.question)
    .filter(Boolean);
  return [
    counts.length ? `题目反馈统计：${counts.join("，")}` : "",
    highlights.length ? `高价值题目：${highlights.join("；")}` : "",
  ].filter(Boolean).join("\n");
};

const summarizeInterviews = cand => (cand.interviews||[])
  .map(ir => {
    const ast = ir.assessment || {};
    const highlights = Array.isArray(ast.highlights) ? ast.highlights.join("、") : "";
    const concerns = Array.isArray(ast.concerns) ? ast.concerns.join("、") : "";
    const noteSnippet = normalizeExtractedText(ir.notes || "").slice(0, 140);
    return `${ir.round || "面试"}：结论${ast.decision || "未定"}；建议${ast.suggestion || "无"}；亮点${highlights || "无"}；顾虑${concerns || "无"}；原始笔记${noteSnippet || "无"}`;
  })
  .join("\n");

const buildLearningSample = (cand, job, verdict, reason) => {
  const aiRecommendation = cand.screening?.recommendation || "";
  const directorVerdict = verdict || "";
  const mismatchType = !aiRecommendation
    ? "manual_only"
    : (aiRecommendation==="建议通过"&&["录用","通过"].includes(directorVerdict))||(aiRecommendation==="建议淘汰"&&directorVerdict==="淘汰")
      ? "aligned"
      : "corrective";
  const deltaNotes = [
    cand.screening?.risks?.length ? `筛选风险：${cand.screening.risks.join("；")}` : "",
    summarizeQuestionFeedback(cand.questions || []),
    summarizeInterviews(cand),
  ].filter(Boolean).join("\n");
  return {
    jobId: job?.id,
    candidateId: cand.id,
    jobTitle: job?.title || "",
    candidateName: cand.name || "",
    aiRecommendation,
    aiScore: cand.screening?.overallScore || null,
    directorVerdict,
    directorReason: reason,
    screeningSummary: cand.screening?.summary || "",
    questionFeedbackSummary: summarizeQuestionFeedback(cand.questions || []),
    interviewSummary: summarizeInterviews(cand),
    mismatchType,
    deltaNotes,
    samplePayload: {
      screening: cand.screening || null,
      questions: cand.questions || null,
      interviews: cand.interviews || [],
      directorReason: reason,
      job: job || null,
    },
  };
};

const buildLearningSynthesisPrompt = (job, samples) => `请基于同一岗位的历史样本，提炼可执行的招聘判断规则和面试题库。
岗位：${job?.title||"未知"} 部门：${job?.department||""}
当前岗位要求：${job?.requirements||""}
当前T0：${job?.t0||"无"}
当前T1：${job?.t1||"无"}
历史样本（最近${samples.length}条）：
${samples.map((sample, index) => `样本${index+1}：
- 候选人：${sample.candidateName||"未命名"}
- AI建议：${sample.aiRecommendation||"无"} / AI评分：${sample.aiScore||"无"}
- 总监结论：${sample.directorVerdict||"无"}
- 总监原因：${sample.directorReason||"无"}
- 简历总结：${sample.screeningSummary||"无"}
- 面试摘要：${sample.interviewSummary||"无"}
- 题目反馈：${sample.questionFeedbackSummary||"无"}
- 偏差类型：${sample.mismatchType||"无"}
- 备注：${sample.deltaNotes||"无"}`).join("\n\n")}
输出JSON：
{"rubricSummary":"一句话总结这一岗位最新判断基准","rubric":{"hardRequirements":["硬门槛"],"coreDimensions":[{"dimension":"维度","weight":"高|中|低","note":"评分说明"}],"passSignals":["优先录用信号"],"redFlags":["高风险信号"],"calibrationTips":["避免误判的评分提醒"]},"questionBankSummary":"一句话总结最新题库策略","questionBank":{"highSignalQuestions":[{"question":"高价值问题","purpose":"为什么有效","targetSignal":"主要识别什么","step":"建议放在第几步"}],"questionPatterns":[{"pattern":"问题模板/提问方向","useWhen":"适用场景","why":"为什么有效"}],"followUpPatterns":[{"pattern":"追问方式","useWhen":"何时继续追问","why":"能挖出什么"}],"avoidQuestions":[{"question":"应该少问或淘汰的问题","reason":"为什么低效/重复/容易被套话"}]}}
要求：
1. 规则一定要能指导后续筛选和面试，不要空泛。
2. 题库必须优先根据面试笔记和题目反馈，区分哪些题真正问出了信息、哪些题只是套话或重复。
3. 不要强行按行为题/技术题分类，更重要的是高区分度、可追问、能和简历经历对上。
4. 如果历史样本不足，仍需输出一个保守版本。`;

async function learnFromDirectorFeedback(cfg, cand, job, verdict, reason, recordTokens) {
  if (!job?.id) return { sampleCount: 0, updatedKnowledge: false };
  const token = cfg?.proxyToken || "";
  const sample = buildLearningSample(cand, job, verdict, reason);
  const sampleRes = await postKnowledgeAction(token, { action: "recordSample", sample });
  const sampleCount = Number(sampleRes?.sampleCount) || 1;
  if (sampleCount < KNOWLEDGE_MIN_SAMPLES) return { sampleCount, updatedKnowledge: false };

  const knowledge = await fetchKnowledgeState(token, job.id);
  const recentSamples = Array.isArray(knowledge?.recentSamples) ? knowledge.recentSamples : [];
  const synthesis = await callAI(
    cfg,
    LEARNING_SYSTEM,
    buildLearningSynthesisPrompt(job, recentSamples),
    recordTokens,
    "",
    { maxTokens: 2600 }
  );
  if (synthesis.error) throw new Error(synthesis.raw || synthesis.error);

  const saveRes = await postKnowledgeAction(token, {
    action: "saveKnowledge",
    jobId: job.id,
    rubric: synthesis.rubric || {},
    rubricSummary: synthesis.rubricSummary || "",
    questionBank: synthesis.questionBank || {},
    questionBankSummary: synthesis.questionBankSummary || "",
    sourceSampleCount: sampleCount,
  });
  return {
    sampleCount,
    updatedKnowledge: true,
    rubricVersion: saveRes?.rubricVersion || null,
    questionBankVersion: saveRes?.questionBankVersion || null,
  };
}

const getFileKind = file => {
  const n = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (n.endsWith(".docx")) return "docx";
  if (type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/") || [".txt",".md",".markdown",".csv",".json",".html",".htm"].some(ext=>n.endsWith(ext))) return "text";
  return "unknown";
};

let pdfJsPromise;
const loadPdfJs = async () => {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then(mod => {
      mod.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return mod;
    });
  }
  return pdfJsPromise;
};

const resolveRecognize = mod => {
  const candidates = [mod?.recognize, mod?.default?.recognize, mod?.default];
  return candidates.find(candidate => typeof candidate === "function") || null;
};

const ocrSource = async (source, label) => {
  const mod = await import("tesseract.js");
  const recognize = resolveRecognize(mod);
  if (!recognize) throw new Error("OCR 组件加载失败，请稍后重试");
  const result = await recognize(source, OCR_LANG, {
    logger: () => {},
  });
  const text = normalizeExtractedText(result?.data?.text || "");
  if (!text) throw new Error(`${label} 未识别出有效文字，请换更清晰的文件`);
  return text;
};

const resolveMammoth = mod => {
  const candidates = [mod, mod?.default, mod?.mammoth, mod?.default?.mammoth, globalThis?.mammoth];
  return candidates.find(candidate => typeof candidate?.extractRawText === "function") || null;
};

const extractDocxText = async file => {
  const mod = await import("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js").catch(()=>null);
  const mammoth = resolveMammoth(mod);
  if (!mammoth) throw new Error("Word 解析组件加载失败，请改用 PDF、图片或纯文本 JD");
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return normalizeExtractedText(result?.value || "");
};

const extractImageText = async file => {
  return ocrSource(file, "图片");
};

const renderPdfPageToCanvas = async (page, scale = 1.8) => {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
};

const extractPdfText = async file => {
  const pdfjsLib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = normalizeExtractedText(
      textContent.items.map(item => ("str" in item ? item.str : "")).join(" ")
    );
    if (pageText) pageTexts.push(`【第${pageNumber}页】\n${pageText}`);
  }

  const extractedText = pageTexts.join("\n\n").trim();
  if (extractedText.length >= 80) return extractedText;

  const ocrTexts = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const canvas = await renderPdfPageToCanvas(page);
    const pageText = await ocrSource(canvas, `PDF 第${pageNumber}页`);
    if (pageText) ocrTexts.push(`【第${pageNumber}页】\n${pageText}`);
  }
  return normalizeExtractedText(ocrTexts.join("\n\n"));
};

const extractFileText = async file => {
  const kind = getFileKind(file);
  if (kind==="text") return normalizeExtractedText(await file.text());
  if (kind==="docx") return extractDocxText(file);
  if (kind==="pdf") return extractPdfText(file);
  if (kind==="image") return extractImageText(file);
  throw new Error("暂不支持该文件格式");
};

// ─── CALL AI ─────────────────────────────────────────────────
async function callAI(cfg, system, user, onTokens, dirCtx="", options={}) {
  const {mode="proxy",provider="claude", model, apiKeys={}, proxyUrl="", proxyToken=""} = cfg;
  const prov = PROVIDERS[provider]||PROVIDERS.claude;
  const apiKey = apiKeys[provider]||"";
  const fullSys = dirCtx ? `${system}\n\n${dirCtx}` : system;
  const maxTokens = Math.max(600, Math.min(Number(options?.maxTokens) || 1200, 3200));
  let inputT=0,outputT=0,text="";
  if (mode==="proxy") {
    const url=proxyUrl.trim();
    if(!url) throw new Error("请先在「设置」中填写代理服务地址");
    const headers={"Content-Type":"application/json"};
    if(proxyToken.trim()) headers.Authorization=`Bearer ${proxyToken.trim()}`;
    const res=await fetch(url,{method:"POST",headers,body:JSON.stringify({provider,model,system:fullSys,user,maxTokens})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error||e.message||`Proxy Error ${res.status}`);}
    const d=await res.json();
    inputT=d.usage?.input||0; outputT=d.usage?.output||0;
    if(onTokens) onTokens(inputT,outputT,provider);
    if(d?.data && typeof d.data==="object") return d.data;
    text=typeof d?.data==="string"?d.data:"";
    return parseJsonResponse(text);
  }
  if (!apiKey) throw new Error(`请先在「设置」中填写 ${prov.name} 的 API Key`);
  if (provider==="claude") {
    const res=await fetch(prov.endpoint,{method:"POST",headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model,max_tokens:maxTokens,system:fullSys,messages:[{role:"user",content:user}]})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`API Error ${res.status}`);}
    const d=await res.json(); inputT=d.usage?.input_tokens||0; outputT=d.usage?.output_tokens||0; text=d.content?.[0]?.text||"";
  } else {
    const body={model,max_tokens:maxTokens,messages:[{role:"system",content:fullSys},{role:"user",content:user}]};
    if(provider==="deepseek") body.response_format={type:"json_object"};
    const res=await fetch(prov.endpoint,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${apiKey}`},body:JSON.stringify(body)});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`API Error ${res.status}`);}
    const d=await res.json(); inputT=d.usage?.prompt_tokens||0; outputT=d.usage?.completion_tokens||0; text=d.choices?.[0]?.message?.content||"";
  }
  if(onTokens) onTokens(inputT,outputT,provider);
  return parseJsonResponse(text);
}

async function callAIWithJobFile(cfg, file, onTokens) {
  const kind = getFileKind(file);
  if (kind==="unknown") throw new Error("仅支持 PDF、图片、Word(.docx) 或纯文本 JD 文件");
  const raw = await extractFileText(file);
  if(!raw) throw new Error("未能从文件中提取到文字，请换一个更清晰的文件重试");
  return callAI(
    cfg,
    JOB_PARSE_SYSTEM,
    `${JOB_PARSE_PROMPT}\n\n【文件名】${file.name}\n【识别文字】\n${raw.slice(0,30000)}`,
    onTokens,
    "",
    {maxTokens:2400}
  );
}

async function runResumeScreening(cfg, job, resumeText, onTokens, dirCtx = "", jobOptions = []) {
  const normalizedResume = normalizeExtractedText(resumeText).slice(0,30000);
  if (!normalizedResume) throw new Error("未能从简历文件中提取到有效文字，请换一个更清晰的文件");

  let learning = { rubric: null, rubricSummary: "", questionBank: null, questionBankSummary: "" };
  try {
    learning = await fetchKnowledgeState(cfg.proxyToken || "", job?.id);
  } catch {}

  const screening = await callAI(
    cfg,
    "你是资深HR顾问，请严格按JSON格式输出，不含任何markdown标记或额外文字。",
    buildScreeningPrompt(job, normalizedResume, formatRubricContext(learning), jobOptions),
    onTokens,
    dirCtx,
    { maxTokens: 2200 }
  );
  if (screening.error) throw new Error(screening.raw || screening.error);
  return { normalizedResume, screening, learning };
}

async function createCandidateFromResumeFile({ cfg, job, file, onTokens, dirCtx = "", name = "", jobs = [] }) {
  const extractedResume = await extractFileText(file);
  const { normalizedResume, screening } = await runResumeScreening(cfg, job, extractedResume, onTokens, dirCtx, job ? [] : jobs);
  const matchedJob = job || resolveMatchedJob(jobs, screening, normalizedResume);
  const candidateName = name.trim() || screening.candidateName || "未命名";
  return {
    candidate: {
      id: Date.now() + Math.floor(Math.random() * 1000000),
      jobId: matchedJob?.id ?? null,
      name: candidateName,
      status: getCandidateStatusFromScore(screening.overallScore),
      resume: normalizedResume,
      resumeFileName: file.name,
      screening,
      questions: null,
      interviews: [],
      scheduledAt: null,
      interviewRound: null,
      directorVerdict: null,
    },
    screening,
    normalizedResume,
  };
}

// ─── THEME ───────────────────────────────────────────────────
const THEMES=[{id:"light",name:"浅色"},{id:"dark",name:"深色"},{id:"warm",name:"暖白"},{id:"slate",name:"石板"}];
const getTheme=id=>({
  light:{bg:"#f9fafb",surface:"#fff",border:"#f3f4f6",border2:"#e5e7eb",text:"#111827",text2:"#374151",text3:"#6b7280",text4:"#9ca3af",accent:"#111827",accentFg:"#fff",sidebar:"#fff",navActive:"#f3f4f6",tabActive:"#111827",tabActiveFg:"#fff",inputBg:"#fff",card2:"#f9fafb"},
  dark: {bg:"#0f172a",surface:"#1e293b",border:"#334155",border2:"#475569",text:"#f1f5f9",text2:"#e2e8f0",text3:"#94a3b8",text4:"#64748b",accent:"#3b82f6",accentFg:"#fff",sidebar:"#0f172a",navActive:"#1e293b",tabActive:"#3b82f6",tabActiveFg:"#fff",inputBg:"#0f172a",card2:"#0f172a"},
  warm: {bg:"#faf8f5",surface:"#fff",border:"#e8e0d5",border2:"#d4c9b8",text:"#2c1810",text2:"#4a3728",text3:"#8b6f5e",text4:"#b39080",accent:"#c2410c",accentFg:"#fff",sidebar:"#f5f0e8",navActive:"#f0ebe3",tabActive:"#c2410c",tabActiveFg:"#fff",inputBg:"#fff",card2:"#faf8f5"},
  slate:{bg:"#1a1f2e",surface:"#242938",border:"#2e3548",border2:"#3a4258",text:"#e2e8f0",text2:"#cbd5e1",text3:"#94a3b8",text4:"#64748b",accent:"#6366f1",accentFg:"#fff",sidebar:"#141824",navActive:"#2e3548",tabActive:"#6366f1",tabActiveFg:"#fff",inputBg:"#1a1f2e",card2:"#1a1f2e"},
})[id]||{};

const STATUS={
  pending:  {label:"待筛选",color:"#6b7280",bg:"#f3f4f6"},
  screening:{label:"简历通过",color:"#2563eb",bg:"#eff6ff"},
  watching: {label:"观察中",color:"#d97706",bg:"#fffbeb"},
  interview:{label:"进入面试",color:"#7c3aed",bg:"#f5f3ff"},
  offer:    {label:"已录用",color:"#059669",bg:"#ecfdf5"},
  rejected: {label:"未通过",color:"#dc2626",bg:"#fef2f2"},
};
const scColor=(v,max=5)=>v/max>=0.8?"#16a34a":v/max>=0.6?"#ca8a04":"#dc2626";
const recSt=r=>r==="建议通过"?{c:"#16a34a",bg:"#dcfce7"}:r==="待定"?{c:"#ca8a04",bg:"#fef9c3"}:{c:"#dc2626",bg:"#fee2e2"};
const getScoreBand = score => {
  const n = Number(score);
  if (!Number.isFinite(n)) return { label: "未筛选", color: "#6b7280", bg: "#f3f4f6", status: "pending", range: "等待 AI 首轮分析" };
  if (n >= 4.5) return { label: "合格", color: "#059669", bg: "#ecfdf5", status: "screening", range: "4.5 - 5.0" };
  if (n >= 3) return { label: "待定", color: "#d97706", bg: "#fffbeb", status: "watching", range: "3.0 - 4.4" };
  return { label: "淘汰", color: "#dc2626", bg: "#fef2f2", status: "rejected", range: "0 - 2.9" };
};
const getCandidateStatusFromScore = score => getScoreBand(score).status;
const DASHBOARD_SCORE_GUIDE = {
  t0: [
    { label: "过去经历与目标岗位方向基本一致", level: "高" },
    { label: "具备该岗位最核心的基础技能或实操经验", level: "高" },
    { label: "做过可验证的真实项目，而非只停留在辅助或学习阶段", level: "高" },
    { label: "能说清自己的职责边界、产出结果和复盘方法", level: "中" },
    { label: "工作稳定性、履历连续性没有明显硬伤", level: "中" },
    { label: "薪资、城市、到岗时间等现实条件基本可谈", level: "中" },
    { label: "没有明显造假、严重注水或完全错配信号", level: "高" },
  ],
  t1: [
    { label: "目标导向", weight: "30%", note: "结果优先，能围绕业务目标推进任务" },
    { label: "抗压性", weight: "10%", note: "高节奏下仍能稳定交付" },
    { label: "反馈迭代", weight: "15%", note: "能根据数据和反馈快速修正方案" },
    { label: "团队协作", weight: "10%", note: "跨团队沟通顺畅，推进配合有效" },
    { label: "学习能力", weight: "10%", note: "新工具、新打法上手快" },
    { label: "专业判断", weight: "10%", note: "能说清方法、标准和判断依据" },
    { label: "自驱力", weight: "10%", note: "主动推进问题闭环" },
    { label: "价值观契合", weight: "5%", note: "与团队工作方式和要求匹配" },
  ],
  t2: [
    "有跨岗位协同或带人推进经验",
    "会数据复盘、流程优化或方法沉淀",
    "有持续输出作品、项目成果或行业案例",
    "有跨平台、跨行业或从0到1的实战经历",
  ],
};
const fmt=n=>n?.toLocaleString()||"0";
const todayStr=()=>new Date().toISOString().slice(0,10);
const isSoon=s=>{if(!s)return false;const d=(new Date(s)-new Date())/86400000;return d>=-0.1&&d<=7;};
const fmtDate=s=>{if(!s)return "";const d=new Date(s);return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;};
const SOFT_SHADOW="0 10px 30px rgba(15,23,42,0.06)";
const CARD_RADIUS=16;
const EMPTY_JOB_FORM=()=>({title:"",department:"",level:"",requirements:"",t0:"",t1:"",salary:""});
const EMPTY_JOB_COMPOSER=()=>({open:false,form:EMPTY_JOB_FORM(),jdFileName:"",jdLoading:false,jdErr:"",parsedJobs:[],activeParsedJob:0,taskId:null});
const normalizeJobLevel = level => cleanListLine(level || "").toLowerCase();
const isSingleRoundLevel = level => /(专员|组长|主管)/.test(normalizeJobLevel(level)) && !/(经理|总监)/.test(normalizeJobLevel(level));
const getInterviewRoundsForJob = job => isSingleRoundLevel(job?.level) ? ["一面"] : ["一面","二面","三面","终面","HR面"];
const getPostInterviewStatus = (job, round, decision) => {
  if (decision === "淘汰") return "rejected";
  if (decision !== "通过") return "watching";
  if (round.includes("终")) return "offer";
  if (isSingleRoundLevel(job?.level)) return "watching";
  return "interview";
};

// ─── APP ROOT ────────────────────────────────────────────────
export default function App() {
  const [cfg,setCfg]   =useState(()=>normalizeCfg(load("hr_cfg",DEFAULT_CFG)));
  const [jobs,setJobs] =useState(()=>load("hr_jobs",[]));
  const [cands,setCands]=useState(()=>load("hr_cands",[]));
  const [usageLogs,setUsageLogs]=useState(()=>load("hr_usage",[]));
  const [jobComposer,setJobComposer]=useState(EMPTY_JOB_COMPOSER);
  const [questionTasks,setQuestionTasks]=useState({});
  const [interviewTasks,setInterviewTasks]=useState({});
  const [view,setView] =useState("dashboard");
  const [selJob,setSelJob]=useState(null);
  const [selCand,setSelCand]=useState(null);
  const [candTab,setCandTab]=useState("screening");
  const [compared,setCompared]=useState([]);
  const [showCompare,setShowCompare]=useState(false);
  const [cloud,setCloud]=useState({phase:"loading",message:"正在连接云端数据库...",updatedAt:""});
  const [cloudHydrated,setCloudHydrated]=useState(false);

  useEffect(()=>save("hr_cfg",cfg),[cfg]);
  useEffect(()=>save("hr_jobs",jobs),[jobs]);
  useEffect(()=>save("hr_cands",cands),[cands]);
  useEffect(()=>save("hr_usage",usageLogs),[usageLogs]);

  useEffect(()=>{
    let cancelled=false;
    const hydrateFromCloud=async()=>{
      setCloudHydrated(false);
      setCloud(prev=>({...prev,phase:"loading",message:"正在连接云端数据库..."}));
      try{
        const payload=await fetchCloudState(cfg.proxyToken||"");
        if(cancelled) return;
        const remote=normalizeCloudState(payload);
        const hasRemoteData=remote.jobs.length>0||remote.cands.length>0||remote.usageLogs.length>0||Object.keys(remote.cfg).length>0;
        if(hasRemoteData){
          setJobs(remote.jobs);
          setCands(remote.cands);
          setUsageLogs(remote.usageLogs);
          setCfg(prev=>normalizeCfg({...prev,...remote.cfg,apiKeys:prev.apiKeys,proxyToken:prev.proxyToken}));
          setCloud({phase:"ready",message:"已从云端数据库载入数据",updatedAt:payload.updatedAt||remote.updatedAt||""});
        }else{
          setCloud({phase:"ready",message:"云端数据库为空，将自动上传当前浏览器数据",updatedAt:payload.updatedAt||remote.updatedAt||""});
        }
      }catch(error){
        if(cancelled) return;
        setCloud(prev=>({phase:"error",message:error?.message||"云端数据库不可用，当前继续使用本地缓存",updatedAt:prev.updatedAt||""}));
      }finally{
        if(!cancelled) setCloudHydrated(true);
      }
    };
    hydrateFromCloud();
    return()=>{cancelled=true;};
  },[cfg.proxyToken]);

  useEffect(()=>{
    if(!cloudHydrated) return;
    let cancelled=false;
    const timer=setTimeout(async()=>{
      try{
        setCloud(prev=>({...prev,phase:"syncing",message:"正在同步到云端数据库..."}));
        const payload=await pushCloudState(cfg.proxyToken||"",buildCloudSnapshot(cfg,jobs,cands,usageLogs));
        if(cancelled) return;
        setCloud({phase:"ready",message:"云端数据库已同步",updatedAt:payload.updatedAt||""});
      }catch(error){
        if(cancelled) return;
        setCloud(prev=>({phase:"error",message:error?.message||"云端同步失败，当前数据仍保存在本地浏览器",updatedAt:prev.updatedAt||""}));
      }
    },700);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[cloudHydrated,cfg.mode,cfg.provider,cfg.model,cfg.theme,cfg.proxyUrl,cfg.proxyToken,jobs,cands,usageLogs]);

  const T=getTheme(cfg.theme);
  const dirCtx=buildDirCtx(cands,jobs);
  const updCand=(id,patch)=>setCands(p=>p.map(c=>c.id===id?{...c,...patch}:c));
  const recordTokens=(inp,out,prov)=>{
    const d=todayStr();
    setUsageLogs(p=>{
      const i=p.findIndex(r=>r.date===d&&r.provider===prov);
      if(i>=0){const n=[...p];n[i]={...n[i],input:n[i].input+inp,output:n[i].output+out,calls:n[i].calls+1};return n;}
      return [...p,{date:d,provider:prov,input:inp,output:out,calls:1}];
    });
  };
  const applyParsedJobToComposer=parsedJob=>{
    if(!parsedJob) return;
    setJobComposer(prev=>({
      ...prev,
      form:{
        title:parsedJob.title||"",
        department:parsedJob.department||"",
        level:parsedJob.level||"",
        salary:parsedJob.salary||"",
        requirements:parsedJob.requirements||"",
        t0:parsedJob.t0||"",
        t1:parsedJob.t1||"",
      },
    }));
  };
  const resetJobComposer=()=>setJobComposer(EMPTY_JOB_COMPOSER());
  const removeCandidate=cid=>{
    setCands(prev=>prev.filter(c=>c.id!==cid));
    setCompared(prev=>prev.filter(id=>id!==cid));
    setQuestionTasks(prev=>{
      if(!prev[cid]) return prev;
      const next={...prev};
      delete next[cid];
      return next;
    });
    setInterviewTasks(prev=>{
      if(!prev[cid]) return prev;
      const next={...prev};
      delete next[cid];
      return next;
    });
    if(selCand===cid) setSelCand(null);
  };
  const startQuestionGeneration=async(candidate,job,learning)=>{
    if(!candidate?.id) return;
    const taskId=`question-${candidate.id}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setQuestionTasks(prev=>({
      ...prev,
      [candidate.id]:{
        loading:true,
        error:"",
        taskId,
        startedAt:Date.now(),
      },
    }));
    try{
      const res=await callAI(
        cfg,
        `你是资深HR面试官，请严格按JSON格式输出，不含任何markdown标记。`,
        buildQuestionPrompt(job, candidate, learning),
        recordTokens,dirCtx,
        {maxTokens:3000}
      );
      if(res.error) throw new Error(res.raw||res.error);
      const questions=normalizeGeneratedQuestionsForRole(normalizeQuestionsPayload(res), job, candidate);
      if(!questions.length) throw new Error("模型已返回内容，但没有识别到有效的面试题列表");
      updCand(candidate.id,{questions});
      setQuestionTasks(prev=>{
        if(prev[candidate.id]?.taskId!==taskId) return prev;
        const next={...prev};
        delete next[candidate.id];
        return next;
      });
    }catch(error){
      setQuestionTasks(prev=>prev[candidate.id]?.taskId!==taskId?prev:{
        ...prev,
        [candidate.id]:{
          loading:false,
          error:error?.message||"面试题生成失败",
          taskId,
          startedAt:prev[candidate.id]?.startedAt||Date.now(),
          finishedAt:Date.now(),
        },
      });
    }
  };
  const startInterviewAssessment=async(candidate,job,round,notes)=>{
    if(!candidate?.id) return;
    const taskId=`interview-${candidate.id}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setInterviewTasks(prev=>({
      ...prev,
      [candidate.id]:{
        loading:true,
        error:"",
        raw:"",
        taskId,
        startedAt:Date.now(),
      },
    }));
    try{
      const res=await callAI(
        cfg,
        `你是资深HR，请严格按JSON格式输出，不含任何markdown标记。顶层只能返回一个对象，字符串尽量简洁。`,
        `岗位：${job?.title} 要求：${job?.requirements}
候选人：${candidate.name} 简历评分：${candidate.screening?.overallScore}/5.0 结论：${candidate.screening?.recommendation}
T1维度(简历)：${JSON.stringify(candidate.screening?.t1?.items?.map(i=>({d:i.dimension,s:i.score}))||[])}
面试轮次：${round} 笔记：${notes}
输出JSON：{"round":"${round}","jdMatch":"高度匹配|基本匹配|部分匹配|不匹配","score":4.5,"decision":"通过|待定|淘汰","suggestion":"建议后续行动",
"dimensions":[{"name":"维度","note":"表现","score":4,"maxScore":5,"vsResume":"一致|存疑|不符","evidence":"依据"}],
"emotions":{"trueMotivation":"真实动机","needsPriority":"成长>薪酬>稳定","stabilityRisk":"低|中|高","managementDifficulty":"低|中|高","stabilityNote":"说明","managementNote":"说明"},
"highlights":["亮点"],"concerns":["顾虑"],"interviewerReview":"面试官复盘"}`,
        recordTokens,dirCtx,
        {maxTokens:2400}
      );
      if(res.error) throw { message: res.error, raw: res.raw || "" };
      const assessment=normalizeInterviewAssessmentPayload(res);
      if(!assessment) throw { message: "模型已返回内容，但没有识别到有效的面试评估结果", raw: JSON.stringify(res, null, 2) };
      const ni={round,notes,date:new Date().toLocaleDateString("zh-CN"),assessment};
      updCand(candidate.id,{
        interviews:[...(candidate.interviews||[]),ni],
        scheduledAt:null,
        status:getPostInterviewStatus(job, round, assessment.decision)
      });
      setInterviewTasks(prev=>{
        if(prev[candidate.id]?.taskId!==taskId) return prev;
        const next={...prev};
        delete next[candidate.id];
        return next;
      });
    }catch(error){
      setInterviewTasks(prev=>prev[candidate.id]?.taskId!==taskId?prev:{
        ...prev,
        [candidate.id]:{
          loading:false,
          error:error?.message||"面试评估失败",
          raw:error?.raw||"",
          taskId,
          startedAt:prev[candidate.id]?.startedAt||Date.now(),
          finishedAt:Date.now(),
        },
      });
    }
  };
  const startJobFileParse=async file=>{
    if(!file) return;
    const taskId=`job-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    setJobComposer(prev=>({
      ...prev,
      open:true,
      jdFileName:file.name,
      jdLoading:true,
      jdErr:"",
      parsedJobs:[],
      activeParsedJob:0,
      taskId,
    }));
    try{
      const res=await callAIWithJobFile(cfg,file,recordTokens);
      if(res.error) throw new Error(res.raw||res.error);
      const jobsFound=normalizeJobParseResult(res);
      if(!jobsFound.length) throw new Error("没有识别到清晰岗位，请尝试更清晰的文件或分开上传");
      setJobComposer(prev=>{
        if(prev.taskId!==taskId) return prev;
        return {
          ...prev,
          jdLoading:false,
          jdErr:"",
          parsedJobs:jobsFound,
          activeParsedJob:0,
          form:{
            title:jobsFound[0].title||"",
            department:jobsFound[0].department||"",
            level:jobsFound[0].level||"",
            salary:jobsFound[0].salary||"",
            requirements:jobsFound[0].requirements||"",
            t0:jobsFound[0].t0||"",
            t1:jobsFound[0].t1||"",
          },
        };
      });
    }catch(error){
      setJobComposer(prev=>prev.taskId!==taskId?prev:{...prev,jdLoading:false,jdErr:error?.message||"JD识别失败"});
    }
  };
  const openCand=(cid,jid)=>{if(jid)setSelJob(jid);setSelCand(cid);setCandTab("screening");setView("candidates");};
  const toggleCompare=(id)=>setCompared(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id].slice(-4));

  const upcoming=cands.filter(c=>isSoon(c.scheduledAt)).sort((a,b)=>new Date(a.scheduledAt)-new Date(b.scheduledAt));
  const dirDone=cands.filter(c=>c.directorVerdict?.verdict);
  const hasQuestionTaskRunning=Object.values(questionTasks).some(task=>task?.loading);
  const hasInterviewTaskRunning=Object.values(interviewTasks).some(task=>task?.loading);
  const needsSettingsAttention = cfg.mode === "direct"
    ? !Object.values(cfg.apiKeys||{}).some(Boolean)
    : !String(cfg.proxyUrl||"").trim();
  const dirMatch=dirDone.filter(c=>{
    const aiRec=c.screening?.recommendation||"";
    const dir=c.directorVerdict.verdict;
    return(aiRec==="建议通过"&&["录用","通过"].includes(dir))||(aiRec==="建议淘汰"&&dir==="淘汰");
  });
  const dirStats={total:dirDone.length,match:dirMatch.length,rate:dirDone.length?Math.round(dirMatch.length/dirDone.length*100):0};

  const nav=[
    {id:"dashboard",icon:"▦",label:"仪表盘"},
    {id:"jobs",icon:"◈",label:"岗位管理"},
    {id:"candidates",icon:"◉",label:"候选人"},
    {id:"settings",icon:"⚙",label:"设置"},
  ];

  return(
    <div style={{display:"flex",minHeight:"100vh",background:T.bg,fontFamily:"'PingFang SC','Noto Sans SC',sans-serif",color:T.text}}>
      <Css T={T}/>
      {showCompare&&<CompareModal T={T} ids={compared} cands={cands} jobs={jobs} onClose={()=>setShowCompare(false)}/>}

      {/* SIDEBAR */}
      <aside style={{width:212,background:T.sidebar,borderRight:`1px solid ${T.border}`,display:"flex",flexDirection:"column",flexShrink:0}}>
        <div style={{display:"flex",gap:9,alignItems:"center",padding:"18px 14px 15px",borderBottom:`1px solid ${T.border}`}}>
          <div style={{width:32,height:32,borderRadius:7,background:T.accent,color:T.accentFg,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:12,flexShrink:0}}>HR</div>
          <div><div style={{fontSize:13,fontWeight:800,color:T.text}}>AI 招聘助手</div><div style={{fontSize:10,color:T.text4}}>快手项目组</div></div>
        </div>
        <div style={{padding:"8px 8px 0",flex:1}}>
          {nav.map(n=>(
            <button key={n.id} onClick={()=>{setView(n.id);if(n.id!=="candidates")setSelCand(null);}}
              style={{display:"flex",alignItems:"center",gap:9,width:"100%",padding:"9px 10px",border:"none",background:view===n.id?T.navActive:"transparent",borderRadius:7,cursor:"pointer",fontSize:13,color:view===n.id?T.text:T.text3,fontWeight:view===n.id?700:400,marginBottom:2,textAlign:"left",transition:"all 0.1s"}}>
              <span style={{fontSize:14,width:18,textAlign:"center"}}>{n.icon}</span>
              <span style={{flex:1}}>{n.label}</span>
              {n.id==="settings"&&needsSettingsAttention&&<span style={{width:6,height:6,background:"#ef4444",borderRadius:"50%"}}/>}
              {n.id==="dashboard"&&upcoming.length>0&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#ef4444",color:"#fff",borderRadius:10}}>{upcoming.length}</span>}
              {n.id==="jobs"&&jobComposer.jdLoading&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#2563eb",color:"#fff",borderRadius:10}}>识别中</span>}
              {n.id==="candidates"&&hasInterviewTaskRunning&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#2563eb",color:"#fff",borderRadius:10}}>评估中</span>}
              {n.id==="candidates"&&!hasInterviewTaskRunning&&hasQuestionTaskRunning&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#7c3aed",color:"#fff",borderRadius:10}}>题目中</span>}
            </button>
          ))}
          {compared.length>=2&&(
            <button onClick={()=>setShowCompare(true)}
              style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"9px 10px",border:`1px solid ${T.accent}`,background:`${T.accent}12`,borderRadius:7,cursor:"pointer",fontSize:12,color:T.accent,fontWeight:700,marginTop:8}}>
              <span>⊞</span>对比 {compared.length} 位候选人
            </button>
          )}
          {compared.length>0&&<button onClick={()=>setCompared([])} style={{width:"100%",padding:"4px",border:"none",background:"transparent",fontSize:11,color:T.text4,cursor:"pointer",marginTop:2}}>清除对比选择</button>}
        </div>
        {/* 底部：沉淀进度 + 今日用量 */}
        <div style={{padding:"10px 14px",borderTop:`1px solid ${T.border}`}}>
          {dirStats.total>0&&(
            <div style={{marginBottom:10,padding:"8px 10px",background:T.navActive,borderRadius:7}}>
              <div style={{fontSize:10,color:T.text4,marginBottom:3}}>总监判断沉淀</div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}><span style={{color:T.text3}}>{dirStats.total} 案例</span><span style={{color:T.accent,fontWeight:700}}>AI匹配 {dirStats.rate}%</span></div>
              <div style={{height:3,background:T.border2,borderRadius:2,marginTop:4}}><div style={{width:`${Math.min(dirStats.rate,100)}%`,height:"100%",background:dirStats.rate>=70?"#16a34a":"#6366f1",borderRadius:2}}/></div>
            </div>
          )}
          <div style={{fontSize:10,color:T.text4,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:5}}>今日用量</div>
          {(()=>{
            const logs=usageLogs.filter(r=>r.date===todayStr());
            const calls=logs.reduce((s,r)=>s+r.calls,0);
            const tokens=logs.reduce((s,r)=>s+r.input+r.output,0);
            return(<div style={{fontSize:12,color:T.text3,lineHeight:2}}>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>调用</span><span style={{color:T.text,fontWeight:600}}>{calls} 次</span></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>Token</span><span style={{color:T.text,fontWeight:600}}>{fmt(tokens)}</span></div>
            </div>);
          })()}
        </div>
      </aside>

      <main style={{flex:1,overflow:"auto"}}>
        {view==="dashboard"  &&<DashboardView T={T} jobs={jobs} cands={cands} dirStats={dirStats} onJobClick={id=>{setSelJob(id);setView("jobs");}} onCandClick={openCand} setCands={setCands} cfg={cfg} recordTokens={recordTokens} dirCtx={dirCtx}/>}
        {view==="jobs"       &&<JobsView T={T} jobs={jobs} setJobs={setJobs} cands={cands} setCands={setCands} selJob={selJob} setSelJob={setSelJob} onCandClick={openCand} jobComposer={jobComposer} setJobComposer={setJobComposer} resetJobComposer={resetJobComposer} applyParsedJobToComposer={applyParsedJobToComposer} startJobFileParse={startJobFileParse}/>}
        {view==="candidates" &&<CandidatesView T={T} cands={cands} setCands={setCands} jobs={jobs} selCand={selCand} setSelCand={setSelCand} tab={candTab} setTab={setCandTab} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} compared={compared} toggleCompare={toggleCompare} questionTasks={questionTasks} interviewTasks={interviewTasks} startQuestionGeneration={startQuestionGeneration} startInterviewAssessment={startInterviewAssessment} removeCandidate={removeCandidate}/>}
        {view==="settings"   &&<SettingsView T={T} cfg={cfg} setCfg={setCfg} usageLogs={usageLogs} dirStats={dirStats} dirDone={dirDone} dirMatch={dirMatch} jobs={jobs} cloud={cloud}/>}
      </main>
    </div>
  );
}

// ─── COMPARE MODAL ───────────────────────────────────────────
function CompareModal({T,ids,cands,jobs,onClose}) {
  const cs=ids.map(id=>cands.find(c=>c.id===id)).filter(Boolean);
  const allT1=[...new Set(cs.flatMap(c=>c.screening?.t1?.items?.map(i=>i.dimension)||[]))];
  const allT0=[...new Set(cs.flatMap(c=>c.screening?.t0?.items?.map(i=>i.requirement)||[]))];
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:200,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"40px 20px",overflowY:"auto"}} onClick={onClose}>
      <div style={{background:T.surface,borderRadius:16,width:"100%",maxWidth:920,padding:26,boxShadow:"0 24px 80px rgba(0,0,0,0.2)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontSize:18,fontWeight:800,color:T.text}}>候选人对比</div>
          <button onClick={onClose} style={{border:"none",background:T.navActive,color:T.text3,borderRadius:7,padding:"6px 14px",cursor:"pointer",fontSize:13}}>关闭</button>
        </div>
        {/* 头部卡片 */}
        <div style={{display:"grid",gridTemplateColumns:`140px repeat(${cs.length},1fr)`,gap:12,marginBottom:18}}>
          <div/>
          {cs.map(c=>{
            const j=jobs.find(j=>j.id===c.jobId);
            const dir=c.directorVerdict;
            const borderColor=dir?.verdict==="录用"?"#059669":dir?.verdict==="淘汰"?"#dc2626":T.border;
            return(
              <div key={c.id} style={{background:T.card2,borderRadius:10,padding:"14px 16px",textAlign:"center",border:`2px solid ${borderColor}`}}>
                <Av name={c.name} T={T} size={40}/>
                <div style={{fontSize:14,fontWeight:800,color:T.text,marginTop:8}}>{c.name||"未命名"}</div>
                <div style={{fontSize:11,color:T.text4,marginTop:2}}>{j?.title||"—"}</div>
                {c.screening&&<><div style={{fontSize:26,fontWeight:900,color:scColor(c.screening.overallScore),marginTop:8}}>{c.screening.overallScore?.toFixed(1)}</div>
                <div style={{fontSize:11,color:T.text4}}>综合评分</div>
                <div style={{marginTop:6}}><Chip c={recSt(c.screening.recommendation).c} bg={recSt(c.screening.recommendation).bg}>{c.screening.recommendation}</Chip></div></>}
                {dir?.verdict&&<div style={{marginTop:8,fontSize:12,fontWeight:700,color:dir.verdict==="录用"?"#059669":dir.verdict==="淘汰"?"#dc2626":"#ca8a04"}}>总监：{dir.verdict}</div>}
              </div>
            );
          })}
        </div>
        {/* T0 */}
        {allT0.length>0&&<CmpSec T={T} label="T0 硬性条件">
          {allT0.map(key=>(
            <div key={key} style={{display:"grid",gridTemplateColumns:`140px repeat(${cs.length},1fr)`,gap:12,padding:"8px 0",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:12,color:T.text3,alignSelf:"center"}}>{key}</div>
              {cs.map(c=>{const it=c.screening?.t0?.items?.find(i=>i.requirement===key);return <CmpScore key={c.id} it={it}/>;} )}
            </div>
          ))}
        </CmpSec>}
        {/* T1 */}
        {allT1.length>0&&<CmpSec T={T} label="T1 核心评分">
          {allT1.map(key=>(
            <div key={key} style={{display:"grid",gridTemplateColumns:`140px repeat(${cs.length},1fr)`,gap:12,padding:"8px 0",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:12,color:T.text3,alignSelf:"center"}}>{key}</div>
              {cs.map(c=>{const it=c.screening?.t1?.items?.find(i=>i.dimension===key);return <CmpScore key={c.id} it={it}/>;} )}
            </div>
          ))}
        </CmpSec>}
        {/* 总监评语 */}
        <CmpSec T={T} label="总监评语">
          <div style={{display:"grid",gridTemplateColumns:`140px repeat(${cs.length},1fr)`,gap:12}}>
            <div style={{fontSize:12,color:T.text3}}>我的判断</div>
            {cs.map(c=><div key={c.id} style={{fontSize:12,color:T.text2}}>{c.directorVerdict?.reason||<span style={{color:T.text4,fontStyle:"italic"}}>暂无</span>}</div>)}
          </div>
        </CmpSec>
      </div>
    </div>
  );
}
const CmpSec=({T,label,children})=>(
  <div style={{marginBottom:18}}>
    <div style={{fontSize:11,fontWeight:800,color:T.text4,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:10}}>{label}</div>
    {children}
  </div>
);
const CmpScore=({it})=>{
  if(!it) return <div style={{fontSize:12,color:"#d1d5db",textAlign:"center"}}>—</div>;
  const pct=(it.score/(it.maxScore||5))*100;
  const c=scColor(it.score,it.maxScore||5);
  return(<div style={{textAlign:"center"}}><div style={{fontSize:16,fontWeight:800,color:c}}>{it.score}<span style={{fontSize:11,color:"#9ca3af"}}>/{it.maxScore||5}</span></div><div style={{height:3,background:"#e5e7eb",borderRadius:2,margin:"4px 8px 0"}}><div style={{width:`${pct}%`,height:"100%",background:c,borderRadius:2}}/></div></div>);
};

// ─── DASHBOARD ───────────────────────────────────────────────
function DashboardView({T,jobs,cands,dirStats,onJobClick,onCandClick,setCands,cfg,recordTokens,dirCtx}) {
  const stats=[
    {label:"简历通过",val:cands.filter(c=>c.status==="screening").length,color:"#2563eb"},
    {label:"观察中",  val:cands.filter(c=>c.status==="watching").length, color:"#d97706"},
    {label:"进入面试",val:cands.filter(c=>c.status==="interview").length,color:"#7c3aed"},
    {label:"已录用",  val:cands.filter(c=>c.status==="offer").length,    color:"#059669"},
    {label:"未通过",  val:cands.filter(c=>c.status==="rejected").length, color:"#dc2626"},
  ];
  const total=cands.length;
  const rankedCands=[...cands].sort((a,b)=>(b.screening?.overallScore??-1)-(a.screening?.overallScore??-1));
  const addImportedCandidates=created=>{
    if(!created?.length) return;
    setCands(prev=>[...created,...prev]);
  };

  return(<Page T={T} title="仪表盘" sub="快手项目组 · 招聘总览">
    {/* 板块1：数据看板 */}
    <SecLabel T={T}>数据看板</SecLabel>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:12,marginBottom:14}}>
      {stats.map(s=>(
        <div key={s.label} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"18px 18px 16px",borderTop:`3px solid ${s.color}`,boxShadow:SOFT_SHADOW}}>
          <div style={{fontSize:30,fontWeight:900,color:s.color,lineHeight:1}}>{s.val}</div>
          <div style={{fontSize:12,color:T.text3,marginTop:5}}>{s.label}</div>
        </div>
      ))}
    </div>
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"14px 18px",marginBottom:24,boxShadow:SOFT_SHADOW}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
        <span style={{fontSize:12,color:T.text3}}>总候选人 {total} 人</span>
        <div style={{display:"flex",gap:16}}>
          {dirStats.total>0&&<span style={{fontSize:12,color:T.text3}}>总监沉淀 {dirStats.total} 案例 · AI匹配率 <strong style={{color:dirStats.rate>=70?"#16a34a":"#ca8a04"}}>{dirStats.rate}%</strong></span>}
          <span style={{fontSize:12,fontWeight:700,color:T.accent}}>通过率 {total>0?Math.round(cands.filter(c=>["screening","interview","offer"].includes(c.status)).length/total*100):0}%</span>
        </div>
      </div>
      <div style={{height:6,background:T.border,borderRadius:3,display:"flex",overflow:"hidden"}}>
        {[["screening","#2563eb"],["watching","#d97706"],["interview","#7c3aed"],["offer","#059669"],["rejected","#dc2626"]].map(([s,c])=>{
          const v=cands.filter(x=>x.status===s).length;
          return total>0&&v>0?<div key={s} style={{width:`${v/total*100}%`,background:c}}/>:null;
        })}
      </div>
    </div>

    {/* 板块2：在招岗位 */}
    <SecLabel T={T}>在招岗位 ({jobs.length})</SecLabel>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:12,marginBottom:24}}>
      {jobs.length===0?<div style={{gridColumn:"1 / -1"}}><Empty T={T} icon="◈" title="暂无在招岗位" sub="先去岗位管理新建岗位，再开始批量上传简历。"/></div>
      :jobs.map(job=>{
        const jobCands=cands.filter(c=>c.jobId===job.id);
        const qualified=jobCands.filter(c=>getScoreBand(c.screening?.overallScore).label==="合格").length;
        const pending=jobCands.filter(c=>getScoreBand(c.screening?.overallScore).label==="待定").length;
        const rejected=jobCands.filter(c=>getScoreBand(c.screening?.overallScore).label==="淘汰").length;
        return(<div key={job.id} onClick={()=>onJobClick(job.id)} className="hr" style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"18px 18px 16px",cursor:"pointer",boxShadow:SOFT_SHADOW,transition:"transform 0.16s ease, box-shadow 0.16s ease"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:12}}>
            <div>
              <div style={{fontSize:15,fontWeight:800,color:T.text}}>{job.title}</div>
              <div style={{fontSize:11,color:T.text4,marginTop:3}}>{[job.department,job.level,job.salary].filter(Boolean).join(" · ")||"待补充岗位信息"}</div>
            </div>
            <span style={{fontSize:11,fontWeight:700,padding:"4px 8px",background:T.card2,borderRadius:20,color:T.text3,whiteSpace:"nowrap"}}>{jobCands.length} 份简历</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
            {[{label:"合格",count:qualified,color:"#059669",bg:"#ecfdf5"},{label:"待定",count:pending,color:"#d97706",bg:"#fffbeb"},{label:"淘汰",count:rejected,color:"#dc2626",bg:"#fef2f2"}].map(item=>(
              <div key={item.label} style={{padding:"10px 8px",background:item.bg,borderRadius:9,textAlign:"center"}}>
                <div style={{fontSize:20,fontWeight:900,color:item.color,lineHeight:1}}>{item.count}</div>
                <div style={{fontSize:11,color:item.color,marginTop:4,fontWeight:700}}>{item.label}</div>
              </div>
            ))}
          </div>
        </div>);
      })}
    </div>

    {/* 板块3：评分标准 */}
    <SecLabel T={T}>评分标准</SecLabel>
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"22px 22px 18px",marginBottom:16,boxShadow:SOFT_SHADOW}}>
      <div style={{fontSize:14,fontWeight:800,color:T.text,marginBottom:6}}>评分拆解（通用版）</div>
      <div style={{fontSize:12,color:T.text4,lineHeight:1.8,marginBottom:16}}>先看 T0 / T1 / T2 具体考察什么。T0 现在代表“是否具备进入评估池的最低岗位匹配”，再用下面的总分档位判断候选人是合格、待定还是淘汰。</div>

      <div style={{marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:800,color:T.text4,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>T0 硬性条件</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10}}>
          {DASHBOARD_SCORE_GUIDE.t0.map(item=>{
            const tone=item.level==="高"?{c:"#b91c1c",bg:"#fee2e2"}:item.level==="中"?{c:"#92400e",bg:"#fef3c7"}:{c:"#374151",bg:"#f3f4f6"};
            return(<div key={item.label} style={{padding:"12px 12px 11px",background:tone.bg,borderRadius:12,border:`1px solid ${T.border}`}}>
              <div style={{fontSize:12,fontWeight:700,color:T.text,lineHeight:1.5}}>{item.label}</div>
              <div style={{fontSize:10,fontWeight:700,color:tone.c,marginTop:4}}>重要度：{item.level}</div>
            </div>);
          })}
        </div>
      </div>

      <div style={{marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:800,color:T.text4,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>T1 核心评分维度</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10}}>
          {DASHBOARD_SCORE_GUIDE.t1.map(item=>(
            <div key={item.label} style={{padding:"12px 12px 11px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:10}}>
              <div style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:13,fontWeight:800,color:T.text}}>{item.label}</div>
                <span style={{fontSize:12,fontWeight:800,color:T.accent}}>{item.weight}</span>
              </div>
              <div style={{fontSize:11,color:T.text3,lineHeight:1.7}}>{item.note}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div style={{fontSize:11,fontWeight:800,color:T.text4,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8}}>T2 加分项</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {DASHBOARD_SCORE_GUIDE.t2.map(item=><Chip key={item} c="#0f766e" bg="#ccfbf1">{item}</Chip>)}
        </div>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:12,marginBottom:24}}>
      {[
        {label:"合格",range:"4.5 - 5.0",desc:"建议直接进入下一轮，优先安排面试。",color:"#059669",bg:"#ecfdf5"},
        {label:"待定",range:"3.0 - 4.4",desc:"保留在观察池，建议补充验证或二次筛选。",color:"#d97706",bg:"#fffbeb"},
        {label:"淘汰",range:"0 - 2.9",desc:"与岗位要求偏差较大，建议结束当前流程。",color:"#dc2626",bg:"#fef2f2"},
      ].map(item=>(
        <div key={item.label} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"18px 18px 16px",boxShadow:SOFT_SHADOW}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <Chip c={item.color} bg={item.bg} lg>{item.label}</Chip>
            <div style={{fontSize:20,fontWeight:900,color:item.color}}>{item.range}</div>
          </div>
          <div style={{fontSize:12,color:T.text3,lineHeight:1.8}}>{item.desc}</div>
        </div>
      ))}
    </div>

    {/* 板块4：简历上传 */}
    <SecLabel T={T}>简历上传</SecLabel>
    <DashboardResumeUploader T={T} jobs={jobs} cfg={cfg} recordTokens={recordTokens} dirCtx={dirCtx} onBatchCreated={addImportedCandidates}/>

    {/* 板块5：候选人列表 */}
    <SecLabel T={T}>候选人列表 ({cands.length})</SecLabel>
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,overflow:"hidden",boxShadow:SOFT_SHADOW}}>
      {rankedCands.length===0?<div style={{padding:"44px 20px",textAlign:"center",color:T.text4,fontSize:13}}>上传简历后，这里会按 AI 首轮匹配度展示候选人。</div>
      :<>
        <div style={{display:"grid",gridTemplateColumns:"1.7fr 1.3fr 0.85fr 0.9fr 0.95fr",padding:"8px 16px",borderBottom:`1px solid ${T.border}`,fontSize:11,fontWeight:700,color:T.text4}}>
          <span>候选人</span>
          <span>在招岗位</span>
          <span style={{textAlign:"center"}}>AI 匹配分</span>
          <span style={{textAlign:"center"}}>首轮判定</span>
          <span style={{textAlign:"center"}}>AI 建议</span>
        </div>
        <div style={{maxHeight:420,overflowY:"auto"}}>
          {rankedCands.map(c=>{
            const job=jobs.find(j=>j.id===c.jobId);
            const band=getScoreBand(c.screening?.overallScore);
            return(<div key={c.id} onClick={()=>onCandClick(c.id,c.jobId)} className="hr" style={{display:"grid",gridTemplateColumns:"1.7fr 1.3fr 0.85fr 0.9fr 0.95fr",padding:"12px 16px",borderBottom:`1px solid ${T.border}`,cursor:"pointer",alignItems:"center",gap:10}}>
              <div style={{display:"flex",gap:9,alignItems:"center",minWidth:0}}>
                <Av name={c.name} T={T} size={30}/>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:700,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name||"未命名"}</div>
                  <div style={{fontSize:11,color:T.text4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.resumeFileName||"手动录入"}</div>
                </div>
              </div>
              <div style={{fontSize:12,color:T.text3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{job?.title||"未绑定岗位"}</div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:24,fontWeight:900,color:Number.isFinite(Number(c.screening?.overallScore))?scColor(c.screening?.overallScore):T.text4,lineHeight:1}}>{Number.isFinite(Number(c.screening?.overallScore))?Number(c.screening.overallScore).toFixed(1):"—"}</div>
                <div style={{fontSize:10,color:T.text4,marginTop:4}}>/ 5.0</div>
              </div>
              <div style={{textAlign:"center"}}><Chip c={band.color} bg={band.bg} lg>{band.label}</Chip></div>
              <div style={{textAlign:"center"}}>
                {c.screening?.recommendation?<Chip c={recSt(c.screening.recommendation).c} bg={recSt(c.screening.recommendation).bg}>{c.screening.recommendation.replace("建议","")}</Chip>
                :<span style={{fontSize:12,color:T.text4}}>未筛选</span>}
              </div>
            </div>);
          })}
        </div>
      </>}
    </div>
  </Page>);
}

function DashboardResumeUploader({T,jobs,cfg,recordTokens,dirCtx,onBatchCreated}) {
  const [files,setFiles]=useState([]);
  const [drag,setDrag]=useState(false);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const [info,setInfo]=useState("");

  const fileKey=file=>`${file.name}-${file.size}-${file.lastModified}`;
  const queueFiles=inputFiles=>{
    const picked=Array.from(inputFiles||[]).filter(Boolean);
    if(!picked.length) return;
    const accepted=[];
    const rejected=[];
    picked.forEach(file=>{
      if(getFileKind(file)==="unknown") rejected.push(file.name);
      else accepted.push(file);
    });
    setFiles(prev=>{
      const existing=new Set(prev.map(fileKey));
      const next=[...prev];
      accepted.forEach(file=>{
        const key=fileKey(file);
        if(!existing.has(key)){existing.add(key);next.push(file);}
      });
      return next;
    });
    setInfo("");
    setErr(rejected.length?`以下文件格式暂不支持：${rejected.join("、")}`:"");
  };

  const removeFile=targetKey=>setFiles(prev=>prev.filter(file=>fileKey(file)!==targetKey));

  const submit=async()=>{
    if(!files.length){setErr("请先拖入或选择至少一份简历");return;}
    setLoading(true);setErr("");setInfo("");
    const created=[];
    const failed=[];
    const failedKeys=new Set();
    for(const file of files){
      try{
        const { candidate }=await createCandidateFromResumeFile({cfg,job:null,file,onTokens:recordTokens,dirCtx,jobs});
        created.push(candidate);
      }catch(error){
        failed.push(`${file.name}：${error?.message||"识别失败"}`);
        failedKeys.add(fileKey(file));
      }
    }
    if(created.length){
      onBatchCreated(created);
      const summary=created.reduce((acc,candidate)=>{
        const label=getScoreBand(candidate.screening?.overallScore).label;
        if(label==="合格") acc.pass+=1;
        else if(label==="待定") acc.pending+=1;
        else if(label==="淘汰") acc.reject+=1;
        return acc;
      },{pass:0,pending:0,reject:0});
      setInfo(`已导入 ${created.length} 份简历：合格 ${summary.pass} 份，待定 ${summary.pending} 份，淘汰 ${summary.reject} 份。`);
    }
    setFiles(prev=>prev.filter(file=>failedKeys.has(fileKey(file))));
    if(failed.length) setErr(failed.slice(0,3).join("；"));
    setLoading(false);
  };

  return(
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:14,padding:"20px 20px 18px",marginBottom:22}}>
      <>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,marginBottom:14,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:18,fontWeight:800,color:T.text}}>一键上传简历并完成 AI 首轮分析</div>
            <div style={{fontSize:12,color:T.text4,marginTop:5,lineHeight:1.8}}>直接把 PDF、图片、Word 或纯文本简历拖进来。系统会先智能识别并完成通用规整与首轮评分，岗位归属如果判断不准，后续再去岗位管理里修改。</div>
          </div>
        </div>

        <div style={{padding:"10px 12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:10,fontSize:12,color:T.text3,lineHeight:1.8,marginBottom:14}}>上传时不需要先选岗位。系统会先按通用标准完成规整和首轮评分，后续如果岗位识别不准确，再去岗位管理里修正即可。</div>

        <div
          onDragOver={e=>{e.preventDefault();setDrag(true);}}
          onDragLeave={()=>setDrag(false)}
          onDrop={e=>{e.preventDefault();setDrag(false);queueFiles(e.dataTransfer.files);}}
          onClick={()=>!loading&&document.getElementById("dashboard-resume-upload-input")?.click()}
          style={{border:`2px dashed ${drag?T.accent:T.border2}`,borderRadius:16,minHeight:220,padding:"26px 24px",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center",background:drag?`${T.accent}10`:T.card2,cursor:loading?"default":"pointer",transition:"all 0.15s"}}>
          <input id="dashboard-resume-upload-input" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.md" multiple style={{display:"none"}} onChange={e=>{queueFiles(e.target.files);e.target.value="";}}/>
          {loading
            ?<div>
              <Spin text="正在识别简历并生成首轮评分..." />
              <div style={{fontSize:12,color:T.text4,marginTop:8}}>会先抽取文字，再按通用标准完成自动规整与首轮初筛</div>
            </div>
            :<>
              <div style={{fontSize:36,lineHeight:1,marginBottom:12}}>⇪</div>
              <div style={{fontSize:19,fontWeight:800,color:T.text}}>把简历拖到这里，或点击选择文件</div>
              <div style={{fontSize:12,color:T.text4,marginTop:8,lineHeight:1.8}}>支持多份同时导入。当前会直接做通用初筛，后续可在岗位管理里再修正岗位归属。</div>
            </>}
        </div>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginTop:14,flexWrap:"wrap"}}>
          <div style={{fontSize:12,color:T.text3,lineHeight:1.8}}>
            {files.length?`已加入 ${files.length} 份待处理简历，可继续拖入补充。`:"还没有加入简历文件。"}
          </div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
            {files.length>0&&<button onClick={()=>setFiles([])} style={{padding:"9px 14px",border:`1px solid ${T.border2}`,background:T.surface,color:T.text3,borderRadius:8,fontSize:12,fontWeight:700,cursor:loading?"not-allowed":"pointer",opacity:loading?0.5:1}}>清空列表</button>}
            <button onClick={submit} disabled={loading||!files.length} style={{padding:"10px 16px",background:T.accent,color:T.accentFg,border:"none",borderRadius:9,fontSize:13,fontWeight:800,cursor:loading||!files.length?"not-allowed":"pointer",opacity:loading||!files.length?0.55:1}}>
              {loading?"正在批量分析...":"开始识别并导入"}
            </button>
          </div>
        </div>

        {files.length>0&&<div style={{marginTop:14,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10}}>
          {files.map(file=>{
            const key=fileKey(file);
            return(<div key={key} style={{padding:"10px 12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:10,display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
              <div style={{minWidth:0}}>
                <div style={{fontSize:12,fontWeight:700,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{file.name}</div>
                <div style={{fontSize:11,color:T.text4,marginTop:3}}>{(file.size/1024/1024).toFixed(2)} MB</div>
              </div>
              <button onClick={e=>{e.stopPropagation();removeFile(key);}} style={{border:"none",background:"transparent",color:T.text4,cursor:"pointer",fontSize:16,lineHeight:1}}>✕</button>
            </div>);
          })}
        </div>}
        {info&&<div style={{marginTop:14,padding:"10px 12px",background:"#ecfdf5",border:"1px solid #bbf7d0",borderRadius:9,fontSize:12,color:"#166534",lineHeight:1.7}}>{info}</div>}
        {err&&<div style={{marginTop:14}}><ErrBox>{err}</ErrBox></div>}
      </>
    </div>
  );
}
const FunnelBar=({label,rate,highlight})=>(
  <div style={{textAlign:"center"}}>
    <div style={{fontSize:14,fontWeight:700,color:highlight?"#059669":rate>=50?"#16a34a":rate>=25?"#ca8a04":"#dc2626"}}>{rate}%</div>
    <div style={{height:4,background:"#f3f4f6",borderRadius:2,margin:"5px 8px"}}><div style={{width:`${rate}%`,height:"100%",background:highlight?"#059669":rate>=50?"#16a34a":rate>=25?"#ca8a04":"#dc2626",borderRadius:2,transition:"width 0.5s"}}/></div>
    <div style={{fontSize:11,color:"#9ca3af"}}>{label}</div>
  </div>
);

// ─── JOBS VIEW ───────────────────────────────────────────────
function JobsView({T,jobs,setJobs,cands,setCands,selJob,setSelJob,onCandClick,jobComposer,setJobComposer,resetJobComposer,applyParsedJobToComposer,startJobFileParse}) {
  const [jdDrag,setJdDrag]=useState(false);
  const [interviewRulesDraft,setInterviewRulesDraft]=useState("");
  const [rulesSaved,setRulesSaved]=useState(false);
  const { open, form, jdFileName, jdLoading, jdErr, parsedJobs, activeParsedJob } = jobComposer;
  const ff=k=>e=>setJobComposer(prev=>({...prev,form:{...prev.form,[k]:e.target.value}}));

  const resetCreateForm=()=>{
    setJdDrag(false);
    resetJobComposer();
  };

  const onJdDrop=e=>{e.preventDefault();setJdDrag(false);const f=e.dataTransfer.files?.[0];if(f)startJobFileParse(f);};
  const saveJob=()=>{
    if(!form.title||!form.requirements)return;
    const j={...form,interviewRules:"",id:Date.now()};
    setJobs(p=>[...p,j]);setSelJob(j.id);
    resetCreateForm();
  };
  const delJob=id=>{if(window.confirm("确认删除该岗位及所有候选人？")){setJobs(p=>p.filter(j=>j.id!==id));setCands(p=>p.filter(c=>c.jobId!==id));if(selJob===id)setSelJob(null);}};
  const job=jobs.find(j=>j.id===selJob);
  const jobCands=cands.filter(c=>c.jobId===selJob);
  useEffect(()=>{
    setInterviewRulesDraft(job?.interviewRules || "");
    setRulesSaved(false);
  },[job?.id, job?.interviewRules]);
  const importParsedJobs=()=>{
    if(!parsedJobs.length) return;
    const created=parsedJobs.map(job=>({...job,id:Date.now()+Math.floor(Math.random()*1000000),interviewRules:job.interviewRules||""}));
    setJobs(p=>[...p,...created]);
    setSelJob(created[0]?.id||null);
    resetCreateForm();
  };
  const addCand=()=>{
    const id=Date.now();
    setCands(p=>[...p,{id,jobId:selJob,name:"",status:"pending",resume:"",screening:null,questions:null,interviews:[],scheduledAt:null,interviewRound:null,directorVerdict:null}]);
    onCandClick(id,selJob);
  };
  const saveInterviewRules=()=>{
    if(!job) return;
    setJobs(prev=>prev.map(item=>item.id===job.id?{...item,interviewRules:interviewRulesDraft.trim()}:item));
    setRulesSaved(true);
    setTimeout(()=>setRulesSaved(false),1500);
  };
  return(<Page T={T} title="岗位管理" sub="创建和管理在招职位">
    <div style={{display:"grid",gridTemplateColumns:"260px 1fr",gap:20}}>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
        <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:13,fontWeight:700,color:T.text}}>岗位列表</span>
          <button onClick={()=>{if(open)resetCreateForm();else setJobComposer(prev=>({...prev,open:true}));}} style={{padding:"4px 10px",background:T.accent,color:T.accentFg,border:"none",borderRadius:6,fontSize:12,fontWeight:600,cursor:"pointer"}}>+ 新建</button>
        </div>
        {open&&(<div style={{padding:14,borderBottom:`1px solid ${T.border}`,background:T.card2}}>
          {jdLoading&&<div style={{marginBottom:12,padding:"10px 12px",background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:10,fontSize:12,color:"#1d4ed8",lineHeight:1.8}}>JD 正在后台识别中。你现在切换到其他页面也不会中断，回来后结果会自动保留在这里。</div>}
          <div style={{marginBottom:12,padding:"12px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
              <label style={{...lbSt(T),marginBottom:0}}>上传岗位 JD（AI 自动填表）</label>
              <button onClick={()=>!jdLoading&&document.getElementById("job-jd-file-input")?.click()}
                style={{padding:"7px 12px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,cursor:jdLoading?"not-allowed":"pointer",fontSize:12,fontWeight:700,opacity:jdLoading?0.5:1}}>
                上传岗位JD
              </button>
            </div>
            <div
              onDragOver={e=>{e.preventDefault();setJdDrag(true);}}
              onDragLeave={()=>setJdDrag(false)}
              onDrop={onJdDrop}
              onClick={()=>!jdLoading&&document.getElementById("job-jd-file-input")?.click()}
              style={{border:`2px dashed ${jdDrag?T.accent:T.border2}`,borderRadius:10,padding:"16px 14px",textAlign:"center",cursor:jdLoading?"default":"pointer",background:jdDrag?`${T.accent}10`:T.inputBg,transition:"all 0.15s"}}>
              <input id="job-jd-file-input" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.md" style={{display:"none"}}
                onChange={e=>{const f=e.target.files?.[0];if(f)startJobFileParse(f);e.target.value="";}}/>
              {jdLoading
                ?<div><Spin text="AI 正在识别 JD..." /><div style={{fontSize:11,color:T.text4,marginTop:6}}>识别完成后会自动填入下面的岗位表单</div></div>
                :jdFileName
                  ?<div><div style={{fontSize:13,fontWeight:700,color:"#16a34a"}}>已识别：{jdFileName}</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>字段已自动回填，你仍然可以手动修改</div></div>
                  :<div><div style={{fontSize:13,fontWeight:700,color:T.text}}>拖入 JD 文件，或点击上传</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>支持 PDF、图片、Word(.docx) 和纯文本 JD</div></div>
              }
            </div>
            {jdErr&&<div style={{fontSize:11,color:"#dc2626",marginTop:8}}>{jdErr}</div>}
            {!jdErr&&jdFileName&&!jdLoading&&<div style={{fontSize:11,color:T.text4,marginTop:8}}>文件会先提取成文字，再交给当前模型做多岗位结构化解析与规整。</div>}
          </div>
          {parsedJobs.length>0&&<div style={{marginBottom:12,padding:"12px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:10}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
              <div>
                <div style={{fontSize:13,fontWeight:800,color:T.text}}>已识别 {parsedJobs.length} 个岗位</div>
                <div style={{fontSize:11,color:T.text4,marginTop:3}}>先看规整结果，再选择填入当前表单或批量导入</div>
              </div>
              {parsedJobs.length>1&&<button onClick={importParsedJobs}
                style={{padding:"7px 12px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700}}>
                批量导入 {parsedJobs.length} 个岗位
              </button>}
            </div>
            <div style={{display:"grid",gap:9}}>
              {parsedJobs.map((job,index)=>(
                <div key={`${job.title}-${index}`} style={{padding:"10px 12px",background:index===activeParsedJob?`${T.accent}10`:T.card2,border:`1px solid ${index===activeParsedJob?T.accent:T.border}`,borderRadius:9}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
                    <div style={{minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:800,color:T.text}}>{job.title}</div>
                      <div style={{fontSize:11,color:T.text4,marginTop:3}}>{[job.department,job.level,job.salary].filter(Boolean).join(" · ")||"未补全字段"}</div>
                    </div>
                    <button onClick={()=>{setJobComposer(prev=>({...prev,activeParsedJob:index}));applyParsedJobToComposer(job);}}
                      style={{padding:"5px 10px",background:index===activeParsedJob?T.accent:"transparent",color:index===activeParsedJob?T.accentFg:T.text3,border:`1px solid ${index===activeParsedJob?T.accent:T.border2}`,borderRadius:7,cursor:"pointer",fontSize:12,flexShrink:0}}>
                      {index===activeParsedJob?"当前填入":"填入表单"}
                    </button>
                  </div>
                  {job.summary&&<div style={{fontSize:12,color:T.text3,marginTop:8,lineHeight:1.6}}>{job.summary}</div>}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>
                    <Chip c={T.text3} bg={T.navActive}>要求 {job.requirementsList.length} 条</Chip>
                    <Chip c="#92400e" bg="#fef3c7">T0 {job.t0?job.t0.split("\n").filter(Boolean).length:0} 条</Chip>
                    <Chip c="#1d4ed8" bg="#dbeafe">T1 {job.t1?job.t1.split("\n").filter(Boolean).length:0} 条</Chip>
                  </div>
                  {job.requirementsList.length>0&&<div style={{marginTop:8,fontSize:11,color:T.text4,lineHeight:1.7}}>
                    {job.requirementsList.slice(0,4).map((item,i)=><div key={i}>• {item}</div>)}
                    {job.requirementsList.length>4&&<div>… 还有 {job.requirementsList.length-4} 条</div>}
                  </div>}
                </div>
              ))}
            </div>
          </div>}
          {[["职位名称 *","title","短视频剪辑师"],["所属部门","department","AI MCN"],["级别","level","mid"],["薪酬","salary","15-25K"]].map(([l,k,ph])=>(
            <Inp key={k} T={T} label={l} placeholder={ph} value={form[k]} onChange={ff(k)}/>
          ))}
          <div style={{marginBottom:9}}><label style={lbSt(T)}>岗位要求 *</label><textarea rows={3} style={{...inSt(T),resize:"vertical",lineHeight:1.6}} placeholder="岗位职责与任职要求..." value={form.requirements} onChange={ff("requirements")}/></div>
          <div style={{marginBottom:9}}><label style={lbSt(T)}>T0 硬性条件（每行一条）</label><textarea rows={2} style={{...inSt(T),resize:"vertical"}} placeholder={"2年以上经验\n熟练使用剪映"} value={form.t0} onChange={ff("t0")}/></div>
          <div style={{marginBottom:12}}><label style={lbSt(T)}>T1 核心维度（每行一条）</label><textarea rows={2} style={{...inSt(T),resize:"vertical"}} placeholder={"目标导向\n团队协作\n自驱力"} value={form.t1} onChange={ff("t1")}/></div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={resetCreateForm} style={{flex:1,padding:"8px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:7,color:T.text3,cursor:"pointer",fontSize:12}}>取消</button>
            <button onClick={saveJob} style={{flex:2,padding:"8px",background:T.accent,color:T.accentFg,border:"none",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700,opacity:form.title&&form.requirements&&!jdLoading?1:0.4}} disabled={!form.title||!form.requirements||jdLoading}>保存</button>
          </div>
        </div>)}
        <div style={{overflowY:"auto",maxHeight:"calc(100vh - 220px)"}}>
          {jobs.length===0?<div style={{padding:"32px 16px",textAlign:"center",color:T.text4,fontSize:13}}>暂无岗位</div>
          :jobs.map(j=>(
            <div key={j.id} onClick={()=>setSelJob(j.id)} className="hr"
              style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,cursor:"pointer",background:selJob===j.id?T.navActive:"transparent",borderLeft:selJob===j.id?`3px solid ${T.accent}`:"3px solid transparent"}}>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <div style={{fontSize:13,fontWeight:600,color:T.text}}>{j.title}</div>
                <button onClick={e=>{e.stopPropagation();delJob(j.id);}} style={{border:"none",background:"transparent",color:T.text4,cursor:"pointer",fontSize:12}}>✕</button>
              </div>
              <div style={{fontSize:11,color:T.text4,marginTop:2}}>{j.department||"未指定"}{j.level?` · ${j.level}`:""}</div>
              <div style={{fontSize:11,color:T.text3,marginTop:3}}>{cands.filter(c=>c.jobId===j.id).length} 位候选人</div>
            </div>
          ))}
        </div>
      </div>
      {job?(<div>
        <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 22px",marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
            <div><h2 style={{fontSize:20,fontWeight:800,color:T.text,margin:0}}>{job.title}</h2><div style={{fontSize:13,color:T.text3,marginTop:3}}>{[job.department,job.level,job.salary].filter(Boolean).join(" · ")}</div></div>
            <button onClick={addCand} style={{padding:"9px 18px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,fontSize:13,fontWeight:700,cursor:"pointer"}}>+ 添加候选人</button>
          </div>
          {job.requirements&&<div style={{fontSize:13,color:T.text2,lineHeight:1.7,padding:"10px 14px",background:T.card2,borderRadius:8}}>{job.requirements}</div>}
        </div>
        <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 22px",marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:10,flexWrap:"wrap"}}>
            <div>
              <div style={{fontSize:14,fontWeight:800,color:T.text}}>岗位级面试准则模板</div>
              <div style={{fontSize:12,color:T.text4,marginTop:4,lineHeight:1.7}}>这里写的内容会直接并入“生成面试题”的 prompt。不同岗位可以维护不同的面试策略。</div>
            </div>
            {rulesSaved&&<Chip c="#059669" bg="#ecfdf5">已保存</Chip>}
          </div>
          <textarea
            rows={10}
            value={interviewRulesDraft}
            onChange={e=>setInterviewRulesDraft(e.target.value)}
            style={{...inSt(T),resize:"vertical",lineHeight:1.7,marginBottom:12}}
            placeholder={INTERVIEW_RULES_PROMPT}
          />
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div style={{fontSize:12,color:T.text4,lineHeight:1.7}}>留空时自动使用系统默认准则；填了以后，这个岗位会优先用你自定义的版本。</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <button onClick={()=>setInterviewRulesDraft(INTERVIEW_RULES_PROMPT)} style={{padding:"8px 12px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:8,color:T.text3,cursor:"pointer",fontSize:12,fontWeight:700}}>套用默认准则</button>
              <button onClick={saveInterviewRules} style={{padding:"8px 14px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700}}>保存到当前岗位</button>
            </div>
          </div>
        </div>
        <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 22px"}}>
          <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:14}}>候选人 ({jobCands.length})</div>
          {jobCands.length===0?<div style={{textAlign:"center",padding:"28px",color:T.text4,fontSize:13}}>暂无候选人，点击右上角添加</div>
          :<>
            <div style={{display:"grid",gridTemplateColumns:"2fr 3fr 1fr 1fr 1fr",gap:8,padding:"6px 0",borderBottom:`2px solid ${T.border}`,fontSize:11,fontWeight:700,color:T.text4,marginBottom:4}}>
              <span>姓名</span><span>AI结论</span><span style={{textAlign:"center"}}>评分</span><span style={{textAlign:"center"}}>状态</span><span style={{textAlign:"center"}}>面试时间</span>
            </div>
            {jobCands.map(c=>{
              const scr=c.screening;
              return(<div key={c.id} onClick={()=>onCandClick(c.id,c.jobId)} className="hr"
                style={{display:"grid",gridTemplateColumns:"2fr 3fr 1fr 1fr 1fr",gap:8,padding:"10px 0",borderBottom:`1px solid ${T.border}`,cursor:"pointer",alignItems:"center"}}>
                <div style={{display:"flex",gap:7,alignItems:"center"}}><Av name={c.name} T={T} size={26}/><span style={{fontSize:13,fontWeight:600,color:T.text}}>{c.name||<span style={{color:T.text4}}>未命名</span>}</span></div>
                <span style={{fontSize:12,color:T.text3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{scr?.summary?scr.summary.slice(0,35)+"…":<span style={{color:T.border2}}>未筛选</span>}</span>
                <span style={{textAlign:"center",fontWeight:700,color:scr?scColor(scr.overallScore):T.text4}}>{scr?scr.overallScore?.toFixed(1):"—"}</span>
                <span style={{textAlign:"center"}}><SBadge status={c.status}/></span>
                <span style={{textAlign:"center",fontSize:11,color:c.scheduledAt?"#7c3aed":T.text4}}>{c.scheduledAt?fmtDate(c.scheduledAt):"—"}</span>
              </div>);
            })}
          </>}
        </div>
      </div>):<Empty T={T} icon="◈" title="选择一个岗位" sub="从左侧列表选择岗位查看详情"/>}
    </div>
  </Page>);
}

// ─── CANDIDATES VIEW ─────────────────────────────────────────
function CandidatesView({T,cands,setCands,jobs,selCand,setSelCand,tab,setTab,cfg,updCand,recordTokens,dirCtx,compared,toggleCompare,questionTasks,interviewTasks,startQuestionGeneration,startInterviewAssessment,removeCandidate}) {
  const cand=cands.find(c=>c.id===selCand);
  const job=getEffectiveCandidateJob(jobs,cand);
  const [showImport,setShowImport]=useState(false);
  const deleteCandidate=candidate=>{
    if(!candidate) return;
    const ok=window.confirm(`确认删除候选人「${candidate.name||"未命名候选人"}」吗？\n\n这会同时删除该简历的筛选结果、面试记录、总监判断和相关反馈，并同步到云端。`);
    if(!ok) return;
    removeCandidate?.(candidate.id);
  };
  const onCreated=candidate=>{
    setCands(prev=>[candidate,...prev]);
    setSelCand(candidate.id);
    setTab("screening");
    setShowImport(false);
  };
  return(<Page T={T} title="候选人" sub="管理所有候选人及评估进度">
    {showImport&&<ResumeImportModal T={T} jobs={jobs} cfg={cfg} recordTokens={recordTokens} dirCtx={dirCtx} onClose={()=>setShowImport(false)} onCreated={onCreated}/>}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:16,flexWrap:"wrap"}}>
      <div style={{fontSize:12,color:T.text3,lineHeight:1.7}}>在候选人库里直接上传简历，系统会自动识别文字、规整简历，并按所选岗位完成初筛。</div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        {cand&&<button onClick={()=>deleteCandidate(cand)} style={{padding:"9px 16px",background:"#fff5f5",color:"#dc2626",border:"1px solid #fecaca",borderRadius:8,fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>删除当前候选人</button>}
        <button onClick={()=>setShowImport(true)} style={{padding:"9px 16px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,fontSize:13,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap"}}>+ 上传简历</button>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"256px 1fr",gap:20}}>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
        <div style={{padding:"11px 14px",borderBottom:`1px solid ${T.border}`,fontSize:13,fontWeight:700,color:T.text}}>全部候选人 ({cands.length})</div>
        <div style={{overflowY:"auto",maxHeight:"calc(100vh - 160px)"}}>
          {cands.length===0?<div style={{padding:"32px 16px",textAlign:"center",color:T.text4,fontSize:13}}>暂无候选人</div>
          :cands.map(c=>{
            const boundJob=jobs.find(j=>j.id===c.jobId);
            const effectiveJob=getEffectiveCandidateJob(jobs,c);
            const isCmp=compared.includes(c.id);
            return(<div key={c.id} style={{padding:"10px 12px",borderBottom:`1px solid ${T.border}`,background:selCand===c.id?T.navActive:"transparent",borderLeft:selCand===c.id?`3px solid ${T.accent}`:"3px solid transparent",cursor:"pointer",transition:"all 0.1s"}} onClick={()=>setSelCand(c.id)}>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <div onClick={e=>{e.stopPropagation();toggleCompare(c.id);}}
                  style={{width:16,height:16,border:`1.5px solid ${isCmp?T.accent:T.border2}`,borderRadius:4,background:isCmp?T.accent:"transparent",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",transition:"all 0.1s"}}>
                  {isCmp&&<span style={{color:T.accentFg,fontSize:10,fontWeight:900}}>✓</span>}
                </div>
                <Av name={c.name} T={T} size={30}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name||"未命名"}</div>
                  <div style={{fontSize:11,color:T.text4,marginTop:1}}>{effectiveJob?.title||c.screening?.roleDirection||"未绑定岗位"}</div>
                  {!boundJob&&effectiveJob&&<div style={{fontSize:10,color:"#2563eb",marginTop:2,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>AI已识别岗位</div>}
                  {!effectiveJob&&c.screening?.matchedJobTitle&&<div style={{fontSize:10,color:"#2563eb",marginTop:2,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>AI建议：{c.screening.matchedJobTitle}</div>}
                  {interviewTasks?.[c.id]?.loading&&<div style={{fontSize:10,color:"#2563eb",marginTop:2,fontWeight:700}}>面试评估后台运行中</div>}
                  {questionTasks?.[c.id]?.loading&&<div style={{fontSize:10,color:"#7c3aed",marginTop:2,fontWeight:700}}>面试题后台生成中</div>}
                </div>
                <div style={{textAlign:"right",flexShrink:0}}>
                  <SBadge status={c.status}/>
                  {c.screening&&<div style={{fontSize:12,fontWeight:700,color:scColor(c.screening.overallScore),marginTop:2}}>{c.screening.overallScore?.toFixed(1)}</div>}
                </div>
              </div>
              {c.scheduledAt&&isSoon(c.scheduledAt)&&<div style={{fontSize:10,color:"#7c3aed",marginTop:5,marginLeft:26}}>📅 {fmtDate(c.scheduledAt)}</div>}
              {c.directorVerdict?.verdict&&<div style={{fontSize:10,marginTop:3,marginLeft:26,fontWeight:700,color:c.directorVerdict.verdict==="录用"?"#059669":c.directorVerdict.verdict==="淘汰"?"#dc2626":"#ca8a04"}}>总监：{c.directorVerdict.verdict}</div>}
            </div>);
          })}
        </div>
      </div>
      {cand?<CandDetail T={T} cand={cand} job={job} jobs={jobs} tab={tab} setTab={setTab} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} questionTask={questionTasks?.[cand.id]} interviewTask={interviewTasks?.[cand.id]} startQuestionGeneration={startQuestionGeneration} startInterviewAssessment={startInterviewAssessment} onDelete={()=>deleteCandidate(cand)}/>
      :<Empty T={T} icon="◉" title="选择候选人" sub="从左侧选择，或勾选多人后点击「对比」"/>}
    </div>
  </Page>);
}

function ResumeImportModal({T,jobs,cfg,recordTokens,dirCtx,onClose,onCreated}) {
  const [jobId,setJobId]=useState(jobs[0]?.id ? String(jobs[0].id) : "");
  const [name,setName]=useState("");
  const [resumeFile,setResumeFile]=useState(null);
  const [resumeFileName,setResumeFileName]=useState("");
  const [drag,setDrag]=useState(false);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const [info,setInfo]=useState("");
  const selectedJob=jobs.find(j=>String(j.id)===String(jobId));

  const queueResumeFile=file=>{
    if(!file) return;
    if(getFileKind(file)==="unknown"){setErr("仅支持 PDF、图片、Word(.docx) 或纯文本简历文件");return;}
    setResumeFile(file);
    setResumeFileName(file.name);
    setErr("");
    setInfo("");
  };

  const submit=async()=>{
    if(!selectedJob){setErr("请先选择岗位");return;}
    if(!resumeFile){setErr("请先上传简历文件");return;}
    setErr("");setInfo("");setLoading(true);
    try{
      const { candidate, screening }=await createCandidateFromResumeFile({cfg,job:selectedJob,file:resumeFile,onTokens:recordTokens,dirCtx,name});
      setInfo(`已完成识别与初筛：${candidate.name} / ${getScoreBand(screening.overallScore).label}`);
      onCreated(candidate);
    }catch(error){
      setErr(error?.message||"上传简历失败");
    }
    setLoading(false);
  };

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.45)",zIndex:220,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"48px 20px",overflowY:"auto"}} onClick={onClose}>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:16,width:"100%",maxWidth:760,padding:"22px 24px",boxShadow:"0 24px 80px rgba(15,23,42,0.18)"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,marginBottom:18}}>
          <div>
            <div style={{fontSize:20,fontWeight:800,color:T.text}}>上传简历</div>
            <div style={{fontSize:12,color:T.text4,marginTop:4,lineHeight:1.7}}>在候选人库里直接上传 PDF / 图片 / Word 简历，系统会自动识别文字、规整信息，并创建候选人档案。</div>
          </div>
          <button onClick={onClose} style={{border:"none",background:"transparent",fontSize:18,color:T.text4,cursor:"pointer",lineHeight:1}}>✕</button>
        </div>

        {jobs.length===0?<div style={{padding:"18px 16px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:10,fontSize:13,color:T.text3,lineHeight:1.8}}>请先去“岗位管理”创建至少一个岗位，再上传简历。系统需要结合岗位要求做自动筛选。</div>
        :<>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
            <div>
              <label style={lbSt(T)}>投递岗位 *</label>
              <select value={jobId} onChange={e=>setJobId(e.target.value)} style={{...inSt(T)}}>
                {jobs.map(job=><option key={job.id} value={job.id}>{job.title}{job.department?` · ${job.department}`:""}</option>)}
              </select>
            </div>
            <Inp T={T} label="候选人姓名（可选）" placeholder="留空则尝试从简历识别" value={name} onChange={e=>setName(e.target.value)}/>
          </div>

          <div style={{padding:"14px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:12,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:10,flexWrap:"wrap"}}>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:T.text}}>上传简历文件</div>
                <div style={{fontSize:11,color:T.text4,marginTop:3}}>支持 PDF、图片、Word(.docx) 与纯文本简历</div>
              </div>
              <button onClick={()=>!loading&&document.getElementById("candidate-resume-import-input")?.click()} style={{padding:"8px 12px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:loading?"not-allowed":"pointer",opacity:loading?0.5:1}}>选择简历文件</button>
            </div>
            <div
              onDragOver={e=>{e.preventDefault();setDrag(true);}}
              onDragLeave={()=>setDrag(false)}
              onDrop={e=>{e.preventDefault();setDrag(false);queueResumeFile(e.dataTransfer.files?.[0]);}}
              onClick={()=>!loading&&document.getElementById("candidate-resume-import-input")?.click()}
              style={{border:`2px dashed ${drag?T.accent:T.border2}`,borderRadius:12,padding:"20px 16px",textAlign:"center",cursor:loading?"default":"pointer",background:drag?`${T.accent}10`:T.inputBg,transition:"all 0.15s"}}>
              <input id="candidate-resume-import-input" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.md" style={{display:"none"}} onChange={e=>{queueResumeFile(e.target.files?.[0]);e.target.value="";}}/>
              {loading
                ?<div><Spin text="正在识别并创建候选人..." /><div style={{fontSize:11,color:T.text4,marginTop:6}}>会先抽取简历文字，再结合岗位完成自动筛选</div></div>
                :resumeFileName
                  ?<div><div style={{fontSize:13,fontWeight:700,color:"#16a34a"}}>已选择：{resumeFileName}</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>确认后将自动创建候选人并生成初筛结果</div></div>
                  :<div><div style={{fontSize:13,fontWeight:700,color:T.text}}>拖入简历文件，或点击上传</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>适合批量收到简历后，直接在候选人库里录入</div></div>
              }
            </div>
          </div>

          {selectedJob&&<div style={{fontSize:12,color:T.text3,lineHeight:1.8,padding:"10px 12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:8,marginBottom:12}}>
            当前会按岗位 <strong style={{color:T.text}}>{selectedJob.title}</strong> 的要求和学习规则做初筛。
          </div>}
          {err&&<ErrBox>{err}</ErrBox>}
          {info&&<div style={{fontSize:12,color:"#166534",marginBottom:10,padding:"10px 12px",background:"#dcfce7",borderRadius:8}}>{info}</div>}

          <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
            <button onClick={onClose} style={{padding:"8px 14px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:8,color:T.text3,cursor:"pointer",fontSize:12}}>取消</button>
            <button onClick={submit} disabled={loading||!resumeFile||!selectedJob} style={{padding:"9px 16px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,cursor:loading||!resumeFile||!selectedJob?"not-allowed":"pointer",fontSize:12,fontWeight:700,opacity:loading||!resumeFile||!selectedJob?0.45:1}}>
              {loading?"处理中...":"上传并创建候选人"}
            </button>
          </div>
        </>}
      </div>
    </div>
  );
}

// ─── CAND DETAIL ─────────────────────────────────────────────
function CandDetail({T,cand,job,jobs,tab,setTab,cfg,updCand,recordTokens,dirCtx,questionTask,interviewTask,startQuestionGeneration,startInterviewAssessment,onDelete}) {
  const [learning,setLearning]=useState({sampleCount:0,recentSamples:[],rubric:null,questionBank:null});
  const [learningState,setLearningState]=useState({loading:!!job?.id,error:""});
  const aiSuggestedJob=resolveMatchedJob(jobs, cand?.screening || {}, cand?.resume || "");
  const assignJob=jobIdValue=>{
    const nextJob=(jobs||[]).find(item=>String(item.id)===String(jobIdValue));
    updCand(cand.id,{jobId:nextJob?.id??null,questions:null});
  };
  const refreshLearning=async()=>{
    if(!job?.id){setLearning({sampleCount:0,recentSamples:[],rubric:null,questionBank:null});setLearningState({loading:false,error:""});return;}
    setLearningState({loading:true,error:""});
    try{
      const data=await fetchKnowledgeState(cfg.proxyToken||"",job.id);
      setLearning({
        sampleCount:Number(data?.sampleCount)||0,
        recentSamples:Array.isArray(data?.recentSamples)?data.recentSamples:[],
        rubric:data?.rubric||null,
        rubricSummary:data?.rubricSummary||"",
        rubricVersion:data?.rubricVersion||null,
        questionBank:data?.questionBank||null,
        questionBankSummary:data?.questionBankSummary||"",
        questionBankVersion:data?.questionBankVersion||null,
      });
      setLearningState({loading:false,error:""});
    }catch(error){
      setLearningState({loading:false,error:error?.message||"学习规则读取失败"});
    }
  };
  useEffect(()=>{refreshLearning();},[job?.id,cfg.proxyToken]);

  const tabs=[
    {id:"screening",label:"① 简历筛选"},
    {id:"questions",label:`② 面试题${questionTask?.loading?" · 生成中":""}`,disabled:!cand.screening},
    {id:"interview",label:"③ 面试记录",disabled:!cand.screening},
    {id:"director", label:"④ 总监判断"},
    {id:"result",   label:"⑤ 评估结果",disabled:!cand.interviews?.some(i=>i.assessment)},
  ];
  const dir=cand.directorVerdict;
  return(<div>
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"14px 18px",marginBottom:14,display:"flex",alignItems:"center",gap:14}}>
      <Av name={cand.name} T={T} size={42}/>
      <div style={{flex:1}}>
        <div style={{fontSize:17,fontWeight:800,color:T.text}}>{cand.name||"未命名候选人"}</div>
        <div style={{fontSize:12,color:T.text3,marginTop:2}}>{job?.title||cand.screening?.roleDirection||"未绑定岗位"}</div>
        {!cand.jobId&&job&&<div style={{fontSize:11,color:"#2563eb",marginTop:4,lineHeight:1.6}}>当前按识别岗位出题：<strong>{job.title}</strong></div>}
        {!job&&cand.screening?.matchedJobTitle&&<div style={{fontSize:11,color:"#2563eb",marginTop:4,lineHeight:1.6}}>AI建议岗位：<strong>{cand.screening.matchedJobTitle}</strong>{cand.screening?.matchedJobReason?` · ${cand.screening.matchedJobReason}`:""}</div>}
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <button onClick={onDelete} style={{padding:"6px 10px",background:"#fff5f5",color:"#dc2626",border:"1px solid #fecaca",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700}}>删除简历</button>
        {dir?.verdict&&<span style={{fontSize:12,fontWeight:700,padding:"4px 12px",borderRadius:20,background:dir.verdict==="录用"?"#ecfdf5":dir.verdict==="淘汰"?"#fef2f2":"#fffbeb",color:dir.verdict==="录用"?"#059669":dir.verdict==="淘汰"?"#dc2626":"#ca8a04"}}>总监：{dir.verdict}</span>}
        {cand.scheduledAt&&<span style={{fontSize:12,color:"#7c3aed",fontWeight:600}}>📅 {fmtDate(cand.scheduledAt)}</span>}
        <div style={{display:"flex",gap:8,alignItems:"center",minWidth:240}}>
          <select value={cand.jobId??""} onChange={e=>assignJob(e.target.value)} style={{...inSt(T),width:"auto",minWidth:180,fontSize:12,padding:"6px 8px"}}>
            <option value="">未绑定岗位</option>
            {jobs.map(item=><option key={item.id} value={item.id}>{item.title}{item.department?` · ${item.department}`:""}</option>)}
          </select>
          {aiSuggestedJob&&cand.jobId!==aiSuggestedJob.id&&<button onClick={()=>assignJob(aiSuggestedJob.id)} style={{padding:"6px 10px",background:"#eff6ff",color:"#2563eb",border:"1px solid #bfdbfe",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>套用AI匹配</button>}
        </div>
        <select value={cand.status} onChange={e=>updCand(cand.id,{status:e.target.value})} style={{...inSt(T),width:"auto",fontSize:12,padding:"6px 8px"}}>
          {Object.entries(STATUS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
        </select>
        {cand.screening&&<div style={{textAlign:"center",padding:"4px 12px",background:T.card2,borderRadius:8,border:`1px solid ${T.border}`}}>
          <div style={{fontSize:20,fontWeight:900,color:scColor(cand.screening.overallScore)}}>{cand.screening.overallScore?.toFixed(1)}</div>
          <div style={{fontSize:10,color:T.text4}}>AI评分</div>
        </div>}
      </div>
    </div>
    <div style={{fontSize:11,color:T.text4,marginBottom:12,padding:"8px 10px",background:T.card2,borderRadius:8}}>这里可以直接给候选人匹配或修改岗位。切换岗位后，建议到“简历筛选”里点一次“重新筛选”，让评分和后续面试题按新岗位重算。</div>
    <div style={{display:"flex",gap:0,marginBottom:14,background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:4}}>
      {tabs.map(t=><button key={t.id}
        style={{flex:1,padding:"7px 4px",border:"none",background:tab===t.id?T.tabActive:"transparent",color:tab===t.id?T.tabActiveFg:T.text3,borderRadius:7,cursor:t.disabled?"not-allowed":"pointer",fontSize:12,fontWeight:tab===t.id?700:400,opacity:t.disabled?0.4:1,transition:"all 0.1s"}}
        disabled={t.disabled} onClick={()=>setTab(t.id)}>{t.label}</button>)}
    </div>
    {tab==="screening"&&<ScreenTab  key={`screening-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} learning={learning} learningState={learningState}/>}
    {tab==="questions"&&<QuestionTab key={`questions-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} learning={learning} learningState={learningState} questionTask={questionTask} startQuestionGeneration={startQuestionGeneration}/>}
    {tab==="interview"&&<InterviewTab key={`interview-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} interviewTask={interviewTask} startInterviewAssessment={startInterviewAssessment}/>}
    {tab==="director" &&<DirectorTab  key={`director-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} learning={learning} learningState={learningState} refreshLearning={refreshLearning}/>}
    {tab==="result"   &&<ResultTab    key={`result-${cand.id}`} T={T} cand={cand}/>}
  </div>);
}

// ─── SCREEN TAB ──────────────────────────────────────────────
function ScreenTab({T,cand,job,cfg,updCand,recordTokens,dirCtx,learning,learningState}) {
  const [name,setName]=useState(cand.name||"");
  const [resume,setResume]=useState(cand.resume||"");
  const [inputMode,setInputMode]=useState(cand.resumeFileName?"file":"text");
  const [resumeFile,setResumeFile]=useState(null);
  const [resumeFileName,setResumeFileName]=useState(cand.resumeFileName||"");
  const [drag,setDrag]=useState(false);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const learningHint = formatRubricContext(learning);

  const queueResumeFile=file=>{
    if(!file) return;
    if(getFileKind(file)==="unknown"){setErr("仅支持 PDF、图片、Word(.docx) 或纯文本简历文件");return;}
    setResumeFile(file);
    setResumeFileName(file.name);
    setInputMode("file");
    setErr("");
  };

  const analyzeExtractedResume=async(extractedResume, sourceName="")=>{
    const normalizedResume=normalizeExtractedText(extractedResume).slice(0,30000);
    const nextResumeFileName=sourceName ?? cand.resumeFileName ?? "";
    if(!normalizedResume) throw new Error("未能从简历文件中提取到有效文字，请换一个更清晰的文件");
    setResume(normalizedResume);
    setResumeFileName(nextResumeFileName);
    updCand(cand.id,{name:name||cand.name,resume:normalizedResume,resumeFileName:nextResumeFileName});
    try{
      const { screening:res }=await runResumeScreening(cfg, job, normalizedResume, recordTokens, dirCtx);
      const candName=res.candidateName||name||cand.name||"";
      if(candName&&!name) setName(candName);
      updCand(cand.id,{
        name:candName,
        resume:normalizedResume,
        resumeFileName:nextResumeFileName,
        screening:res,
        status:getCandidateStatusFromScore(res.overallScore)
      });
    }catch(e){throw e;}
  };

  const analyzeText=async()=>{
    if(!resume.trim()){setErr("请粘贴简历内容");return;}
    setErr("");setLoading(true);
    try{await analyzeExtractedResume(resume,"");}
    catch(e){setErr(e.message);}
    setLoading(false);
  };

  const analyzeFile=async()=>{
    if(resumeFile){
      setErr("");setLoading(true);
      try{
        const extractedResume = await extractFileText(resumeFile);
        await analyzeExtractedResume(extractedResume,resumeFile.name);
      }catch(e){setErr(e.message);}
      setLoading(false);
      return;
    }
    if(resume.trim() && resumeFileName){
      setErr("");setLoading(true);
      try{await analyzeExtractedResume(resume,resumeFileName);}
      catch(e){setErr(e.message);}
      setLoading(false);
      return;
    }
    setErr("请先上传简历文件");
  };

  const scr=cand.screening;
  return(<div>
    {!scr&&(<SCard T={T} title="输入候选人信息">
      <Inp T={T} label="候选人姓名" placeholder="姓名（可选）" value={name} onChange={e=>setName(e.target.value)}/>
      <div style={{display:"flex",gap:0,marginBottom:12,border:`1px solid ${T.border2}`,borderRadius:8,overflow:"hidden",width:"fit-content"}}>
        {[["file","📄 上传简历文件"],["text","✏️ 粘贴文字"]].map(([mode,label])=>(
          <button key={mode} onClick={()=>setInputMode(mode)}
            style={{padding:"7px 16px",border:"none",background:inputMode===mode?T.accent:T.inputBg,color:inputMode===mode?T.accentFg:T.text3,cursor:"pointer",fontSize:12,fontWeight:inputMode===mode?700:400}}>
            {label}
          </button>
        ))}
      </div>
      {inputMode==="file"&&<div style={{marginBottom:12,padding:"12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:10}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
          <label style={{...lbSt(T),marginBottom:0}}>上传简历文件（AI 自动识别并规整）</label>
          <button onClick={()=>!loading&&document.getElementById(`resume-file-input-${cand.id}`)?.click()}
            style={{padding:"7px 12px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,cursor:loading?"not-allowed":"pointer",fontSize:12,fontWeight:700,opacity:loading?0.5:1}}>
            上传简历文件
          </button>
        </div>
        <div
          onDragOver={e=>{e.preventDefault();setDrag(true);}}
          onDragLeave={()=>setDrag(false)}
          onDrop={e=>{e.preventDefault();setDrag(false);queueResumeFile(e.dataTransfer.files?.[0]);}}
          onClick={()=>!loading&&document.getElementById(`resume-file-input-${cand.id}`)?.click()}
          style={{border:`2px dashed ${drag?T.accent:T.border2}`,borderRadius:10,padding:"16px 14px",textAlign:"center",cursor:loading?"default":"pointer",background:drag?`${T.accent}10`:T.inputBg,transition:"all 0.15s"}}>
          <input id={`resume-file-input-${cand.id}`} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.md" style={{display:"none"}}
            onChange={e=>{queueResumeFile(e.target.files?.[0]);e.target.value="";}}/>
          {loading
            ?<div><Spin text="正在识别并规整简历..." /><div style={{fontSize:11,color:T.text4,marginTop:6}}>会先抽取文字，再按岗位要求做智能筛选</div></div>
            :resumeFileName
              ?<div><div style={{fontSize:13,fontWeight:700,color:"#16a34a"}}>已选择：{resumeFileName}</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>可直接开始筛选，或重新上传替换文件</div></div>
              :<div><div style={{fontSize:13,fontWeight:700,color:T.text}}>拖入简历文件，或点击上传</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>支持 PDF、图片、Word(.docx) 和纯文本简历</div></div>
          }
        </div>
      </div>}
      {inputMode==="text"&&<div style={{marginBottom:12}}><label style={lbSt(T)}>粘贴简历内容 *</label>
        <textarea rows={12} value={resume} onChange={e=>setResume(e.target.value)} style={{...inSt(T),resize:"vertical",lineHeight:1.6}} placeholder={"将简历文字粘贴到此处...\n包括：基本信息、教育背景、工作经历、技能特长等"}/>
      </div>}
      {dirCtx&&<div style={{fontSize:11,color:T.accent,marginBottom:8,padding:"6px 10px",background:`${T.accent}10`,borderRadius:6}}>✦ 已融入你的历史判断标准，AI评估将更贴近你的用人偏好</div>}
      {learningState?.loading&&<div style={{fontSize:11,color:"#2563eb",marginBottom:8,padding:"6px 10px",background:"#eff6ff",borderRadius:6}}>✦ 正在加载该岗位的学习规则，当前会先按已有岗位要求筛选</div>}
      {!learningState?.loading&&learningHint&&<div style={{fontSize:11,color:"#0f766e",marginBottom:8,padding:"6px 10px",background:"#ecfeff",borderRadius:6}}>✦ 已加载该岗位学习规则，筛选会参考最新硬门槛、风险信号和评分校准</div>}
      {err&&<ErrBox>{err}</ErrBox>}
      {inputMode==="file"&&<BtnPrimary T={T} loading={loading} disabled={loading||(!resumeFile&&!resumeFileName)} onClick={analyzeFile}>{loading?<Spin text="AI 正在分析简历文件..."/>:"识别并智能筛选 →"}</BtnPrimary>}
      {inputMode==="text"&&<BtnPrimary T={T} loading={loading} disabled={loading||!resume.trim()} onClick={analyzeText}>{loading?<Spin text="AI 正在分析简历..."/>:"AI 智能筛选 →"}</BtnPrimary>}
    </SCard>)}
    {scr&&(<div>
      <div style={{...cardSt(T),borderLeft:`4px solid ${recSt(scr.recommendation).c}`,marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div style={{flex:1,marginRight:20}}>
            <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:7}}>筛选结论</div>
            <div style={{fontSize:14,color:T.text2,lineHeight:1.7}}>{scr.summary}</div>
          </div>
          <div style={{textAlign:"center",flexShrink:0}}>
            <div style={{fontSize:42,fontWeight:900,lineHeight:1,color:scColor(scr.overallScore)}}>{scr.overallScore?.toFixed(1)}</div>
            <div style={{fontSize:11,color:T.text4,marginBottom:7}}>/ 5.0</div>
            <Chip c={recSt(scr.recommendation).c} bg={recSt(scr.recommendation).bg}>{scr.recommendation}</Chip>
          </div>
        </div>
      </div>
      <ScoreSection T={T} title={`T0 硬性条件  ${scr.t0?.score?.toFixed(1)||"—"}/5.0`}>
        {scr.t0?.items?.map((it,i)=><ScoreBar key={i} T={T} label={it.requirement} score={it.score} max={it.maxScore} badge={it.level} note={it.note}/>)}
      </ScoreSection>
      <ScoreSection T={T} title="T1 核心评分">
        {scr.t1?.items?.map((it,i)=><ScoreBar key={i} T={T} label={it.dimension} score={it.score} max={it.maxScore} note={it.note}/>)}
      </ScoreSection>
      {scr.t2?.items?.length>0&&<ScoreSection T={T} title="T2 加分项">
        {scr.t2.items.map((it,i)=>(<div key={i} style={{display:"flex",gap:9,padding:"9px 0",borderBottom:`1px solid ${T.border}`,alignItems:"flex-start"}}>
          <span style={{fontSize:15,color:it.has?"#16a34a":T.border2,flexShrink:0}}>{it.has?"✓":"○"}</span>
          <div><div style={{fontSize:13,color:it.has?T.text:T.text4,fontWeight:500}}>{it.item}</div><div style={{fontSize:11,color:T.text4,marginTop:2}}>{it.note}</div></div>
        </div>))}
      </ScoreSection>}
      <ScoreSection T={T} title="精细化筛选">
        {[["学历匹配度",scr.fineScreen?.education],["行业跨度风险",scr.fineScreen?.industryRisk],["工作年限匹配",scr.fineScreen?.tenureMatch],["薪酬合理性",scr.fineScreen?.salaryReason]].filter(([,v])=>v).map(([l,v])=>(
          <ScoreBar key={l} T={T} label={l} score={v.score} max={v.maxScore} note={v.note}/>
        ))}
      </ScoreSection>
      {scr.risks?.length>0&&<div style={{...cardSt(T),background:"#fffbeb",borderLeft:"4px solid #d97706",marginBottom:12}}>
        <div style={{fontSize:12,fontWeight:700,color:"#92400e",marginBottom:7}}>▲ 风险提示</div>
        {scr.risks.map((r,i)=><div key={i} style={{fontSize:13,color:"#78350f",padding:"2px 0"}}>• {r}</div>)}
      </div>}
      <button onClick={()=>{
        setErr("");
        setResumeFile(null);
        setResumeFileName(cand.resumeFileName||"");
        setInputMode(cand.resumeFileName?"file":"text");
        updCand(cand.id,{screening:null,questions:null});
      }} style={{padding:"7px 14px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:7,color:T.text3,cursor:"pointer",fontSize:12}}>重新筛选</button>
    </div>)}
  </div>);
}

// ─── QUESTION TAB ────────────────────────────────────────────
function QuestionTab({T,cand,job,cfg,updCand,recordTokens,dirCtx,learning,learningState,questionTask,startQuestionGeneration}) {
  const loading=!!questionTask?.loading;
  const err=questionTask?.error||"";
  const feedbackHistory = mergeQuestionFeedbackHistory(cand.questionFeedbackHistory, cand.questions || []);
  const updateQuestionFeedback=(index,patch)=>{
    const next=(cand.questions||[]).map((item,i)=>i===index?{...item,...patch}:item);
    updCand(cand.id,{
      questions:next,
      questionFeedbackHistory:mergeQuestionFeedbackHistory(cand.questionFeedbackHistory,next),
    });
  };
  const gen=async()=>{
    startQuestionGeneration?.(cand,job,learning);
  };
  const qs=cand.questions;
  return(<div>
    {!qs?(<SCard T={T} title="生成面试题">
      <div style={{fontSize:13,color:T.text3,marginBottom:14}}>基于岗位要求和简历分析，AI 生成结构化面试题，含好/差/红旗回答参考</div>
      {dirCtx&&<div style={{fontSize:11,color:T.accent,marginBottom:10,padding:"6px 10px",background:`${T.accent}10`,borderRadius:6}}>✦ 已融入总监历史判断标准，面试题将更贴近你的用人偏好</div>}
      {learningState?.loading&&<div style={{fontSize:11,color:"#2563eb",marginBottom:10,padding:"6px 10px",background:"#eff6ff",borderRadius:6}}>✦ 正在加载该岗位最新规则与题库，当前先按岗位要求生成面试题</div>}
      {!learningState?.loading&&formatQuestionBankContext(learning)&&<div style={{fontSize:11,color:"#0f766e",marginBottom:10,padding:"6px 10px",background:"#ecfeff",borderRadius:6}}>✦ 已加载学习后的题库偏好，面试题会优先覆盖高区分度问题和风险排查</div>}
      {!!feedbackHistory.length&&<div style={{fontSize:11,color:"#7c3aed",marginBottom:10,padding:"6px 10px",background:"#f5f3ff",borderRadius:6}}>✦ 本候选人上一轮题目反馈已生效：重复/无效题会被避开，高价值题会优先保留相近问法。</div>}
      {loading&&<div style={{fontSize:11,color:"#7c3aed",marginBottom:10,padding:"6px 10px",background:"#f5f3ff",borderRadius:6}}>✦ 面试题正在后台生成中。你现在切换到其他窗口也不会中断，回来后结果会自动保留。</div>}
      {err&&<ErrBox>{err}</ErrBox>}
      <BtnPrimary T={T} loading={loading} disabled={loading} onClick={gen}>{loading?<Spin text="生成中..."/>:"生成面试题 →"}</BtnPrimary>
    </SCard>):(<div>
      {questionTask?.loading&&<div style={{fontSize:11,color:"#7c3aed",marginBottom:12,padding:"6px 10px",background:"#f5f3ff",borderRadius:6}}>✦ 正在后台重新生成面试题。你切换页面后任务仍会继续。</div>}
      <div style={{fontSize:12,color:T.text4,marginBottom:12,padding:"8px 10px",background:T.card2,borderRadius:8}}>
        面试后可直接给每道题打标：高价值 / 一般 / 重复 / 无效。系统后续会把这些反馈沉淀进岗位题库学习。
      </div>
      {[...new Set(qs.map(q=>q.step))].sort().map(step=>{
        const sq=qs.map((q,index)=>({q,index})).filter(item=>item.q.step===step);
        return(<div key={step} style={{marginBottom:18}}>
          <div style={{fontSize:12,fontWeight:700,color:T.text2,padding:"6px 12px",background:T.navActive,borderRadius:6,marginBottom:9,borderLeft:`3px solid ${T.accent}`}}>第{step}步 · {sq[0]?.q?.stepName}</div>
          {sq.map(({q,index})=><QCard key={`${step}-${index}`} T={T} q={q} sourceMeta={getQuestionBankSourceMeta(q, learning)} onFeedbackChange={patch=>updateQuestionFeedback(index,patch)}/>)}
        </div>);
      })}
      <button onClick={()=>updCand(cand.id,{
        questions:null,
        questionFeedbackHistory:mergeQuestionFeedbackHistory(cand.questionFeedbackHistory,cand.questions||[]),
      })} style={{padding:"7px 14px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:7,color:T.text3,cursor:"pointer",fontSize:12}}>重新生成</button>
    </div>)}
  </div>);
}
function QCard({T,q,sourceMeta,onFeedbackChange}) {
  const [open,setOpen]=useState(false);
  const feedbackOption = getQuestionFeedbackOption(q.feedbackTag);
  return(<div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:14,marginBottom:9}}>
    <div style={{cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}} onClick={()=>setOpen(!open)}>
      <div style={{flex:1,marginRight:10}}>
        <div style={{display:"flex",gap:5,marginBottom:6,flexWrap:"wrap"}}>
          <Chip c={T.text2} bg={T.navActive}>{q.tag}</Chip>
          {q.subTag&&<Chip c={T.text3} bg={T.card2}>{q.subTag}</Chip>}
          {q.principle&&<Chip c="#7c3aed" bg="#f3e8ff">{q.principle}</Chip>}
          {sourceMeta&&<Chip c={sourceMeta.kind==="应少问/淘汰题"?"#b91c1c":"#1d4ed8"} bg={sourceMeta.kind==="应少问/淘汰题"?"#fee2e2":"#dbeafe"}>{`来源：${sourceMeta.kind}`}</Chip>}
          {feedbackOption&&<Chip c={feedbackOption.color} bg={feedbackOption.bg}>{feedbackOption.label}</Chip>}
        </div>
        <div style={{fontSize:14,color:T.text,fontWeight:500,lineHeight:1.5}}>{q.question}</div>
        {q.resumeEvidence&&<div style={{fontSize:11,color:T.text4,marginTop:6,lineHeight:1.6}}>简历锚点：{q.resumeEvidence}</div>}
      </div>
      <span style={{fontSize:11,color:T.text4,flexShrink:0}}>{open?"▲":"▼"}</span>
    </div>
    {open&&<div style={{marginTop:13,paddingTop:13,borderTop:`1px solid ${T.border}`}}>
      {sourceMeta&&<div style={{padding:"7px 9px",borderRadius:6,background:sourceMeta.kind==="应少问/淘汰题"?"#fff5f5":"#eff6ff",marginBottom:8}}>
        <span style={{fontSize:10,fontWeight:700,color:sourceMeta.kind==="应少问/淘汰题"?"#b91c1c":"#1d4ed8",marginRight:6}}>题库来源</span>
        <span style={{fontSize:12,color:"#374151"}}>{sourceMeta.text}{sourceMeta.hint?` · ${sourceMeta.hint}`:""}</span>
      </div>}
      {[["考察目标","#374151","#f9fafb",q.purpose],["好的回答","#16a34a","#f0fdf4",q.goodAnswer],["一般回答","#ca8a04","#fefce8",q.okAnswer],["差的回答","#dc2626","#fff5f5",q.badAnswer],q.redFlag&&["红旗回答","#7f1d1d","#fef2f2",q.redFlag],["追问方向","#4f46e5","#eef2ff",q.followUp]].filter(Boolean).map(([l,c,bg,t])=>(
        <div key={l} style={{padding:"7px 9px",borderRadius:6,background:bg,marginBottom:7}}><span style={{fontSize:10,fontWeight:700,color:c,marginRight:5}}>{l}</span><span style={{fontSize:13,color:"#374151",lineHeight:1.6}}>{t}</span></div>
      ))}
      <div style={{marginTop:12,paddingTop:12,borderTop:`1px dashed ${T.border}`}}>
        <div style={{fontSize:11,fontWeight:700,color:T.text2,marginBottom:8}}>题目质量反馈</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
          {QUESTION_FEEDBACK_OPTIONS.map(option=>(
            <button
              key={option.id}
              type="button"
              onClick={()=>onFeedbackChange?.({feedbackTag:option.id})}
              style={{
                padding:"6px 10px",
                borderRadius:999,
                border:`1px solid ${q.feedbackTag===option.id?option.color:T.border2}`,
                background:q.feedbackTag===option.id?option.bg:T.surface,
                color:q.feedbackTag===option.id?option.color:T.text3,
                fontSize:11,
                fontWeight:700,
                cursor:"pointer"
              }}
            >
              {option.label}
            </button>
          ))}
          {q.feedbackTag&&<button
            type="button"
            onClick={()=>onFeedbackChange?.({feedbackTag:"",feedbackNote:""})}
            style={{padding:"6px 10px",borderRadius:999,border:`1px solid ${T.border2}`,background:"transparent",color:T.text4,fontSize:11,cursor:"pointer"}}
          >
            清除
          </button>}
        </div>
        <textarea
          rows={3}
          value={q.feedbackNote||""}
          onChange={e=>onFeedbackChange?.({feedbackNote:e.target.value})}
          style={{...inSt(T),resize:"vertical",lineHeight:1.6,fontSize:12}}
          placeholder="记录这道题为什么有效、重复，或需要怎样优化问法..."
        />
      </div>
    </div>}
  </div>);
}

// ─── INTERVIEW TAB ───────────────────────────────────────────
function InterviewTab({T,cand,job,cfg,updCand,recordTokens,dirCtx,interviewTask,startInterviewAssessment}) {
  const roundOptions = getInterviewRoundsForJob(job);
  const [round,setRound]=useState(roundOptions[0] || "一面");
  const [notes,setNotes]=useState("");
  const [schedDate,setSchedDate]=useState("");
  const [schedTime,setSchedTime]=useState("10:00");
  const [noteFile,setNoteFile]=useState(null);
  const [noteFileName,setNoteFileName]=useState("");
  const [noteDrag,setNoteDrag]=useState(false);
  const [fileLoading,setFileLoading]=useState(false);
  const [fileInfo,setFileInfo]=useState("");
  const [localErr,setLocalErr]=useState("");
  const loading=!!interviewTask?.loading;
  const err=interviewTask?.error||localErr||"";
  const rawErr=interviewTask?.raw||"";
  const dateInputRef=useRef(null);
  const timeInputRef=useRef(null);
  const prevInterviewCountRef=useRef((cand.interviews||[]).length);

  useEffect(()=>{
    const currentCount=(cand.interviews||[]).length;
    if(currentCount>prevInterviewCountRef.current){
      setNotes("");
      setRound(roundOptions[0] || "一面");
      setNoteFile(null);
      setNoteFileName("");
      setFileInfo("");
      setLocalErr("");
    }
    prevInterviewCountRef.current=currentCount;
  },[cand.interviews,roundOptions]);

  useEffect(()=>{
    if(!roundOptions.includes(round)) setRound(roundOptions[0] || "一面");
  },[round,roundOptions]);

  const openPicker=ref=>{
    const input=ref?.current;
    if(!input) return;
    if(typeof input.showPicker==="function") input.showPicker();
    else{
      input.focus();
      input.click?.();
    }
  };

  const queueNoteFile=file=>{
    if(!file) return;
    if(getFileKind(file)==="unknown"){setLocalErr("仅支持 PDF、图片、Word(.docx) 或纯文本面试记录文件");return;}
    setNoteFile(file);
    setNoteFileName(file.name);
    setLocalErr("");
    setFileInfo("");
  };

  const appendInterviewFile=async()=>{
    if(!noteFile){setLocalErr("请先上传面试记录文件");return;}
    setLocalErr("");
    setFileInfo("");
    setFileLoading(true);
    try{
      const extracted=normalizeExtractedText(await extractFileText(noteFile)).slice(0,20000);
      if(!extracted) throw new Error("未能从面试记录文件中提取到有效文字，请换一个更清晰的文件");
      const merged=notes.trim()
        ? `${notes.trim()}\n\n【上传文件：${noteFile.name}】\n${extracted}`
        : `【上传文件：${noteFile.name}】\n${extracted}`;
      setNotes(merged);
      setFileInfo(`已识别并追加：${noteFile.name}`);
    }catch(error){
      setLocalErr(error?.message||"面试记录文件识别失败");
    }
    setFileLoading(false);
  };

  const saveSchedule=()=>{
    if(!schedDate)return;
    updCand(cand.id,{scheduledAt:`${schedDate}T${schedTime}:00`,interviewRound:round,status:"interview"});
  };

  const assess=async()=>{
    if(!notes.trim()){setLocalErr("请填写面试笔记");return;}
    setLocalErr("");
    startInterviewAssessment?.(cand,job,round,notes);
  };

  return(<div>
    {(cand.interviews||[]).map((ir,i)=><IRecord key={i} T={T} record={ir}/>)}
    <SCard T={T} title="📅 安排面试时间">
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr auto",gap:10,alignItems:"flex-end"}}>
        <div><label style={lbSt(T)}>面试轮次</label>
          <select value={round} onChange={e=>setRound(e.target.value)} style={{...inSt(T)}}>
            {roundOptions.map(r=><option key={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label style={lbSt(T)}>面试日期</label>
          <div style={{display:"flex",gap:8}}>
            <input ref={dateInputRef} type="date" value={schedDate} onChange={e=>setSchedDate(e.target.value)} style={{...inSt(T),flex:1}}/>
            <button type="button" onClick={()=>openPicker(dateInputRef)} style={{padding:"0 12px",border:`1px solid ${T.border2}`,borderRadius:8,background:T.surface,color:T.text2,cursor:"pointer",fontSize:16}}>📅</button>
          </div>
        </div>
        <div>
          <label style={lbSt(T)}>面试时间</label>
          <div style={{display:"flex",gap:8}}>
            <input ref={timeInputRef} type="time" value={schedTime} onChange={e=>setSchedTime(e.target.value)} style={{...inSt(T),flex:1}}/>
            <button type="button" onClick={()=>openPicker(timeInputRef)} style={{padding:"0 12px",border:`1px solid ${T.border2}`,borderRadius:8,background:T.surface,color:T.text2,cursor:"pointer",fontSize:15}}>🕒</button>
          </div>
        </div>
        <button onClick={saveSchedule} disabled={!schedDate}
          style={{padding:"8px 16px",background:schedDate?T.accent:"#e5e7eb",color:schedDate?T.accentFg:T.text4,border:"none",borderRadius:7,cursor:schedDate?"pointer":"not-allowed",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>
          确认预约
        </button>
      </div>
      {isSingleRoundLevel(job?.level)&&<div style={{marginTop:10,fontSize:12,color:T.text3,lineHeight:1.7,padding:"8px 10px",background:T.card2,borderRadius:8}}>
        当前岗位职级为 <strong style={{color:T.text}}>{job?.level||"专员/组长/主管"}</strong>，默认只安排一面；一面通过后直接进入最终判断，不再默认进入二面。
      </div>}
      {cand.scheduledAt&&<div style={{marginTop:10,fontSize:13,color:"#7c3aed",fontWeight:600}}>✓ 已预约：{cand.interviewRound} · {fmtDate(cand.scheduledAt)}</div>}
    </SCard>
    <SCard T={T} title="录入面试记录">
      {loading&&<div style={{fontSize:11,color:"#2563eb",marginBottom:10,padding:"6px 10px",background:"#eff6ff",borderRadius:6}}>✦ 面试综合评估正在后台运行中。你现在切换到其他窗口也不会中断，回来后结果会自动保留。</div>}
      <div style={{marginBottom:12,padding:"14px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:10,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:T.text}}>上传面试记录文件</div>
            <div style={{fontSize:11,color:T.text4,marginTop:3}}>支持 PDF、图片、Word(.docx) 与纯文本文件，识别后会自动追加到笔记里</div>
          </div>
          <button onClick={()=>!fileLoading&&document.getElementById(`interview-file-input-${cand.id}`)?.click()} style={{padding:"8px 12px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,fontSize:12,fontWeight:700,cursor:fileLoading?"not-allowed":"pointer",opacity:fileLoading?0.5:1}}>选择文件</button>
        </div>
        <div
          onDragOver={e=>{e.preventDefault();setNoteDrag(true);}}
          onDragLeave={()=>setNoteDrag(false)}
          onDrop={e=>{e.preventDefault();setNoteDrag(false);queueNoteFile(e.dataTransfer.files?.[0]);}}
          onClick={()=>!fileLoading&&document.getElementById(`interview-file-input-${cand.id}`)?.click()}
          style={{border:`2px dashed ${noteDrag?T.accent:T.border2}`,borderRadius:12,padding:"18px 14px",textAlign:"center",cursor:fileLoading?"default":"pointer",background:noteDrag?`${T.accent}10`:T.inputBg,transition:"all 0.15s",marginBottom:10}}>
          <input id={`interview-file-input-${cand.id}`} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.md" style={{display:"none"}} onChange={e=>{queueNoteFile(e.target.files?.[0]);e.target.value="";}}/>
          {fileLoading
            ?<div><Spin text="正在识别面试记录文件..." /><div style={{fontSize:11,color:T.text4,marginTop:6}}>识别完成后会自动追加到下方笔记</div></div>
            :noteFileName
              ?<div><div style={{fontSize:13,fontWeight:700,color:"#16a34a"}}>已选择：{noteFileName}</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>点击下方按钮即可识别并追加到笔记</div></div>
              :<div><div style={{fontSize:13,fontWeight:700,color:T.text}}>拖入面试记录文件，或点击上传</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>适合上传面评表、会议纪要、语音转写文本等</div></div>
          }
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{fontSize:11,color:T.text4}}>{fileInfo||"上传后可将识别文字直接并入当前面试笔记"}</div>
          <button onClick={appendInterviewFile} disabled={fileLoading||!noteFile} style={{padding:"8px 12px",background:fileLoading||!noteFile?"#e5e7eb":T.accent,color:fileLoading||!noteFile?T.text4:T.accentFg,border:"none",borderRadius:8,cursor:fileLoading||!noteFile?"not-allowed":"pointer",fontSize:12,fontWeight:700}}>
            {fileLoading?"识别中...":"识别并追加到笔记"}
          </button>
        </div>
      </div>
      <div style={{marginBottom:12}}><label style={lbSt(T)}>面试笔记 *</label>
        <textarea rows={10} value={notes} onChange={e=>setNotes(e.target.value)} style={{...inSt(T),resize:"vertical",lineHeight:1.7}}
          placeholder={"记录候选人表现、回答要点、你的观察...\n例：\n- 自我介绍流畅，突出5年短视频经验\n- 团队协作举了具体项目，数据清晰（粉丝增长40%）\n- 离职原因：想要更大平台\n- 薪资期望20K，目前18K，有弹性"}/>
      </div>
      {dirCtx&&<div style={{fontSize:11,color:T.accent,marginBottom:8,padding:"6px 10px",background:`${T.accent}10`,borderRadius:6}}>✦ AI将参考你的历史判断标准进行评估</div>}
      {err&&<ErrBox>{err}</ErrBox>}
      {!!rawErr&&<details style={{marginBottom:10}}>
        <summary style={{fontSize:11,color:T.text4,cursor:"pointer"}}>查看模型原始返回</summary>
        <pre style={{marginTop:8,padding:"10px 12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:8,fontSize:11,color:T.text2,whiteSpace:"pre-wrap",wordBreak:"break-word",lineHeight:1.6,maxHeight:220,overflow:"auto"}}>{rawErr}</pre>
      </details>}
      <BtnPrimary T={T} loading={loading||fileLoading} disabled={loading||fileLoading||!notes.trim()} onClick={assess}>{loading?<Spin text="AI 三源综合评估中..."/>:fileLoading?<Spin text="文件识别中..."/>:`AI ${round}综合评估 →`}</BtnPrimary>
    </SCard>
  </div>);
}
function IRecord({T,record}) {
  const [open,setOpen]=useState(true);
  const ast=record.assessment;
  const dc=ast?.decision==="通过"?{c:"#16a34a",bg:"#dcfce7"}:ast?.decision==="淘汰"?{c:"#dc2626",bg:"#fee2e2"}:{c:"#ca8a04",bg:"#fef9c3"};
  return(<div style={{...cardSt(T),borderLeft:`4px solid ${dc.c}`,marginBottom:14}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setOpen(!open)}>
      <div style={{display:"flex",gap:10,alignItems:"center"}}>
        <Chip c={dc.c} bg={dc.bg}>{record.round}</Chip>
        <span style={{fontSize:12,color:T.text3}}>{record.date}</span>
        {ast&&<Chip c={dc.c} bg={dc.bg}>{ast.decision}</Chip>}
      </div>
      {ast&&<span style={{fontWeight:900,fontSize:20,color:scColor(ast.score)}}>{ast.score?.toFixed(1)}</span>}
    </div>
    {open&&ast&&<div style={{marginTop:14}}>
      <div style={{padding:"10px 13px",background:T.card2,borderRadius:8,marginBottom:12}}>
        <div style={{fontSize:12,color:T.text3,marginBottom:3}}>JD匹配：<strong style={{color:T.text}}>{ast.jdMatch}</strong></div>
        <div style={{fontSize:13,color:T.text2,fontWeight:500}}>💡 {ast.suggestion}</div>
      </div>
      {ast.dimensions?.length>0&&<div style={{marginBottom:14}}>
        <SecLabel T={T}>维度评分</SecLabel>
        {ast.dimensions.map((d,i)=>(<div key={i} style={{padding:"9px 0",borderBottom:`1px solid ${T.border}`}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
            <span style={{fontSize:13,fontWeight:600,color:T.text}}>{d.name}</span>
            <div style={{display:"flex",gap:7,alignItems:"center"}}>
              {d.vsResume&&<Chip c={d.vsResume==="一致"?"#16a34a":d.vsResume==="存疑"?"#ca8a04":"#dc2626"} bg={d.vsResume==="一致"?"#dcfce7":d.vsResume==="存疑"?"#fef9c3":"#fee2e2"}>vs简历:{d.vsResume}</Chip>}
              <span style={{fontWeight:700,color:scColor(d.score,d.maxScore||5)}}>{d.score}/{d.maxScore||5}</span>
            </div>
          </div>
          <div style={{fontSize:12,color:T.text3}}>{d.note}</div>
          <MiniBar score={d.score} max={d.maxScore||5} color={scColor(d.score,d.maxScore||5)}/>
        </div>))}
      </div>}
      {ast.emotions&&<div style={{marginBottom:12,background:T.card2,borderRadius:8,padding:"10px 13px",fontSize:12,display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
        <div><span style={{color:T.text3}}>真实动机：</span><span style={{color:T.text}}>{ast.emotions.trueMotivation}</span></div>
        <div><span style={{color:T.text3}}>诉求优先：</span><span style={{color:T.text}}>{ast.emotions.needsPriority}</span></div>
        <div><span style={{color:T.text3}}>稳定性：</span><span style={{color:ast.emotions.stabilityRisk==="低"?"#16a34a":ast.emotions.stabilityRisk==="高"?"#dc2626":"#ca8a04",fontWeight:600}}>{ast.emotions.stabilityRisk}</span>{ast.emotions.stabilityNote&&<span style={{color:T.text4}}> — {ast.emotions.stabilityNote}</span>}</div>
        <div><span style={{color:T.text3}}>管理难度：</span><span style={{color:ast.emotions.managementDifficulty==="低"?"#16a34a":ast.emotions.managementDifficulty==="高"?"#dc2626":"#ca8a04",fontWeight:600}}>{ast.emotions.managementDifficulty}</span>{ast.emotions.managementNote&&<span style={{color:T.text4}}> — {ast.emotions.managementNote}</span>}</div>
      </div>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:12}}>
        {ast.highlights?.length>0&&<div><SecLabel T={T}>+ 亮点</SecLabel>{ast.highlights.map((h,i)=><div key={i} style={{fontSize:12,color:T.text2,padding:"2px 0"}}>✓ {h}</div>)}</div>}
        {ast.concerns?.length>0&&<div><SecLabel T={T}>! 顾虑</SecLabel>{ast.concerns.map((c,i)=><div key={i} style={{fontSize:12,color:T.text2,padding:"2px 0"}}>• {c}</div>)}</div>}
      </div>
      {ast.interviewerReview&&<div style={{padding:"9px 12px",background:"#eff6ff",borderRadius:7,borderLeft:"3px solid #2563eb"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#1e40af",marginBottom:3}}>面试官复盘</div>
        <div style={{fontSize:12,color:"#374151"}}>{ast.interviewerReview}</div>
      </div>}
      <details style={{marginTop:10}}><summary style={{fontSize:11,color:T.text4,cursor:"pointer"}}>▶ 查看笔记原文</summary>
        <div style={{fontSize:12,color:T.text3,padding:"9px",background:T.card2,borderRadius:6,marginTop:6,whiteSpace:"pre-wrap",lineHeight:1.7}}>{record.notes}</div>
      </details>
    </div>}
  </div>);
}

function QuestionBankPanel({T,learning}) {
  const bank = learning?.questionBank;
  const sections = [
    ["highSignalQuestions","高价值题",(item)=>`${cleanListLine(item?.question||"")}${cleanListLine(item?.targetSignal||"")?` · ${cleanListLine(item.targetSignal)}`:""}`],
    ["questionPatterns","优先提问模式",(item)=>`${cleanListLine(item?.pattern||"")}${cleanListLine(item?.useWhen||"")?` · 适用：${cleanListLine(item.useWhen)}`:""}`],
    ["followUpPatterns","高价值追问模式",(item)=>`${cleanListLine(item?.pattern||"")}${cleanListLine(item?.why||"")?` · 价值：${cleanListLine(item.why)}`:""}`],
    ["avoidQuestions","应少问/淘汰题",(item)=>`${cleanListLine(item?.question||"")}${cleanListLine(item?.reason||"")?` · 原因：${cleanListLine(item.reason)}`:""}`],
  ];
  const hasDynamic = sections.some(([key])=>Array.isArray(bank?.[key])&&bank[key].length);
  if (!hasDynamic && !learning?.questionBankSummary) return null;
  return (
    <div style={{...cardSt(T),marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:10,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:T.text}}>题库优化面板</div>
          {learning?.questionBankSummary&&<div style={{fontSize:12,color:T.text4,marginTop:4,lineHeight:1.7}}>{learning.questionBankSummary}</div>}
        </div>
        {learning?.questionBankVersion&&<Chip c="#7c3aed" bg="#f5f3ff">题库 v{learning.questionBankVersion}</Chip>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        {sections.map(([key,label,fmtItem])=>{
          const items = Array.isArray(bank?.[key]) ? bank[key].slice(0,4) : [];
          if (!items.length) return null;
          return (
            <div key={key} style={{padding:"12px 14px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:10}}>
              <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:8}}>{label}</div>
              <div style={{display:"grid",gap:8}}>
                {items.map((item,index)=>(
                  <div key={index} style={{fontSize:12,color:T.text2,lineHeight:1.7,paddingBottom:8,borderBottom:index===items.length-1?"none":`1px solid ${T.border}`}}>
                    {fmtItem(item)}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const getAiVerdictTone = recommendation => {
  if (!recommendation) return "unknown";
  if (/(通过|录用)/.test(recommendation)) return "positive";
  if (/淘汰/.test(recommendation)) return "negative";
  return "neutral";
};

const getHumanVerdictTone = verdict => {
  if (!verdict) return "unknown";
  if (["录用","通过"].includes(verdict)) return "positive";
  if (verdict === "淘汰") return "negative";
  return "neutral";
};

const buildVerdictGapAnalysis = cand => {
  const aiRec = cand.screening?.recommendation || "";
  const humanVerdict = cand.directorVerdict?.verdict || "";
  if (!aiRec || !humanVerdict) return null;

  const aiTone = getAiVerdictTone(aiRec);
  const humanTone = getHumanVerdictTone(humanVerdict);
  const same = aiTone === humanTone && aiTone !== "unknown";
  const latest = (cand.interviews || []).filter(i => i.assessment).slice(-1)[0]?.assessment || {};
  const riskLines = Array.isArray(cand.screening?.risks) ? cand.screening.risks.slice(0, 3) : [];
  const concernLines = Array.isArray(latest.concerns) ? latest.concerns.slice(0, 3) : [];
  const highlightLines = Array.isArray(latest.highlights) ? latest.highlights.slice(0, 3) : [];
  const mismatchDims = Array.isArray(latest.dimensions)
    ? latest.dimensions
        .filter(d => ["存疑", "不符"].includes(d?.vsResume))
        .slice(0, 3)
        .map(d => `${d.name}：${d.vsResume}${d.evidence ? `（${d.evidence}）` : ""}`)
    : [];
  const strongDims = Array.isArray(latest.dimensions)
    ? latest.dimensions
        .filter(d => Number(d?.score) >= 4 && d?.name)
        .slice(0, 3)
        .map(d => `${d.name}${d.evidence ? `（${d.evidence}）` : ""}`)
    : [];

  if (same) {
    return {
      same: true,
      title: "判断一致",
      summary: "AI 录用建议与面试官/总监最终判断一致，本次主要用于沉淀判断依据。",
      reasons: [
        concernLines.length ? `人工顾虑：${concernLines.join("；")}` : "",
        highlightLines.length ? `现场亮点：${highlightLines.join("；")}` : "",
        cand.directorVerdict?.reason ? `最终判断依据：${cand.directorVerdict.reason}` : "",
      ].filter(Boolean),
    };
  }

  const summary = aiTone === "positive" && humanTone !== "positive"
    ? "AI 给出了偏乐观的录用建议，但面试官/总监在真实面试里发现了更关键的风险。"
    : aiTone === "negative" && humanTone === "positive"
      ? "AI 判断偏保守，但面试官/总监结合现场表现和补充事实，认为候选人仍值得推进。"
      : "AI 建议与面试官/总监最终判断存在分歧，需要回看真实面试证据。";

  return {
    same: false,
    title: "判断不一致",
    summary,
    reasons: [
      mismatchDims.length ? `现场核验出的差异点：${mismatchDims.join("；")}` : "",
      concernLines.length ? `人工顾虑：${concernLines.join("；")}` : "",
      highlightLines.length ? `人工补充看到的亮点：${highlightLines.join("；")}` : "",
      strongDims.length && aiTone === "negative" && humanTone === "positive" ? `被人工加权的强项：${strongDims.join("；")}` : "",
      riskLines.length ? `AI 初筛主要关注：${riskLines.join("；")}` : "",
      cand.directorVerdict?.reason ? `最终判断依据：${cand.directorVerdict.reason}` : "",
    ].filter(Boolean),
  };
};

// ─── DIRECTOR TAB ────────────────────────────────────────────
function DirectorTab({T,cand,job,cfg,updCand,recordTokens,learning,learningState,refreshLearning}) {
  const dir=cand.directorVerdict||{};
  const [verdict,setVerdict]=useState(dir.verdict||"");
  const [reason,setReason]=useState(dir.reason||"");
  const [saving,setSaving]=useState(false);
  const [learningMsg,setLearningMsg]=useState("");
  const saved=dir.verdict&&dir.reason;
  const aiRec=cand.screening?.recommendation;
  const gapAnalysis=saved?buildVerdictGapAnalysis(cand):null;
  const match=!!gapAnalysis?.same;

  const save=async()=>{
    if(!verdict||!reason.trim())return;
    setSaving(true);
    setLearningMsg("正在保存判断并沉淀学习样本...");
    updCand(cand.id,{
      directorVerdict:{verdict,reason,date:new Date().toLocaleDateString("zh-CN"),aiRec},
      status:verdict==="录用"?"offer":verdict==="淘汰"?"rejected":cand.status
    });
    try{
      const res=await learnFromDirectorFeedback(cfg,cand,job,verdict,reason.trim(),recordTokens);
      if(res.updatedKnowledge){
        setLearningMsg(`已新增学习样本，并更新岗位规则 v${res.rubricVersion||"-"} / 题库 v${res.questionBankVersion||"-"}`);
        if(refreshLearning) await refreshLearning();
      }else{
        setLearningMsg(`已新增学习样本，当前累计 ${res.sampleCount} 条；达到 ${KNOWLEDGE_MIN_SAMPLES} 条后会自动更新规则与题库`);
        if(refreshLearning) await refreshLearning();
      }
    }catch(error){
      setLearningMsg(`判断已保存，但学习沉淀失败：${error?.message||"请稍后重试"}`);
    }
    setSaving(false);
  };

  return(<div>
    <div style={{...cardSt(T),borderLeft:`4px solid ${T.accent}`,marginBottom:14}}>
      <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:6}}>🧠 总监判断沉淀系统</div>
      <div style={{fontSize:13,color:T.text2,lineHeight:1.7}}>
        你对候选人的最终判断和点评，将自动积累成 AI 的参考标准。<br/>
        <strong style={{color:T.accent}}>积累越多，AI 越懂你的用人偏好，评估越准。</strong>
      </div>
    </div>
    <div style={{...cardSt(T),marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:T.text}}>岗位学习状态</div>
          <div style={{fontSize:12,color:T.text4,marginTop:4}}>
            当前岗位已沉淀 {Number(learning?.sampleCount)||0} 条学习样本
            {learning?.rubricVersion?` · 规则 v${learning.rubricVersion}`:" · 暂无规则版本"}
            {learning?.questionBankVersion?` · 题库 v${learning.questionBankVersion}`:" · 暂无题库版本"}
          </div>
        </div>
        {learningState?.loading&&<Chip c="#2563eb" bg="#eff6ff">学习数据加载中</Chip>}
        {!learningState?.loading&&learning?.rubricVersion&&<Chip c="#059669" bg="#ecfdf5">已启用学习规则</Chip>}
      </div>
      {learningMsg&&<div style={{marginTop:10,fontSize:12,color:T.text3,lineHeight:1.7}}>{learningMsg}</div>}
    </div>
    <QuestionBankPanel T={T} learning={learning}/>

    {cand.screening&&(
      <div style={{...cardSt(T),marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:12}}>AI 录用建议 vs 最终结果（以面试官/总监为准）</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div style={{padding:"14px",background:T.card2,borderRadius:9,textAlign:"center"}}>
            <div style={{fontSize:11,color:T.text4,marginBottom:6}}>AI 录用建议</div>
            <div style={{fontSize:16,fontWeight:700,color:recSt(aiRec).c}}>{aiRec||"未评估"}</div>
            <div style={{fontSize:28,fontWeight:900,color:scColor(cand.screening.overallScore),marginTop:4}}>{cand.screening.overallScore?.toFixed(1)}</div>
          </div>
          <div style={{padding:"14px",background:T.card2,borderRadius:9,textAlign:"center",border:saved?`2px solid ${verdict==="录用"?"#059669":verdict==="淘汰"?"#dc2626":"#ca8a04"}`:undefined}}>
            <div style={{fontSize:11,color:T.text4,marginBottom:6}}>最终结果（面试官/总监）</div>
            {saved?<div style={{fontSize:16,fontWeight:700,color:verdict==="录用"?"#059669":verdict==="淘汰"?"#dc2626":"#ca8a04"}}>{verdict}</div>
            :<div style={{fontSize:13,color:T.text4}}>待填写</div>}
            {saved&&aiRec&&<div style={{marginTop:8,fontSize:12,fontWeight:700,color:match?"#16a34a":"#dc2626"}}>{match?"✓ 人工判断与AI建议一致":"✗ 以人工判断为准，并记录AI分歧原因"}</div>}
          </div>
        </div>
        {gapAnalysis&&<div style={{marginTop:12,padding:"10px 12px",background:match?"#f0fdf4":"#fff7ed",borderRadius:8,borderLeft:`3px solid ${match?"#16a34a":"#ea580c"}`,fontSize:12,color:T.text2,lineHeight:1.8}}>
          <strong style={{color:match?"#166534":"#9a3412"}}>{gapAnalysis.title}</strong>
          <div style={{marginTop:4}}>{gapAnalysis.summary}</div>
          {gapAnalysis.reasons?.length>0&&<div style={{marginTop:8,display:"grid",gap:6}}>
            {gapAnalysis.reasons.map((item,index)=><div key={index}>• {item}</div>)}
          </div>}
        </div>}
      </div>
    )}

    <SCard T={T} title={saved?"更新我的判断":"填写我的判断"}>
      <div style={{marginBottom:14}}>
        <label style={lbSt(T)}>最终决定（以面试官/总监判断为准）</label>
        <div style={{display:"flex",gap:10}}>
          {[["录用","#059669","#ecfdf5"],["通过","#2563eb","#eff6ff"],["待定","#ca8a04","#fef9c3"],["淘汰","#dc2626","#fef2f2"]].map(([v,c,bg])=>(
            <div key={v} onClick={()=>setVerdict(v)}
              style={{flex:1,padding:"10px",textAlign:"center",borderRadius:9,border:`2px solid ${verdict===v?c:T.border}`,cursor:"pointer",background:verdict===v?bg:T.card2,fontWeight:700,fontSize:14,color:verdict===v?c:T.text3,transition:"all 0.1s"}}>
              {v}
            </div>
          ))}
        </div>
      </div>
      <div style={{marginBottom:14}}>
        <label style={lbSt(T)}>我的点评（这将成为 AI 的学习参考）</label>
        <textarea rows={4} value={reason} onChange={e=>setReason(e.target.value)} style={{...inSt(T),resize:"vertical",lineHeight:1.7}}
          placeholder={"简短记录你的核心判断依据...\n例：\n· 执行力强，见过大项目，能快速上手\n· 内容思维好但数据意识不足\n· 稳定性有顾虑但潜力值得冒险"}/>
      </div>
      <BtnPrimary T={T} onClick={save} disabled={saving||!verdict||!reason.trim()}>
        {saving?<Spin text="沉淀学习中..."/>:(saved?"更新判断":"保存判断 · 沉淀为AI参考")}
      </BtnPrimary>
      {saved&&<div style={{marginTop:10,fontSize:12,color:T.text3}}>✓ 已保存于 {dir.date}</div>}
    </SCard>

    <div style={{padding:"12px 14px",background:T.navActive,borderRadius:9,border:`1px solid ${T.border}`}}>
      <div style={{fontSize:12,color:T.text3,lineHeight:1.8}}>
        <strong style={{color:T.text}}>💡 如何让 AI 越来越懂你：</strong><br/>
        积累 <strong style={{color:T.accent}}>10个以上</strong> 案例后，AI 对你用人偏好的理解会显著提升。<br/>
        不同判断（与AI意见相左）的案例尤其有价值。
      </div>
    </div>
  </div>);
}

// ─── RESULT TAB ──────────────────────────────────────────────
function ResultTab({T,cand}) {
  const ivs=(cand.interviews||[]).filter(i=>i.assessment);
  if(!ivs.length) return <Empty T={T} icon="◎" title="暂无评估结果" sub="完成面试记录并进行AI评估后显示"/>;
  const lat=ivs[ivs.length-1];
  const allOk=ivs.every(i=>i.assessment?.decision==="通过");
  const aiRec=allOk?"建议录用":lat.assessment?.decision==="待定"?"待最终确认":"建议淘汰";
  const aiTone=getAiVerdictTone(aiRec);
  const aiChip=aiTone==="positive"?{c:"#16a34a",bg:"#dcfce7"}:aiTone==="negative"?{c:"#dc2626",bg:"#fee2e2"}:{c:"#ca8a04",bg:"#fef9c3"};
  const humanVerdict=cand.directorVerdict?.verdict||"";
  const humanTone=getHumanVerdictTone(humanVerdict);
  const humanChip=humanTone==="positive"?{c:"#16a34a",bg:"#dcfce7"}:humanTone==="negative"?{c:"#dc2626",bg:"#fee2e2"}:humanTone==="neutral"?{c:"#ca8a04",bg:"#fef9c3"}:{c:T.text4,bg:T.card2};
  const gapAnalysis=buildVerdictGapAnalysis({
    ...cand,
    screening:{...(cand.screening||{}),recommendation:aiRec}
  });
  return(<div>
    <div style={{...cardSt(T),borderLeft:`4px solid ${humanVerdict?humanChip.c:aiChip.c}`,marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:14,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>评估结果总览</div>
          <div style={{fontSize:13,color:T.text2}}>完成 {ivs.length} 轮面试 · AI 最终评分 <strong style={{color:scColor(lat.assessment.score)}}>{lat.assessment.score?.toFixed(1)}/5.0</strong></div>
          <div style={{fontSize:13,color:T.text3,marginTop:4}}>{lat.assessment.suggestion}</div>
        </div>
        <div style={{display:"grid",gap:8,justifyItems:"end"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:12,color:T.text4}}>AI 录用建议</span>
            <Chip c={aiChip.c} bg={aiChip.bg} lg>{aiRec}</Chip>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:12,color:T.text4}}>最终结果（面试官/总监）</span>
            <Chip c={humanVerdict?humanChip.c:T.text4} bg={humanVerdict?humanChip.bg:T.card2} lg>{humanVerdict||"待面试官/总监确认"}</Chip>
          </div>
        </div>
      </div>
    </div>
    {gapAnalysis&&<div style={{...cardSt(T),marginBottom:14,borderLeft:`4px solid ${gapAnalysis.same?"#16a34a":"#ea580c"}`}}>
      <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:6}}>
        {gapAnalysis.same?"AI 与人工判断一致":"AI 与人工判断不一致，需回看分歧原因"}
      </div>
      <div style={{fontSize:12,color:T.text2,lineHeight:1.8}}>{gapAnalysis.summary}</div>
      {gapAnalysis.reasons?.length>0&&<div style={{marginTop:8,display:"grid",gap:6}}>
        {gapAnalysis.reasons.map((item,index)=><div key={index} style={{fontSize:12,color:T.text2}}>• {item}</div>)}
      </div>}
    </div>}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12}}>
      {ivs.map((ir,i)=>{
        const dc=ir.assessment.decision==="通过"?{c:"#16a34a",bg:"#dcfce7"}:ir.assessment.decision==="淘汰"?{c:"#dc2626",bg:"#fee2e2"}:{c:"#ca8a04",bg:"#fef9c3"};
        return(<div key={i} style={{...cardSt(T),borderTop:`3px solid ${dc.c}`}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><span style={{fontWeight:700,color:T.text}}>{ir.round}</span><Chip c={dc.c} bg={dc.bg}>{ir.assessment.decision}</Chip></div>
          <div style={{fontSize:26,fontWeight:900,color:scColor(ir.assessment.score)}}>{ir.assessment.score?.toFixed(1)}</div>
          <div style={{fontSize:11,color:T.text4,marginBottom:6}}>/ 5.0 · {ir.date}</div>
          <div style={{fontSize:12,color:T.text2}}>{ir.assessment.suggestion}</div>
        </div>);
      })}
    </div>
  </div>);
}

// ─── SETTINGS VIEW ───────────────────────────────────────────
function SettingsView({T,cfg,setCfg,usageLogs,dirStats,dirDone,dirMatch,jobs,cloud}) {
  const [keys,setKeys]=useState(cfg.apiKeys||{});
  const [saved,setSaved]=useState("");
  const saveKey=pid=>{setCfg(p=>({...p,apiKeys:{...p.apiKeys,[pid]:keys[pid]}}));setSaved(pid);setTimeout(()=>setSaved(""),1500);};
  const usingProxy=cfg.mode!=="direct";
  const cloudTone=cloud?.phase==="ready"?{c:"#059669",bg:"#ecfdf5"}:cloud?.phase==="syncing"||cloud?.phase==="loading"?{c:"#2563eb",bg:"#eff6ff"}:{c:"#dc2626",bg:"#fef2f2"};
  const cloudLabel=cloud?.phase==="ready"?"已连接 D1":cloud?.phase==="syncing"?"同步中":cloud?.phase==="loading"?"连接中":"云端异常";

  const accuracy=dirDone.map(c=>{
    const aiRec=c.screening?.recommendation||"";
    const dir=c.directorVerdict.verdict;
    const j=jobs.find(j=>j.id===c.jobId);
    const match=(aiRec==="建议通过"&&["录用","通过"].includes(dir))||(aiRec==="建议淘汰"&&dir==="淘汰");
    return{name:c.name||"未命名",job:j?.title||"",aiRec,dir,match,date:c.directorVerdict.date};
  });

  const days=[...new Set(usageLogs.map(r=>r.date))].sort().slice(-14);
  const dayTotals=days.map(d=>({date:d,tokens:usageLogs.filter(r=>r.date===d).reduce((s,r)=>s+r.input+r.output,0),calls:usageLogs.filter(r=>r.date===d).reduce((s,r)=>s+r.calls,0)}));
  const maxT=Math.max(...dayTotals.map(d=>d.tokens),1);
  const total={tokens:usageLogs.reduce((s,r)=>s+r.input+r.output,0),calls:usageLogs.reduce((s,r)=>s+r.calls,0)};

  return(<Page T={T} title="设置" sub="配置 API 密钥、AI 模型与界面偏好">
    <div style={{maxWidth:820}}>
      <SecLabel T={T}>调用方式</SecLabel>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px",marginBottom:22}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
          {[["proxy","后端代理","推荐：浏览器不直接暴露模型密钥"],["direct","浏览器直连","仅适合本地临时调试"]].map(([id,title,desc])=>(
            <div key={id} onClick={()=>setCfg(p=>normalizeCfg({...p,mode:id}))}
              style={{padding:"14px 16px",border:`2px solid ${cfg.mode===id?T.accent:T.border}`,borderRadius:10,cursor:"pointer",background:cfg.mode===id?`${T.accent}10`:T.card2}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                <span style={{fontSize:14,fontWeight:800,color:T.text}}>{title}</span>
                {cfg.mode===id&&<span style={{fontSize:12,color:T.accent,fontWeight:700}}>✓</span>}
              </div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.6}}>{desc}</div>
            </div>
          ))}
        </div>
        {usingProxy&&<>
          <Inp T={T} label="代理地址" placeholder="http://localhost:8787/api/ai" value={cfg.proxyUrl||""} onChange={e=>setCfg(p=>normalizeCfg({...p,proxyUrl:e.target.value}))}/>
          <Inp T={T} label="代理访问令牌（可选）" placeholder="留空表示不校验" value={cfg.proxyToken||""} onChange={e=>setCfg(p=>normalizeCfg({...p,proxyToken:e.target.value}))}/>
          <div style={{fontSize:12,color:T.text3,lineHeight:1.7,padding:"10px 12px",background:T.card2,borderRadius:8,border:`1px solid ${T.border}`}}>
            当前为代理模式：前端只发送 `provider / model / prompt` 到你的服务端，真正的模型 API Key 保存在服务端环境变量里。
          </div>
        </>}
      </div>

      <SecLabel T={T}>云端数据库</SecLabel>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px",marginBottom:22}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:12,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:14,fontWeight:800,color:T.text}}>Cloudflare D1 同步状态</div>
            <div style={{fontSize:12,color:T.text4,marginTop:4}}>岗位、候选人、面试记录和调用统计会自动同步到云端，同时保留浏览器本地缓存兜底。</div>
          </div>
          <Chip c={cloudTone.c} bg={cloudTone.bg}>{cloudLabel}</Chip>
        </div>
        <div style={{fontSize:12,color:T.text2,lineHeight:1.8,padding:"10px 12px",background:T.card2,borderRadius:8,border:`1px solid ${T.border}`}}>
          <div>{cloud?.message||"等待云端同步状态..."}</div>
          {cloud?.updatedAt&&<div style={{marginTop:6,color:T.text4}}>最近成功同步：{fmtCloudTime(cloud.updatedAt)}</div>}
          <div style={{marginTop:6,color:T.text4}}>正常版本更新不会清空 D1 里的数据；但如果你清浏览器缓存，只会丢本地副本，不会影响云端主数据。</div>
          <div style={{marginTop:6,color:T.text4}}>如果你配置了「代理访问令牌」，云端数据接口也会复用同一个 Bearer token。当前同步采用整库快照，多人同时改动时以后保存的内容会覆盖之前的保存。</div>
        </div>
      </div>

      <SecLabel T={T}>AI 模型配置</SecLabel>
      <div style={{display:"grid",gap:12,marginBottom:24}}>
        {Object.entries(PROVIDERS).map(([pid,prov])=>{
          const isActive=cfg.provider===pid;
          return(<div key={pid} style={{background:T.surface,border:`2px solid ${isActive?prov.color:T.border}`,borderRadius:12,padding:"16px 18px",transition:"border 0.15s"}}>
            <div style={{display:"flex",alignItems:"center",gap:11,marginBottom:12}}>
              <div style={{width:32,height:32,borderRadius:7,background:prov.color,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:14,flexShrink:0}}>{prov.logo}</div>
              <div style={{flex:1}}><div style={{fontSize:14,fontWeight:800,color:T.text}}>{prov.name}</div><div style={{fontSize:11,color:T.text4}}>{prov.models.length} 个可用模型</div></div>
              {isActive&&<span style={{fontSize:11,fontWeight:700,padding:"3px 9px",background:`${prov.color}18`,color:prov.color,borderRadius:20}}>当前使用</span>}
            </div>
            {!usingProxy
              ?<div style={{marginBottom:11}}>
                <label style={lbSt(T)}>API Key</label>
                <div style={{display:"flex",gap:7}}>
                  <input type="password" value={keys[pid]||""} onChange={e=>setKeys(p=>({...p,[pid]:e.target.value}))} placeholder={prov.keyPlaceholder} style={{...inSt(T),flex:1,fontSize:12}}/>
                  <button onClick={()=>saveKey(pid)} style={{padding:"7px 13px",background:saved===pid?"#059669":prov.color,color:"#fff",border:"none",borderRadius:7,fontSize:12,fontWeight:700,cursor:"pointer",flexShrink:0,minWidth:56,transition:"background 0.2s"}}>{saved===pid?"✓":"保存"}</button>
                </div>
              </div>
              :<div style={{marginBottom:11,padding:"10px 12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:8,fontSize:12,color:T.text3,lineHeight:1.6}}>
                代理模式下，此供应商的 API Key 由服务端环境变量提供，前端不再保存密钥。
              </div>}
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7}}>
              {prov.models.map(m=>{
                const isSel=isActive&&cfg.model===m.id;
                return(<div key={m.id} onClick={()=>setCfg(p=>({...p,provider:pid,model:m.id}))}
                  style={{padding:"8px 10px",border:`1.5px solid ${isSel?prov.color:T.border}`,borderRadius:8,cursor:"pointer",background:isSel?`${prov.color}10`:T.card2,transition:"all 0.1s"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}><span style={{fontSize:12,fontWeight:700,color:T.text}}>{m.name}</span>{isSel&&<span style={{color:prov.color,fontSize:11}}>✓</span>}</div>
                  <div style={{fontSize:11,color:T.text3}}>{m.note}</div>
                  {prov.pricing?.[m.id]&&<div style={{fontSize:10,color:T.text4,marginTop:2}}>${prov.pricing[m.id].in}/${prov.pricing[m.id].out}/M</div>}
                </div>);
              })}
            </div>
          </div>);
        })}
      </div>

      <SecLabel T={T}>界面风格</SecLabel>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px",marginBottom:22}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:9}}>
          {THEMES.map(t=>{
            const th=getTheme(t.id);
            return(<div key={t.id} onClick={()=>setCfg(p=>({...p,theme:t.id}))} style={{border:`2px solid ${cfg.theme===t.id?T.accent:T.border}`,borderRadius:9,overflow:"hidden",cursor:"pointer",transition:"border 0.15s"}}>
              <div style={{height:48,background:th.bg,padding:8,display:"flex",flexDirection:"column",gap:3}}>
                <div style={{height:7,width:"55%",background:th.surface,borderRadius:2,border:`1px solid ${th.border}`}}/>
                <div style={{display:"flex",gap:3}}><div style={{height:6,width:"27%",background:th.accent,borderRadius:2,opacity:0.85}}/><div style={{height:6,width:"37%",background:th.border2,borderRadius:2}}/></div>
                <div style={{height:4,width:"72%",background:th.border,borderRadius:2}}/>
              </div>
              <div style={{padding:"6px 9px",background:T.surface,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,fontWeight:600,color:T.text}}>{t.name}</span>
                {cfg.theme===t.id&&<span style={{color:T.accent,fontSize:12}}>✓</span>}
              </div>
            </div>);
          })}
        </div>
      </div>

      <SecLabel T={T}>总监判断沉淀 · AI准确率追踪</SecLabel>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px",marginBottom:22}}>
        {accuracy.length===0
          ?<div style={{textAlign:"center",padding:"28px",color:T.text4,fontSize:13}}>暂无判断记录，在候选人的「④ 总监判断」中填写后自动追踪</div>
          :<>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:16}}>
              {[{label:"已沉淀案例",val:dirStats.total,color:T.accent},{label:"AI判断一致",val:dirStats.match,color:"#16a34a"},{label:"AI匹配率",val:`${dirStats.rate}%`,color:dirStats.rate>=70?"#16a34a":dirStats.rate>=50?"#ca8a04":"#dc2626"}].map(s=>(
                <div key={s.label} style={{padding:"14px",background:T.card2,borderRadius:9,border:`1px solid ${T.border}`,textAlign:"center"}}>
                  <div style={{fontSize:26,fontWeight:900,color:s.color}}>{s.val}</div>
                  <div style={{fontSize:12,color:T.text4,marginTop:3}}>{s.label}</div>
                </div>
              ))}
            </div>
            <div style={{height:4,background:T.border,borderRadius:2,marginBottom:18}}>
              <div style={{width:`${dirStats.rate}%`,height:"100%",background:dirStats.rate>=70?"#16a34a":dirStats.rate>=50?"#ca8a04":"#6366f1",borderRadius:2,transition:"width 0.5s"}}/>
            </div>
            <div style={{border:`1px solid ${T.border}`,borderRadius:9,overflow:"hidden"}}>
              <div style={{display:"grid",gridTemplateColumns:"1.5fr 1.5fr 1fr 1fr 1fr",padding:"8px 12px",background:T.card2,fontSize:11,fontWeight:700,color:T.text4,borderBottom:`1px solid ${T.border}`}}>
                <span>候选人</span><span>岗位</span><span>AI建议</span><span>总监判断</span><span style={{textAlign:"center"}}>一致</span>
              </div>
              {accuracy.slice().reverse().map((a,i)=>(
                <div key={i} style={{display:"grid",gridTemplateColumns:"1.5fr 1.5fr 1fr 1fr 1fr",padding:"9px 12px",fontSize:12,color:T.text2,borderBottom:i<accuracy.length-1?`1px solid ${T.border}`:"none",alignItems:"center"}}>
                  <span style={{fontWeight:600}}>{a.name}</span>
                  <span style={{color:T.text3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.job}</span>
                  <Chip c={recSt(a.aiRec).c} bg={recSt(a.aiRec).bg}>{a.aiRec?.replace("建议","")}</Chip>
                  <span style={{fontWeight:700,color:a.dir==="录用"?"#059669":a.dir==="淘汰"?"#dc2626":"#ca8a04"}}>{a.dir}</span>
                  <span style={{textAlign:"center",fontSize:16}}>{a.match?"✅":"❌"}</span>
                </div>
              ))}
            </div>
          </>
        }
      </div>

      <SecLabel T={T}>用量统计（近14天）</SecLabel>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px 18px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:16}}>
          {[{label:"总调用次数",val:total.calls,color:T.accent},{label:"总 Token",val:fmt(total.tokens),color:"#7c3aed"}].map(s=>(
            <div key={s.label} style={{padding:"12px",background:T.card2,borderRadius:8,border:`1px solid ${T.border}`,textAlign:"center"}}>
              <div style={{fontSize:24,fontWeight:800,color:s.color}}>{s.val}</div>
              <div style={{fontSize:11,color:T.text4,marginTop:2}}>{s.label}</div>
            </div>
          ))}
        </div>
        {dayTotals.length>0?(<>
          <div style={{fontSize:12,fontWeight:600,color:T.text3,marginBottom:9}}>每日 Token 用量</div>
          <div style={{display:"flex",gap:3,alignItems:"flex-end",height:80,marginBottom:22}}>
            {dayTotals.map(d=>{
              const h=Math.max((d.tokens/maxT)*66,2);
              const isT=d.date===todayStr();
              return(<div key={d.date} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
                <div title={`${d.date}: ${fmt(d.tokens)} tokens, ${d.calls}次`} style={{width:"100%",borderRadius:"2px 2px 0 0",background:isT?T.accent:T.border2,height:`${h}px`,opacity:0.85,cursor:"help"}}/>
                <div style={{fontSize:9,color:T.text4,transform:"rotate(-45deg)",transformOrigin:"top center",whiteSpace:"nowrap"}}>{d.date.slice(5)}</div>
              </div>);
            })}
          </div>
          {(()=>{
            const todayLogs=usageLogs.filter(r=>r.date===todayStr());
            return todayLogs.length>0?(<div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {todayLogs.map((r,i)=>{const p=PROVIDERS[r.provider];return p?(<div key={i} style={{padding:"7px 11px",background:T.card2,border:`1px solid ${T.border}`,borderLeft:`3px solid ${p.color}`,borderRadius:7,fontSize:12}}>
                <span style={{fontWeight:700,color:p.color}}>{p.name}</span>
                <span style={{color:T.text3,marginLeft:7}}>{fmt(r.input+r.output)} tokens</span>
                <span style={{color:T.text4,marginLeft:5}}>{r.calls}次</span>
              </div>):null;})}
            </div>):null;
          })()}
        </>):<div style={{textAlign:"center",padding:"28px",color:T.text4,fontSize:13}}>暂无使用记录</div>}
      </div>
    </div>
  </Page>);
}

// ─── SHARED COMPONENTS ───────────────────────────────────────
const Page=({T,title,sub,children})=>(<div style={{padding:"30px 34px 34px",maxWidth:1180,margin:"0 auto"}}><div style={{marginBottom:24,padding:"0 0 16px",borderBottom:`1px solid ${T.border}`}}><h1 style={{fontSize:24,fontWeight:900,color:T.text,margin:0,letterSpacing:"-0.02em"}}>{title}</h1>{sub&&<div style={{fontSize:13,color:T.text4,marginTop:5,lineHeight:1.7}}>{sub}</div>}</div>{children}</div>);
const SCard=({T,title,children})=>(<div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"20px 22px",marginBottom:16,boxShadow:SOFT_SHADOW}}>{title&&<div style={{fontSize:15,fontWeight:800,color:T.text,marginBottom:16,paddingBottom:12,borderBottom:`1px solid ${T.border}`}}>{title}</div>}{children}</div>);
const cardSt=T=>({background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"20px 22px",marginBottom:14,boxShadow:SOFT_SHADOW});
const ScoreSection=({T,title,children})=>(<div style={{...cardSt(T),marginBottom:14}}><div style={{fontSize:13,fontWeight:800,color:T.text,marginBottom:12,paddingBottom:8,borderBottom:`1px solid ${T.border}`}}>{title}</div>{children}</div>);
const ScoreBar=({T,label,score,max,badge,note})=>{const c=scColor(score,max||5);return(<div style={{padding:"9px 0",borderBottom:`1px solid ${T.border}`}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}><div style={{display:"flex",gap:7,alignItems:"center"}}><span style={{fontSize:13,color:T.text,fontWeight:500}}>{label}</span>{badge&&<Chip c={T.text3} bg={T.navActive}>{badge}</Chip>}</div><span style={{fontWeight:700,color:c,fontSize:13}}>{score}/{max}</span></div><MiniBar score={score} max={max} color={c}/>{note&&<div style={{fontSize:11,color:T.text4,marginTop:4}}>{note}</div>}</div>);};
const MiniBar=({score,max,color})=>(<div style={{height:3,background:"#e5e7eb",borderRadius:2}}><div style={{width:`${(score/(max||5))*100}%`,height:"100%",background:color||"#111827",borderRadius:2,transition:"width 0.4s ease"}}/></div>);
const SecLabel=({T,children})=><div style={{fontSize:11,fontWeight:800,color:T.text4,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10,marginTop:4}}>{children}</div>;
const Chip=({c,bg,children,lg})=><span style={{display:"inline-block",padding:lg?"6px 14px":"4px 9px",borderRadius:999,fontSize:lg?13:11,fontWeight:700,color:c,background:bg,whiteSpace:"nowrap",border:"1px solid rgba(255,255,255,0.25)"}}>{children}</span>;
const SBadge=({status})=>{const s=STATUS[status]||STATUS.pending;return <Chip c={s.color} bg={s.bg}>{s.label}</Chip>;};
const Av=({name,T,size=36})=><div style={{width:size,height:size,borderRadius:"50%",background:`${T.accent}22`,color:T.accent,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:size*0.38,flexShrink:0}}>{(name||"?")[0]?.toUpperCase()}</div>;
const Inp=({T,label,...props})=><div style={{marginBottom:9}}>{label&&<label style={lbSt(T)}>{label}</label>}<input style={inSt(T)} {...props}/></div>;
const Empty=({T,icon,title,sub})=><div style={{textAlign:"center",padding:"60px 24px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,boxShadow:SOFT_SHADOW}}><div style={{fontSize:32,color:T.border2,marginBottom:10}}>{icon}</div><div style={{fontSize:15,fontWeight:700,color:T.text2,marginBottom:5}}>{title}</div><div style={{fontSize:13,color:T.text4,lineHeight:1.7}}>{sub}</div></div>;
const ErrBox=({children})=><div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:7,padding:"8px 12px",fontSize:13,color:"#dc2626",marginBottom:9}}>{children}</div>;
const BtnPrimary=({T,children,loading,disabled,onClick})=><button onClick={onClick} disabled={disabled} style={{padding:"12px 14px",background:T.accent,color:T.accentFg,border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:disabled?"not-allowed":"pointer",width:"100%",opacity:disabled?0.5:1,transition:"opacity 0.1s, transform 0.1s"}}>{children}</button>;
const Spin=({text})=><span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7}}><span style={{width:13,height:13,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/>{text}</span>;
const lbSt=T=>({fontSize:11,fontWeight:600,color:T.text3,display:"block",marginBottom:5});
const inSt=T=>({width:"100%",padding:"10px 12px",border:`1px solid ${T.border2}`,borderRadius:10,fontSize:13,color:T.text,outline:"none",boxSizing:"border-box",fontFamily:"inherit",background:T.inputBg});
function Css({T}) {
  return <style>{`
    @keyframes spin{to{transform:rotate(360deg)}}
    *{box-sizing:border-box;margin:0;padding:0}
    input:focus,textarea:focus,select:focus{border-color:${T.accent}!important;outline:none;box-shadow:0 0 0 3px ${T.accent}15}
    button,textarea{font-family:inherit}
    .hr:hover{background:${T.navActive}!important;transform:translateY(-1px)}
    ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:${T.border2};border-radius:2px}
    details summary{list-style:none}details summary::-webkit-details-marker{display:none}
  `}</style>;
}
