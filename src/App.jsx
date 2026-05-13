import { useState, useEffect, useRef, useMemo } from "react";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { CandDetail } from "./components/CandDetail.jsx";

// ─── PERSIST ─────────────────────────────────────────────────
const load = (k,d)=>{ try{const v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch{return d;}};
const save = (k,v)=>{ try{localStorage.setItem(k,JSON.stringify(v));}catch{}};
const ENV_PROXY_URL=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_PROXY_URL?import.meta.env.VITE_HR_PROXY_URL:"/api/ai";
const ENV_PROXY_TOKEN=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_PROXY_TOKEN?import.meta.env.VITE_HR_PROXY_TOKEN:"";
const ENV_STATE_URL=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_STATE_URL?import.meta.env.VITE_HR_STATE_URL:"/api/state";
const ENV_PREVIEW_URL=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_PREVIEW_URL?import.meta.env.VITE_HR_PREVIEW_URL:"/api/preview";
const ENV_KNOWLEDGE_URL=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_KNOWLEDGE_URL?import.meta.env.VITE_HR_KNOWLEDGE_URL:"/api/knowledge";
const ENV_MODEL_STATUS_URL=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_MODEL_STATUS_URL?import.meta.env.VITE_HR_MODEL_STATUS_URL:"/api/model-status";
const ENV_TRANSCRIBE_URL=typeof import.meta!=="undefined"&&import.meta.env?.VITE_HR_TRANSCRIBE_URL?import.meta.env.VITE_HR_TRANSCRIBE_URL:"/api/transcribe";
const CLOUD_SCHEMA_VERSION = 1;
export const KNOWLEDGE_MIN_SAMPLES = 2;

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

const normalizeDeletedIds = list => [...new Set((Array.isArray(list) ? list : []).map(id => String(id || "").trim()).filter(Boolean))];
const mergeDeletedIds = (left = [], right = []) => normalizeDeletedIds([...(left || []), ...(right || [])]);
const filterDeletedCandidates = (cands = [], deletedCandidateIds = []) => {
  const deletedSet = new Set(normalizeDeletedIds(deletedCandidateIds));
  if (!deletedSet.size) return Array.isArray(cands) ? cands : [];
  return (Array.isArray(cands) ? cands : []).filter(candidate => !deletedSet.has(String(candidate?.id || "").trim()));
};

const previewPagesCount = preview => {
  if (!preview?.src) return 0;
  return Array.isArray(preview.pages) && preview.pages.length ? preview.pages.length : 1;
};

const previewWeight = preview => {
  if (!preview?.src) return 0;
  let score = 1;
  if (preview.kind === "pdf") score += Math.min(previewPagesCount(preview), 8);
  if (preview.previewMode === "full") score += 12;
  else if (preview.previewMode === "light") score += 5;
  else if (preview.previewMode === "cloud") score += 2;
  return score;
};

const pickPreferredResumePreview = (primary, fallback) => {
  if (!primary?.src) return fallback || null;
  if (!fallback?.src) return primary || null;
  return previewWeight(primary) >= previewWeight(fallback) ? primary : fallback;
};

const buildCloudSafeResumePreview = candidate => {
  const preview = candidate?.resumePreviewCloud || candidate?.resumePreview;
  if (!preview?.src) return null;
  const firstPage = (Array.isArray(preview.pages) && preview.pages.length ? preview.pages[0] : preview.src) || preview.src;
  if (!firstPage) return null;
  return {
    kind: preview.kind || "image",
    src: firstPage,
    pages: [firstPage],
    name: preview.name || candidate?.resumeFileName || "",
    pageCount: Number(preview.pageCount) || previewPagesCount(preview) || 1,
    previewMode: "cloud",
  };
};

const sanitizeCandidateForCloud = candidate => {
  if (!candidate || typeof candidate !== "object") return candidate;
  const { resumePreviewCloud, ...rest } = candidate;
  return {
    ...rest,
    resumePreview: buildCloudSafeResumePreview(candidate),
  };
};

const buildCloudSnapshot = (cfg, jobs, cands, usageLogs, deletedCandidateIds = []) => ({
  schemaVersion: CLOUD_SCHEMA_VERSION,
  cfg: pickCloudCfg(cfg),
  jobs: Array.isArray(jobs) ? jobs : [],
  cands: filterDeletedCandidates(cands, deletedCandidateIds).map(sanitizeCandidateForCloud),
  usageLogs: Array.isArray(usageLogs) ? usageLogs : [],
  deletedCandidateIds: normalizeDeletedIds(deletedCandidateIds),
});

const buildRuntimeSnapshot = (cfg, jobs, cands, usageLogs, deletedCandidateIds = []) => ({
  schemaVersion: CLOUD_SCHEMA_VERSION,
  cfg: pickCloudCfg(cfg),
  jobs: Array.isArray(jobs) ? jobs : [],
  cands: filterDeletedCandidates(cands, deletedCandidateIds),
  usageLogs: Array.isArray(usageLogs) ? usageLogs : [],
  deletedCandidateIds: normalizeDeletedIds(deletedCandidateIds),
});

const entityTime = entity => {
  const value = entity?.updatedAt || entity?.createdAt || "";
  const ts = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ts) ? ts : 0;
};

const pickRicherValue = (preferred, fallback) => {
  if (preferred == null || preferred === "") return fallback;
  if (Array.isArray(preferred) && !preferred.length) return fallback;
  if (typeof preferred === "object" && !Array.isArray(preferred) && !Object.keys(preferred).length) return fallback;
  return preferred;
};

// 客户端版逐轮合并，与服务端 functions/api/state.js:mergeInterviews 同款逻辑。
// 关键：保留 extractedQA、interview_location 等子字段，避免整段替换导致数据丢失。
const mergeInterviewsList = (newerInterviews = [], olderInterviews = []) => {
  if (!Array.isArray(newerInterviews) || !newerInterviews.length) return olderInterviews || [];
  if (!Array.isArray(olderInterviews) || !olderInterviews.length) return newerInterviews;
  const merged = newerInterviews.map(item => ({ ...item }));
  olderInterviews.forEach(olderInterview => {
    if (!olderInterview) return;
    const newerMatch = merged.find(ni =>
      ni && (
        (olderInterview.id != null && ni.id != null && ni.id === olderInterview.id) ||
        (ni.round && olderInterview.round && ni.round === olderInterview.round) ||
        (ni.date && olderInterview.date && ni.date === olderInterview.date)
      )
    );
    if (!newerMatch) {
      merged.push(olderInterview);
      return;
    }
    Object.keys(olderInterview).forEach(key => {
      if (newerMatch[key] == null || newerMatch[key] === "") {
        newerMatch[key] = olderInterview[key];
      }
    });
  });
  return merged;
};

const mergeCandidateRecord = (left, right) => {
  const newer = entityTime(left) > entityTime(right) ? left : right;
  const older = newer === left ? right : left;
  const mergedTime = Math.max(entityTime(left), entityTime(right));
  const manualStatusRecord = [left, right]
    .filter(item => item?.statusSource === "manual" && item?.status)
    .sort((a, b) => entityTime(b) - entityTime(a))[0];
  return {
    ...older,
    ...newer,
    name: pickRicherValue(newer?.name, older?.name),
    jobId: newer?.jobId ?? older?.jobId ?? null,
    status: manualStatusRecord?.status || pickRicherValue(newer?.status, older?.status) || "pending",
    statusSource: manualStatusRecord ? "manual" : (pickRicherValue(newer?.statusSource, older?.statusSource) || "system"),
    resume: pickRicherValue(newer?.resume, older?.resume),
    resumeSignature: pickRicherValue(newer?.resumeSignature, older?.resumeSignature || buildResumeSignature(newer?.resume || older?.resume || "")),
    resumeFileName: pickRicherValue(newer?.resumeFileName, older?.resumeFileName),
    resumePreview: pickPreferredResumePreview(newer?.resumePreview, older?.resumePreview),
    resumePreviewCloud: pickPreferredResumePreview(newer?.resumePreviewCloud, older?.resumePreviewCloud),
    screening: pickRicherValue(newer?.screening, older?.screening),
    questions: pickRicherValue(newer?.questions, older?.questions) || null,
    interviews: mergeInterviewsList(newer?.interviews, older?.interviews),
    scheduledAt: pickRicherValue(newer?.scheduledAt, older?.scheduledAt) || null,
    interviewRound: pickRicherValue(newer?.interviewRound, older?.interviewRound) || null,
    interviewLocation: newer?.interviewLocation ?? older?.interviewLocation ?? null,
    interviewLink: newer?.interviewLink ?? older?.interviewLink ?? null,
    interviewNotes: newer?.interviewNotes ?? older?.interviewNotes ?? null,
    directorVerdict: pickRicherValue(newer?.directorVerdict, older?.directorVerdict) || null,
    updatedAt: (mergedTime ? new Date(mergedTime) : new Date()).toISOString(),
  };
};

const mergeJobsById = (localJobs = [], remoteJobs = []) => {
  const map = new Map();
  [...remoteJobs, ...localJobs].forEach(job => {
    if (!job?.id) return;
    const existing = map.get(job.id);
    if (!existing) {
      map.set(job.id, job);
      return;
    }
    map.set(job.id, entityTime(job) > entityTime(existing) ? { ...existing, ...job } : { ...job, ...existing });
  });
  return [...map.values()];
};

const mergeCandidates = (localCands = [], remoteCands = []) => {
  const map = new Map();
  [...remoteCands, ...localCands].forEach(candidate => {
    if (!candidate) return;
    const signature = candidate.resumeSignature || buildResumeSignature(candidate.resume || "");
    const key = candidate.id ? `id:${candidate.id}` : signature ? `sig:${signature}` : `name:${normalizeDuplicateField(candidate.name)}|file:${normalizeDuplicateField(candidate.resumeFileName)}`;
    const enriched = signature ? { ...candidate, resumeSignature: signature } : candidate;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, enriched);
      return;
    }
    map.set(key, mergeCandidateRecord(existing, enriched));
  });
  return [...map.values()].sort((a, b) => entityTime(b) - entityTime(a));
};

const mergeUsageLogs = (localLogs = [], remoteLogs = []) => {
  const map = new Map();
  [...remoteLogs, ...localLogs].forEach(log => {
    if (!log?.date || !log?.provider) return;
    const key = `${log.date}-${log.provider}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, log);
      return;
    }
    map.set(key, {
      ...existing,
      ...log,
      input: Math.max(Number(existing.input) || 0, Number(log.input) || 0),
      output: Math.max(Number(existing.output) || 0, Number(log.output) || 0),
      calls: Math.max(Number(existing.calls) || 0, Number(log.calls) || 0),
    });
  });
  return [...map.values()].sort((a, b) => `${a.date}-${a.provider}`.localeCompare(`${b.date}-${b.provider}`));
};

const mergeCloudSnapshots = (localState, remoteState) => ({
  deletedCandidateIds: mergeDeletedIds(localState.deletedCandidateIds, remoteState.deletedCandidateIds),
  cfg: { ...remoteState.cfg, ...localState.cfg },
  jobs: mergeJobsById(localState.jobs, remoteState.jobs),
  cands: filterDeletedCandidates(
    mergeCandidates(localState.cands, remoteState.cands),
    mergeDeletedIds(localState.deletedCandidateIds, remoteState.deletedCandidateIds)
  ),
  usageLogs: mergeUsageLogs(localState.usageLogs, remoteState.usageLogs),
  updatedAt: remoteState.updatedAt || localState.updatedAt || "",
});

const normalizeCloudState = payload => {
  const state = payload && typeof payload === "object" && "state" in payload ? payload.state : payload;
  return {
    cfg: state?.cfg && typeof state.cfg === "object" ? state.cfg : {},
    jobs: Array.isArray(state?.jobs) ? state.jobs : [],
    cands: Array.isArray(state?.cands) ? state.cands : [],
    usageLogs: Array.isArray(state?.usageLogs) ? state.usageLogs : [],
    deletedCandidateIds: normalizeDeletedIds(state?.deletedCandidateIds),
    updatedAt: state?.updatedAt || payload?.updatedAt || "",
  };
};

const serializeComparableCloudState = state => JSON.stringify({
  cfg: state?.cfg || {},
  jobs: Array.isArray(state?.jobs) ? state.jobs : [],
  cands: Array.isArray(state?.cands) ? state.cands.map(sanitizeCandidateForCloud) : [],
  usageLogs: Array.isArray(state?.usageLogs) ? state.usageLogs : [],
  deletedCandidateIds: normalizeDeletedIds(state?.deletedCandidateIds),
});

const getLatestStateEntityTime = state => {
  const jobTs = Array.isArray(state?.jobs) ? state.jobs.reduce((max, item) => Math.max(max, entityTime(item)), 0) : 0;
  const candTs = Array.isArray(state?.cands) ? state.cands.reduce((max, item) => Math.max(max, entityTime(item)), 0) : 0;
  const usageTs = Array.isArray(state?.usageLogs) ? state.usageLogs.reduce((max, item) => {
    const ts = item?.date ? new Date(`${item.date}T23:59:59`).getTime() : 0;
    return Math.max(max, Number.isFinite(ts) ? ts : 0);
  }, 0) : 0;
  return Math.max(jobTs, candTs, usageTs);
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

export async function fetchCloudPreview(token = "", candidateId = "") {
  const id = String(candidateId || "").trim();
  if (!id) return null;
  const url = `${ENV_PREVIEW_URL}?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: buildCloudHeaders(token) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `云端简历快照读取失败 ${res.status}`);
  return data?.preview || null;
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

async function fetchModelStatus(token = "") {
  const res = await fetch(ENV_MODEL_STATUS_URL, { headers: buildCloudHeaders(token) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `模型状态读取失败 ${res.status}`);
  return data;
}

const resolveProxyProviderSelection = (cfg, providers = []) => {
  const connectedProviders = (Array.isArray(providers) ? providers : []).filter(item => item?.configured);
  if (!connectedProviders.length) return null;
  const connectedIds = connectedProviders.map(item => item.id).filter(Boolean);
  const currentProviderConnected = connectedIds.includes(cfg?.provider);
  const currentProviderModels = PROVIDERS[cfg?.provider]?.models || [];
  const currentModelValid = currentProviderModels.some(item => item.id === cfg?.model);
  const targetProviderId = currentProviderConnected ? cfg.provider : connectedIds[0];
  const targetProviderModels = PROVIDERS[targetProviderId]?.models || [];
  const targetModel = currentProviderConnected && currentModelValid
    ? cfg.model
    : targetProviderModels[0]?.id;
  if (!targetProviderId || !targetModel) return null;
  if (cfg?.provider === targetProviderId && cfg?.model === targetModel) return null;
  return normalizeCfg({ ...(cfg || DEFAULT_CFG), provider: targetProviderId, model: targetModel });
};

export async function fetchKnowledgeState(token = "", jobId) {
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
  deepseek: {name:"DeepSeek",color:"#4f46e5",logo:"D",endpoint:"https://api.deepseek.com/v1/chat/completions",    keyPlaceholder:"sk-...",           models:[{id:"deepseek-v4-flash",name:"DeepSeek V4 Flash",note:"快速 / 非思考"},{id:"deepseek-v4-pro",name:"DeepSeek V4 Pro",note:"深度推理 / 思考模式"}],pricing:{"deepseek-v4-flash":{in:0.27,out:1.1},"deepseek-v4-pro":{in:0.55,out:2.19}}},
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
export const normalizeExtractedText = text => String(text || "")
  .replace(/\u0000/g, " ")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

export const buildReadableResumePreview = text => normalizeExtractedText(String(text || "")
  .replace(/\[\s*第\s*\d+\s*页\s*\]/gi, "\n")
  .replace(/([。！？；])/g, "$1\n")
  .replace(/(\d{4}[./-]\d{1,2}\s*[-~至到]+\s*(?:\d{4}[./-]\d{1,2}|至今))/g, "\n$1")
  .replace(/((?:19|20)\d{2}[./-]\d{1,2}(?:[./-]\d{1,2})?)/g, "\n$1")
  .replace(/(工作内容[：:])/g, "\n$1")
  .replace(/(项目内容[：:])/g, "\n$1")
  .replace(/(教育背景[：:])/g, "\n$1")
  .replace(/(自我评价[：:])/g, "\n$1")
  .replace(/(技能特长[：:])/g, "\n$1")
  .replace(/\n{3,}/g, "\n\n")
  .trim());

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const normalizeLooseListText = text => normalizeExtractedText(String(text || "")
  .replace(/([0-9]{1,2}\s*[\.、\)])\s*/g, "\n$1 ")
  .replace(/[•·●▪◦▸►]/g, "\n")
  .replace(/岗位职责[:：]/g, "\n岗位职责：")
  .replace(/任职要求[:：]/g, "\n任职要求：")
);

export const cleanListLine = line => String(line || "")
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

export const formatRubricContext = knowledge => {
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

export const formatQuestionBankContext = knowledge => {
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

export const getQuestionBankSourceMeta = (question, knowledge) => {
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

const ROLE_KEYWORD_GROUPS = [
  ["店铺运营", /(店铺运营|店务运营|店铺管理|店铺后台|电商运营|淘系运营|快手店铺|抖音店铺|商品运营|店铺店务|商城运营)/gi],
  ["短视频编导", /(编导|短视频|脚本|选题|内容策划|导演|内容组)/gi],
  ["剪辑后期", /(剪辑|后期|pr|ae|剪映|达芬奇|包装|调色)/gi],
  ["拍摄执行", /(拍摄|摄影|机位|打光|收音|器材)/gi],
  ["信息流投放", /(信息流|投流|投放|优化师|买量|roi|cpm|ctr|cvr|账户|出价|人群包|计划)/gi],
  ["直播运营", /(直播运营|中控|场控|直播间|主播|排品|千川|直播投流)/gi],
  ["内容运营", /(内容运营|内容增长|新媒体|种草|小红书|公众号|社媒运营)/gi],
];
const escapeRegExp = text => String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const extractRoleKeywords = text => {
  const src = String(text || "").toLowerCase();
  return ROLE_KEYWORD_GROUPS
    .filter(([, re]) => re.test(src))
    .map(([label]) => label);
};
export const extractRoleKeywordHits = (text, limit = 18) => {
  const src = String(text || "");
  const hits = [];
  ROLE_KEYWORD_GROUPS.forEach(([, re]) => {
    re.lastIndex = 0;
    const matches = src.match(re) || [];
    matches.forEach(hit => {
      const normalized = String(hit || "").trim();
      if (!normalized) return;
      if (!hits.some(item => item.toLowerCase() === normalized.toLowerCase())) hits.push(normalized);
    });
  });
  return hits.slice(0, limit);
};
export const highlightTextByKeywords = (text, keywords = []) => {
  const src = String(text || "");
  const list = Array.from(new Set((keywords || []).filter(Boolean))).sort((a, b) => b.length - a.length);
  if (!src || !list.length) return src;
  const regex = new RegExp(`(${list.map(escapeRegExp).join("|")})`, "gi");
  return src.split(regex).map((part, index) => {
    const matched = list.some(keyword => keyword.toLowerCase() === String(part).toLowerCase());
    return matched
      ? <mark key={`hit-${index}`} style={{background:"#fef3c7",color:"#92400e",padding:"0 2px",borderRadius:4}}>{part}</mark>
      : <span key={`txt-${index}`}>{part}</span>;
  });
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

export const resolveMatchedJob = (jobs, screening = {}, resumeText = "") => {
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

const COMPARE_METRIC_SYNONYMS = [
  [/该品类达人/g, "达人"],
  [/该品类/g, ""],
  [/相关经验|相关能力/g, ""],
  [/合作模式|合作方式/g, "合作"],
  [/报价体系|报价机制/g, "报价"],
  [/gmv|成交额|销售额/g, "业绩"],
  [/平台资源|平台经验/g, "平台"],
  [/独立全流程|独立完成从建联到成交的全流程/g, "全流程执行"],
  [/沟通谈判与关系维护|沟通谈判能力强/g, "沟通谈判"],
  [/抗压与目标接受度|抗压能力强|能接受gmv目标考核/g, "抗压目标"],
  [/业绩与数据分析能力|数据分析能力/g, "数据分析"],
];

const COMPARE_METRIC_CONCEPTS = [
  "达人","美妆","个护","护肤","合作","报价","平台","资源","快手","抖音","小红书",
  "全流程执行","执行","沟通谈判","关系维护","数据分析","业绩","抗压目标","管理",
  "建联","成交","活动","货盘","投流","素材","脚本","剪辑","直播","选品","转化",
];

const normalizeCompareMetricText = text => {
  let normalized = cleanListLine(text || "")
    .toLowerCase()
    .replace(/[，,。；;：:（）()【】[\]《》<>“”"'`]/g, "")
    .replace(/\s+/g, "");
  COMPARE_METRIC_SYNONYMS.forEach(([pattern, replacement]) => {
    normalized = normalized.replace(pattern, replacement);
  });
  return normalized.replace(/具备|拥有|有一定的|一定的|能够|可以|独立|熟悉|了解|经验|能力|相关|以及|并且|进行|完成|较强|很强|强/g, "");
};

const extractCompareMetricConcepts = text => {
  const normalized = normalizeCompareMetricText(text);
  const concepts = new Set();
  COMPARE_METRIC_CONCEPTS.forEach(token => {
    if (normalized.includes(token)) concepts.add(token);
  });
  return concepts;
};

const buildCompareMetricKey = text => {
  const concepts = [...extractCompareMetricConcepts(text)].sort();
  if (concepts.length) return concepts.join("|");
  return normalizeCompareMetricText(text);
};

const buildCompareMetricGrams = text => {
  const src = normalizeCompareMetricText(text);
  if (!src) return new Set();
  const grams = new Set([src]);
  for (let i = 0; i < src.length - 1; i += 1) grams.add(src.slice(i, i + 2));
  return grams;
};

const compareMetricSimilarity = (left, right) => {
  const a = normalizeCompareMetricText(left);
  const b = normalizeCompareMetricText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const conceptsA = extractCompareMetricConcepts(left);
  const conceptsB = extractCompareMetricConcepts(right);
  if (conceptsA.size && conceptsB.size) {
    const union = new Set([...conceptsA, ...conceptsB]);
    let inter = 0;
    conceptsA.forEach(token => { if (conceptsB.has(token)) inter += 1; });
    const conceptScore = inter / union.size;
    if (conceptScore >= 0.8) return Math.max(0.86, conceptScore);
    if (conceptScore >= 0.6) return Math.max(0.74, conceptScore);
  }
  const gramsA = buildCompareMetricGrams(a);
  const gramsB = buildCompareMetricGrams(b);
  const union = new Set([...gramsA, ...gramsB]);
  if (!union.size) return 0;
  let inter = 0;
  gramsA.forEach(token => { if (gramsB.has(token)) inter += 1; });
  return inter / union.size;
};

const buildCompareRows = (cands, jobs, type = "t0") => {
  const labelField = type === "t0" ? "requirement" : "dimension";
  const jobLabels = dedupeLines(cands.flatMap(candidate => {
    const effectiveJob = getEffectiveCandidateJob(jobs, candidate);
    return type === "t0"
      ? toLineArray(effectiveJob?.t0, 12)
      : toLineArray(effectiveJob?.t1, 12);
  }));
  const rows = [];
  const findRow = label => {
    if (!label) return null;
    let best = null;
    rows.forEach(row => {
      const score = compareMetricSimilarity(row.label, label);
      if (!best || score > best.score) best = { row, score };
    });
    return best && best.score >= 0.62 ? best.row : null;
  };
  const ensureRow = (label, preferCanonical = false) => {
    const cleaned = cleanListLine(label || "");
    if (!cleaned) return null;
    const key = buildCompareMetricKey(cleaned);
    const keyed = rows.find(row => row.metricKey === key && key);
    if (keyed) {
      if (preferCanonical && keyed.label.length < cleaned.length) keyed.label = cleaned;
      return keyed;
    }
    const existing = findRow(cleaned);
    if (existing) {
      if (preferCanonical && existing.label.length < cleaned.length) existing.label = cleaned;
      return existing;
    }
    const row = { key: `${type}-${rows.length}-${cleaned}`, label: cleaned, metricKey: key };
    rows.push(row);
    return row;
  };

  jobLabels.forEach(label => ensureRow(label, true));
  cands.forEach(candidate => {
    const items = type === "t0" ? candidate.screening?.t0?.items : candidate.screening?.t1?.items;
    (items || []).forEach(item => ensureRow(item?.[labelField] || "", false));
  });

  return rows
    .map(row => {
      const values = Object.fromEntries(cands.map(candidate => {
        const items = type === "t0" ? candidate.screening?.t0?.items : candidate.screening?.t1?.items;
        const best = (items || []).reduce((memo, item) => {
          const score = compareMetricSimilarity(row.label, item?.[labelField] || "");
          if (!memo || score > memo.score) return { item, score };
          return memo;
        }, null);
        return [candidate.id, best && best.score >= 0.46 ? best.item : null];
      }));
      const comparableCount = cands.filter(candidate => values[candidate.id]).length;
      return { ...row, values, comparableCount };
    })
    .filter(row => row.comparableCount >= Math.min(2, cands.length));
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
3. matchedJobReason 要明确说明你是根据哪些经历、产品、工具、产出和结果做出的岗位判断。
4. candidateName 必须是简历正文中明确标注的真实姓名（中文2-6字 或 英文4字以上）；如果简历开头没有清晰的"姓名/Name"标签，或只看到 PDF 水印/页眉里的零散英文片段，直接返回空字符串，不要从邮箱前缀、英文水印、教育/工作经历中拼凑出名字。`;
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
  const hasShopKeywords = /(店铺运营|店务运营|店铺管理|商品运营|货架|商城运营|电商运营|平台运营|商品|货盘|gmv|客单|选品|促销|上架|履约|客服|售后)/.test(corpus);
  const hasTrafficKeywords = /(投流|投手|信息流|优化师|买量|roi|cpm|ctr|cvr|消耗|投放)/.test(corpus);
  const hasContentKeywords = /(编导|剪辑|短视频|脚本|拍摄|pr|ae|剪映|达芬奇|内容策划|素材)/.test(corpus);

  if (hasShopKeywords) {
    blocks.push(`【该岗位基础问题池：店铺运营/商品运营方向】
- 必问真实店铺项目：围绕店铺、商品、货盘、活动、搜索、转化、GMV、达人分销、履约或售后中的真实经历，拆解目标、动作、结果与复盘。
- 必问活动与商品动作：如果简历写过活动策划、货盘优化、选品、上架、促销、资源位或页面改版，必须追问当时具体执行方案和判断依据。
- 必问关键经营数据：优先问 GMV、转化率、客单、搜索流量、点击、加购、支付、活动表现，不要把问题问成纯账号涨粉或社媒运营。
- 必问平台与协同：追问他如何和达人、客服、设计、仓配、内容或投放协同，以及谁主导节奏和决策。
- 如果简历里只出现账号运营、涨粉、内容号增长等经历，而没有明确店铺经营动作，不要围绕这类经验大篇幅出题，优先追问它和店铺经营的实际关联，关联弱则少问或不问。`);
  }

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
  const hasShopKeywords = /(店铺运营|店务运营|店铺管理|商品运营|货架|商城运营|电商运营|平台运营|商品|货盘|gmv|客单|选品|促销|上架|履约|客服|售后)/.test(text);
  const hasTrafficKeywords = /(投流|投放|信息流|roi|cpm|ctr|cvr|消耗|账户|出价|人群包|计划)/.test(text);
  const hasContentKeywords = /(编导|剪辑|脚本|拍摄|pr|ae|剪映|达芬奇|镜头|选题|前三秒|素材)/.test(text);

  if (hasShopKeywords) {
    hits.push(`【候选人特征：店铺运营/商品运营经历明显】
- 专业题优先围绕店铺经营、商品/货盘、活动策划、平台流量、转化、GMV、客单、达人分销和复盘动作。
- 如果简历里同时出现账号运营/涨粉经历，也不要默认围绕账号增长展开，除非这段经历和店铺经营结果有直接关系。
- 问数据时必须问店铺经营数据或素材判断依据，不要偏成社媒账号涨粉问题。`);
  }

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
const SHOP_ROLE_RE = /(店铺运营|店务运营|店铺管理|商品运营|货架|商城运营|电商运营|平台运营|店铺后台)/i;
const PLAN_METRIC_QUESTION_RE = /(cpm|ctr|cvr|roi|投放计划|计划数据|计划的|计划层|出价|人群包|账户消耗|整条计划|五维数据链)/i;
const CONTENT_ACCOUNT_QUESTION_RE = /(小红书|账号运营|账号涨粉|涨粉|社媒|公众号|内容号|粉丝|笔记种草|私域运营|账号矩阵)/i;
const SHOP_EXPERIENCE_ANCHOR_RE = /(店铺|商品|货盘|活动|策划|gmv|销售额|转化|客单|促销|上架|选品|达人|商城|履约|客服|售后|流量|搜索|货架|平台运营|复盘)/i;
const SHOP_ROLE_OPERATION_RE = /(店铺|商品|货盘|活动|选品|上架|促销|商城|货架|搜索|转化|gmv|客服|售后|达人|分销|平台运营)/i;
const DIRECTOR_ROLE_RE = /(编导|短视频|脚本|选题|导演|内容策划|内容组)/i;
const EDITOR_ROLE_RE = /(剪辑|后期|包装|调色|pr|ae|剪映|达芬奇)/i;
const SHOOT_ROLE_RE = /(拍摄|摄影|机位|打光|收音|器材|现场执行)/i;
const LIVE_ROLE_RE = /(直播运营|中控|场控|直播间|主播|排品|千川|直播投流)/i;
const CONTENT_OPS_ROLE_RE = /(内容运营|内容增长|新媒体|种草|小红书|公众号|社媒运营)/i;
const TRAFFIC_EXPERIENCE_ANCHOR_RE = /(投流|投放|信息流|roi|cpm|ctr|cvr|消耗|账户|出价|人群包|计划|素材|复盘|冷启|放量|跑量|优化)/i;
const DIRECTOR_EXPERIENCE_ANCHOR_RE = /(编导|短视频|脚本|选题|内容策划|导演|镜头|前三秒|节奏|素材|拍摄|项目|复盘|转化)/i;
const EDITOR_EXPERIENCE_ANCHOR_RE = /(剪辑|后期|包装|调色|pr|ae|剪映|达芬奇|节奏|卡点|字幕|成片|素材)/i;
const SHOOT_EXPERIENCE_ANCHOR_RE = /(拍摄|摄影|机位|打光|收音|器材|现场|布景|镜头|机型|脚本|棚拍|外拍)/i;
const LIVE_EXPERIENCE_ANCHOR_RE = /(直播运营|中控|场控|直播间|主播|排品|话术|场观|停留|在线|千川|转化|直播节奏)/i;
const CONTENT_OPS_EXPERIENCE_ANCHOR_RE = /(内容运营|内容增长|新媒体|种草|小红书|公众号|社媒运营|选题|发布|账号|粉丝|内容矩阵|互动|转化)/i;
const ROLE_GROWTH_RE = /(小红书|账号运营|账号涨粉|涨粉|社媒|公众号|内容号|粉丝|笔记|私域运营|账号矩阵)/i;
const STORE_ONLY_RE = /(店铺|商品|货盘|gmv|客单|选品|促销|上架|履约|客服|售后|商城|货架|搜索)/i;

const isContentRole = (job, cand) => CONTENT_ROLE_RE.test(`${job?.title||""}\n${job?.requirements||""}\n${cand?.resume||""}`);
const isTrafficRole = (job, cand) => TRAFFIC_ROLE_RE.test(`${job?.title||""}\n${job?.requirements||""}\n${cand?.resume||""}`);
const isShopRole = (job, cand) => SHOP_ROLE_RE.test(`${job?.title||""}\n${job?.requirements||""}\n${job?.t0||""}\n${job?.t1||""}\n${cand?.screening?.roleDirection||""}`);

const INTERVIEW_ROLE_PROFILES = [
  { label: "店铺运营", matchRe: SHOP_ROLE_RE, anchorRe: SHOP_EXPERIENCE_ANCHOR_RE, weakQuestionRe: ROLE_GROWTH_RE },
  { label: "信息流投放", matchRe: TRAFFIC_ROLE_RE, anchorRe: TRAFFIC_EXPERIENCE_ANCHOR_RE, weakQuestionRe: new RegExp(`${ROLE_GROWTH_RE.source}|${STORE_ONLY_RE.source}|${EDITOR_ROLE_RE.source}|${SHOOT_ROLE_RE.source}`, "i") },
  { label: "短视频编导", matchRe: DIRECTOR_ROLE_RE, anchorRe: DIRECTOR_EXPERIENCE_ANCHOR_RE, weakQuestionRe: new RegExp(`${PLAN_METRIC_QUESTION_RE.source}|${STORE_ONLY_RE.source}`, "i") },
  { label: "剪辑后期", matchRe: EDITOR_ROLE_RE, anchorRe: EDITOR_EXPERIENCE_ANCHOR_RE, weakQuestionRe: new RegExp(`${PLAN_METRIC_QUESTION_RE.source}|${STORE_ONLY_RE.source}|${ROLE_GROWTH_RE.source}`, "i") },
  { label: "拍摄执行", matchRe: SHOOT_ROLE_RE, anchorRe: SHOOT_EXPERIENCE_ANCHOR_RE, weakQuestionRe: new RegExp(`${PLAN_METRIC_QUESTION_RE.source}|${STORE_ONLY_RE.source}|${ROLE_GROWTH_RE.source}`, "i") },
  { label: "直播运营", matchRe: LIVE_ROLE_RE, anchorRe: LIVE_EXPERIENCE_ANCHOR_RE, weakQuestionRe: new RegExp(`${ROLE_GROWTH_RE.source}|${EDITOR_ROLE_RE.source}`, "i") },
  { label: "内容运营", matchRe: CONTENT_OPS_ROLE_RE, anchorRe: CONTENT_OPS_EXPERIENCE_ANCHOR_RE, weakQuestionRe: new RegExp(`${PLAN_METRIC_QUESTION_RE.source}|${STORE_ONLY_RE.source}`, "i") },
];

const ROLE_QUESTION_STYLES = {
  店铺运营: {
    domain: "店铺经营、商品、活动、GMV、转化",
    signal: "经营数据、用户反馈和转化信号",
    mismatch: "账号涨粉或泛内容运营",
  },
  信息流投放: {
    domain: "投放计划、素材、人群、出价、放量",
    signal: "计划数据、素材反馈和转化信号",
    mismatch: "纯内容制作或店铺后台杂务",
  },
  短视频编导: {
    domain: "选题、脚本、前三秒、转化表达、内容复盘",
    signal: "素材反馈、完播、点击和转化信号",
    mismatch: "店铺经营或计划级投流数据",
  },
  剪辑后期: {
    domain: "剪辑节奏、包装、调色、版本优化",
    signal: "成片反馈、完播、点击和修改信号",
    mismatch: "店铺经营或投放计划指标",
  },
  拍摄执行: {
    domain: "机位、灯光、收音、现场执行、拍摄应变",
    signal: "现场反馈、成片效果和执行风险信号",
    mismatch: "店铺经营或账号涨粉结果",
  },
  直播运营: {
    domain: "排品、直播节奏、主播协同、场观与转化",
    signal: "场观、停留、点击和转化信号",
    mismatch: "纯内容制作或账号涨粉",
  },
  内容运营: {
    domain: "选题、发布节奏、互动策略、内容增长",
    signal: "内容反馈、互动、完播和转化信号",
    mismatch: "店铺经营或计划级投流数据",
  },
};

const resolveInterviewRoleProfile = (job, cand) => {
  const targetText = `${job?.title||""}\n${job?.requirements||""}\n${job?.t0||""}\n${job?.t1||""}\n${cand?.screening?.roleDirection||""}`;
  const resumeText = `${cand?.resume||""}`;
  return INTERVIEW_ROLE_PROFILES.find(profile => profile.matchRe.test(targetText))
    || INTERVIEW_ROLE_PROFILES.find(profile => profile.matchRe.test(resumeText))
    || null;
};

const extractRoleAnchors = (profile, resumeText, limit = 6) => {
  const genericAnchors = extractResumeInterviewAnchors(resumeText, 12);
  if (!profile?.anchorRe) return genericAnchors.slice(0, limit);
  const roleAnchors = genericAnchors.filter(item => profile.anchorRe.test(item));
  return (roleAnchors.length ? roleAnchors : genericAnchors).slice(0, limit);
};

const extractShopRoleAnchors = (resumeText, limit = 6) => extractResumeInterviewAnchors(resumeText, 12)
  .filter(item => SHOP_EXPERIENCE_ANCHOR_RE.test(item))
  .slice(0, limit);

const buildRoleMatchedQuestion = (profile, question, cand, anchorOverride = "") => {
  const style = ROLE_QUESTION_STYLES[profile?.label] || ROLE_QUESTION_STYLES["内容运营"];
  const anchors = extractRoleAnchors(profile, cand?.resume || "", 8);
  const anchor = cleanListLine(anchorOverride || question?.resumeEvidence || anchors[0] || "一段最能代表你的真实经历");
  const step = Number(question?.step || 0);
  const base = {
    ...question,
    principle: "岗位强匹配",
    resumeEvidence: anchor,
  };
  switch (step) {
    case 4:
      return {
        ...base,
        tag: "专业能力",
        subTag: profile?.label,
        riskPoint: `是否真做过${style.domain}`,
        question: `简历里提到“${anchor}”，请完整还原这段经历：当时目标是什么，你具体做了哪些动作，最后结果怎样？`,
        purpose: `核验候选人是否真做过与${profile?.label || "当前岗位"}直接相关的核心经历`,
        goodAnswer: "能按目标、动作、结果、复盘完整拆开，并明确自己的角色",
        okAnswer: "能讲清经历主线，但判断依据和结果细节不足",
        badAnswer: "只能复述简历，讲不出真实动作",
        redFlag: `把岗位问题答成${style.mismatch}，讲不出与当前岗位直接相关的动作`,
        followUp: "继续追问当时你最先做的动作是什么，为什么先做那一步",
      };
    case 5:
      return {
        ...base,
        tag: "专业能力",
        subTag: "执行方案",
        riskPoint: "是否具备可落地的执行拆解能力",
        question: `还是围绕“${anchor}”，你当时具体怎么拆执行方案、定优先级、推进落地？如果重来一次，你会改哪一步？`,
        purpose: "核验候选人的执行方案设计能力和优先级判断",
        goodAnswer: "能讲清执行步骤、资源安排、判断依据和迭代动作",
        okAnswer: "能说出大致流程，但优先级和判断逻辑不够清晰",
        badAnswer: "只会讲结果，不会拆过程",
        redFlag: "把执行动作说成别人负责，自己只有配合",
        followUp: "继续追问当时最难推进的一步是什么，你靠什么推动落地",
      };
    case 6:
      return {
        ...base,
        tag: "专业能力",
        subTag: "判断依据",
        riskPoint: `是否真的懂${style.signal}`,
        question: `在“${anchor}”这段经历里，你当时主要看哪些${style.signal}来做判断？这些判断分别影响了你什么动作？`,
        purpose: "核验候选人是否真的有判断依据，而不是只会描述结果",
        goodAnswer: "能讲清关键数据或反馈信号、它们的含义和对应动作",
        okAnswer: "知道会看一些信号，但解释不完整",
        badAnswer: "说不清自己依据什么做判断",
        redFlag: "完全靠感觉拍脑袋，没有过程信号支撑",
        followUp: "继续追问当时最先看的一个信号是什么，它为什么比别的更重要",
      };
    case 7:
      return {
        ...base,
        tag: "关键鉴别题",
        subTag: "主导度核验",
        riskPoint: "是否只是参与者而非主导者",
        question: `如果把“${anchor}”这件事拆开，你能具体说明哪些部分是你亲自主导、哪些是协同配合完成的吗？请别只讲团队结果。`,
        purpose: "区分核心操盘手、主执行和参与者",
        goodAnswer: "能明确区分主导动作、协同动作和结果归因",
        okAnswer: "能讲部分个人动作，但边界仍不够清楚",
        badAnswer: "一直用“我们”表述，讲不出自己具体负责什么",
        redFlag: "把团队成绩直接等同于个人能力，没有证据证明主导度",
        followUp: "继续追问当时如果拿掉你，这件事最可能出问题的是哪一环",
      };
    case 8:
      return {
        ...base,
        tag: "关键鉴别题",
        subTag: "压力测试",
        riskPoint: "岗位适配与质疑应对",
        question: `如果我质疑“${anchor}”这段经历对当前${profile?.label || "岗位"}帮助有限，甚至更像${style.mismatch}，你会拿什么事实和逻辑来证明自己的价值？`,
        purpose: "观察候选人在被质疑时的稳定性、事实感和沟通方式",
        goodAnswer: "能稳住情绪，用事实、过程和结果补充说明自己的价值",
        okAnswer: "能解释，但事实支撑偏少",
        badAnswer: "急于反驳或只强调主观感受",
        redFlag: "情绪化、防御性强，无法就事论事",
        followUp: "继续追问如果我仍不认可，你还能补哪条最关键的证据",
      };
    case 9:
      return {
        ...base,
        tag: "关键鉴别题",
        subTag: "失败复盘",
        riskPoint: "失败归因和复盘深度",
        question: `请再回忆一次你在${style.domain}上结果不理想的经历，当时具体哪里出了问题？你后来是怎么避免再犯的？`,
        purpose: "看候选人面对失败时的归因方式、复盘深度和改进能力",
        goodAnswer: "能客观复盘问题、责任和后续改进动作",
        okAnswer: "能承认问题，但复盘不够具体",
        badAnswer: "只怪外部环境，讲不清自己该承担什么",
        redFlag: "无法承认错误，或者把失败说成别人问题",
        followUp: "继续追问后来你建立了什么机制，确保类似问题不再出现",
      };
    default:
      return base;
  }
};

const rewriteToShopQuestion = (question, cand) => {
  const anchors = extractShopRoleAnchors(cand?.resume || "", 6);
  const bestAnchor = anchors[0] || "店铺运营项目";
  let nextQuestion = "请回忆一次你过去负责店铺运营项目时，具体承担了哪些动作？你是怎么判断优先级并推进执行的？";
  let nextPurpose = "核验候选人是否真正做过店铺运营相关工作，而不是泛化的账号或内容运营";
  let nextGood = "能结合真实店铺/商品/活动案例，讲清目标、动作、数据和复盘";
  let nextOk = "能说出主要动作，但细节、判断依据和结果不够完整";
  let nextBad = "只能泛谈账号内容或曝光，讲不清店铺动作与经营结果";
  let nextRedFlag = "把店铺运营答成纯内容涨粉或账号维护，没有商品、活动、转化、流量动作";
  let nextFollow = "继续追问当时具体做了哪些动作，哪些数据最关键，为什么这么判断";

  if (/活动|策划|大促|促销/.test(bestAnchor)) {
    nextQuestion = "请回忆一次你过去负责店铺活动策划的经历，当时具体的执行方案是什么？你怎么定节奏、资源位和转化目标？";
    nextPurpose = "核验候选人是否真正做过店铺活动策划与落地，不只是参与配合";
    nextGood = "能讲清活动目标、排期、资源配置、商品策略、页面动作和复盘指标";
    nextFollow = "继续追问活动前、中、后分别盯哪些数据，发现问题后怎么临场调整";
  } else if (/商品|货盘|选品|上架/.test(bestAnchor)) {
    nextQuestion = "请回忆一次你过去负责商品或货盘优化的经历，你当时具体怎么判断该推哪些商品？又做了哪些调整动作？";
    nextPurpose = "核验候选人是否具备店铺商品运营和货盘判断能力";
    nextGood = "能讲清商品选择逻辑、价格带、转化表现和后续调整动作";
    nextFollow = "继续追问你当时主要看哪些商品数据，哪些信号会让你加推或下架";
  } else if (/gmv|销售额|转化|流量|搜索|货架|平台运营/.test(bestAnchor)) {
    nextQuestion = "请回忆一次你过去提升店铺GMV或转化的案例，当时具体做了哪些动作？你主要看哪些数据判断这些动作有效？";
    nextPurpose = "核验候选人是否真正做过店铺经营优化，而不是只做外围内容或账号维护";
    nextGood = "能结合真实店铺案例说明流量、转化、客单或活动数据，以及对应优化动作";
    nextFollow = "继续追问当时最关键的数据拐点是什么，你据此做了哪些后续动作";
  }

  return {
    ...question,
    tag: question?.tag || "专业能力",
    subTag: "店铺运营实操",
    principle: "岗位强匹配",
    resumeEvidence: cleanListLine(bestAnchor),
    question: nextQuestion,
    purpose: nextPurpose,
    goodAnswer: nextGood,
    okAnswer: nextOk,
    badAnswer: nextBad,
    redFlag: nextRedFlag,
    followUp: nextFollow,
  };
};

const rewriteToTrafficQuestion = (question, cand) => {
  const anchors = extractRoleAnchors(resolveInterviewRoleProfile({ title: "信息流投放" }, cand), cand?.resume || "", 6);
  const bestAnchor = anchors[0] || "信息流投放项目";
  return {
    ...question,
    tag: question?.tag || "专业能力",
    subTag: "投放实操",
    principle: "岗位强匹配",
    resumeEvidence: cleanListLine(bestAnchor),
    question: "请回忆一次你过去主导的信息流投放案例，当时的目标、核心动作、关键数据和排查思路分别是什么？",
    purpose: "核验候选人是否真正做过投放计划诊断、放量和异常排查，而不是只会讲泛化方法论",
    goodAnswer: "能讲清计划目标、关键数据区间、异常定位顺序和调整动作",
    okAnswer: "能说出投放动作，但数据和排查逻辑不够完整",
    badAnswer: "只会泛谈曝光和涨粉，讲不清计划、数据和优化动作",
    redFlag: "把投放问题答成内容运营或店铺运营，没有计划与数据闭环",
    followUp: "继续追问当时最关键的异常信号是什么，你为什么优先调整那一步",
  };
};

const rewriteToDirectorQuestion = (question, cand) => {
  const anchors = extractRoleAnchors(resolveInterviewRoleProfile({ title: "短视频编导" }, cand), cand?.resume || "", 6);
  const bestAnchor = anchors[0] || "短视频项目";
  return {
    ...question,
    tag: question?.tag || "专业能力",
    subTag: "编导实操",
    principle: "岗位强匹配",
    resumeEvidence: cleanListLine(bestAnchor),
    question: "请回忆一次你过去主导的短视频项目，当时你的选题、脚本、前三秒设计和转化思路分别是什么？",
    purpose: "核验候选人是否真正具备编导岗位需要的策划与拆解能力",
    goodAnswer: "能讲清选题依据、脚本结构、镜头安排、前三秒和复盘动作",
    okAnswer: "能描述视频内容，但结构化拆解和判断依据较弱",
    badAnswer: "只会泛谈账号或流量，讲不清具体内容设计与执行",
    redFlag: "把编导问题答成纯投放或纯账号增长，没有内容设计细节",
    followUp: "继续追问当时哪一段内容最关键，你是怎么判断它有效的",
  };
};

const rewriteToEditorQuestion = (question, cand) => {
  const anchors = extractRoleAnchors(resolveInterviewRoleProfile({ title: "剪辑后期" }, cand), cand?.resume || "", 6);
  const bestAnchor = anchors[0] || "剪辑项目";
  return {
    ...question,
    tag: question?.tag || "专业能力",
    subTag: "剪辑后期实操",
    principle: "岗位强匹配",
    resumeEvidence: cleanListLine(bestAnchor),
    question: "请回忆一次你过去主导后期剪辑的项目，当时你具体怎么处理节奏、包装、字幕或调色？",
    purpose: "核验候选人是否真正具备剪辑后期岗位的落地能力",
    goodAnswer: "能结合真实项目说明素材处理、节奏判断、包装选择和修改依据",
    okAnswer: "能描述软件和流程，但成片判断与优化动作不够具体",
    badAnswer: "只会泛谈内容方向，讲不清具体后期动作",
    redFlag: "把剪辑问题答成账号运营或投放，不会讲成片处理细节",
    followUp: "继续追问你当时改过哪几个版本，分别想解决什么问题",
  };
};

const rewriteToShootQuestion = (question, cand) => {
  const anchors = extractRoleAnchors(resolveInterviewRoleProfile({ title: "拍摄执行" }, cand), cand?.resume || "", 6);
  const bestAnchor = anchors[0] || "拍摄项目";
  return {
    ...question,
    tag: question?.tag || "专业能力",
    subTag: "拍摄执行实操",
    principle: "岗位强匹配",
    resumeEvidence: cleanListLine(bestAnchor),
    question: "请回忆一次你过去负责拍摄执行的项目，当时你具体怎么安排机位、灯光、收音和现场推进？",
    purpose: "核验候选人是否真正做过拍摄执行，而不是只参与旁支环节",
    goodAnswer: "能讲清现场条件、机位安排、灯光收音方案和应急处理",
    okAnswer: "能讲出拍摄流程，但现场判断和执行细节偏少",
    badAnswer: "只会讲脚本或后期，讲不清现场执行动作",
    redFlag: "把拍摄岗位问题答成内容号增长或投放，没有现场执行细节",
    followUp: "继续追问现场出过什么问题，你当时怎么快速调整",
  };
};

const rewriteToLiveOpsQuestion = (question, cand) => {
  const anchors = extractRoleAnchors(resolveInterviewRoleProfile({ title: "直播运营" }, cand), cand?.resume || "", 6);
  const bestAnchor = anchors[0] || "直播运营项目";
  return {
    ...question,
    tag: question?.tag || "专业能力",
    subTag: "直播间实操",
    principle: "岗位强匹配",
    resumeEvidence: cleanListLine(bestAnchor),
    question: "请回忆一次你过去负责直播间运营的经历，当时你怎么安排排品、节奏、主播协同和场观转化？",
    purpose: "核验候选人是否真正做过直播运营核心动作，而不是只做外围协助",
    goodAnswer: "能讲清排品逻辑、直播节奏、主播协同和关键数据复盘",
    okAnswer: "能说出主要分工，但直播动作和判断依据不够清楚",
    badAnswer: "只会泛谈内容或店铺，没有直播间运营细节",
    redFlag: "把直播运营问题答成账号涨粉或纯后期工作，没有直播间动作",
    followUp: "继续追问当时你最关注哪几个直播数据，为什么",
  };
};

const rewriteToContentOpsQuestion = question => ({
  ...question,
  tag: question?.tag || "专业能力",
  subTag: "内容增长实操",
  principle: "岗位强匹配",
  question: "请回忆一次你过去负责内容增长或账号运营的经历，当时你具体怎么定选题、发布节奏、互动策略和复盘标准？",
  purpose: "核验候选人是否真正做过内容运营，而不是泛泛讲内容感觉",
  goodAnswer: "能讲清选题、发布、互动、增长判断和复盘动作",
  okAnswer: "能说出基本流程，但增长判断和复盘不够具体",
  badAnswer: "只会泛谈内容感觉或投放，不会讲内容增长动作",
  redFlag: "把内容运营答成纯投流或店铺经营，没有内容增长逻辑",
  followUp: "继续追问哪一轮内容调整最有效，你依据什么做判断",
});

const looksLikeShopRelevantQuestion = question => {
  const corpus = [
    question?.question,
    question?.resumeEvidence,
    question?.purpose,
    question?.tag,
    question?.subTag,
    question?.followUp,
  ].join("\n");
  return SHOP_ROLE_OPERATION_RE.test(corpus);
};

const shouldRewriteToShopQuestion = (question, cand) => {
  const corpus = [
    question?.question,
    question?.resumeEvidence,
    question?.purpose,
    question?.tag,
    question?.subTag,
    question?.followUp,
  ].join("\n");
  const step = Number(question?.step || 0);
  if (step < 4 || step > 9) return false;
  if (CONTENT_ACCOUNT_QUESTION_RE.test(corpus)) return true;
  if (!looksLikeShopRelevantQuestion(question) && /(账号|涨粉|粉丝|笔记|内容号|社媒|公众号|小红书|短视频账号)/.test(corpus)) return true;
  const anchors = extractShopRoleAnchors(cand?.resume || "", 4);
  if (anchors.length && !SHOP_ROLE_OPERATION_RE.test(String(question?.resumeEvidence || "")) && /经历深挖|关键鉴别题|专业能力/.test(`${question?.stepName||""}${question?.tag||""}`)) {
    return true;
  }
  return false;
};

const rewriteQuestionByRoleProfile = (profile, question, cand) => {
  if (!profile) return question;
  return buildRoleMatchedQuestion(profile, question, cand);
};

const shouldRewriteQuestionByRoleProfile = (profile, question, cand) => {
  if (!profile) return false;
  if (profile.label === "店铺运营") return shouldRewriteToShopQuestion(question, cand);
  const corpus = [
    question?.question,
    question?.resumeEvidence,
    question?.purpose,
    question?.tag,
    question?.subTag,
    question?.followUp,
  ].join("\n");
  const step = Number(question?.step || 0);
  if (step < 4 || step > 9) return false;
  if (profile.weakQuestionRe?.test(corpus)) return true;
  const anchors = extractRoleAnchors(profile, cand?.resume || "", 4);
  if (anchors.length && !profile.anchorRe?.test(String(question?.resumeEvidence || "")) && /经历深挖|关键鉴别题|专业能力/.test(`${question?.stepName||""}${question?.tag||""}`)) {
    return true;
  }
  return false;
};

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
  const roleProfile = resolveInterviewRoleProfile(job, cand);
  const contentOnly = isContentRole(job, cand) && !isTrafficRole(job, cand);
  return (questions || []).map(question => {
    const questionText = String(question?.question || "");
    if (shouldRewriteQuestionByRoleProfile(roleProfile, question, cand)) {
      return rewriteQuestionByRoleProfile(roleProfile, question, cand);
    }
    if (contentOnly && PLAN_METRIC_QUESTION_RE.test(questionText)) {
      return rewriteToContentMetricsQuestion(question);
    }
    return question;
  });
};

export function mergeQuestionFeedbackHistory(history = [], questions = []) {
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

const QUESTION_STEP_TEMPLATES = [
  { step: 1, stepName: "开场破冰" },
  { step: 2, stepName: "自我介绍" },
  { step: 3, stepName: "离职动机" },
  { step: 4, stepName: "经历深挖" },
  { step: 5, stepName: "经历深挖" },
  { step: 6, stepName: "经历深挖" },
  { step: 7, stepName: "关键鉴别题" },
  { step: 8, stepName: "关键鉴别题" },
  { step: 9, stepName: "关键鉴别题" },
  { step: 10, stepName: "反问" },
];

const QUESTION_ANCHOR_PREFERENCE = {
  1: 0,
  2: 0,
  3: 1,
  4: 0,
  5: 1,
  6: 2,
  7: 0,
  8: 1,
  9: 2,
  10: 0,
};

const STEP_DEFAULT_RISK_POINT = {
  1: "表达真实性与岗位相关度",
  2: "真实生态位与职责边界",
  3: "稳定性与求职动机",
  4: "是否真做过核心项目",
  5: "执行方案是否可落地",
  6: "判断依据是否扎实",
  7: "主导度是否注水",
  8: "压力下是否能稳定应对",
  9: "失败复盘是否到位",
  10: "关注点是否成熟且匹配岗位",
};

const extractResumeInterviewAnchors = (resumeText, limit = 8) => {
  const lines = normalizeLooseListText(resumeText)
    .split(/\n+/)
    .map(cleanListLine)
    .filter(Boolean);
  const prioritized = lines.filter(line => /(项目|活动|策划|投放|素材|脚本|拍摄|剪辑|店铺|gmv|roi|ctr|cvr|直播|选品|达人|复盘|增长|转化|活动方案|运营)/i.test(line));
  const selected = dedupeLines([...(prioritized.length ? prioritized : lines)]).slice(0, limit);
  return selected;
};

const normalizeGeneratedQuestions = questions => {
  const fallbackByStep = new Map(QUESTION_STEP_TEMPLATES.map(item => [item.step, item.stepName]));
  return (questions || [])
    .map((item, index) => {
      const parsedStep = Number(item?.step);
      const safeStep = Number.isFinite(parsedStep) && parsedStep >= 1 && parsedStep <= 10
        ? Math.round(parsedStep)
        : Math.min(index + 1, 10);
      return {
        ...item,
        step: safeStep,
        stepName: cleanListLine(item?.stepName || "") || fallbackByStep.get(safeStep) || `第${safeStep}步`,
        resumeEvidence: cleanListLine(item?.resumeEvidence || ""),
        riskPoint: cleanListLine(item?.riskPoint || ""),
      };
    })
    .sort((a, b) => Number(a.step) - Number(b.step));
};

const buildQuestionSignature = question => normalizeMatchText(question?.question || "");

const pickFallbackQuestionAnchor = (anchors, usedAnchors, step) => {
  const list = (anchors || []).map(cleanListLine).filter(Boolean);
  if (!list.length) return "";
  const preferredIndex = QUESTION_ANCHOR_PREFERENCE[step] ?? 0;
  for (let offset = 0; offset < list.length; offset += 1) {
    const anchor = list[(preferredIndex + offset) % list.length];
    const key = normalizeMatchText(anchor);
    if (key && !usedAnchors.has(key)) return anchor;
  }
  return list[preferredIndex % list.length];
};

const buildFallbackQuestionForStep = (template, roleProfile, cand, anchors, usedAnchors) => {
  const anchor = pickFallbackQuestionAnchor(anchors, usedAnchors, template.step) || "简历里最核心的一段经历";
  if (roleProfile && template.step >= 4 && template.step <= 9) {
    return buildRoleMatchedQuestion(
      roleProfile,
      { step: template.step, stepName: template.stepName, tag: template.step >= 7 ? "关键鉴别题" : "专业能力" },
      cand,
      anchor
    );
  }
  const roleLabel = roleProfile?.label || cleanListLine(cand?.screening?.roleDirection || "") || "当前岗位";
  const base = {
    step: template.step,
    stepName: template.stepName,
    principle: "只用过去看未来",
    resumeEvidence: cleanListLine(anchor),
    riskPoint: STEP_DEFAULT_RISK_POINT[template.step] || "岗位匹配风险",
  };
  switch (template.step) {
    case 1:
      return {
        ...base,
        tag: "破冰",
        subTag: "综合观察",
        question: `先从“${anchor}”这段经历开始，请你用最简洁的方式介绍一下这段经历为什么最能代表你现在的岗位能力。`,
        purpose: "用候选人最熟的真实经历开场，先看表达清晰度和真实感",
        goodAnswer: "能迅速讲清背景、角色、动作和结果，且和当前岗位相关",
        okAnswer: "能讲清大概经历，但重点不够聚焦",
        badAnswer: "只重复简历，没有具体做法和结果",
        redFlag: "一开口就是空泛概念，讲不清真实项目",
        followUp: "追问当时最关键的动作是什么，为什么由你来做",
      };
    case 2:
      return {
        ...base,
        tag: "背景核实",
        subTag: "组织架构",
        principle: "必须覆盖过去公司的组织架构",
        question: `围绕“${anchor}”这段经历，请具体说说当时团队结构、你的汇报对象、协同对象，以及你真正负责的边界。`,
        purpose: "核验候选人真实生态位，避免只听 title",
        goodAnswer: "能讲清组织结构、汇报关系、分工边界和真实主导范围",
        okAnswer: "能讲清团队关系，但职责边界偏模糊",
        badAnswer: "只会讲 title，讲不清谁管谁、谁做什么",
        redFlag: "把自己包装成负责人，却说不清真实汇报链和协同边界",
        followUp: "继续追问你真正拍板过什么，哪些事情必须先向上汇报",
      };
    case 3:
      return {
        ...base,
        tag: "动机考察",
        subTag: "稳定性",
        question: `请结合“${anchor}”这段经历和最近一份工作，具体说说你当时离开的真实原因，以及这次换工作的核心诉求。`,
        purpose: "判断离职动机、稳定性和岗位匹配预期",
        goodAnswer: "能具体说明离开原因、客观限制和下一份工作的真实诉求",
        okAnswer: "能说出原因，但更多是泛泛表述",
        badAnswer: "只说发展、学习等空话，避开真实原因",
        redFlag: "频繁归因外部，回避自己决策和适配问题",
        followUp: "继续追问如果遇到类似问题，你下一份工作会怎么降低重复发生的概率",
      };
    case 4:
      return {
        ...base,
        tag: "专业能力",
        subTag: "项目还原",
        principle: "岗位强匹配",
        question: `简历里提到“${anchor}”，请把这段经历完整还原一遍：当时目标是什么，你具体做了哪些动作，最后结果怎样？`,
        purpose: `核验候选人是否真做过与${roleLabel}相关的核心经历`,
        goodAnswer: "能按目标、动作、结果、复盘完整拆开，并明确个人角色",
        okAnswer: "能讲清主要动作，但判断依据和结果细节不足",
        badAnswer: "只能重复简历表述，讲不出真实执行过程",
        redFlag: "把亲身经历答成团队概况，缺少自己的具体动作",
        followUp: "继续追问当时哪一步最关键，为什么先做那一步",
      };
    case 5:
      return {
        ...base,
        tag: "专业能力",
        subTag: "执行拆解",
        principle: "显性指标打假",
        question: `还是围绕“${anchor}”这件事，你当时具体怎么拆执行方案、定优先级、推进落地？如果重来一次，你会改哪一步？`,
        purpose: "深挖候选人的执行方案设计能力和优先级判断",
        goodAnswer: "能拆清执行步骤、资源安排、判断依据和迭代动作",
        okAnswer: "知道大致流程，但优先级和判断逻辑不够清晰",
        badAnswer: "只会讲结果，不会拆过程",
        redFlag: "把执行动作说成别人负责，自己只有配合",
        followUp: "继续追问当时哪一步最容易失控，你怎么稳住结果",
      };
    case 6:
      return {
        ...base,
        tag: "专业能力",
        subTag: "判断依据",
        principle: "显性指标打假",
        question: `在“${anchor}”这段经历里，你当时主要看哪些信号、数据或反馈来做判断？这些判断分别影响了你什么动作？`,
        purpose: "核验候选人是否真的有判断依据，而不是只会描述结果",
        goodAnswer: "能讲清关键判断信号、数据含义和对应动作",
        okAnswer: "知道会看反馈或数据，但解释不完整",
        badAnswer: "说不清自己依据什么做判断",
        redFlag: "完全靠感觉拍脑袋，没有过程数据或反馈支撑",
        followUp: "继续追问当时最先看的一个信号是什么，它为什么比别的更重要",
      };
    case 7:
      return {
        ...base,
        tag: "关键鉴别题",
        subTag: "主导度核验",
        principle: "显性指标打假",
        question: `如果把“${anchor}”这件事拆开，你能具体说明哪些部分是你亲自主导、哪些是协同配合完成的吗？请别只讲团队结果。`,
        purpose: "区分核心操盘手、主执行和参与者",
        goodAnswer: "能明确区分主导动作、协同动作和结果归因",
        okAnswer: "能讲部分个人动作，但边界仍不够清楚",
        badAnswer: "一直用“我们”表述，讲不出自己具体负责什么",
        redFlag: "把团队成绩直接等同于个人能力，没有证据证明主导度",
        followUp: "继续追问当时如果拿掉你，这件事最可能出问题的是哪一环",
      };
    case 8:
      return {
        ...base,
        tag: "关键鉴别题",
        subTag: "压力测试",
        principle: "对抗性压力测试",
        question: `如果我质疑“${anchor}”这段经历的结果含金量不够，或者觉得它对当前岗位帮助有限，你会拿什么事实和逻辑来证明自己的价值？`,
        purpose: "观察候选人在质疑和压力下的稳定性、事实感和沟通方式",
        goodAnswer: "能稳住情绪，用事实、过程和结果补充说明自己的价值",
        okAnswer: "能解释，但事实支撑偏少",
        badAnswer: "急于反驳或只强调主观感受",
        redFlag: "情绪化、防御性强，无法就事论事",
        followUp: "继续追问如果最后我仍不认可，你会如何补充最关键的一条证据",
      };
    case 9:
      return {
        ...base,
        tag: "关键鉴别题",
        subTag: "失败复盘",
        principle: "隐性指标挖掘",
        question: `请再回忆一次和“${anchor}”相近、但结果不理想的经历，当时哪里出了问题？你后来是怎么避免再犯的？`,
        purpose: "看候选人面对失败时的归因方式、复盘深度和改进能力",
        goodAnswer: "能客观复盘问题、责任和后续改进动作",
        okAnswer: "能承认问题，但复盘不够具体",
        badAnswer: "只怪外部环境，讲不清自己该承担什么",
        redFlag: "无法承认错误，或者把失败说成别人问题",
        followUp: "继续追问后来你做了什么机制化动作，确保类似问题不再出现",
      };
    case 10:
    default:
      return {
        ...base,
        tag: "收尾",
        subTag: "反问",
        principle: "综合观察",
        question: "你还有什么问题想进一步了解？也可以直接说说你决定 offer 时最在意的两个条件。",
        purpose: "看候选人关注点是否成熟、务实且与岗位匹配",
        goodAnswer: "问题聚焦岗位、团队、目标或资源边界，判断成熟",
        okAnswer: "有一些问题，但更多停留在表层",
        badAnswer: "完全没有问题，或只问福利八卦",
        redFlag: "只关注短期利益，不关心岗位和工作内容",
        followUp: "追问如果这两个条件里只能满足一个，你会怎么选，为什么",
      };
  }
};

const ensureUniqueGeneratedQuestions = (questions, job, cand) => {
  const roleProfile = resolveInterviewRoleProfile(job, cand);
  const anchors = dedupeLines([
    ...extractRoleAnchors(roleProfile, cand?.resume || "", 12),
    ...extractResumeInterviewAnchors(cand?.resume || "", 12),
  ]).filter(Boolean);
  const usedSignatures = new Set();
  const usedAnchors = new Set();
  const result = [];

  QUESTION_STEP_TEMPLATES.forEach(template => {
    const stepCandidates = (questions || []).filter(item => Number(item?.step) === template.step);
    let picked = stepCandidates.find(item => {
      const signature = buildQuestionSignature(item);
      return signature && !usedSignatures.has(signature);
    });
    if (!picked) {
      picked = buildFallbackQuestionForStep(template, roleProfile, cand, anchors, usedAnchors);
    }
    const signature = buildQuestionSignature(picked);
    if (signature) usedSignatures.add(signature);
    if (picked?.resumeEvidence) {
      usedAnchors.add(normalizeMatchText(picked.resumeEvidence));
    }
    result.push({
      ...picked,
      step: template.step,
      stepName: template.stepName,
    });
  });

  return result;
};

const buildQuestionPrompt = (job, cand, knowledge) => {
  const roleLabel = job?.title || cand?.screening?.roleDirection || "待识别岗位";
  const rubricCtx = formatRubricContext(knowledge);
  const bankCtx = formatQuestionBankContext(knowledge);
  const feedbackGuardrails = buildQuestionFeedbackGuardrails(cand, knowledge);
  const roleBaselineCtx = buildRoleBaselinePrompt(job, cand);
  const candidateBiasCtx = buildCandidateBiasPrompt(cand);
  const interviewRules = getInterviewRulesText(job);
  const roleProfile = resolveInterviewRoleProfile(job, cand);
  const roleSpecificGuardrails = {
    店铺运营: "12. 如果岗位是店铺运营/商品运营/货架运营，禁止围绕小红书涨粉、账号运营、内容号增长、社媒矩阵等无直接店铺经营价值的经历出题；必须优先围绕店铺活动、商品/货盘、平台流量、转化、GMV、达人分销、履约协同等真实经历提问。",
    信息流投放: "12. 如果岗位是信息流投放/投手，禁止围绕纯内容号涨粉、账号运营或店铺后台杂务出题；必须优先围绕投放计划、素材、人群、出价、异常排查和数据闭环提问。",
    短视频编导: "12. 如果岗位是短视频编导，禁止围绕纯店铺后台经营或账号涨粉结果出题；必须优先围绕选题、脚本、前三秒、镜头、转化表达和内容复盘提问。",
    剪辑后期: "12. 如果岗位是剪辑后期，禁止围绕店铺经营数据、账号涨粉或投放计划细节出题；必须优先围绕剪辑节奏、包装、调色、软件能力和成片复盘提问。",
    拍摄执行: "12. 如果岗位是拍摄执行，禁止围绕店铺经营、投放计划或社媒涨粉出题；必须优先围绕机位、灯光、收音、现场推进和拍摄应变提问。",
    直播运营: "12. 如果岗位是直播运营，禁止围绕纯社媒账号涨粉或后期剪辑细节出题；必须优先围绕直播节奏、排品、主播协同、场观、停留、转化和复盘提问。",
    内容运营: "12. 如果岗位是内容运营/新媒体，禁止围绕店铺货盘经营或投放计划级数据闭环出题；必须优先围绕选题、发布节奏、互动策略、内容增长和复盘提问。",
  };
  const roleGuardrail = roleSpecificGuardrails[roleProfile?.label] || "";
  const resumeAnchors = roleProfile
    ? (() => {
        const anchors = extractRoleAnchors(roleProfile, cand.resume, 8);
        return anchors.length ? anchors : extractResumeInterviewAnchors(cand.resume, 8);
      })()
    : extractResumeInterviewAnchors(cand.resume, 8);
  return `岗位：${roleLabel} 要求：${job?.requirements||""}
简历摘要：${cand.resume?.slice(0,500)} 筛选结论：${cand.screening?.summary}
风险：${JSON.stringify(cand.screening?.risks||[])}
${resumeAnchors.length?`简历关键锚点：\n${resumeAnchors.map((item,index)=>`${index+1}. ${item}`).join("\n")}\n`:""}
${rubricCtx?`${rubricCtx}\n`:""}${bankCtx?`${bankCtx}\n`:""}${feedbackGuardrails?`${feedbackGuardrails}\n`:""}${interviewRules}
${roleBaselineCtx}
${candidateBiasCtx}
生成10道结构化面试题，返回JSON：
{"questions":[{"step":1,"stepName":"开场破冰","tag":"破冰","subTag":"综合观察","principle":"命中的准则名称","resumeEvidence":"对应简历锚点","riskPoint":"这道题想验证的风险点","question":"问题","purpose":"目的","goodAnswer":"好的回答...","okAnswer":"一般回答...","badAnswer":"差的回答...","redFlag":"红旗回答...","followUp":"追问方向..."}]}
固定步骤顺序：
1. 开场破冰
2. 自我介绍
3. 离职动机
4. 经历深挖
5. 经历深挖
6. 经历深挖
7. 关键鉴别题
8. 关键鉴别题
9. 关键鉴别题
10. 反问
要求：
1. 优先覆盖学习后的重点维度和高风险点，避免重复和空泛问题。
2. 必须返回合法 JSON，只能有一个顶层对象，顶层键名固定为 questions。
3. 每道题都要明确写出它命中的准则（principle）和对应的简历锚点（resumeEvidence）。
4. 所有问题必须指向候选人的真实过往案例，默认使用“请回忆一次你过去...” “你当时具体怎么做的...” 这样的问法。
5. 题目必须优先命中上面的“简历关键锚点”。如果简历里出现活动策划、项目操盘、素材优化、平台运营、达人对接等经历，就必须围绕这些真实经历追问具体执行方案、判断依据、复盘动作，不能脱离简历另起炉灶。
5.1 每道题都必须写 riskPoint，明确这道题到底想验证什么，例如“是否真做过”“是否只是参与者”“是否缺少判断依据”“是否岗位适配不足”。
6. 不要问泛泛的“如果你来我们公司会怎么做”，也不要把简历里没出现过的经历硬塞给候选人。
6.1 所有题目优先按“目标-动作-判断-结果-复盘”结构追问，不要停留在观点、方法论或空泛经验总结。
7. step 必须严格使用 1 到 10，每个数字只出现一次，stepName 必须与固定步骤顺序对应，不能把第10步放到前面。
8. 每个字段都用简洁中文，单个字段尽量控制在 40 字以内，避免输出过长导致 JSON 被截断。
9. 不要为了凑分类强行区分行为题、专业题，优先输出真正高区分度、便于追问、能从面试笔记里持续优化的问题。
10. 如果某个字段不适合展开，也必须返回空字符串，不要省略字段。
11. 如果候选人更偏内容/编导，而不是投流优化师，禁止生成计划级投放数据题；必须改问素材层数据、素材判断依据和内容优化动作。
12. 10道题必须各问不同角度，禁止同一问题、同一锚点、同一能力点只换步骤重复出现。
${roleGuardrail}`.trim();
};

const normalizeQuestionsPayload = payload => {
  const raw = Array.isArray(payload) ? payload
    : Array.isArray(payload?.questions) ? payload.questions
    : Array.isArray(payload?.data?.questions) ? payload.data.questions
    : Array.isArray(payload?.result?.questions) ? payload.result.questions
    : [];
  return normalizeGeneratedQuestions(raw);
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

export const QUESTION_FEEDBACK_OPTIONS = [
  { id: "high_value", label: "高价值", color: "#059669", bg: "#ecfdf5" },
  { id: "normal", label: "一般", color: "#2563eb", bg: "#eff6ff" },
  { id: "duplicate", label: "重复", color: "#d97706", bg: "#fffbeb" },
  { id: "invalid", label: "无效", color: "#dc2626", bg: "#fef2f2" },
];
export const getQuestionFeedbackOption = id => QUESTION_FEEDBACK_OPTIONS.find(option => option.id === id) || null;

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

export const getFinalAiRecommendation = cand => {
  const interviews = (cand?.interviews || []).filter(item => item?.assessment);
  if (interviews.length) {
    const latestDecision = interviews[interviews.length - 1]?.assessment?.decision || "";
    if (latestDecision === "通过") return "建议录用";
    if (latestDecision === "待定") return "待最终确认";
    if (latestDecision === "淘汰") return "建议淘汰";
  }
  return cand?.screening?.recommendation || "";
};

export const getAiVerdictTone = recommendation => {
  if (!recommendation) return "unknown";
  if (/(通过|录用)/.test(recommendation)) return "positive";
  if (/淘汰/.test(recommendation)) return "negative";
  return "neutral";
};

export const getHumanVerdictTone = verdict => {
  if (!verdict) return "unknown";
  if (["录用","通过"].includes(verdict)) return "positive";
  if (verdict === "淘汰") return "negative";
  return "neutral";
};

const buildLearningSample = (cand, job, verdict, reason) => {
  const aiRecommendation = getFinalAiRecommendation(cand);
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
    interviewNotesRaw: ((cand.interviews || [])
      .map((ir, idx) => {
        const round = ir?.round || `第${idx+1}轮`;
        const qa = Array.isArray(ir?.extractedQA) ? ir.extractedQA : [];
        const loc = ir?.assessment?.summary ? `\n  评估摘要：${ir.assessment.summary}` : "";

        let body = "";
        if (qa.length > 0) {
          body = qa.map((item, i) => {
            const q = String(item.question || "").trim();
            const a = String(item.answer || "").trim();
            const sig = item.signal ? `[${item.signal}]` : "";
            return `  ${i+1}. ${sig} 问：${q}${a ? `\n     答：${a}` : ""}`;
          }).join("\n");
        } else {
          const rawNotes = String(ir?.notes || "").trim();
          body = rawNotes ? `  原始笔记：\n${rawNotes.slice(0, 4000)}` : "";
        }

        if (!body && !loc) return "";
        return `[${round}]\n${body}${loc}`;
      })
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 12000)) || "",
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
- 备注：${sample.deltaNotes||"无"}
- 面试笔记原文：${sample.interviewNotesRaw||"无"}`).join("\n\n")}
输出JSON：
{"rubricSummary":"一句话总结这一岗位最新判断基准","rubric":{"hardRequirements":["硬门槛"],"coreDimensions":[{"dimension":"维度","weight":"高|中|低","note":"评分说明"}],"passSignals":["优先录用信号"],"redFlags":["高风险信号"],"calibrationTips":["避免误判的评分提醒"]},"questionBankSummary":"一句话总结最新题库策略","questionBank":{"highSignalQuestions":[{"question":"高价值问题","purpose":"为什么有效","targetSignal":"主要识别什么","step":"建议放在第几步"}],"questionPatterns":[{"pattern":"问题模板/提问方向","useWhen":"适用场景","why":"为什么有效"}],"followUpPatterns":[{"pattern":"追问方式","useWhen":"何时继续追问","why":"能挖出什么"}],"avoidQuestions":[{"question":"应该少问或淘汰的问题","reason":"为什么低效/重复/容易被套话"}]}}
要求：
1. 规则一定要能指导后续筛选和面试，不要空泛。
2. 题库必须优先消费"面试笔记原文"字段——从笔记中识别哪些问题真正问出了信息（候选人答得具体、暴露了能力或风险），哪些问题只是套话或重复。highSignalQuestions 必须能在某条笔记原文里找到出处或同类问法。avoidQuestions 必须基于笔记里出现的"问了但答不出有效信息"的题。interviewNotesRaw 字段已结构化抽取了真实面试问答（含 [经验][能力][动机][风险][其他] 五种信号标签）。highSignalQuestions 必须从这份真实问答中归纳，重点选择那些 signal 是「经验」「能力」「风险」、且候选人回答暴露关键差异的问题。avoidQuestions 应包含那些 answer 内容雷同、套话化、无信号增量的问题。不要虚构问题，所有题必须能在 interviewNotesRaw 中找到出处。
3. 不要强行按行为题/技术题分类，更重要的是高区分度、可追问、能和简历经历对上。
4. 如果历史样本不足，仍需输出一个保守版本。`;

export async function learnFromDirectorFeedback(cfg, cand, job, verdict, reason, recordTokens) {
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

export const getFileKind = file => {
  const n = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  if (n.endsWith(".docx")) return "docx";
  if (type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/") || [".mp3",".m4a",".wav",".aac",".ogg",".oga",".webm",".mp4",".mpeg",".mpga"].some(ext=>n.endsWith(ext))) return "audio";
  if (type.startsWith("text/") || [".txt",".md",".markdown",".csv",".json",".html",".htm"].some(ext=>n.endsWith(ext))) return "text";
  return "unknown";
};

const resolveTranscribeUrl = proxyUrl => {
  const raw = String(proxyUrl || "").trim() || ENV_TRANSCRIBE_URL;
  if (!raw) return "";
  return raw.endsWith("/api/ai") ? `${raw.slice(0, -"/api/ai".length)}/api/transcribe` : raw;
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

const fileToDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ""));
  reader.onerror = () => reject(new Error("文件预览读取失败"));
  reader.readAsDataURL(file);
});

const dataUrlToImage = dataUrl => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("图片预览处理失败"));
  image.src = dataUrl;
});

const compressImageDataUrl = async (dataUrl, { maxWidth = 1600, maxHeight = 2200, quality = 0.95 } = {}) => {
  const image = await dataUrlToImage(dataUrl);
  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;
  if (!width || !height) return dataUrl;
  const ratio = Math.min(1, maxWidth / width, maxHeight / height);
  if (ratio >= 1 && dataUrl.length <= 180000) return dataUrl;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext("2d");
  if (!context) return dataUrl;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
};

export const createResumeVisualPreview = async (file, options = {}) => {
  const {
    maxPages = Number.POSITIVE_INFINITY,
    scale = 2.0,
    imageQuality = 0.98,
    forceImageCompression = false,
    imageMaxWidth = 1600,
    imageMaxHeight = 2200,
  } = options || {};
  const kind = getFileKind(file);
  if (kind === "image") {
    const rawSrc = await fileToDataUrl(file);
    const src = forceImageCompression
      ? await compressImageDataUrl(rawSrc, { maxWidth: imageMaxWidth, maxHeight: imageMaxHeight, quality: imageQuality })
      : rawSrc;
    return {
      kind: "image",
      src,
      pages: [src],
      name: file.name,
      pageCount: 1,
      previewMode: "full",
    };
  }
  if (kind === "pdf") {
    const pdfjsLib = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    const renderCount = Math.min(pdf.numPages, Math.max(1, Number.isFinite(maxPages) ? maxPages : pdf.numPages));
    for (let pageNumber = 1; pageNumber <= renderCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const canvas = await renderPdfPageToCanvas(page, scale);
      pages.push(canvas.toDataURL("image/png"));
    }
    return {
      kind: "pdf",
      src: pages[0] || "",
      pages,
      name: file.name,
      pageCount: pdf.numPages,
      previewMode: renderCount >= pdf.numPages ? "full" : "light",
    };
  }
  return null;
};

export const createCloudResumePreview = async file => {
  const kind = getFileKind(file);
  if (kind === "pdf") {
    // 提升清晰度：scale 0.72→1.5、quality 0.62→0.92。
    // 单页 preview 经 /api/preview 按需返回，单条 D1 行约 250-400KB，仍在 CPU 与 PUT 4MB 限制内。
    return createResumeVisualPreview(file, { maxPages: 1, scale: 1.5, imageQuality: 0.92 });
  }
  if (kind === "image") {
    return createResumeVisualPreview(file, {
      imageQuality: 0.92,
      forceImageCompression: true,
      imageMaxWidth: 1400,
      imageMaxHeight: 1900,
    });
  }
  return null;
};

export const extractFileText = async file => {
  const kind = getFileKind(file);
  if (kind==="text") return normalizeExtractedText(await file.text());
  if (kind==="docx") return extractDocxText(file);
  if (kind==="pdf") return extractPdfText(file);
  if (kind==="image") return extractImageText(file);
  throw new Error("暂不支持该文件格式");
};

// 从文件名提取姓名：去掉扩展名、常见后缀（"-简历"、"_简历"、"的简历"等）
export const extractNameFromFileName = (fileName = "") => {
  const base = String(fileName || "").replace(/\.[^./\\]+$/, "").trim();
  if (!base) return "";
  return base
    .replace(/[-_\s]*(简历|个人简历|求职简历|应聘简历|Resume|CV)[-_\s]*/gi, "")
    .replace(/[-_\s]*(的|-).*$/, "")
    .trim();
};

// 校验 AI 返回的候选人姓名是否合理：
//  - 必须是 2-15 字符
//  - 中文 2-6 字 / 英文 ≥ 4 字符 / 中英混合也接受
//  - 排除明显的错误识别（纯英文 2-3 字、纯标点等）
export const isValidCandidateName = name => {
  const trimmed = String(name || "").trim();
  if (!trimmed) return false;
  if (trimmed.length < 2 || trimmed.length > 15) return false;
  if (/^(未命名|未知|候选人|Unknown|N\/A|None|null)$/i.test(trimmed)) return false;
  const cnChars = (trimmed.match(/[一-龥]/g) || []).length;
  if (cnChars >= 2) return true;
  const enChars = (trimmed.match(/[A-Za-z]/g) || []).length;
  if (enChars >= 4 && cnChars === 0) return true;
  if (cnChars >= 1 && enChars >= 2) return true;
  return false;
};

// 综合解析候选人姓名：AI 返回 → 校验 → 文件名 fallback → "未命名"
export const resolveCandidateName = ({ aiName = "", manualName = "", fileName = "" } = {}) => {
  const manual = String(manualName || "").trim();
  if (manual) return manual;
  const ai = String(aiName || "").trim();
  if (isValidCandidateName(ai)) return ai;
  const fromFile = extractNameFromFileName(fileName);
  if (isValidCandidateName(fromFile)) return fromFile;
  return "未命名";
};

export async function transcribeAudioFile(cfg, file) {
  const kind = getFileKind(file);
  if (kind !== "audio") throw new Error("当前文件不是录音文件");
  if ((cfg?.mode || "proxy") === "proxy") {
    const url = resolveTranscribeUrl(cfg?.proxyUrl || "");
    if (!url) throw new Error("请先在「设置」中填写代理服务地址");
    const form = new FormData();
    form.append("file", file, file.name);
    const headers = {};
    if (cfg?.proxyToken?.trim()) headers.Authorization = `Bearer ${cfg.proxyToken.trim()}`;
    const res = await fetch(url, { method: "POST", headers, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `录音转写失败 ${res.status}`);
    return normalizeExtractedText(data.text || "");
  }

  const apiKey = cfg?.apiKeys?.openai || "";
  if (!apiKey) throw new Error("录音转写需要 OpenAI API Key，请先在设置中填写，或切回后端代理模式");
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "zh");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || data.message || `录音转写失败 ${res.status}`);
  return normalizeExtractedText(data.text || "");
}

// ─── CALL AI ─────────────────────────────────────────────────
async function callAI(cfg, system, user, onTokens, dirCtx="", options={}) {
  const {mode="proxy",provider="claude", model, apiKeys={}, proxyUrl="", proxyToken=""} = cfg;
  const prov = PROVIDERS[provider]||PROVIDERS.claude;
  const apiKey = apiKeys[provider]||"";
  const fullSys = dirCtx ? `${system}\n\n${dirCtx}` : system;
  const maxTokens = Math.max(600, Math.min(Number(options?.maxTokens) || 1200, 3200));
  const allowReasonerFallback = options?.allowReasonerFallback !== false;
  const shouldFallbackReasoner = provider==="deepseek" && model==="deepseek-v4-pro" && allowReasonerFallback;
  let inputT=0,outputT=0,text="";
  if (mode==="proxy") {
    const url=proxyUrl.trim();
    if(!url) throw new Error("请先在「设置」中填写代理服务地址");
    const headers={"Content-Type":"application/json"};
    if(proxyToken.trim()) headers.Authorization=`Bearer ${proxyToken.trim()}`;
    let res;
    let lastError=null;
    for(let attempt=0;attempt<3;attempt+=1){
      try{
        res=await fetch(url,{method:"POST",headers,body:JSON.stringify({provider,model,system:fullSys,user,maxTokens})});
        if(res.ok) break;
        const e=await res.json().catch(()=>({}));
        const message=e.error||e.message||`Proxy Error ${res.status}`;
        if(res.status>=500 && attempt<2){
          lastError=new Error(message);
          await sleep(350*(attempt+1));
          continue;
        }
        throw new Error(message);
      }catch(error){
        if(attempt<2){
          lastError=error;
          await sleep(350*(attempt+1));
          continue;
        }
        throw error||lastError;
      }
    }
    if(!res?.ok) throw lastError||new Error("代理服务暂时不可用");
    const d=await res.json();
    inputT=d.usage?.input||0; outputT=d.usage?.output||0;
    if(onTokens) onTokens(inputT,outputT,d.usage?.provider||d.meta?.provider||provider);
    if(d?.data && typeof d.data==="object") return d.data;
    text=typeof d?.data==="string"?d.data:"";
    const parsed=parseJsonResponse(text);
    if(shouldFallbackReasoner && parsed?.error){
      return callAI(
        {...cfg,model:"deepseek-v4-flash"},
        `${system}\n\n补充要求：你现在用于结构化输出环节，必须返回稳定 JSON，不要输出思考过程、解释或代码块。`,
        user,
        onTokens,
        dirCtx,
        {...options,allowReasonerFallback:false}
      );
    }
    return parsed;
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
  const parsed=parseJsonResponse(text);
  if(shouldFallbackReasoner && parsed?.error){
    return callAI(
      {...cfg,model:"deepseek-v4-flash"},
      `${system}\n\n补充要求：你现在用于结构化输出环节，必须返回稳定 JSON，不要输出思考过程、解释或代码块。`,
      user,
      onTokens,
      dirCtx,
      {...options,allowReasonerFallback:false}
    );
  }
  return parsed;
}

async function extractInterviewQAByLLM(cfg, notes, onTokens) {
  const text = String(notes || "").trim();
  if (!text || text.length < 50) return [];

  const truncated = text.slice(0, 12000);

  const system = `你是面试笔记结构化分析师。从面试笔记中抽取所有"面试官问候选人"的真实问答对。严格按 JSON 输出，不含任何 markdown 标记。`;

  const user = `下面是一份面试笔记（markdown 格式），请抽取所有"面试官提问 + 候选人回答"对。

抽取规则：
1. 显式标记的 Q/A、面试官提问、问答章节里的提问，都要抽取
2. 列表项作为问题、引用块（> A:）作为回答的，也要抽取
3. 隐含的"应当追问"点（如"需要确认xxx""需要验证xxx"），抽取为 question 但 answer 留空
4. 候选人反问（"面试者提问"章节）不要抽取，只要面试官问候选人的
5. 描述性段落（如"工作经历描述"）不是问答，不要抽取
6. 同一问题不要重复抽取，按笔记出现顺序输出

每条问答输出 signal 字段，从下列枚举选一个最贴切的：
- 经验：考察过往项目、岗位经历
- 能力：考察技能、方法论、解决问题方式
- 动机：考察求职原因、职业规划、稳定性
- 风险：考察可能的风险点（薪资、休息、抗压等）
- 其他：以上都不是

输出 JSON：
{
  "extractedQA": [
    {"question": "问题原文", "answer": "回答原文（无答案则空字符串）", "signal": "经验|能力|动机|风险|其他"}
  ]
}

笔记内容：
${truncated}`;

  try {
    const res = await callAI(
      {...cfg, provider:"deepseek", model:"deepseek-v4-flash"},
      system,
      user,
      onTokens,
      "",
      { maxTokens: 3000 }
    );
    if (res?.error) return [];
    let parsed = res;
    if (typeof res === "string") {
      try { parsed = JSON.parse(res); } catch { return []; }
    }
    const arr = Array.isArray(parsed?.extractedQA) ? parsed.extractedQA : [];
    return arr
      .filter(x => x && typeof x.question === "string" && x.question.trim().length >= 3)
      .map(x => ({
        question: String(x.question).trim().slice(0, 300),
        answer: String(x.answer || "").trim().slice(0, 800),
        signal: ["经验","能力","动机","风险","其他"].includes(x.signal) ? x.signal : "其他",
      }))
      .slice(0, 50);
  } catch (e) {
    return [];
  }
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

export async function runResumeScreening(cfg, job, resumeText, onTokens, dirCtx = "", jobOptions = []) {
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

const normalizeDuplicateField = value => cleanListLine(String(value || "")).toLowerCase().replace(/\s+/g,"");
export const buildResumeSignature = text => normalizeExtractedText(text)
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu,"")
  .slice(0,1600);

const findDuplicateResumeCandidate = (cands, { candidateName = "", fileName = "", resumeSignature = "" } = {}) => {
  const targetName = normalizeDuplicateField(candidateName);
  const targetFile = normalizeDuplicateField(fileName);
  const targetSig = resumeSignature || "";
  return (cands || []).find(candidate => {
    const existingSig = candidate?.resumeSignature || buildResumeSignature(candidate?.resume || "");
    if (targetSig && existingSig && existingSig === targetSig) return true;
    const existingName = normalizeDuplicateField(candidate?.name);
    const existingFile = normalizeDuplicateField(candidate?.resumeFileName);
    if (targetName && targetFile && existingName === targetName && existingFile === targetFile) return true;
    if (targetName && targetSig && existingName === targetName && existingSig && existingSig.slice(0,600) === targetSig.slice(0,600)) return true;
    return false;
  }) || null;
};

const buildDuplicateResumeError = duplicateCandidate => {
  const duplicateLabel = duplicateCandidate?.name || "未命名候选人";
  const duplicateFile = duplicateCandidate?.resumeFileName ? `（${duplicateCandidate.resumeFileName}）` : "";
  const error = new Error(`疑似重复导入：候选人「${duplicateLabel}」${duplicateFile} 已存在。若要更新，可直接打开该候选人并覆盖简历。`);
  error.code = "DUPLICATE_RESUME";
  error.duplicateCandidateId = duplicateCandidate?.id ?? null;
  error.duplicateCandidateName = duplicateLabel;
  error.duplicateCandidateFileName = duplicateCandidate?.resumeFileName || "";
  return error;
};

async function buildCandidateResumeUpdate({ candidate, cfg, job, file, onTokens, dirCtx = "", jobs = [], existingCandidates = [], previewMode = "full" }) {
  const resumePreview = previewMode
    ? await createResumeVisualPreview(
        file,
        previewMode === "light"
          ? { maxPages: 1, scale: 0.95, imageQuality: 0.82 }
          : {}
      ).catch(() => null)
    : null;
  const resumePreviewCloud = await createCloudResumePreview(file).catch(() => null);
  const extractedResume = await extractFileText(file);
  const { normalizedResume, screening } = await runResumeScreening(cfg, job, extractedResume, onTokens, dirCtx, job ? [] : jobs);
  const matchedJob = job || resolveMatchedJob(jobs, screening, normalizedResume);
  const candidateName = resolveCandidateName({
    aiName: screening.candidateName,
    manualName: candidate?.name,
    fileName: file.name,
  });
  const resumeSignature = buildResumeSignature(normalizedResume);
  const duplicateCandidate = findDuplicateResumeCandidate(existingCandidates, {
    candidateName,
    fileName: file.name,
    resumeSignature,
  });
  if (duplicateCandidate) throw buildDuplicateResumeError(duplicateCandidate);
  return {
    name: candidateName,
    jobId: matchedJob?.id ?? candidate?.jobId ?? null,
    resume: normalizedResume,
    resumeSignature,
    resumeFileName: file.name,
    resumePreview,
    resumePreviewCloud,
    resumePreviewStatus: resumePreview?.src ? (resumePreview?.previewMode==="light" ? "generating" : "ready") : "none",
    screening,
    ...resolveScreeningStatusPatch(candidate, screening.overallScore),
    questions: null,
    interviews: [],
    scheduledAt: null,
    interviewRound: null,
    directorVerdict: null,
    updatedAt: new Date().toISOString(),
  };
}

async function createCandidateFromResumeFile({ cfg, job, file, onTokens, dirCtx = "", name = "", jobs = [], existingCandidates = [], previewMode = "full", importMeta = {} }) {
  const resumePreview = previewMode
    ? await createResumeVisualPreview(
        file,
        previewMode === "light"
          ? { maxPages: 1, scale: 0.95, imageQuality: 0.82 }
          : {}
      ).catch(() => null)
    : null;
  const resumePreviewCloud = await createCloudResumePreview(file).catch(() => null);
  const extractedResume = await extractFileText(file);
  const { normalizedResume, screening } = await runResumeScreening(cfg, job, extractedResume, onTokens, dirCtx, job ? [] : jobs);
  const matchedJob = job || resolveMatchedJob(jobs, screening, normalizedResume);
  const candidateName = resolveCandidateName({
    aiName: screening.candidateName,
    manualName: name,
    fileName: file.name,
  });
  const resumeSignature = buildResumeSignature(normalizedResume);
  const duplicateCandidate = findDuplicateResumeCandidate(existingCandidates, {
    candidateName,
    fileName: file.name,
    resumeSignature,
  });
  if (duplicateCandidate) throw buildDuplicateResumeError(duplicateCandidate);
  return {
    candidate: {
      id: Date.now() + Math.floor(Math.random() * 1000000),
      jobId: matchedJob?.id ?? null,
      name: candidateName,
      status: getCandidateStatusFromScore(screening.overallScore),
      statusSource: "system",
      resume: normalizedResume,
      resumeSignature,
      resumeFileName: file.name,
      resumePreview,
      resumePreviewCloud,
      resumePreviewStatus: resumePreview?.src ? (resumePreview?.previewMode==="light" ? "generating" : "ready") : "none",
      screening,
      questions: null,
      interviews: [],
      scheduledAt: null,
      interviewRound: null,
      directorVerdict: null,
      importedAt: importMeta.importedAt || new Date().toISOString(),
      importBatchId: importMeta.importBatchId || "",
      importSeq: Number.isFinite(importMeta.importSeq) ? importMeta.importSeq : null,
      updatedAt: new Date().toISOString(),
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

export const STATUS={
  pending:  {label:"待筛选",color:"#6b7280",bg:"#f3f4f6"},
  screening:{label:"简历通过",color:"#2563eb",bg:"#eff6ff"},
  watching: {label:"观察中",color:"#d97706",bg:"#fffbeb"},
  interview:{label:"进入面试",color:"#7c3aed",bg:"#f5f3ff"},
  offer:    {label:"已录用",color:"#059669",bg:"#ecfdf5"},
  rejected: {label:"未通过",color:"#dc2626",bg:"#fef2f2"},
};
export const scColor=(v,max=5)=>v/max>=0.8?"#16a34a":v/max>=0.6?"#ca8a04":"#dc2626";
export const recSt = r => {
  const text = String(r || "");
  if (/(通过|录用)/.test(text)) return { c: "#16a34a", bg: "#dcfce7" };
  if (/淘汰/.test(text)) return { c: "#dc2626", bg: "#fee2e2" };
  return { c: "#ca8a04", bg: "#fef9c3" };
};
const getScoreBand = score => {
  const n = Number(score);
  if (!Number.isFinite(n)) return { label: "未筛选", color: "#6b7280", bg: "#f3f4f6", status: "pending", range: "等待 AI 首轮分析" };
  if (n >= 4.5) return { label: "合格", color: "#059669", bg: "#ecfdf5", status: "screening", range: "4.5 - 5.0" };
  if (n >= 3) return { label: "待定", color: "#d97706", bg: "#fffbeb", status: "watching", range: "3.0 - 4.4" };
  return { label: "淘汰", color: "#dc2626", bg: "#fef2f2", status: "rejected", range: "0 - 2.9" };
};
const getCandidateStatusFromScore = score => getScoreBand(score).status;
export const resolveScreeningStatusPatch = (candidate, score) => (
  candidate?.statusSource === "manual" && candidate?.status
    ? { status: candidate.status, statusSource: "manual" }
    : { status: getCandidateStatusFromScore(score), statusSource: "system" }
);
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
export const fmt=n=>n?.toLocaleString()||"0";
const todayStr=()=>new Date().toISOString().slice(0,10);
const isSoon=s=>{if(!s)return false;const d=(new Date(s)-new Date())/86400000;return d>=-0.1&&d<=7;};
export const fmtDate=s=>{if(!s)return "";const d=new Date(s);return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;};
export const SOFT_SHADOW="0 10px 30px rgba(15,23,42,0.06)";
export const CARD_RADIUS=16;
const EMPTY_JOB_FORM=()=>({title:"",department:"",level:"",requirements:"",t0:"",t1:"",salary:""});
const EMPTY_JOB_COMPOSER=()=>({open:false,form:EMPTY_JOB_FORM(),jdFileName:"",jdLoading:false,jdErr:"",parsedJobs:[],activeParsedJob:0,taskId:null});
const EMPTY_DASHBOARD_UPLOAD=()=>({files:[],loading:false,err:"",info:"",taskId:null,results:{}});
const dashboardFileKey=file=>`${file.name}-${file.size}-${file.lastModified}`;
const normalizeJobLevel = level => cleanListLine(level || "").toLowerCase();
export const isSingleRoundLevel = level => /(专员|组长|主管)/.test(normalizeJobLevel(level)) && !/(经理|总监)/.test(normalizeJobLevel(level));
export const getInterviewRoundsForJob = job => isSingleRoundLevel(job?.level) ? ["一面"] : ["一面","二面","三面","终面","HR面"];
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
  const [dashboardUpload,setDashboardUpload]=useState(EMPTY_DASHBOARD_UPLOAD);
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
  const [modelStatus,setModelStatus]=useState({loading:cfg.mode==="proxy",error:"",checkedAt:"",providers:[]});
  const [deletedCandidateIds,setDeletedCandidateIds]=useState(()=>load("hr_deleted_cands",[]));
  const latestCloudStateRef=useRef({cfg,jobs,cands,usageLogs,deletedCandidateIds,cloudUpdatedAt:"",dirtyCandidateState:false});

  useEffect(()=>save("hr_cfg",cfg),[cfg]);
  useEffect(()=>save("hr_jobs",jobs),[jobs]);
  useEffect(()=>save("hr_cands",cands),[cands]);
  useEffect(()=>save("hr_usage",usageLogs),[usageLogs]);
  useEffect(()=>save("hr_deleted_cands",deletedCandidateIds),[deletedCandidateIds]);
  useEffect(()=>{
    latestCloudStateRef.current={
      ...latestCloudStateRef.current,
      cfg,
      jobs,
      cands,
      usageLogs,
      deletedCandidateIds,
      cloudUpdatedAt:cloud.updatedAt||latestCloudStateRef.current.cloudUpdatedAt||"",
    };
  },[cfg,jobs,cands,usageLogs,deletedCandidateIds,cloud.updatedAt]);

  const reloadModelStatus=async()=>{
    if(cfg.mode==="direct"){
      setModelStatus({loading:false,error:"",checkedAt:"",providers:[]});
      return;
    }
    setModelStatus(prev=>({...prev,loading:true,error:""}));
    try{
      const data=await fetchModelStatus(cfg.proxyToken||"");
      setModelStatus({
        loading:false,
        error:"",
        checkedAt:data?.checkedAt||"",
        providers:Array.isArray(data?.providers)?data.providers:[],
      });
    }catch(error){
      setModelStatus({
        loading:false,
        error:error?.message||"模型状态读取失败",
        checkedAt:"",
        providers:[],
      });
    }
  };

  useEffect(()=>{
    reloadModelStatus();
  },[cfg.mode,cfg.proxyToken]);

  useEffect(()=>{
    if(cfg.mode!=="proxy" || modelStatus.loading || modelStatus.error) return;
    const nextCfg=resolveProxyProviderSelection(cfg, modelStatus.providers);
    if(nextCfg) setCfg(nextCfg);
  },[cfg,modelStatus.loading,modelStatus.error,modelStatus.providers]);

  useEffect(()=>{
    let cancelled=false;
    const pullCloudState=async({initial=false,silent=false}={})=>{
      const current=latestCloudStateRef.current;
      const lastCloudTs=current.cloudUpdatedAt?new Date(current.cloudUpdatedAt).getTime():0;
      const hasLocalUnsyncedChanges=!initial && getLatestStateEntityTime(current)>lastCloudTs;
      if(hasLocalUnsyncedChanges || (!initial && current.dirtyCandidateState)) return;
      if(initial){
        setCloudHydrated(false);
        setCloud(prev=>({...prev,phase:"loading",message:"正在连接云端数据库..."}));
      }else if(!silent){
        setCloud(prev=>({...prev,phase:"syncing",message:"正在同步云端最新简历库..."}));
      }
      try{
        const payload=await fetchCloudState(cfg.proxyToken||"");
        if(cancelled) return;
        const remote=normalizeCloudState(payload);
        const local=normalizeCloudState(buildRuntimeSnapshot(current.cfg,current.jobs,current.cands,current.usageLogs,current.deletedCandidateIds));
        const hasRemoteData=remote.jobs.length>0||remote.cands.length>0||remote.usageLogs.length>0||Object.keys(remote.cfg).length>0;
        if(hasRemoteData){
          const merged=mergeCloudSnapshots(local, remote);
          const localComparable=serializeComparableCloudState(local);
          const mergedComparable=serializeComparableCloudState(merged);
          const hasRemoteChanges=mergedComparable!==localComparable;
          if(hasRemoteChanges){
            setJobs(merged.jobs);
            setCandsSynced(merged.cands,{markDirty:false});
            setUsageLogs(merged.usageLogs);
            setDeletedCandidateIdsSynced(merged.deletedCandidateIds||[],{markDirty:false});
            setCfg(prev=>{
              const next=normalizeCfg({...prev,...merged.cfg,apiKeys:prev.apiKeys,proxyToken:prev.proxyToken});
              return JSON.stringify(pickCloudCfg(next))===JSON.stringify(pickCloudCfg(prev))?prev:next;
            });
          }
          const mergedExtraCount=Math.max(0, merged.cands.length - remote.cands.length);
          setCloud(prev=>({
            phase:"ready",
            message:hasRemoteChanges
              ? (initial
                ? (mergedExtraCount>0?"已合并本地与云端简历库并完成同步准备":"已从云端数据库载入数据")
                : "已同步云端最新简历库")
              : (initial ? "已从云端数据库载入数据" : (prev.message||"云端数据库已同步")),
            updatedAt:payload.updatedAt||remote.updatedAt||prev.updatedAt||"",
          }));
        }else{
          setCloud(prev=>({
            phase:"ready",
            message:initial?"云端数据库为空，将自动上传当前浏览器数据":(prev.message||"云端数据库已同步"),
            updatedAt:payload.updatedAt||remote.updatedAt||prev.updatedAt||"",
          }));
        }
      }catch(error){
        if(cancelled) return;
        setCloud(prev=>({phase:"error",message:error?.message||"云端数据库不可用，当前继续使用本地缓存",updatedAt:prev.updatedAt||""}));
      }finally{
        if(!cancelled && initial) setCloudHydrated(true);
      }
    };
    const onFocus=()=>pullCloudState({silent:true});
    const onVisibility=()=>{ if(document.visibilityState==="visible") pullCloudState({silent:true}); };
    pullCloudState({initial:true});
    const timer=setInterval(()=>pullCloudState({silent:true}),5000);
    window.addEventListener("focus",onFocus);
    document.addEventListener("visibilitychange",onVisibility);
    return()=>{
      cancelled=true;
      clearInterval(timer);
      window.removeEventListener("focus",onFocus);
      document.removeEventListener("visibilitychange",onVisibility);
    };
  },[cfg.proxyToken]);

  useEffect(()=>{
    if(!cloudHydrated) return;
    let cancelled=false;
    const timer=setTimeout(async()=>{
      try{
        setCloud(prev=>({...prev,phase:"syncing",message:"正在同步到云端数据库..."}));
        const payload=await pushCloudState(cfg.proxyToken||"",buildCloudSnapshot(cfg,jobs,cands,usageLogs,deletedCandidateIds));
        if(cancelled) return;
        latestCloudStateRef.current={...latestCloudStateRef.current,cloudUpdatedAt:payload.updatedAt||"",dirtyCandidateState:false};
        setCloud({phase:"ready",message:"云端数据库已同步",updatedAt:payload.updatedAt||""});
      }catch(error){
        if(cancelled) return;
        setCloud(prev=>({phase:"error",message:error?.message||"云端同步失败，当前数据仍保存在本地浏览器",updatedAt:prev.updatedAt||""}));
      }
    },700);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[cloudHydrated,cfg.mode,cfg.provider,cfg.model,cfg.theme,cfg.proxyUrl,cfg.proxyToken,jobs,cands,usageLogs,deletedCandidateIds]);

  const T=getTheme(cfg.theme);
  const dirCtx=buildDirCtx(cands,jobs);
  const setCandsSynced = (updater, options={}) => setCands(prev=>{
    const { markDirty = true } = options || {};
    const next = typeof updater === "function" ? updater(prev) : updater;
    latestCloudStateRef.current={...latestCloudStateRef.current,cands:next,dirtyCandidateState:markDirty?true:latestCloudStateRef.current.dirtyCandidateState};
    return next;
  });
  const setDeletedCandidateIdsSynced = (updater, options={}) => {
    const { markDirty = true } = options || {};
    setDeletedCandidateIds(prev=>{
      const next = typeof updater === "function" ? updater(prev) : updater;
      latestCloudStateRef.current={...latestCloudStateRef.current,deletedCandidateIds:next,dirtyCandidateState:markDirty?true:latestCloudStateRef.current.dirtyCandidateState};
      return next;
    });
  };
  const updCand=(id,patch)=>setCandsSynced(p=>{
    const next=p.map(c=>c.id===id?{...c,...patch,updatedAt:new Date().toISOString()}:c);
    return next;
  });
  const startCandidatePreviewUpgrade=async(candidateId,file)=>{
    if(!candidateId || !file || getFileKind(file)!=="pdf") return;
    updCand(candidateId,{resumePreviewStatus:"generating"});
    try{
      const fullPreview=await createResumeVisualPreview(file);
      const cloudPreview=await createCloudResumePreview(file).catch(()=>null);
      updCand(candidateId,{resumePreview:fullPreview,resumePreviewCloud:cloudPreview||undefined,resumePreviewStatus:fullPreview?.src?"ready":"none"});
    }catch{
      updCand(candidateId,{resumePreviewStatus:"failed"});
    }
  };
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
    const deletedId=String(cid||"").trim();
    setCandsSynced(prev=>{
      const next=prev.filter(c=>String(c.id||"").trim()!==deletedId);
      return next;
    });
    setDeletedCandidateIdsSynced(prev=>{
      const next=mergeDeletedIds(prev,[deletedId]);
      return next;
    });
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
  const startDashboardResumeImport=async(taskSnapshot=dashboardUpload)=>{
    const files=[...(taskSnapshot?.files||[])];
    const previousResults=taskSnapshot?.results||{};
    const pendingFiles=files.filter(file=>previousResults[dashboardFileKey(file)]?.status!=="success");
    if(!files.length) return;
    if(!pendingFiles.length){
      setDashboardUpload(prev=>({
        ...prev,
        info:"当前列表里的简历都已经导入完成。如需重新导入，请先清空列表再重新选择文件。",
        err:"",
      }));
      return;
    }
    const taskId=`dashboard-upload-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const importBatchId=`batch-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const importBatchTime=new Date().toISOString();
    setDashboardUpload(prev=>({
      ...prev,
      loading:true,
      err:"",
      info:"",
      taskId,
      startedAt:Date.now(),
      results:files.reduce((acc,file)=>{
        const key=dashboardFileKey(file);
        const existing=prev.results?.[key];
        acc[key]=existing?.status==="success" ? existing : {
          status:"processing",
          message:"正在识别并导入...",
          name:file.name,
        };
        return acc;
      },{...(prev.results||{})}),
    }));
    const created=[];
    const failed=[];
    const nextResults={...previousResults};
    const concurrency=Math.min(3,pendingFiles.length);
    let cursor=0;
    const syncProgress=(partialInfo="")=>{
      setDashboardUpload(prev=>{
        if(prev.taskId!==taskId) return prev;
        return {
          ...prev,
          results:{...nextResults},
          info:partialInfo||prev.info,
        };
      });
    };
    const processFile=async(file)=>{
      const key=dashboardFileKey(file);
      const importSeq=files.findIndex(item=>dashboardFileKey(item)===key);
      try{
        const { candidate }=await createCandidateFromResumeFile({
          cfg,
          job:null,
          file,
          onTokens:recordTokens,
          dirCtx,
          jobs,
          existingCandidates:[...cands,...created],
          previewMode:"light",
          importMeta:{
            importBatchId,
            importSeq,
            importedAt: importBatchTime,
          },
        });
        created.push(candidate);
        setCandsSynced(prev=>[candidate,...prev]);
        nextResults[key]={
          status:"success",
          message:`已导入：${candidate.name||"未命名候选人"} · ${getScoreBand(candidate.screening?.overallScore).label}${candidate.resumePreview?.previewMode==="light"?" · 正在后台补全完整预览":""}`,
          candidateId:candidate.id,
          name:file.name,
        };
        if(candidate.resumePreview?.previewMode==="light"){
          startCandidatePreviewUpgrade(candidate.id,file);
        }
      }catch(error){
        failed.push(`${file.name}：${error?.message||"识别失败"}`);
        nextResults[key]={
          status:"error",
          message:error?.message||"识别失败",
          name:file.name,
        };
      }
      const doneCount=Object.values(nextResults).filter(item=>item?.status==="success"||item?.status==="error").length;
      syncProgress(`正在批量导入：已完成 ${doneCount}/${files.length} 份。批量导入已自动跳过重型版式预览，速度会更快。`);
    };
    const workers=Array.from({length:concurrency},async()=>{
      while(cursor<pendingFiles.length){
        const file=pendingFiles[cursor];
        cursor+=1;
        await processFile(file);
      }
    });
    await Promise.all(workers);
    setDashboardUpload(prev=>{
      if(prev.taskId!==taskId) return prev;
      const summary=created.reduce((acc,candidate)=>{
        const label=getScoreBand(candidate.screening?.overallScore).label;
        if(label==="合格") acc.pass+=1;
        else if(label==="待定") acc.pending+=1;
        else if(label==="淘汰") acc.reject+=1;
        return acc;
      },{pass:0,pending:0,reject:0});
      return {
        ...prev,
        loading:false,
        info:created.length?`已导入 ${created.length} 份简历：合格 ${summary.pass} 份，待定 ${summary.pending} 份，淘汰 ${summary.reject} 份。文件列表已保留，你切页面回来也能继续查看处理状态。`:"",
        err:failed.length?failed.slice(0,3).join("；"):"",
        files:prev.files,
        results:nextResults,
        finishedAt:Date.now(),
      };
    });
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
      const questions=ensureUniqueGeneratedQuestions(
        normalizeGeneratedQuestionsForRole(normalizeQuestionsPayload(res), job, candidate),
        job,
        candidate
      );
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
      const extractedQA = await extractInterviewQAByLLM(cfg, notes, recordTokens).catch(()=>[]);
      const ni={round,notes,date:new Date().toLocaleDateString("zh-CN"),assessment,extractedQA};
      updCand(candidate.id,{
        interviews:[...(candidate.interviews||[]),ni],
        scheduledAt:null,
        status:getPostInterviewStatus(job, round, assessment.decision),
        statusSource:"system",
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
  const hasDashboardUploadRunning=!!dashboardUpload.loading;
  const needsSettingsAttention = cfg.mode === "direct"
    ? !Object.values(cfg.apiKeys||{}).some(Boolean)
    : !String(cfg.proxyUrl||"").trim();
  const dirMatch=dirDone.filter(c=>{
    const aiRec=getFinalAiRecommendation(c);
    const dir=c.directorVerdict.verdict;
    const aiTone=getAiVerdictTone(aiRec);
    const dirTone=getHumanVerdictTone(dir);
    return aiTone!=="unknown" && aiTone===dirTone;
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
      <aside style={{width:236,background:`linear-gradient(180deg, ${T.sidebar} 0%, #f7f9fc 100%)`,borderRight:`1px solid ${T.border}`,display:"flex",flexDirection:"column",flexShrink:0,boxShadow:"inset -1px 0 0 rgba(255,255,255,0.02)"}}>
        <div style={{display:"flex",gap:12,alignItems:"center",padding:"20px 16px 18px",borderBottom:`1px solid ${T.border}`,background:"rgba(255,255,255,0.72)",backdropFilter:"blur(8px)"}}>
          <div style={{width:38,height:38,borderRadius:12,background:T.accent,color:T.accentFg,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:12,flexShrink:0,boxShadow:"0 12px 28px rgba(15,23,42,0.18)"}}>HR</div>
          <div><div style={{fontSize:14,fontWeight:900,color:T.text}}>AI 招聘助手</div><div style={{fontSize:10,color:T.text4,marginTop:3,letterSpacing:"0.04em"}}>快手项目组</div></div>
        </div>
        <div style={{padding:"14px 12px 0",flex:1}}>
          {nav.map(n=>(
            <button key={n.id} onClick={()=>{setView(n.id);if(n.id!=="candidates")setSelCand(null);}}
              style={{display:"flex",alignItems:"center",gap:11,width:"100%",padding:"12px 13px",border:view===n.id?`1px solid ${T.border}`:"1px solid transparent",background:view===n.id?"rgba(255,255,255,0.86)":"transparent",borderRadius:14,cursor:"pointer",fontSize:13,color:view===n.id?T.text:T.text3,fontWeight:view===n.id?800:500,marginBottom:7,textAlign:"left",transition:"all 0.12s ease",boxShadow:view===n.id?SOFT_SHADOW:"none",position:"relative"}}>
              {view===n.id&&<span style={{position:"absolute",left:0,top:10,bottom:10,width:3,borderRadius:999,background:T.accent}}/>}
              <span style={{fontSize:15,width:24,height:24,textAlign:"center",display:"inline-flex",alignItems:"center",justifyContent:"center",borderRadius:8,background:view===n.id?`${T.accent}12`:"rgba(255,255,255,0.7)",color:view===n.id?T.accent:T.text3,boxShadow:view===n.id?"none":"inset 0 0 0 1px rgba(148,163,184,0.12)"}}>{n.icon}</span>
              <span style={{flex:1}}>{n.label}</span>
              {n.id==="settings"&&needsSettingsAttention&&<span style={{width:6,height:6,background:"#ef4444",borderRadius:"50%"}}/>}
              {n.id==="dashboard"&&hasDashboardUploadRunning&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#2563eb",color:"#fff",borderRadius:10}}>导入中</span>}
              {n.id==="dashboard"&&upcoming.length>0&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#ef4444",color:"#fff",borderRadius:10}}>{upcoming.length}</span>}
              {n.id==="jobs"&&jobComposer.jdLoading&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#2563eb",color:"#fff",borderRadius:10}}>识别中</span>}
              {n.id==="candidates"&&hasInterviewTaskRunning&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#2563eb",color:"#fff",borderRadius:10}}>评估中</span>}
              {n.id==="candidates"&&!hasInterviewTaskRunning&&hasQuestionTaskRunning&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#7c3aed",color:"#fff",borderRadius:10}}>题目中</span>}
            </button>
          ))}
          {compared.length>=2&&(
            <button onClick={()=>setShowCompare(true)}
              style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"11px 12px",border:`1px solid ${T.accent}`,background:`${T.accent}12`,borderRadius:14,cursor:"pointer",fontSize:12,color:T.accent,fontWeight:800,marginTop:12,boxShadow:"0 10px 24px rgba(15,23,42,0.06)"}}>
              <span>⊞</span>对比 {compared.length} 位候选人
            </button>
          )}
          {compared.length>0&&<button onClick={()=>setCompared([])} style={{width:"100%",padding:"6px",border:"none",background:"transparent",fontSize:11,color:T.text4,cursor:"pointer",marginTop:2}}>清除对比选择</button>}
        </div>
        {/* 底部：沉淀进度 + 今日用量 */}
        <div style={{padding:"12px 14px 14px",borderTop:`1px solid ${T.border}`,background:"rgba(255,255,255,0.78)"}}>
          {dirStats.total>0&&(
            <div style={{marginBottom:10,padding:"11px 12px",background:"#ffffff",borderRadius:14,border:`1px solid ${T.border}`,boxShadow:"0 10px 24px rgba(15,23,42,0.05)"}}>
              <div style={{fontSize:10,color:T.text4,marginBottom:3}}>总监判断沉淀</div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}><span style={{color:T.text3}}>{dirStats.total} 案例</span><span style={{color:T.accent,fontWeight:700}}>AI匹配 {dirStats.rate}%</span></div>
              <div style={{height:3,background:T.border2,borderRadius:2,marginTop:4}}><div style={{width:`${Math.min(dirStats.rate,100)}%`,height:"100%",background:dirStats.rate>=70?"#16a34a":"#6366f1",borderRadius:2}}/></div>
            </div>
          )}
          <div style={{padding:"11px 12px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:14,boxShadow:"0 10px 24px rgba(15,23,42,0.05)"}}>
          <div style={{fontSize:10,color:T.text4,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:6}}>今日用量</div>
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
        </div>
      </aside>

      <main style={{flex:1,overflow:"auto"}}>
        {view==="dashboard"  &&<DashboardView T={T} jobs={jobs} cands={cands} dirStats={dirStats} onJobClick={id=>{setSelJob(id);setView("jobs");}} onCandClick={openCand} cfg={cfg} recordTokens={recordTokens} dirCtx={dirCtx} dashboardUpload={dashboardUpload} setDashboardUpload={setDashboardUpload} startDashboardResumeImport={startDashboardResumeImport} cloud={cloud} jobComposer={jobComposer} questionTasks={questionTasks} interviewTasks={interviewTasks}/>}
        {view==="jobs"       &&<JobsView T={T} jobs={jobs} setJobs={setJobs} cands={cands} setCands={setCands} selJob={selJob} setSelJob={setSelJob} onCandClick={openCand} jobComposer={jobComposer} setJobComposer={setJobComposer} resetJobComposer={resetJobComposer} applyParsedJobToComposer={applyParsedJobToComposer} startJobFileParse={startJobFileParse}/>}
        {view==="candidates" &&<CandidatesView T={T} cands={cands} setCandsSynced={setCandsSynced} jobs={jobs} selCand={selCand} setSelCand={setSelCand} tab={candTab} setTab={setCandTab} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} compared={compared} toggleCompare={toggleCompare} questionTasks={questionTasks} interviewTasks={interviewTasks} startQuestionGeneration={startQuestionGeneration} startInterviewAssessment={startInterviewAssessment} removeCandidate={removeCandidate} startCandidatePreviewUpgrade={startCandidatePreviewUpgrade}/>}
        {view==="settings"   &&<SettingsView T={T} cfg={cfg} setCfg={setCfg} usageLogs={usageLogs} dirStats={dirStats} dirDone={dirDone} dirMatch={dirMatch} jobs={jobs} cloud={cloud} modelStatus={modelStatus} reloadModelStatus={reloadModelStatus}/>}
      </main>
    </div>
  );
}

// ─── COMPARE MODAL ───────────────────────────────────────────
function CompareModal({T,ids,cands,jobs,onClose}) {
  const cs=ids.map(id=>cands.find(c=>c.id===id)).filter(Boolean);
  const t0Rows=useMemo(()=>buildCompareRows(cs,jobs,"t0"),[cs,jobs]);
  const t1Rows=useMemo(()=>buildCompareRows(cs,jobs,"t1"),[cs,jobs]);
  const hasSharedMetrics = t0Rows.length || t1Rows.length;
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
        {!hasSharedMetrics&&<div style={{padding:"12px 14px",marginBottom:16,background:"#f8fafc",border:`1px solid ${T.border}`,borderRadius:12,fontSize:12,color:T.text3,lineHeight:1.8}}>
          当前只展示可互相对齐的共同维度。如果两位候选人来自不同岗位、或当前评估维度差异过大，建议先切到同岗位候选人再做对比。
        </div>}
        {/* T0 */}
        {t0Rows.length>0&&<CmpSec T={T} label="T0 硬性条件（共同维度）">
          {t0Rows.map(row=>(
            <div key={row.key} style={{display:"grid",gridTemplateColumns:`140px repeat(${cs.length},1fr)`,gap:12,padding:"8px 0",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:12,color:T.text3,alignSelf:"center"}}>{row.label}</div>
              {cs.map(c=><CmpScore key={c.id} it={row.values[c.id]}/> )}
            </div>
          ))}
        </CmpSec>}
        {/* T1 */}
        {t1Rows.length>0&&<CmpSec T={T} label="T1 核心评分（共同维度）">
          {t1Rows.map(row=>(
            <div key={row.key} style={{display:"grid",gridTemplateColumns:`140px repeat(${cs.length},1fr)`,gap:12,padding:"8px 0",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:12,color:T.text3,alignSelf:"center"}}>{row.label}</div>
              {cs.map(c=><CmpScore key={c.id} it={row.values[c.id]}/> )}
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
  if(!it) return <div style={{textAlign:"center"}}>
    <div style={{fontSize:12,fontWeight:700,color:"#94a3b8"}}>待核验</div>
    <div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>该候选人当前未评到这一共同维度</div>
  </div>;
  const pct=(it.score/(it.maxScore||5))*100;
  const c=scColor(it.score,it.maxScore||5);
  return(<div style={{textAlign:"center"}}><div style={{fontSize:16,fontWeight:800,color:c}}>{it.score}<span style={{fontSize:11,color:"#9ca3af"}}>/{it.maxScore||5}</span></div><div style={{height:3,background:"#e5e7eb",borderRadius:2,margin:"4px 8px 0"}}><div style={{width:`${pct}%`,height:"100%",background:c,borderRadius:2}}/></div></div>);
};

// ─── DASHBOARD ───────────────────────────────────────────────
function DashboardView({T,jobs,cands,dirStats,onJobClick,onCandClick,cfg,recordTokens,dirCtx,dashboardUpload,setDashboardUpload,startDashboardResumeImport,cloud,jobComposer,questionTasks,interviewTasks}) {
  const stats=[
    {label:"简历通过",val:cands.filter(c=>c.status==="screening").length,color:"#2563eb"},
    {label:"观察中",  val:cands.filter(c=>c.status==="watching").length, color:"#d97706"},
    {label:"进入面试",val:cands.filter(c=>c.status==="interview").length,color:"#7c3aed"},
    {label:"已录用",  val:cands.filter(c=>c.status==="offer").length,    color:"#059669"},
    {label:"未通过",  val:cands.filter(c=>c.status==="rejected").length, color:"#dc2626"},
  ];
  const total=cands.length;
  const rankedCands=[...cands].sort((a,b)=>(b.screening?.overallScore??-1)-(a.screening?.overallScore??-1));
  const upcomingInterviewCandidates = cands.filter(c => {
    if (!c?.scheduledAt) return false;
    const d = new Date(c.scheduledAt);
    if (Number.isNaN(d.getTime())) return false;
    const now = Date.now();
    const scheduled = d.getTime();
    // 过去 12 小时到未来 7 天
    return scheduled >= now - 12*3600*1000 && scheduled <= now + 7*24*3600*1000;
  }).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  const dashboardShell={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:CARD_RADIUS,
    boxShadow:SOFT_SHADOW,
  };
  const passRate=total>0?Math.round(cands.filter(c=>["screening","interview","offer"].includes(c.status)).length/total*100):0;
  const runningQuestionCount=Object.values(questionTasks||{}).filter(task=>task?.loading).length;
  const runningInterviewCount=Object.values(interviewTasks||{}).filter(task=>task?.loading).length;
  const dashboardQueuedCount=(dashboardUpload?.files||[]).length;
  const dashboardProcessingCount=Object.values(dashboardUpload?.results||{}).filter(item=>item?.status==="processing").length;
  const dashboardFailedCount=Object.values(dashboardUpload?.results||{}).filter(item=>item?.status==="error").length;
  const failedQuestionTasks=Object.entries(questionTasks||{}).filter(([,task])=>task?.error).map(([candidateId,task])=>({
    candidateName:cands.find(candidate=>String(candidate.id)===String(candidateId))?.name||"候选人",
    message:task.error,
  }));
  const failedInterviewTasks=Object.entries(interviewTasks||{}).filter(([,task])=>task?.error).map(([candidateId,task])=>({
    candidateName:cands.find(candidate=>String(candidate.id)===String(candidateId))?.name||"候选人",
    message:task.error,
  }));
  const liveTasks=[
    cloud?.phase==="syncing"||cloud?.phase==="loading"
      ? {label:"云端同步",count:1,detail:cloud?.message||"正在和 D1 对齐简历库与候选人状态",color:"#2563eb",bg:"#eff6ff"}
      : null,
    dashboardUpload?.loading
      ? {label:"简历导入",count:Math.max(dashboardProcessingCount,1),detail:dashboardUpload?.info||`正在处理 ${dashboardQueuedCount} 份简历`,color:"#0f766e",bg:"#ecfeff"}
      : null,
    jobComposer?.jdLoading
      ? {label:"岗位 JD 识别",count:1,detail:jobComposer?.jdFileName?`正在解析 ${jobComposer.jdFileName}`:"正在识别岗位文件",color:"#7c3aed",bg:"#f5f3ff"}
      : null,
    runningQuestionCount
      ? {label:"面试题生成",count:runningQuestionCount,detail:"候选人面试题正在后台补齐",color:"#8b5cf6",bg:"#f5f3ff"}
      : null,
    runningInterviewCount
      ? {label:"面试评估",count:runningInterviewCount,detail:"面试记录解析与综合评估正在后台运行",color:"#2563eb",bg:"#eff6ff"}
      : null,
  ].filter(Boolean);
  const taskFailures=[
    dashboardUpload?.err ? {label:"简历导入失败",detail:dashboardUpload.err} : null,
    jobComposer?.jdErr ? {label:"岗位 JD 识别失败",detail:jobComposer.jdErr} : null,
    ...failedQuestionTasks.map(item=>({label:`${item.candidateName} · 面试题失败`,detail:item.message})),
    ...failedInterviewTasks.map(item=>({label:`${item.candidateName} · 面试评估失败`,detail:item.message})),
  ].filter(Boolean).slice(0,4);
  return(<Page T={T} title="仪表盘" sub="快手项目组 · 招聘总览">
    <SecLabel T={T}>数据看板</SecLabel>
    <div style={{...dashboardShell,padding:"22px 22px 18px",marginBottom:24}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0, 1.5fr) minmax(320px, 0.9fr)",gap:16,alignItems:"stretch"}}>
        <div style={{display:"grid",gap:14}}>
          <div>
            <div style={{fontSize:24,fontWeight:900,color:T.text,letterSpacing:"-0.03em"}}>招聘运营总览</div>
            <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:6,maxWidth:720}}>先看今天必须处理的面试，再看整体候选人流转和岗位状态。首页只保留最关键的数字和入口，不让信息分散在很多小卡片里。</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(148px,1fr))",gap:10}}>
            {stats.map(s=>(
              <div key={s.label} style={{padding:"14px 14px 12px",borderRadius:16,background:"#ffffff",border:`1px solid ${T.border}`,boxShadow:"0 10px 24px rgba(15,23,42,0.04)"}}>
                <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>{s.label}</div>
                <div style={{fontSize:30,fontWeight:900,color:s.color,lineHeight:1,marginTop:10}}>{s.val}</div>
              </div>
            ))}
          </div>
          <div style={{padding:"14px 16px",borderRadius:16,background:"#ffffff",border:`1px solid ${T.border}`}}>
            <div style={{display:"flex",justifyContent:"space-between",gap:14,alignItems:"center",flexWrap:"wrap",marginBottom:10}}>
              <div style={{fontSize:12,color:T.text3}}>总候选人 <strong style={{color:T.text,fontWeight:800}}>{total}</strong> 人</div>
              <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                {dirStats.total>0&&<span style={{fontSize:12,color:T.text3}}>总监沉淀 {dirStats.total} 案例 · AI匹配率 <strong style={{color:dirStats.rate>=70?"#16a34a":"#ca8a04"}}>{dirStats.rate}%</strong></span>}
                <span style={{fontSize:12,fontWeight:800,color:T.accent}}>通过率 {passRate}%</span>
              </div>
            </div>
            <div style={{height:8,background:T.border,borderRadius:999,display:"flex",overflow:"hidden"}}>
              {[["screening","#2563eb"],["watching","#d97706"],["interview","#7c3aed"],["offer","#059669"],["rejected","#dc2626"]].map(([s,c])=>{
                const v=cands.filter(x=>x.status===s).length;
                return total>0&&v>0?<div key={s} style={{width:`${v/total*100}%`,background:c}}/>:null;
              })}
            </div>
          </div>
        </div>
        <div style={{padding:"16px 16px 14px",borderRadius:18,background:"linear-gradient(180deg, #faf5ff 0%, #ffffff 100%)",border:"1px solid #e9d5ff",boxShadow:"0 14px 32px rgba(124,58,237,0.08)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:12,flexWrap:"wrap"}}>
            <div>
              <div style={{fontSize:14,fontWeight:900,color:T.text}}>近期面试安排（7天内）</div>
              <div style={{fontSize:12,color:T.text4,marginTop:4,lineHeight:1.7}}>未来 7 天排期的候选人会固定放在这里，直接从首页进入面试记录。</div>
            </div>
            <Chip c="#7c3aed" bg="#ede9fe" lg>{`${upcomingInterviewCandidates.length} 场`}</Chip>
          </div>
          {upcomingInterviewCandidates.length===0
            ? <div style={{padding:"18px 14px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:14,fontSize:12,color:T.text4,lineHeight:1.8}}>近期 7 天暂无面试安排</div>
            : <div style={{display:"grid",gap:10}}>
                {upcomingInterviewCandidates.map(candidate=>{
                  const candidateJob = getEffectiveCandidateJob(jobs, candidate);
                  return(
                    <button
                      key={candidate.id}
                      onClick={()=>onCandClick(candidate.id,candidate.jobId)}
                      className="hr"
                      style={{padding:"13px 14px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:14,cursor:"pointer",textAlign:"left",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}
                    >
                      <div style={{minWidth:0}}>
                        <div style={{fontSize:14,fontWeight:800,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{candidate.name||"未命名候选人"}</div>
                        <div style={{fontSize:11,color:T.text4,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{candidateJob?.title||candidate.screening?.roleDirection||"未绑定岗位"}</div>
                      </div>
                      <div style={{textAlign:"right",flexShrink:0}}>
                        <div style={{fontSize:18,fontWeight:900,color:"#7c3aed",lineHeight:1}}>{(()=>{
                          const d = new Date(candidate.scheduledAt);
                          const today = new Date().toDateString();
                          const tomorrow = new Date(Date.now() + 24*3600*1000).toDateString();
                          let prefix = "";
                          if (d.toDateString() === today) prefix = "今日 ";
                          else if (d.toDateString() === tomorrow) prefix = "明日 ";
                          else prefix = `${d.getMonth()+1}/${d.getDate()} `;
                          return prefix + fmtDate(candidate.scheduledAt);
                        })()}</div>
                        <div style={{fontSize:11,color:"#7c3aed",fontWeight:800,marginTop:4}}>{candidate.interviewRound||"面试"}{(candidate.interviewLocation ?? "")?` · 📍 ${candidate.interviewLocation ?? ""}`:""} · 进入记录</div>
                      </div>
                    </button>
                  );
                })}
              </div>}
        </div>
      </div>
    </div>

    <SecLabel T={T}>同步与任务中心</SecLabel>
    <div style={{...dashboardShell,padding:"20px 22px",marginBottom:24}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.15fr) minmax(320px,0.85fr)",gap:18,alignItems:"stretch"}}>
        <div style={{display:"grid",gap:14}}>
          <div>
            <div style={{fontSize:18,fontWeight:900,color:T.text,letterSpacing:"-0.03em"}}>系统状态总览</div>
            <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:6,maxWidth:720}}>这里专门回答两个问题：现在云端有没有正常同步、后台还有哪些任务正在跑。高频使用时先看这里，再决定是继续导简历、去安排面试，还是先处理异常。</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
            <div style={{padding:"14px 14px 12px",borderRadius:16,background:"#ffffff",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>云端同步</div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10,flexWrap:"wrap"}}>
                <Chip c={cloud?.phase==="ready"?"#059669":cloud?.phase==="error"?"#dc2626":"#2563eb"} bg={cloud?.phase==="ready"?"#ecfdf5":cloud?.phase==="error"?"#fef2f2":"#eff6ff"} lg>
                  {cloud?.phase==="ready"?"已同步":cloud?.phase==="error"?"异常":"处理中"}
                </Chip>
                {cloud?.updatedAt&&<span style={{fontSize:11,color:T.text4}}>最近成功：{fmtCloudTime(cloud.updatedAt)}</span>}
              </div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:10}}>{cloud?.message||"等待读取云端状态..."}</div>
            </div>
            <div style={{padding:"14px 14px 12px",borderRadius:16,background:"#ffffff",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>后台任务</div>
              <div style={{fontSize:30,fontWeight:900,color:liveTasks.length?"#111827":"#94a3b8",lineHeight:1,marginTop:10}}>{liveTasks.length}</div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:8}}>
                {liveTasks.length
                  ? "有任务正在后台继续运行，切换页面不会中断。"
                  : "当前没有进行中的后台任务，系统处于空闲状态。"}
              </div>
            </div>
            <div style={{padding:"14px 14px 12px",borderRadius:16,background:"#ffffff",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>最近异常</div>
              <div style={{fontSize:30,fontWeight:900,color:taskFailures.length?"#dc2626":"#16a34a",lineHeight:1,marginTop:10}}>{taskFailures.length}</div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:8}}>
                {taskFailures.length
                  ? "建议先处理这些失败项，再继续批量导入或生成。"
                  : "最近没有检测到需要你立即处理的失败项。"}
              </div>
            </div>
          </div>
        </div>
        <div style={{display:"grid",gap:12}}>
          <div style={{padding:"14px 16px",borderRadius:18,background:"linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)",border:`1px solid ${T.border}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:900,color:T.text}}>进行中的后台任务</div>
              <Chip c={liveTasks.length?"#2563eb":"#6b7280"} bg={liveTasks.length?"#eff6ff":"#f3f4f6"}>{liveTasks.length?`${liveTasks.length} 项`:"空闲"}</Chip>
            </div>
            {liveTasks.length===0
              ? <div style={{fontSize:12,color:T.text4,lineHeight:1.8}}>当前没有导入、JD 识别、面试题生成或面试评估在后台运行。</div>
              : <div style={{display:"grid",gap:10}}>
                  {liveTasks.map(task=>(
                    <div key={task.label} style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:12,alignItems:"start",padding:"10px 0",borderBottom:`1px solid ${T.border}`}}>
                      <div style={{minWidth:64,textAlign:"center",padding:"8px 10px",borderRadius:999,background:task.bg,color:task.color,fontSize:12,fontWeight:900}}>{task.count}</div>
                      <div>
                        <div style={{fontSize:13,fontWeight:800,color:T.text}}>{task.label}</div>
                        <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:4}}>{task.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>}
          </div>
          <div style={{padding:"14px 16px",borderRadius:18,background:"linear-gradient(180deg, #fff7ed 0%, #ffffff 100%)",border:"1px solid #fed7aa"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:900,color:T.text}}>最近失败项</div>
              <Chip c={taskFailures.length?"#dc2626":"#16a34a"} bg={taskFailures.length?"#fef2f2":"#ecfdf5"}>{taskFailures.length?`${taskFailures.length} 条`:"正常"}</Chip>
            </div>
            {taskFailures.length===0
              ? <div style={{fontSize:12,color:T.text3,lineHeight:1.8}}>导入、题目生成、评估和 JD 识别最近都没有明显报错，可以继续推进今天的招聘流程。</div>
              : <div style={{display:"grid",gap:10}}>
                  {taskFailures.map((item,index)=>(
                    <div key={`${item.label}-${index}`} style={{padding:"10px 12px",background:"#ffffff",borderRadius:14,border:"1px solid #fecaca"}}>
                      <div style={{fontSize:12,fontWeight:800,color:"#991b1b"}}>{item.label}</div>
                      <div style={{fontSize:12,color:"#7f1d1d",lineHeight:1.8,marginTop:4}}>{item.detail}</div>
                    </div>
                  ))}
                </div>}
          </div>
        </div>
      </div>
    </div>

    <SecLabel T={T}>在招岗位 ({jobs.length})</SecLabel>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:12,marginBottom:24}}>
      {jobs.length===0?<div style={{gridColumn:"1 / -1"}}><Empty T={T} icon="◈" title="暂无在招岗位" sub="先去岗位管理新建岗位，再开始批量上传简历。"/></div>
      :jobs.map(job=>{
        const jobCands=cands.filter(c=>c.jobId===job.id);
        const statusStats=[
          {key:"screening",label:"简历通过"},
          {key:"watching",label:"观察中"},
          {key:"interview",label:"进入面试"},
          {key:"offer",label:"已录用"},
          {key:"rejected",label:"未通过"},
        ].map(item=>({
          ...item,
          count:jobCands.filter(c=>c.status===item.key).length,
          color:STATUS[item.key].color,
          bg:STATUS[item.key].bg,
        }));
        return(<div key={job.id} onClick={()=>onJobClick(job.id)} className="hr" style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"18px 18px 16px",cursor:"pointer",boxShadow:SOFT_SHADOW,transition:"transform 0.16s ease, box-shadow 0.16s ease"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:12}}>
            <div>
              <div style={{fontSize:15,fontWeight:800,color:T.text}}>{job.title}</div>
              <div style={{fontSize:11,color:T.text4,marginTop:3}}>{[job.department,job.level,job.salary].filter(Boolean).join(" · ")||"待补充岗位信息"}</div>
            </div>
            <span style={{fontSize:11,fontWeight:700,padding:"4px 8px",background:T.card2,borderRadius:20,color:T.text3,whiteSpace:"nowrap"}}>{jobCands.length} 份简历</span>
          </div>
          <div style={{fontSize:11,color:T.text4,marginBottom:8}}>以下为当前流程状态统计，和候选人列表口径一致。</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(92px,1fr))",gap:8}}>
            {statusStats.map(item=>(
              <div key={item.label} style={{padding:"10px 8px",background:item.bg,borderRadius:9,textAlign:"center"}}>
                <div style={{fontSize:20,fontWeight:900,color:item.color,lineHeight:1}}>{item.count}</div>
                <div style={{fontSize:11,color:item.color,marginTop:4,fontWeight:700}}>{item.label}</div>
              </div>
            ))}
          </div>
        </div>);
      })}
    </div>

    <SecLabel T={T}>评分标准</SecLabel>
    <div style={{...dashboardShell,padding:"22px 22px 18px",marginBottom:16}}>
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
        <div key={item.label} style={{...dashboardShell,padding:"18px 18px 16px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <Chip c={item.color} bg={item.bg} lg>{item.label}</Chip>
            <div style={{fontSize:20,fontWeight:900,color:item.color}}>{item.range}</div>
          </div>
          <div style={{fontSize:12,color:T.text3,lineHeight:1.8}}>{item.desc}</div>
        </div>
      ))}
    </div>

    <SecLabel T={T}>简历上传</SecLabel>
    <DashboardResumeUploader T={T} jobs={jobs} cfg={cfg} recordTokens={recordTokens} dirCtx={dirCtx} task={dashboardUpload} setTask={setDashboardUpload} onStart={startDashboardResumeImport}/>

    <SecLabel T={T}>候选人列表 ({cands.length})</SecLabel>
    <div style={{...dashboardShell,overflow:"hidden"}}>
      {rankedCands.length===0?<div style={{padding:"44px 20px",textAlign:"center",color:T.text4,fontSize:13}}>上传简历后，这里会按 AI 首轮匹配度展示候选人。</div>
      :<>
        <div style={{display:"grid",gridTemplateColumns:"1.7fr 1.3fr 0.85fr 0.9fr 0.95fr",padding:"10px 16px",borderBottom:`1px solid ${T.border}`,fontSize:11,fontWeight:800,color:T.text4,background:"#f8fafc"}}>
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

function DashboardResumeUploader({T,jobs,cfg,recordTokens,dirCtx,task,setTask,onStart}) {
  const [drag,setDrag]=useState(false);
  const files=task?.files||[];
  const loading=!!task?.loading;
  const err=task?.err||"";
  const info=task?.info||"";
  const results=task?.results||{};
  const queueFiles=inputFiles=>{
    const picked=Array.from(inputFiles||[]).filter(Boolean);
    if(!picked.length) return;
    const accepted=[];
    const rejected=[];
    picked.forEach(file=>{
      if(getFileKind(file)==="unknown") rejected.push(file.name);
      else accepted.push(file);
    });
    setTask(prev=>{
      const existing=new Set((prev.files||[]).map(dashboardFileKey));
      const merged=[...(prev.files||[])];
      accepted.forEach(file=>{
        const key=dashboardFileKey(file);
        if(!existing.has(key)){existing.add(key);merged.push(file);}
      });
      return {
        ...prev,
        files:merged,
        info:"",
        err:rejected.length?`以下文件格式暂不支持：${rejected.join("、")}`:"",
        results:merged.reduce((acc,file)=>{
          const key=dashboardFileKey(file);
          acc[key]=prev.results?.[key]||{status:"queued",message:"等待导入",name:file.name};
          return acc;
        },{}),
      };
    });
  };

  const removeFile=targetKey=>setTask(prev=>{
    const nextFiles=(prev.files||[]).filter(file=>dashboardFileKey(file)!==targetKey);
    const nextResults={...(prev.results||{})};
    delete nextResults[targetKey];
    return {...prev,files:nextFiles,results:nextResults};
  });

  const submit=async()=>{
    if(!files.length){setTask(prev=>({...prev,err:"请先拖入或选择至少一份简历"}));return;}
    onStart?.({files,results});
  };
  const queuedCount=files.length;
  const successCount=Object.values(results).filter(item=>item?.status==="success").length;
  const processingCount=Object.values(results).filter(item=>item?.status==="processing").length;
  const failedCount=Object.values(results).filter(item=>item?.status==="error").length;

  return(
    <div style={{background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"22px 22px 20px",marginBottom:22,boxShadow:SOFT_SHADOW}}>
      <>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0, 1.45fr) minmax(280px, 0.75fr)",gap:16,alignItems:"stretch",marginBottom:16}}>
          <div style={{display:"grid",gap:14}}>
            <div>
              <div style={{fontSize:20,fontWeight:900,color:T.text,letterSpacing:"-0.03em"}}>一键上传简历并完成 AI 首轮分析</div>
              <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.8}}>直接把 PDF、图片、Word 或纯文本简历拖进来。系统会先完成通用规整与首轮评分，岗位归属如果判断不准，后续再去岗位管理里修正。</div>
            </div>
            <div style={{padding:"10px 12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:12,fontSize:12,color:T.text3,lineHeight:1.8}}>上传时不需要先选岗位。系统会先按通用标准完成规整和首轮评分，后续如果岗位识别不准确，再去岗位管理里修正即可。</div>
            <div
              onDragOver={e=>{e.preventDefault();setDrag(true);}}
              onDragLeave={()=>setDrag(false)}
              onDrop={e=>{e.preventDefault();setDrag(false);queueFiles(e.dataTransfer.files);}}
              onClick={()=>!loading&&document.getElementById("dashboard-resume-upload-input")?.click()}
              style={{border:`2px dashed ${drag?T.accent:T.border2}`,borderRadius:18,minHeight:230,padding:"30px 28px",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",textAlign:"center",background:drag?`${T.accent}10`:"#fbfcfe",cursor:loading?"default":"pointer",transition:"all 0.15s"}}
            >
              <input id="dashboard-resume-upload-input" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.md" multiple style={{display:"none"}} onChange={e=>{queueFiles(e.target.files);e.target.value="";}}/>
              {loading
                ?<div>
                  <Spin text="正在识别简历并生成首轮评分..." />
                  <div style={{fontSize:12,color:T.text4,marginTop:8,lineHeight:1.8}}>任务已转入后台。你现在切换到其他窗口也不会中断，回来后会自动保留进度和结果。</div>
                </div>
                :<>
                  <div style={{fontSize:40,lineHeight:1,marginBottom:14}}>⇪</div>
                  <div style={{fontSize:22,fontWeight:900,color:T.text,letterSpacing:"-0.03em"}}>把简历拖到这里</div>
                  <div style={{fontSize:13,color:T.text3,marginTop:8,lineHeight:1.8}}>或者点击选择文件，支持多份同时导入。当前会直接做通用初筛，后续可在岗位管理里再修正岗位归属。</div>
                </>}
            </div>
          </div>
          <div style={{display:"grid",gap:12}}>
            <div style={{padding:"16px 16px 14px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:18,boxShadow:"0 12px 28px rgba(15,23,42,0.05)"}}>
              <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:10}}>导入概览</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div style={{padding:"10px 12px",borderRadius:12,background:"#f8fafc",border:`1px solid ${T.border}`}}>
                  <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>队列总数</div>
                  <div style={{fontSize:24,fontWeight:900,color:T.text,marginTop:8,lineHeight:1}}>{queuedCount}</div>
                </div>
                <div style={{padding:"10px 12px",borderRadius:12,background:"#ecfdf5",border:"1px solid #bbf7d0"}}>
                  <div style={{fontSize:10,fontWeight:800,color:"#059669",letterSpacing:"0.08em"}}>已导入</div>
                  <div style={{fontSize:24,fontWeight:900,color:"#059669",marginTop:8,lineHeight:1}}>{successCount}</div>
                </div>
                <div style={{padding:"10px 12px",borderRadius:12,background:"#f5f3ff",border:"1px solid #ddd6fe"}}>
                  <div style={{fontSize:10,fontWeight:800,color:"#7c3aed",letterSpacing:"0.08em"}}>处理中</div>
                  <div style={{fontSize:24,fontWeight:900,color:"#7c3aed",marginTop:8,lineHeight:1}}>{processingCount}</div>
                </div>
                <div style={{padding:"10px 12px",borderRadius:12,background:"#fff5f5",border:"1px solid #fecaca"}}>
                  <div style={{fontSize:10,fontWeight:800,color:"#dc2626",letterSpacing:"0.08em"}}>失败</div>
                  <div style={{fontSize:24,fontWeight:900,color:"#dc2626",marginTop:8,lineHeight:1}}>{failedCount}</div>
                </div>
              </div>
            </div>
            <div style={{padding:"16px 16px 14px",background:"linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",border:`1px solid ${T.border}`,borderRadius:18}}>
              <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:10}}>操作台</div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginBottom:12}}>
                {files.length?`已加入 ${files.length} 份待处理简历，可继续拖入补充。`:"还没有加入简历文件。"}
              </div>
              <div style={{display:"grid",gap:10}}>
                {files.length>0&&<button onClick={()=>setTask(prev=>({...prev,files:[],err:"",info:"",results:{}}))} style={{padding:"10px 14px",border:`1px solid ${T.border2}`,background:T.surface,color:T.text3,borderRadius:12,fontSize:12,fontWeight:800,cursor:loading?"not-allowed":"pointer",opacity:loading?0.5:1}}>清空列表</button>}
                <button onClick={submit} disabled={loading||!files.length} style={{padding:"12px 16px",background:T.accent,color:T.accentFg,border:"none",borderRadius:12,fontSize:13,fontWeight:900,cursor:loading||!files.length?"not-allowed":"pointer",opacity:loading||!files.length?0.55:1}}>
                  {loading?"正在批量分析...":"开始识别并导入"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {files.length>0&&<div style={{marginTop:14,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10}}>
          {files.map(file=>{
            const key=dashboardFileKey(file);
            const result=results[key]||{status:"queued",message:"等待导入"};
            const tone=result.status==="success"
              ? {c:"#166534",bg:"#ecfdf5",label:"已导入"}
              : result.status==="error"
              ? {c:"#b91c1c",bg:"#fef2f2",label:"失败"}
              : result.status==="processing"
              ? {c:"#7c3aed",bg:"#f5f3ff",label:"处理中"}
              : {c:T.text3,bg:T.card2,label:"待导入"};
            return(<div key={key} style={{padding:"12px 12px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:14,display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,boxShadow:"0 10px 24px rgba(15,23,42,0.04)"}}>
              <div style={{minWidth:0}}>
                <div style={{fontSize:12,fontWeight:700,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{file.name}</div>
                <div style={{fontSize:11,color:T.text4,marginTop:3}}>{(file.size/1024/1024).toFixed(2)} MB</div>
                <div style={{fontSize:11,color:tone.c,marginTop:5,lineHeight:1.6}}>{result.message}</div>
              </div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
                <span style={{fontSize:10,fontWeight:800,color:tone.c,background:tone.bg,padding:"4px 8px",borderRadius:999}}>{tone.label}</span>
                <button onClick={e=>{e.stopPropagation();removeFile(key);}} style={{border:"none",background:"transparent",color:T.text4,cursor:"pointer",fontSize:16,lineHeight:1}}>✕</button>
              </div>
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
  const delJob=id=>{if(window.confirm("确认删除该岗位及所有候选人？")){setJobs(p=>p.filter(j=>j.id!==id));setCandsSynced(p=>p.filter(c=>c.jobId!==id));if(selJob===id)setSelJob(null);}};
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
    setCandsSynced(p=>[...p,{id,jobId:selJob,name:"",status:"pending",resume:"",screening:null,questions:null,interviews:[],scheduledAt:null,interviewRound:null,directorVerdict:null}]);
    onCandClick(id,selJob);
  };
  const saveInterviewRules=()=>{
    if(!job) return;
    setJobs(prev=>prev.map(item=>item.id===job.id?{...item,interviewRules:interviewRulesDraft.trim()}:item));
    setRulesSaved(true);
    setTimeout(()=>setRulesSaved(false),1500);
  };
  const jobsShell={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:CARD_RADIUS,
    boxShadow:SOFT_SHADOW,
  };
  const jobRailShell={...jobsShell,overflow:"hidden"};
  const jobWorkbenchShell={...jobsShell,padding:"20px 22px"};
  const jobFlowStats=job?[
    {label:"候选人",value:jobCands.length,color:T.text},
    {label:"进入面试",value:jobCands.filter(item=>item.status==="interview").length,color:"#7c3aed"},
    {label:"已录用",value:jobCands.filter(item=>item.status==="offer").length,color:"#059669"},
  ]:[];
  const jobMeta=[job?.department,job?.level,job?.salary].filter(Boolean).join(" · ");
  const requirementsList=(job?.requirements||"").split("\n").map(item=>item.trim()).filter(Boolean);
  return(<Page T={T} title="岗位管理" sub="创建和管理在招职位">
    <div style={{...jobsShell,padding:"20px 22px 18px",marginBottom:18}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.2fr) minmax(320px,0.8fr)",gap:18,alignItems:"start"}}>
        <div>
          <div style={{fontSize:22,fontWeight:900,color:T.text,letterSpacing:"-0.03em"}}>岗位工作台</div>
          <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:6,maxWidth:760}}>左侧保持岗位轨道，右侧专注岗位详情、JD 规整与候选人推进。岗位创建、规则维护和候选人流转都放在同一条工作线上，避免在不同页面来回切换。</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:14}}>
            <Chip c={T.text3} bg={T.card2}>{jobs.length} 个在招岗位</Chip>
            <Chip c="#059669" bg="#ecfdf5">{cands.length} 位候选人</Chip>
            <Chip c="#7c3aed" bg="#f5f3ff">{jdLoading?"JD 识别进行中":"JD 识别空闲"}</Chip>
          </div>
        </div>
        <div style={{padding:"14px 16px",borderRadius:18,background:"#ffffff",border:`1px solid ${T.border}`,display:"grid",gap:12}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:10}}>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>在招岗位</div>
              <div style={{fontSize:24,fontWeight:900,color:T.text,marginTop:8,lineHeight:1}}>{jobs.length}</div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>已入库候选人</div>
              <div style={{fontSize:24,fontWeight:900,color:"#059669",marginTop:8,lineHeight:1}}>{cands.length}</div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>JD 任务</div>
              <div style={{fontSize:24,fontWeight:900,color:"#7c3aed",marginTop:8,lineHeight:1}}>{jdLoading?1:0}</div>
            </div>
          </div>
          <div style={{fontSize:12,color:T.text4,lineHeight:1.75}}>当前更适合把这页当成岗位运营台：先整理 JD 和评分底座，再持续把候选人推入对应岗位，而不是把岗位当作静态配置表。</div>
        </div>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"320px minmax(0,1fr)",gap:18,alignItems:"start"}}>
      <div style={jobRailShell}>
        <div style={{padding:"16px 16px 14px",borderBottom:`1px solid ${T.border}`,background:"linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:8}}>
            <div>
              <div style={{fontSize:14,fontWeight:900,color:T.text}}>岗位轨道</div>
              <div style={{fontSize:11,color:T.text4,marginTop:4,lineHeight:1.7}}>先建岗位，再在右侧推进规则和候选人。</div>
            </div>
            <button onClick={()=>{if(open)resetCreateForm();else setJobComposer(prev=>({...prev,open:true}));}} style={{padding:"8px 12px",background:T.accent,color:T.accentFg,border:"none",borderRadius:10,fontSize:12,fontWeight:800,cursor:"pointer",boxShadow:"0 10px 22px rgba(15,23,42,0.12)"}}>+ 新建</button>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <Chip c={T.text3} bg={T.card2}>{jobs.length} 个岗位</Chip>
            <Chip c="#059669" bg="#ecfdf5">{cands.length} 位候选人</Chip>
          </div>
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
        <div style={{overflowY:"auto",maxHeight:"calc(100vh - 250px)"}}>
          {jobs.length===0?<div style={{padding:"32px 16px",textAlign:"center",color:T.text4,fontSize:13}}>暂无岗位</div>
          :jobs.map(j=>(
            <div key={j.id} onClick={()=>setSelJob(j.id)} className="hr"
              style={{padding:"14px 16px",borderBottom:`1px solid ${T.border}`,cursor:"pointer",background:selJob===j.id?"linear-gradient(180deg, rgba(59,130,246,0.08) 0%, rgba(59,130,246,0.03) 100%)":"transparent",borderLeft:selJob===j.id?`3px solid ${T.accent}`:"3px solid transparent"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:700,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{j.title}</div>
                  <div style={{fontSize:11,color:T.text4,marginTop:3}}>{j.department||"未指定"}{j.level?` · ${j.level}`:""}</div>
                </div>
                <button onClick={e=>{e.stopPropagation();delJob(j.id);}} style={{border:"none",background:"transparent",color:T.text4,cursor:"pointer",fontSize:12,lineHeight:1,flexShrink:0}}>✕</button>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8,gap:10}}>
                <span style={{fontSize:11,color:T.text3}}>{cands.filter(c=>c.jobId===j.id).length} 位候选人</span>
                {selJob===j.id&&<Chip c={T.accent} bg={`${T.accent}12`}>当前查看</Chip>}
              </div>
            </div>
          ))}
        </div>
      </div>
      {job?(<div>
        <div style={{...jobWorkbenchShell,marginBottom:14}}>
          <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.2fr) minmax(250px,0.8fr)",gap:18,alignItems:"stretch"}}>
            <div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:14,marginBottom:14,flexWrap:"wrap"}}>
                <div style={{minWidth:0}}>
                  <h2 style={{fontSize:24,fontWeight:900,color:T.text,margin:0,letterSpacing:"-0.03em"}}>{job.title}</h2>
                  <div style={{fontSize:12,color:T.text3,marginTop:6,lineHeight:1.8}}>{jobMeta||"待补充岗位信息"}</div>
                </div>
                <button onClick={addCand} style={{padding:"10px 18px",background:T.accent,color:T.accentFg,border:"none",borderRadius:12,fontSize:13,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap",boxShadow:"0 12px 24px rgba(15,23,42,0.12)"}}>+ 添加候选人</button>
              </div>
              {job.requirements&&<div style={{fontSize:13,color:T.text2,lineHeight:1.85,padding:"14px 16px",background:"#f8fafc",border:`1px solid ${T.border}`,borderRadius:16}}>{job.requirements}</div>}
            </div>
            <div style={{padding:"16px",borderRadius:18,background:"linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:10}}>岗位概览</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:10}}>
                {jobFlowStats.map(item=>(
                  <div key={item.label} style={{padding:"10px 10px 9px",borderRadius:12,background:"#ffffff",border:`1px solid ${T.border}`}}>
                    <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>{item.label}</div>
                    <div style={{fontSize:22,fontWeight:900,color:item.color,marginTop:8,lineHeight:1}}>{item.value}</div>
                  </div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:12}}>
                <div style={{padding:"10px 12px",background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:12}}>
                  <div style={{fontSize:10,fontWeight:800,color:"#c2410c",letterSpacing:"0.08em"}}>T0 条数</div>
                  <div style={{fontSize:20,fontWeight:900,color:"#c2410c",marginTop:8,lineHeight:1}}>{job.t0?job.t0.split("\n").filter(Boolean).length:0}</div>
                </div>
                <div style={{padding:"10px 12px",background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:12}}>
                  <div style={{fontSize:10,fontWeight:800,color:"#1d4ed8",letterSpacing:"0.08em"}}>T1 条数</div>
                  <div style={{fontSize:20,fontWeight:900,color:"#1d4ed8",marginTop:8,lineHeight:1}}>{job.t1?job.t1.split("\n").filter(Boolean).length:0}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,0.95fr) minmax(0,1.05fr)",gap:14,marginBottom:14}}>
          <div style={{...jobWorkbenchShell,marginBottom:0}}>
            <div style={{fontSize:14,fontWeight:800,color:T.text,marginBottom:10}}>岗位要求与评分底座</div>
            <div style={{display:"grid",gap:12}}>
              <div style={{padding:"14px 16px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:16}}>
                <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>岗位要求</div>
                {requirementsList.length
                  ?<div style={{display:"grid",gap:7}}>
                    {requirementsList.slice(0,6).map((item,index)=><div key={index} style={{fontSize:12,color:T.text2,lineHeight:1.8}}>• {item}</div>)}
                    {requirementsList.length>6&&<div style={{fontSize:11,color:T.text4}}>… 还有 {requirementsList.length-6} 条</div>}
                  </div>
                  :<div style={{fontSize:12,color:T.text4}}>暂未整理岗位要求</div>}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                <div style={{padding:"14px 16px",background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:16}}>
                  <div style={{fontSize:11,fontWeight:800,color:"#c2410c",letterSpacing:"0.08em",marginBottom:8}}>T0 硬性条件</div>
                  {job.t0?.trim()
                    ?job.t0.split("\n").filter(Boolean).map((item,index)=><div key={index} style={{fontSize:12,color:T.text2,lineHeight:1.8}}>• {item}</div>)
                    :<div style={{fontSize:12,color:T.text4}}>暂未设置</div>}
                </div>
                <div style={{padding:"14px 16px",background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:16}}>
                  <div style={{fontSize:11,fontWeight:800,color:"#1d4ed8",letterSpacing:"0.08em",marginBottom:8}}>T1 核心维度</div>
                  {job.t1?.trim()
                    ?job.t1.split("\n").filter(Boolean).map((item,index)=><div key={index} style={{fontSize:12,color:T.text2,lineHeight:1.8}}>• {item}</div>)
                    :<div style={{fontSize:12,color:T.text4}}>暂未设置</div>}
                </div>
              </div>
            </div>
          </div>
          <div style={{...jobWorkbenchShell,marginBottom:0}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:10,flexWrap:"wrap"}}>
              <div>
                <div style={{fontSize:14,fontWeight:800,color:T.text}}>岗位级面试准则模板</div>
                <div style={{fontSize:12,color:T.text4,marginTop:4,lineHeight:1.7}}>这里写的内容会直接并入“生成面试题”的 prompt。不同岗位可以维护不同的面试策略。</div>
              </div>
              {rulesSaved&&<Chip c="#059669" bg="#ecfdf5">已保存</Chip>}
            </div>
            <textarea
              rows={12}
              value={interviewRulesDraft}
              onChange={e=>setInterviewRulesDraft(e.target.value)}
              style={{...inSt(T),resize:"vertical",lineHeight:1.8,marginBottom:12,background:"#fbfcfe"}}
              placeholder={INTERVIEW_RULES_PROMPT}
            />
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div style={{fontSize:12,color:T.text4,lineHeight:1.7}}>留空时自动使用系统默认准则；填了以后，这个岗位会优先用你自定义的版本。</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={()=>setInterviewRulesDraft(INTERVIEW_RULES_PROMPT)} style={{padding:"8px 12px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:10,color:T.text3,cursor:"pointer",fontSize:12,fontWeight:700}}>套用默认准则</button>
                <button onClick={saveInterviewRules} style={{padding:"8px 14px",background:T.accent,color:T.accentFg,border:"none",borderRadius:10,cursor:"pointer",fontSize:12,fontWeight:700}}>保存到当前岗位</button>
              </div>
            </div>
          </div>
        </div>
        <div style={{...jobWorkbenchShell}}>
          <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:14}}>候选人 ({jobCands.length})</div>
          {jobCands.length===0?<div style={{textAlign:"center",padding:"28px",color:T.text4,fontSize:13}}>暂无候选人，点击右上角添加</div>
          :<>
            <div style={{display:"grid",gridTemplateColumns:"2fr 3fr 1fr 1fr 1fr",gap:8,padding:"8px 12px",borderBottom:`1px solid ${T.border}`,fontSize:11,fontWeight:700,color:T.text4,marginBottom:6,background:"#f8fafc",borderRadius:"12px 12px 0 0"}}>
              <span>姓名</span><span>AI结论</span><span style={{textAlign:"center"}}>评分</span><span style={{textAlign:"center"}}>状态</span><span style={{textAlign:"center"}}>面试时间</span>
            </div>
            {jobCands.map(c=>{
              const scr=c.screening;
              return(<div key={c.id} onClick={()=>onCandClick(c.id,c.jobId)} className="hr"
                style={{display:"grid",gridTemplateColumns:"2fr 3fr 1fr 1fr 1fr",gap:8,padding:"11px 12px",borderBottom:`1px solid ${T.border}`,cursor:"pointer",alignItems:"center",borderRadius:12}}>
                <div style={{display:"flex",gap:7,alignItems:"center"}}><Av name={c.name} T={T} size={26}/><span style={{fontSize:13,fontWeight:600,color:T.text}}>{c.name||<span style={{color:T.text4}}>未命名</span>}</span></div>
                <span style={{fontSize:12,color:T.text3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{scr?.summary?scr.summary.slice(0,35)+"…":<span style={{color:T.border2}}>未筛选</span>}</span>
                <span style={{textAlign:"center",fontWeight:700,color:scr?scColor(scr.overallScore):T.text4}}>{scr?scr.overallScore?.toFixed(1):"—"}</span>
                <span style={{textAlign:"center"}}><SBadge status={c.status}/></span>
                <span style={{textAlign:"center",fontSize:11,color:c.scheduledAt?"#7c3aed":T.text4}}>{c.scheduledAt?`${fmtDate(c.scheduledAt)}${(c.interviewLocation ?? "")?` · ${c.interviewLocation ?? ""}`:""}`:"—"}</span>
              </div>);
            })}
          </>}
        </div>
      </div>):<Empty T={T} icon="◈" title="选择一个岗位" sub="从左侧列表选择岗位查看详情"/>}
    </div>
  </Page>);
}

// ─── CANDIDATES VIEW ─────────────────────────────────────────
function CandidatesView({T,cands,setCandsSynced,jobs,selCand,setSelCand,tab,setTab,cfg,updCand,recordTokens,dirCtx,compared,toggleCompare,questionTasks,interviewTasks,startQuestionGeneration,startInterviewAssessment,removeCandidate,startCandidatePreviewUpgrade}) {
  const [searchText,setSearchText]=useState("");
  const [sortMode,setSortMode]=useState("import"); // "import" | "interview"
  const sortedCands=useMemo(()=>{
    const compareByImport=(a,b)=>{
      const batchA=a.importBatchId||"";
      const batchB=b.importBatchId||"";
      const timeA=new Date(a.importedAt || a.createdAt || a.updatedAt || 0).getTime() || 0;
      const timeB=new Date(b.importedAt || b.createdAt || b.updatedAt || 0).getTime() || 0;
      if(batchA && batchA===batchB){
        const seqA=Number.isFinite(a.importSeq)?a.importSeq:Number.MAX_SAFE_INTEGER;
        const seqB=Number.isFinite(b.importSeq)?b.importSeq:Number.MAX_SAFE_INTEGER;
        if(seqA!==seqB) return seqA-seqB;
      }
      if(timeA!==timeB) return timeB-timeA;
      return Number(b.id||0)-Number(a.id||0);
    };
    const candidateMatchesSearch = candidate => {
      const query = normalizeMatchText(searchText);
      if (!query) return true;
      const effectiveJob = getEffectiveCandidateJob(jobs, candidate);
      const corpus = [
        candidate?.name,
        candidate?.resumeFileName,
        candidate?.screening?.roleDirection,
        candidate?.screening?.matchedJobTitle,
        effectiveJob?.title,
        candidate?.status,
        candidate?.directorVerdict?.verdict,
      ].join("\n");
      return normalizeMatchText(corpus).includes(query);
    };
    const filtered=[...cands].filter(candidateMatchesSearch);
    if(sortMode==="interview"){
      const scheduled = filtered.filter(c=>{
        if(!c?.scheduledAt) return false;
        const scheduledTime = new Date(c.scheduledAt).getTime();
        return !Number.isNaN(scheduledTime);
      }).sort((a,b)=>new Date(a.scheduledAt)-new Date(b.scheduledAt));
      const unscheduled = filtered.filter(c=>{
        if(!c?.scheduledAt) return true;
        const scheduledTime = new Date(c.scheduledAt).getTime();
        return Number.isNaN(scheduledTime);
      }).sort(compareByImport);
      return [...scheduled,...unscheduled];
    }
    return filtered.sort(compareByImport);
  },[cands,jobs,searchText,sortMode]);
  const filteredCands=sortedCands;
  const cand=cands.find(c=>c.id===selCand);
  const job=getEffectiveCandidateJob(jobs,cand);
  const [showImport,setShowImport]=useState(false);
  const candidateShell={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:CARD_RADIUS,
    boxShadow:SOFT_SHADOW,
  };
  const railPanel={
    ...candidateShell,
    overflow:"hidden",
  };
  const totalCandidates=cands.length;
  const interviewCount=cands.filter(item=>item.status==="interview").length;
  const passedCount=cands.filter(item=>item.status==="screening").length;
  const failedCount=cands.filter(item=>item.status==="rejected").length;
  const deleteCandidate=candidate=>{
    if(!candidate) return;
    const ok=window.confirm(`确认删除候选人「${candidate.name||"未命名候选人"}」吗？\n\n这会同时删除该简历的筛选结果、面试记录、总监判断和相关反馈，并同步到云端。`);
    if(!ok) return;
    removeCandidate?.(candidate.id);
  };
  const onCreated=candidate=>{
    setCandsSynced(prev=>{
      const next=[candidate,...prev];
      return next;
    });
    setSelCand(candidate.id);
    setTab("screening");
    setShowImport(false);
  };
  const openCandidateForResumeUpdate=candidateId=>{
    if(!candidateId) return;
    setSelCand(candidateId);
    setTab("screening");
    setShowImport(false);
  };
  const replaceCandidateResume=async(candidateId,file)=>{
    if(!candidateId || !file) return;
    const targetCandidate=cands.find(item=>item.id===candidateId);
    if(!targetCandidate) throw new Error("没有找到要更新的候选人");
    const effectiveJob=getEffectiveCandidateJob(jobs,targetCandidate);
    const nextPatch=await buildCandidateResumeUpdate({
      candidate:targetCandidate,
      cfg,
      job:effectiveJob,
      file,
      onTokens:recordTokens,
      dirCtx,
      jobs,
      existingCandidates:cands.filter(item=>item.id!==candidateId),
      previewMode:"light",
    });
    const needsPreviewUpgrade = nextPatch.resumePreview?.previewMode==="light" || (!nextPatch.resumePreview?.src && ["pdf","image"].includes(getFileKind(file)));
    const candidatePatch = {
      ...nextPatch,
      resumePreviewStatus: needsPreviewUpgrade ? "generating" : nextPatch.resumePreviewStatus,
    };
    setCandsSynced(prev=>prev.map(item=>item.id===candidateId?{...item,...candidatePatch}:item));
    if(needsPreviewUpgrade) startCandidatePreviewUpgrade(candidateId,file);
    setSelCand(candidateId);
    setTab("screening");
    setShowImport(false);
    return candidatePatch;
  };
  return(<Page T={T} title="候选人" sub="管理所有候选人及评估进度">
    {showImport&&<ResumeImportModal T={T} jobs={jobs} cands={cands} cfg={cfg} recordTokens={recordTokens} dirCtx={dirCtx} onClose={()=>setShowImport(false)} onCreated={onCreated} onOpenCandidate={openCandidateForResumeUpdate} onReplaceExisting={replaceCandidateResume}/>}
    <div style={{...candidateShell,padding:"18px 20px",marginBottom:18}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:18,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 460px",minWidth:0}}>
          <div style={{fontSize:22,fontWeight:900,color:T.text,letterSpacing:"-0.03em"}}>候选人工作台</div>
          <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:6,maxWidth:760}}>左侧保持候选人轨道，右侧专注单人工作区。你可以连续搜索、切换、推进每一位候选人的筛选、面试与最终判断。</div>
        </div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
          {cand&&<button onClick={()=>deleteCandidate(cand)} style={{padding:"10px 15px",background:"#fff5f5",color:"#dc2626",border:"1px solid #fecaca",borderRadius:12,fontSize:12,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap"}}>删除当前候选人</button>}
          <button onClick={()=>setShowImport(true)} style={{padding:"10px 16px",background:T.accent,color:T.accentFg,border:"none",borderRadius:12,fontSize:12,fontWeight:800,cursor:"pointer",whiteSpace:"nowrap",boxShadow:"0 14px 24px rgba(15,23,42,0.12)"}}>+ 上传简历</button>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4, minmax(0, 1fr))",gap:10,marginTop:18}}>
        <div style={{padding:"10px 12px",borderRadius:14,background:"#ffffff",border:`1px solid ${T.border}`}}>
          <div style={{fontSize:10,fontWeight:800,letterSpacing:"0.08em",color:T.text4}}>总候选人</div>
          <div style={{fontSize:22,fontWeight:900,color:T.text,lineHeight:1,marginTop:8}}>{totalCandidates}</div>
        </div>
        <div style={{padding:"10px 12px",borderRadius:14,background:"#ecfdf5",border:"1px solid #bbf7d0"}}>
          <div style={{fontSize:10,fontWeight:800,letterSpacing:"0.08em",color:"#059669"}}>简历通过</div>
          <div style={{fontSize:22,fontWeight:900,color:"#059669",lineHeight:1,marginTop:8}}>{passedCount}</div>
        </div>
        <div style={{padding:"10px 12px",borderRadius:14,background:"#f5f3ff",border:"1px solid #ddd6fe"}}>
          <div style={{fontSize:10,fontWeight:800,letterSpacing:"0.08em",color:"#7c3aed"}}>进入面试</div>
          <div style={{fontSize:22,fontWeight:900,color:"#7c3aed",lineHeight:1,marginTop:8}}>{interviewCount}</div>
        </div>
        <div style={{padding:"10px 12px",borderRadius:14,background:"#fff5f5",border:"1px solid #fecaca"}}>
          <div style={{fontSize:10,fontWeight:800,letterSpacing:"0.08em",color:"#dc2626"}}>未通过</div>
          <div style={{fontSize:22,fontWeight:900,color:"#dc2626",lineHeight:1,marginTop:8}}>{failedCount}</div>
        </div>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"minmax(296px, 336px) minmax(0, 1fr)",gap:18,alignItems:"start"}}>
      <div style={railPanel}>
        <div style={{padding:"18px 18px 14px",borderBottom:`1px solid ${T.border}`,background:"linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:10}}>
            <div>
              <div style={{fontSize:11,fontWeight:800,letterSpacing:"0.08em",color:T.text4}}>候选人轨道</div>
              <div style={{fontSize:20,fontWeight:900,color:T.text,letterSpacing:"-0.03em",marginTop:6}}>全部候选人</div>
            </div>
            <div style={{fontSize:12,color:T.text4,fontWeight:700}}>{filteredCands.length} / {totalCandidates}</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:14}}>
            <div style={{padding:"10px 12px",borderRadius:12,background:"#ffffff",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>对比中</div>
              <div style={{fontSize:18,fontWeight:900,color:T.text,marginTop:6}}>{compared.length}</div>
            </div>
            <div style={{padding:"10px 12px",borderRadius:12,background:"#ffffff",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>观察中</div>
              <div style={{fontSize:18,fontWeight:900,color:"#ca8a04",marginTop:6}}>{cands.filter(item=>item.status==="watching").length}</div>
            </div>
          </div>
          <div style={{display:"flex",gap:10,alignItems:"center",marginTop:14}}>
            <div style={{position:"relative",flex:1,minWidth:0}}>
              <span style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",fontSize:13,color:T.text4,pointerEvents:"none"}}>⌕</span>
              <input
                value={searchText}
                onChange={e=>setSearchText(e.target.value)}
                placeholder="搜索姓名、岗位、文件名..."
                style={{...inSt(T),marginBottom:0,fontSize:12,padding:"10px 12px 10px 34px",background:"#ffffff"}}
              />
            </div>
            <select
              value={sortMode}
              onChange={e=>setSortMode(e.target.value)}
              style={{padding:"10px 10px",border:`1px solid ${T.border2}`,borderRadius:12,background:"#ffffff",color:T.text,fontSize:12,fontWeight:700,outline:"none",cursor:"pointer",maxWidth:116}}
            >
              <option value="import">按导入时间</option>
              <option value="interview">按面试时间</option>
            </select>
          </div>
          <div style={{fontSize:10,color:T.text4,marginTop:8,lineHeight:1.6}}>
            {!!searchText.trim()?`当前命中 ${filteredCands.length} 位候选人`:sortMode==="interview"?"已排期候选人按面试时间置顶":"候选人会按上传顺序与最近活动自动排序"}
          </div>
        </div>
        <div style={{overflowY:"auto",maxHeight:"calc(100vh - 208px)",padding:"10px 10px 12px"}}>
          {filteredCands.length===0?<div style={{padding:"40px 16px",textAlign:"center",color:T.text4,fontSize:13,lineHeight:1.8}}>{searchText.trim()?"没有匹配到候选人":"暂无候选人，先上传一份简历试试"}</div>
          :filteredCands.map(c=>{
            const boundJob=jobs.find(j=>j.id===c.jobId);
            const effectiveJob=getEffectiveCandidateJob(jobs,c);
            const isCmp=compared.includes(c.id);
            const selected=selCand===c.id;
            return(<div key={c.id}
              style={{padding:"12px 12px 12px 13px",marginBottom:8,borderRadius:16,background:selected?"#f8fbff":"#ffffff",border:selected?"1px solid #bfdbfe":`1px solid ${T.border}`,boxShadow:selected?"0 12px 28px rgba(37,99,235,0.08)":"0 6px 14px rgba(15,23,42,0.04)",cursor:"pointer",transition:"all 0.16s",position:"relative"}}
              onClick={()=>setSelCand(c.id)}>
              <div style={{position:"absolute",left:0,top:12,bottom:12,width:3,borderRadius:99,background:selected?T.accent:"transparent"}} />
              <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                <button
                  onClick={e=>{e.stopPropagation();toggleCompare(c.id);}}
                  style={{width:18,height:18,border:`1.5px solid ${isCmp?T.accent:T.border2}`,borderRadius:5,background:isCmp?T.accent:"transparent",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",marginTop:7}}
                >
                  {isCmp&&<span style={{color:T.accentFg,fontSize:10,fontWeight:900}}>✓</span>}
                </button>
                <Av name={c.name} T={T} size={34}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"flex-start"}}>
                    <div style={{minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:800,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name||"未命名"}</div>
                      <div style={{fontSize:11,color:T.text4,marginTop:3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{effectiveJob?.title||c.screening?.roleDirection||"未绑定岗位"}</div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      {c.screening&&<div style={{fontSize:18,fontWeight:900,color:scColor(c.screening.overallScore),lineHeight:1}}>{c.screening.overallScore?.toFixed(1)}</div>}
                      <div style={{fontSize:10,color:T.text4,marginTop:3}}>AI评分</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10,alignItems:"center"}}>
                    <SBadge status={c.status}/>
                    {!boundJob&&effectiveJob&&<span style={{fontSize:10,fontWeight:800,padding:"4px 8px",borderRadius:999,background:"#eff6ff",color:"#2563eb"}}>AI已识别岗位</span>}
                    {!effectiveJob&&c.screening?.matchedJobTitle&&<span style={{fontSize:10,fontWeight:800,padding:"4px 8px",borderRadius:999,background:"#eff6ff",color:"#2563eb",maxWidth:"100%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>AI建议：{c.screening.matchedJobTitle}</span>}
                    {c.statusSource==="manual"&&<span style={{fontSize:10,fontWeight:800,padding:"4px 8px",borderRadius:999,background:"#eef2ff",color:"#4f46e5"}}>手动状态</span>}
                  </div>
                  {(interviewTasks?.[c.id]?.loading || questionTasks?.[c.id]?.loading || c.scheduledAt || c.directorVerdict?.verdict)&&<div style={{display:"grid",gap:4,marginTop:10}}>
                    {interviewTasks?.[c.id]?.loading&&<div style={{fontSize:10,color:"#2563eb",fontWeight:700}}>面试评估后台运行中</div>}
                    {questionTasks?.[c.id]?.loading&&<div style={{fontSize:10,color:"#7c3aed",fontWeight:700}}>面试题后台生成中</div>}
                    {c.status==="interview"&&<div style={{fontSize:10,color:"#7c3aed",fontWeight:700}}>
                      📅 {c.scheduledAt?`面试时间：${fmtDate(c.scheduledAt)}${(c.interviewLocation ?? "")?` · 📍 ${c.interviewLocation ?? ""}`:""}`:"已进入面试 · 待安排时间"}
                    </div>}
                    {c.status!=="interview"&&c.scheduledAt&&isSoon(c.scheduledAt)&&<div style={{fontSize:10,color:"#7c3aed"}}>📅 {fmtDate(c.scheduledAt)}{(c.interviewLocation ?? "")?` · 📍 ${c.interviewLocation ?? ""}`:""}</div>}
                    {c.directorVerdict?.verdict&&<div style={{fontSize:10,fontWeight:700,color:c.directorVerdict.verdict==="录用"?"#059669":c.directorVerdict.verdict==="淘汰"?"#dc2626":"#ca8a04"}}>总监：{c.directorVerdict.verdict}</div>}
                  </div>}
                </div>
              </div>
            </div>);
          })}
        </div>
      </div>
      {cand?<CandDetail T={T} cand={cand} job={job} jobs={jobs} allCandidates={cands} tab={tab} setTab={setTab} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} questionTask={questionTasks?.[cand.id]} interviewTask={interviewTasks?.[cand.id]} startQuestionGeneration={startQuestionGeneration} startInterviewAssessment={startInterviewAssessment} onDelete={()=>deleteCandidate(cand)} onReplaceResume={replaceCandidateResume}/>
      :<Empty T={T} icon="◉" title="选择候选人" sub="从左侧选择，或勾选多人后点击「对比」"/>}
    </div>
  </Page>);
}

function ResumeImportModal({T,jobs,cands,cfg,recordTokens,dirCtx,onClose,onCreated,onOpenCandidate,onReplaceExisting}) {
  const [jobId,setJobId]=useState(jobs[0]?.id ? String(jobs[0].id) : "");
  const [name,setName]=useState("");
  const [resumeFile,setResumeFile]=useState(null);
  const [resumeFileName,setResumeFileName]=useState("");
  const [drag,setDrag]=useState(false);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const [info,setInfo]=useState("");
  const [duplicateInfo,setDuplicateInfo]=useState(null);
  const selectedJob=jobs.find(j=>String(j.id)===String(jobId));

  const queueResumeFile=file=>{
    if(!file) return;
    if(getFileKind(file)==="unknown"){setErr("仅支持 PDF、图片、Word(.docx) 或纯文本简历文件");return;}
    setResumeFile(file);
    setResumeFileName(file.name);
    setErr("");
    setInfo("");
    setDuplicateInfo(null);
  };

  const submit=async()=>{
    if(!selectedJob){setErr("请先选择岗位");return;}
    if(!resumeFile){setErr("请先上传简历文件");return;}
    setErr("");setInfo("");setDuplicateInfo(null);setLoading(true);
    try{
      const { candidate, screening }=await createCandidateFromResumeFile({cfg,job:selectedJob,file:resumeFile,onTokens:recordTokens,dirCtx,name,existingCandidates:cands});
      setInfo(`已完成识别与初筛：${candidate.name} / ${getScoreBand(screening.overallScore).label}`);
      onCreated(candidate);
    }catch(error){
      if(error?.code==="DUPLICATE_RESUME"){
        setDuplicateInfo({
          candidateId:error.duplicateCandidateId,
          candidateName:error.duplicateCandidateName,
          fileName:error.duplicateCandidateFileName,
        });
      }
      setErr(error?.message||"上传简历失败");
    }
    setLoading(false);
  };
  const replaceDuplicateResume=async()=>{
    if(!duplicateInfo?.candidateId || !resumeFile || !onReplaceExisting) return;
    setErr("");setInfo("");setLoading(true);
    try{
      await onReplaceExisting(duplicateInfo.candidateId,resumeFile);
    }catch(error){
      setErr(error?.message||"更新简历失败");
      setLoading(false);
    }
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
          {duplicateInfo&&<div style={{marginBottom:12,padding:"12px 14px",background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:12}}>
            <div style={{fontSize:12,fontWeight:800,color:"#9a3412",marginBottom:6}}>检测到重复候选人</div>
            <div style={{fontSize:12,color:"#7c2d12",lineHeight:1.8}}>
              当前文件更像候选人 <strong>「{duplicateInfo.candidateName||"未命名候选人"}」</strong>
              {duplicateInfo.fileName?`（${duplicateInfo.fileName}）`:""}。你可以直接打开该候选人查看，或用当前文件覆盖更新。
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
              <button onClick={()=>onOpenCandidate?.(duplicateInfo.candidateId)} style={{padding:"8px 12px",background:"#eff6ff",color:"#2563eb",border:"1px solid #bfdbfe",borderRadius:10,cursor:"pointer",fontSize:12,fontWeight:800}}>打开该候选人</button>
              <button onClick={replaceDuplicateResume} disabled={loading||!resumeFile} style={{padding:"8px 12px",background:"#111827",color:"#fff",border:"none",borderRadius:10,cursor:loading||!resumeFile?"not-allowed":"pointer",fontSize:12,fontWeight:800,opacity:loading||!resumeFile?0.45:1}}>用当前文件覆盖更新</button>
            </div>
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
// ─── SETTINGS VIEW ───────────────────────────────────────────
function SettingsView({T,cfg,setCfg,usageLogs,dirStats,dirDone,dirMatch,jobs,cloud,modelStatus,reloadModelStatus}) {
  const [keys,setKeys]=useState(cfg.apiKeys||{});
  const [saved,setSaved]=useState("");
  const saveKey=pid=>{setCfg(p=>({...p,apiKeys:{...p.apiKeys,[pid]:keys[pid]}}));setSaved(pid);setTimeout(()=>setSaved(""),1500);};
  const usingProxy=cfg.mode!=="direct";
  const cloudTone=cloud?.phase==="ready"?{c:"#059669",bg:"#ecfdf5"}:cloud?.phase==="syncing"||cloud?.phase==="loading"?{c:"#2563eb",bg:"#eff6ff"}:{c:"#dc2626",bg:"#fef2f2"};
  const cloudLabel=cloud?.phase==="ready"?"已连接 D1":cloud?.phase==="syncing"?"同步中":cloud?.phase==="loading"?"连接中":"云端异常";
  const providerStatusMap=Object.fromEntries((modelStatus.providers||[]).map(item=>[item.id,item]));
  const connectedProviders=(modelStatus.providers||[]).filter(item=>item.configured);
  const firstConnectedProvider=connectedProviders[0] || null;
  const providerEntries=Object.entries(PROVIDERS).sort(([a],[b])=>{
    const aConnected=!!providerStatusMap[a]?.configured;
    const bConnected=!!providerStatusMap[b]?.configured;
    if(aConnected!==bConnected) return aConnected?-1:1;
    if(cfg.provider===a && cfg.provider!==b) return -1;
    if(cfg.provider===b && cfg.provider!==a) return 1;
    return 0;
  });

  const accuracy=dirDone.map(c=>{
    const aiRec=getFinalAiRecommendation(c);
    const dir=c.directorVerdict.verdict;
    const j=jobs.find(j=>j.id===c.jobId);
    const match=getAiVerdictTone(aiRec)!=="unknown" && getAiVerdictTone(aiRec)===getHumanVerdictTone(dir);
    return{name:c.name||"未命名",job:j?.title||"",aiRec,dir,match,date:c.directorVerdict.date};
  });

  const days=[...new Set(usageLogs.map(r=>r.date))].sort().slice(-14);
  const dayTotals=days.map(d=>({date:d,tokens:usageLogs.filter(r=>r.date===d).reduce((s,r)=>s+r.input+r.output,0),calls:usageLogs.filter(r=>r.date===d).reduce((s,r)=>s+r.calls,0)}));
  const maxT=Math.max(...dayTotals.map(d=>d.tokens),1);
  const total={tokens:usageLogs.reduce((s,r)=>s+r.input+r.output,0),calls:usageLogs.reduce((s,r)=>s+r.calls,0)};
  const settingsShell={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:CARD_RADIUS,
    boxShadow:SOFT_SHADOW,
  };
  const settingsPanel={...settingsShell,padding:"20px 22px"};
  const systemSummaryCards=[
    {label:"调用模式",value:usingProxy?"后端代理":"浏览器直连",tone:usingProxy?"#2563eb":"#ca8a04"},
    {label:"云端同步",value:cloudLabel,tone:cloudTone.c},
    {label:"已连接模型",value:`${connectedProviders.length} 个`,tone:connectedProviders.length?"#059669":"#dc2626"},
  ];

  return(<Page T={T} title="设置" sub="配置 API 密钥、AI 模型与界面偏好">
    <div style={{display:"grid",gridTemplateColumns:"minmax(0,0.95fr) minmax(360px,1.05fr)",gap:18,alignItems:"start"}}>
      <div style={{display:"grid",gap:18}}>
        <div style={{...settingsShell,padding:"20px 22px 18px"}}>
          <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.18fr) minmax(320px,0.82fr)",gap:18,alignItems:"start"}}>
            <div>
              <div style={{fontSize:22,fontWeight:900,color:T.text,letterSpacing:"-0.03em"}}>系统与模型控制台</div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:6,maxWidth:760}}>把模型连通、云端同步、主题风格和日常用量收进一个控制台里。先看系统健康度，再处理具体配置，避免设置页也变成很多等权重的小卡片。</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:14}}>
                {systemSummaryCards.map(item=>(
                  <Chip key={item.label} c={item.tone} bg="#ffffff">{`${item.label} · ${item.value}`}</Chip>
                ))}
              </div>
            </div>
            <div style={{padding:"14px 16px",borderRadius:18,background:"#ffffff",border:`1px solid ${T.border}`,display:"grid",gap:12}}>
              <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>系统快照</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:10}}>
                {systemSummaryCards.map(item=>(
                  <div key={item.label}>
                    <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>{item.label}</div>
                    <div style={{fontSize:18,fontWeight:900,color:item.tone,marginTop:8,lineHeight:1.2}}>{item.value}</div>
                  </div>
                ))}
              </div>
              <div style={{fontSize:12,color:T.text4,lineHeight:1.75}}>代理模式、云端同步和后台模型连接数都会汇总到这里，先看系统是否健康，再往下调模型和同步策略。</div>
            </div>
          </div>
        </div>

        <div style={settingsPanel}>
          <SecLabel T={T}>系统接入</SecLabel>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            {[["proxy","后端代理","推荐：浏览器不直接暴露模型密钥"],["direct","浏览器直连","仅适合本地临时调试"]].map(([id,title,desc])=>(
              <div key={id} onClick={()=>setCfg(p=>normalizeCfg({...p,mode:id}))}
                style={{padding:"14px 16px",border:`2px solid ${cfg.mode===id?T.accent:T.border}`,borderRadius:14,cursor:"pointer",background:cfg.mode===id?`${T.accent}10`:"#fbfcfe",boxShadow:cfg.mode===id?"0 12px 24px rgba(15,23,42,0.06)":"none"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                  <span style={{fontSize:14,fontWeight:800,color:T.text}}>{title}</span>
                  {cfg.mode===id&&<span style={{fontSize:12,color:T.accent,fontWeight:700}}>✓</span>}
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.7}}>{desc}</div>
              </div>
            ))}
          </div>
          {usingProxy&&<>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
              <Inp T={T} label="代理地址" placeholder="http://localhost:8787/api/ai" value={cfg.proxyUrl||""} onChange={e=>setCfg(p=>normalizeCfg({...p,proxyUrl:e.target.value}))}/>
              <Inp T={T} label="代理访问令牌（可选）" placeholder="留空表示不校验" value={cfg.proxyToken||""} onChange={e=>setCfg(p=>normalizeCfg({...p,proxyToken:e.target.value}))}/>
            </div>
            <div style={{fontSize:12,color:T.text3,lineHeight:1.7,padding:"12px 14px",background:"#f8fafc",borderRadius:12,border:`1px solid ${T.border}`}}>
              当前为代理模式：前端只发送 `provider / model / prompt` 到你的服务端，真正的模型 API Key 保存在服务端环境变量里。
            </div>
          </>}
          <div style={{marginTop:14,padding:"14px 16px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:10,flexWrap:"wrap"}}>
              <div>
                <div style={{fontSize:14,fontWeight:800,color:T.text}}>Cloudflare D1 同步状态</div>
                <div style={{fontSize:12,color:T.text4,marginTop:4,lineHeight:1.7}}>岗位、候选人、面试记录和调用统计会自动同步到云端，同时保留浏览器本地缓存兜底。</div>
              </div>
              <Chip c={cloudTone.c} bg={cloudTone.bg}>{cloudLabel}</Chip>
            </div>
            <div style={{fontSize:12,color:T.text2,lineHeight:1.8,padding:"10px 12px",background:T.card2,borderRadius:10,border:`1px solid ${T.border}`}}>
              <div>{cloud?.message||"等待云端同步状态..."}</div>
              {cloud?.updatedAt&&<div style={{marginTop:6,color:T.text4}}>最近成功同步：{fmtCloudTime(cloud.updatedAt)}</div>}
              <div style={{marginTop:6,color:T.text4}}>正常版本更新不会清空 D1 里的数据；但如果你清浏览器缓存，只会丢本地副本，不会影响云端主数据。</div>
              <div style={{marginTop:6,color:T.text4}}>如果你配置了「代理访问令牌」，云端数据接口也会复用同一个 Bearer token。当前同步采用整库快照，多人同时改动时以后保存的内容会覆盖之前的保存。</div>
            </div>
          </div>
        </div>

        <div style={settingsPanel}>
          <SecLabel T={T}>界面风格</SecLabel>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
            {THEMES.map(t=>{
              const th=getTheme(t.id);
              return(<div key={t.id} onClick={()=>setCfg(p=>({...p,theme:t.id}))} style={{border:`2px solid ${cfg.theme===t.id?T.accent:T.border}`,borderRadius:14,overflow:"hidden",cursor:"pointer",transition:"border 0.15s, transform 0.15s",background:"#ffffff"}}>
                <div style={{height:56,background:th.bg,padding:10,display:"flex",flexDirection:"column",gap:4}}>
                  <div style={{height:8,width:"55%",background:th.surface,borderRadius:3,border:`1px solid ${th.border}`}}/>
                  <div style={{display:"flex",gap:4}}><div style={{height:7,width:"27%",background:th.accent,borderRadius:3,opacity:0.85}}/><div style={{height:7,width:"37%",background:th.border2,borderRadius:3}}/></div>
                  <div style={{height:4,width:"72%",background:th.border,borderRadius:3}}/>
                </div>
                <div style={{padding:"8px 10px",background:T.surface,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:12,fontWeight:700,color:T.text}}>{t.name}</span>
                  {cfg.theme===t.id&&<span style={{color:T.accent,fontSize:12}}>✓</span>}
                </div>
              </div>);
            })}
          </div>
        </div>
      </div>

      <div style={{display:"grid",gap:18}}>
        <div style={settingsPanel}>
          <SecLabel T={T}>模型控制台</SecLabel>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:12,flexWrap:"wrap"}}>
            <div>
              <div style={{fontSize:14,fontWeight:800,color:T.text}}>后台模型状态</div>
              <div style={{fontSize:12,color:T.text4,marginTop:4}}>设置页每次打开都会自动检测后台环境变量，告诉你哪些模型已连通、哪些还没配置。</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              {modelStatus.checkedAt&&<span style={{fontSize:11,color:T.text4}}>最近检查：{fmtCloudTime(modelStatus.checkedAt)}</span>}
              <button
                onClick={reloadModelStatus}
                style={{padding:"8px 12px",background:T.card2,color:T.text3,border:`1px solid ${T.border}`,borderRadius:10,cursor:"pointer",fontSize:12,fontWeight:700}}
              >
                {modelStatus.loading?"检测中...":"重新检测"}
              </button>
            </div>
          </div>
          {modelStatus.error
            ?<div style={{fontSize:12,color:"#b91c1c",padding:"10px 12px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:8,lineHeight:1.7}}>{modelStatus.error}</div>
            :<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10,marginBottom:12}}>
              {providerEntries.map(([pid,prov])=>{
                const statusItem=modelStatus.providers.find(item=>item.id===pid);
                const connected=!!statusItem?.configured;
                const tone=connected?{c:"#059669",bg:"#ecfdf5",dot:"#10b981"}:{c:"#dc2626",bg:"#fef2f2",dot:"#ef4444"};
                return(
                  <div key={pid} style={{padding:"14px 14px 12px",background:connected?tone.bg:"#fbfcfe",border:`1px solid ${connected?"#bbf7d0":T.border}`,borderRadius:14}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
                        <div style={{width:10,height:10,borderRadius:999,background:tone.dot,flexShrink:0}}/>
                        <div style={{fontSize:13,fontWeight:800,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{prov.name}</div>
                      </div>
                      <Chip c={tone.c} bg={connected?tone.bg:"#fef2f2"}>{connected?"已连接":"未连接"}</Chip>
                    </div>
                    <div style={{fontSize:11,color:T.text3,lineHeight:1.7}}>{statusItem?.message || "尚未检测到该模型状态"}</div>
                    <div style={{fontSize:11,color:T.text4,marginTop:6,lineHeight:1.6}}>{statusItem?.tip || "配置好服务端环境变量后即可在代理模式下使用"}</div>
                  </div>
                );
              })}
            </div>}
          <div style={{fontSize:11,color:T.text4,marginBottom:12,lineHeight:1.7}}>
            {usingProxy
              ?"当前为后端代理模式，以上状态来自服务端环境变量探测。"
              :"当前为浏览器直连模式，后台模型状态仅供参考；真正调用仍取决于你在前端保存的 API Key。"}
          </div>
          {usingProxy&&firstConnectedProvider&&<div style={{fontSize:12,color:T.text3,marginBottom:14,lineHeight:1.7}}>
            代理模式下会默认选择已连接模型，当前优先供应商为 <span style={{fontWeight:800,color:T.text}}>{PROVIDERS[firstConnectedProvider.id]?.name||firstConnectedProvider.id}</span>。
          </div>}
          <div style={{display:"grid",gap:12}}>
            {providerEntries.map(([pid,prov])=>{
              const isActive=cfg.provider===pid;
              const providerState=providerStatusMap[pid];
              const isConnected=!!providerState?.configured;
              const selectionDisabled=usingProxy && !isConnected;
              return(<div key={pid} style={{background:isActive?`${prov.color}08`:"#ffffff",border:`2px solid ${isActive?prov.color:T.border}`,borderRadius:16,padding:"16px 18px",transition:"border 0.15s"}}>
                <div style={{display:"flex",alignItems:"center",gap:11,marginBottom:12}}>
                  <div style={{width:34,height:34,borderRadius:10,background:prov.color,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:14,flexShrink:0}}>{prov.logo}</div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:800,color:T.text}}>{prov.name}</div>
                    <div style={{fontSize:11,color:T.text4}}>{prov.models.length} 个可用模型</div>
                  </div>
                  {isActive&&<span style={{fontSize:11,fontWeight:700,padding:"3px 9px",background:`${prov.color}18`,color:prov.color,borderRadius:20}}>当前使用</span>}
                  {usingProxy&&<span style={{fontSize:11,fontWeight:700,padding:"3px 9px",background:isConnected?"#ecfdf5":"#fef2f2",color:isConnected?"#059669":"#dc2626",borderRadius:20}}>{isConnected?"已连接":"未连接"}</span>}
                </div>
                {!usingProxy
                  ?<div style={{marginBottom:11}}>
                    <label style={lbSt(T)}>API Key</label>
                    <div style={{display:"flex",gap:7}}>
                      <input type="password" value={keys[pid]||""} onChange={e=>setKeys(p=>({...p,[pid]:e.target.value}))} placeholder={prov.keyPlaceholder} style={{...inSt(T),flex:1,fontSize:12}}/>
                      <button onClick={()=>saveKey(pid)} style={{padding:"7px 13px",background:saved===pid?"#059669":prov.color,color:"#fff",border:"none",borderRadius:10,fontSize:12,fontWeight:700,cursor:"pointer",flexShrink:0,minWidth:56,transition:"background 0.2s"}}>{saved===pid?"✓":"保存"}</button>
                    </div>
                  </div>
                  :<div style={{marginBottom:11,padding:"10px 12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:10,fontSize:12,color:T.text3,lineHeight:1.6}}>
                    {providerState?.message || "代理模式下，此供应商的 API Key 由服务端环境变量提供，前端不再保存密钥。"}
                  </div>}
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {prov.models.map(m=>{
                    const isSel=isActive&&cfg.model===m.id;
                    return(<div key={m.id} onClick={()=>{if(selectionDisabled) return;setCfg(p=>({...p,provider:pid,model:m.id}));}}
                      style={{padding:"9px 10px",border:`1.5px solid ${isSel?prov.color:T.border}`,borderRadius:10,cursor:selectionDisabled?"not-allowed":"pointer",background:isSel?`${prov.color}10`:T.card2,transition:"all 0.1s",opacity:selectionDisabled?0.45:1}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}><span style={{fontSize:12,fontWeight:700,color:T.text}}>{m.name}</span>{isSel&&<span style={{color:prov.color,fontSize:11}}>✓</span>}</div>
                      <div style={{fontSize:11,color:T.text3,lineHeight:1.6}}>{m.note}</div>
                      {prov.pricing?.[m.id]&&<div style={{fontSize:10,color:T.text4,marginTop:2}}>${prov.pricing[m.id].in}/${prov.pricing[m.id].out}/M</div>}
                    </div>);
                  })}
                </div>
                {usingProxy&&selectionDisabled&&<div style={{fontSize:11,color:"#dc2626",marginTop:8,lineHeight:1.7}}>当前后台还没连通这个供应商，代理模式下默认不会切到它。请先配置对应环境变量，再点上方“重新检测”。</div>}
              </div>);
            })}
          </div>
        </div>

        <div style={settingsPanel}>
          <SecLabel T={T}>总监沉淀与用量</SecLabel>
          <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr)",gap:18}}>
            <div>
              <div style={{fontSize:14,fontWeight:800,color:T.text,marginBottom:10}}>总监判断沉淀 · AI准确率追踪</div>
              {accuracy.length===0
                ?<div style={{textAlign:"center",padding:"28px",color:T.text4,fontSize:13,background:"#fbfcfe",border:`1px solid ${T.border}`,borderRadius:14}}>暂无判断记录，在候选人的「④ 总监判断」中填写后自动追踪</div>
                :<>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:16}}>
                    {[{label:"已沉淀案例",val:dirStats.total,color:T.accent},{label:"AI判断一致",val:dirStats.match,color:"#16a34a"},{label:"AI匹配率",val:`${dirStats.rate}%`,color:dirStats.rate>=70?"#16a34a":dirStats.rate>=50?"#ca8a04":"#dc2626"}].map(s=>(
                      <div key={s.label} style={{padding:"14px",background:T.card2,borderRadius:12,border:`1px solid ${T.border}`,textAlign:"center"}}>
                        <div style={{fontSize:26,fontWeight:900,color:s.color}}>{s.val}</div>
                        <div style={{fontSize:12,color:T.text4,marginTop:3}}>{s.label}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{height:5,background:T.border,borderRadius:999,marginBottom:16}}>
                    <div style={{width:`${dirStats.rate}%`,height:"100%",background:dirStats.rate>=70?"#16a34a":dirStats.rate>=50?"#ca8a04":"#6366f1",borderRadius:999,transition:"width 0.5s"}}/>
                  </div>
                  <div style={{border:`1px solid ${T.border}`,borderRadius:14,overflow:"hidden"}}>
                    <div style={{display:"grid",gridTemplateColumns:"1.5fr 1.5fr 1fr 1fr 1fr",padding:"10px 12px",background:T.card2,fontSize:11,fontWeight:700,color:T.text4,borderBottom:`1px solid ${T.border}`}}>
                      <span>候选人</span><span>岗位</span><span>AI建议</span><span>总监判断</span><span style={{textAlign:"center"}}>一致</span>
                    </div>
                    {accuracy.slice().reverse().map((a,i)=>(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"1.5fr 1.5fr 1fr 1fr 1fr",padding:"10px 12px",fontSize:12,color:T.text2,borderBottom:i<accuracy.length-1?`1px solid ${T.border}`:"none",alignItems:"center"}}>
                        <span style={{fontWeight:600}}>{a.name}</span>
                        <span style={{color:T.text3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.job}</span>
                        <Chip c={recSt(a.aiRec).c} bg={recSt(a.aiRec).bg}>{a.aiRec?.replace("建议","")}</Chip>
                        <span style={{fontWeight:700,color:a.dir==="录用"?"#059669":a.dir==="淘汰"?"#dc2626":"#ca8a04"}}>{a.dir}</span>
                        <span style={{textAlign:"center",fontSize:16}}>{a.match?"✅":"❌"}</span>
                      </div>
                    ))}
                  </div>
                </>}
            </div>
            <div>
              <div style={{fontSize:14,fontWeight:800,color:T.text,marginBottom:10}}>用量统计（近14天）</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:16}}>
                {[{label:"总调用次数",val:total.calls,color:T.accent},{label:"总 Token",val:fmt(total.tokens),color:"#7c3aed"}].map(s=>(
                  <div key={s.label} style={{padding:"12px",background:T.card2,borderRadius:12,border:`1px solid ${T.border}`,textAlign:"center"}}>
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
                      <div title={`${d.date}: ${fmt(d.tokens)} tokens, ${d.calls}次`} style={{width:"100%",borderRadius:"4px 4px 0 0",background:isT?T.accent:T.border2,height:`${h}px`,opacity:0.85,cursor:"help"}}/>
                      <div style={{fontSize:9,color:T.text4,transform:"rotate(-45deg)",transformOrigin:"top center",whiteSpace:"nowrap"}}>{d.date.slice(5)}</div>
                    </div>);
                  })}
                </div>
                {(()=>{
                  const todayLogs=usageLogs.filter(r=>r.date===todayStr());
                  return todayLogs.length>0?(<div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {todayLogs.map((r,i)=>{const p=PROVIDERS[r.provider];return p?(<div key={i} style={{padding:"7px 11px",background:T.card2,border:`1px solid ${T.border}`,borderLeft:`3px solid ${p.color}`,borderRadius:10,fontSize:12}}>
                      <span style={{fontWeight:700,color:p.color}}>{p.name}</span>
                      <span style={{color:T.text3,marginLeft:7}}>{fmt(r.input+r.output)} tokens</span>
                      <span style={{color:T.text4,marginLeft:5}}>{r.calls}次</span>
                    </div>):null;})}
                  </div>):null;
                })()}
              </>):<div style={{textAlign:"center",padding:"28px",color:T.text4,fontSize:13,background:"#fbfcfe",border:`1px solid ${T.border}`,borderRadius:14}}>暂无使用记录</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  </Page>);
}

// ─── SHARED COMPONENTS ───────────────────────────────────────
export const Page=({T,title,sub,children})=>(<div style={{padding:"32px 36px 38px",maxWidth:1240,margin:"0 auto"}}><div style={{marginBottom:26,padding:"0 0 18px",borderBottom:`1px solid ${T.border}`}}><h1 style={{fontSize:24,fontWeight:900,color:T.text,margin:0,letterSpacing:"-0.02em"}}>{title}</h1>{sub&&<div style={{fontSize:13,color:T.text4,marginTop:6,lineHeight:1.8,maxWidth:720}}>{sub}</div>}</div>{children}</div>);
export const SCard=({T,title,children})=>(<div style={{background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"20px 22px",marginBottom:16,boxShadow:SOFT_SHADOW}}>{title&&<div style={{fontSize:15,fontWeight:800,color:T.text,marginBottom:16,paddingBottom:12,borderBottom:`1px solid ${T.border}`}}>{title}</div>}{children}</div>);
export const cardSt=T=>({background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,padding:"20px 22px",marginBottom:14,boxShadow:SOFT_SHADOW});
export const ScoreSection=({T,title,children})=>(<div style={{...cardSt(T),marginBottom:14}}><div style={{fontSize:13,fontWeight:800,color:T.text,marginBottom:12,paddingBottom:8,borderBottom:`1px solid ${T.border}`}}>{title}</div>{children}</div>);
export const ScoreBar=({T,label,score,max,badge,note})=>{const c=scColor(score,max||5);return(<div style={{padding:"9px 0",borderBottom:`1px solid ${T.border}`}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}><div style={{display:"flex",gap:7,alignItems:"center"}}><span style={{fontSize:13,color:T.text,fontWeight:500}}>{label}</span>{badge&&<Chip c={T.text3} bg={T.navActive}>{badge}</Chip>}</div><span style={{fontWeight:700,color:c,fontSize:13}}>{score}/{max}</span></div><MiniBar score={score} max={max} color={c}/>{note&&<div style={{fontSize:11,color:T.text4,marginTop:4}}>{note}</div>}</div>);};
export const MiniBar=({score,max,color})=>(<div style={{height:3,background:"#e5e7eb",borderRadius:2}}><div style={{width:`${(score/(max||5))*100}%`,height:"100%",background:color||"#111827",borderRadius:2,transition:"width 0.4s ease"}}/></div>);
export const SecLabel=({T,children})=><div style={{fontSize:11,fontWeight:800,color:T.text4,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10,marginTop:4}}>{children}</div>;
export const Chip=({c,bg,children,lg})=><span style={{display:"inline-block",padding:lg?"6px 14px":"4px 9px",borderRadius:999,fontSize:lg?13:11,fontWeight:700,color:c,background:bg,whiteSpace:"nowrap",border:"1px solid rgba(255,255,255,0.25)"}}>{children}</span>;
export const SBadge=({status})=>{const s=STATUS[status]||STATUS.pending;return <Chip c={s.color} bg={s.bg}>{s.label}</Chip>;};
export const Av=({name,T,size=36})=><div style={{width:size,height:size,borderRadius:"50%",background:`${T.accent}22`,color:T.accent,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:size*0.38,flexShrink:0}}>{(name||"?")[0]?.toUpperCase()}</div>;
export const Inp=({T,label,...props})=><div style={{marginBottom:9}}>{label&&<label style={lbSt(T)}>{label}</label>}<input style={inSt(T)} {...props}/></div>;
export const Empty=({T,icon,title,sub})=><div style={{textAlign:"center",padding:"60px 24px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:CARD_RADIUS,boxShadow:SOFT_SHADOW}}><div style={{fontSize:32,color:T.border2,marginBottom:10}}>{icon}</div><div style={{fontSize:15,fontWeight:700,color:T.text2,marginBottom:5}}>{title}</div><div style={{fontSize:13,color:T.text4,lineHeight:1.7}}>{sub}</div></div>;
export const ErrBox=({children})=><div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:7,padding:"8px 12px",fontSize:13,color:"#dc2626",marginBottom:9}}>{children}</div>;
export const BtnPrimary=({T,children,loading,disabled,onClick})=><button onClick={onClick} disabled={disabled} style={{padding:"12px 14px",background:T.accent,color:T.accentFg,border:"none",borderRadius:10,fontSize:14,fontWeight:800,cursor:disabled?"not-allowed":"pointer",width:"100%",opacity:disabled?0.5:1,transition:"opacity 0.1s, transform 0.1s"}}>{children}</button>;
export const Spin=({text})=><span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7}}><span style={{width:13,height:13,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/>{text}</span>;
export const lbSt=T=>({fontSize:11,fontWeight:600,color:T.text3,display:"block",marginBottom:5});
export const inSt=T=>({width:"100%",padding:"10px 12px",border:`1px solid ${T.border2}`,borderRadius:10,fontSize:13,color:T.text,outline:"none",boxSizing:"border-box",fontFamily:"inherit",background:T.inputBg});
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
