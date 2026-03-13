import { useState, useEffect, useRef } from "react";

// ─── PERSIST ─────────────────────────────────────────────────
const load = (k,d)=>{ try{const v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch{return d;}};
const save = (k,v)=>{ try{localStorage.setItem(k,JSON.stringify(v));}catch{}};
const FILE_MARKER=/^\[文件：(.+)\]$/;
const extractStoredFileName=resume=>FILE_MARKER.exec(resume||"")?.[1]||"";
const isStoredFileResume=resume=>FILE_MARKER.test(resume||"");
const MAX_RESUME_FILES=5;
const FILE_CACHE=new Map();
const getStoredResumeFileNames=cand=>{
  const names=(cand?.resumeFiles||[]).map(f=>typeof f==="string"?f:f?.name).filter(Boolean);
  if(names.length) return names;
  const legacy=extractStoredFileName(cand?.resume||"");
  return legacy?legacy.split("、").map(s=>s.trim()).filter(Boolean):[];
};
const getCachedResumeFiles=id=>FILE_CACHE.get(id)||[];
const setCachedResumeFiles=(id,files)=>{ if(files?.length) FILE_CACHE.set(id,files); else FILE_CACHE.delete(id); };
const fileKey=file=>`${file.name}::${file.size}::${file.lastModified}`;
const uniqFiles=files=>{const seen=new Set();return files.filter(file=>{const key=fileKey(file);if(seen.has(key))return false;seen.add(key);return true;});};
const storeResumeFilesMeta=files=>files.map(file=>({name:file.name,size:file.size,type:file.type,lastModified:file.lastModified}));
const fileMarkerFromNames=names=>names.length?`[文件：${names.join("、")}]`:"";

// ─── PROVIDERS ───────────────────────────────────────────────
const PROVIDERS = {
  claude:   {name:"Claude",  color:"#d97706",logo:"C",supportsFile:true, endpoint:"https://api.anthropic.com/v1/messages",          keyPlaceholder:"sk-ant-api03-...",models:[{id:"claude-sonnet-4-20250514",name:"Sonnet 4",note:"推荐"},{id:"claude-opus-4-5",name:"Opus 4.5",note:"最强"},{id:"claude-haiku-4-5-20251001",name:"Haiku 4.5",note:"极速"}],pricing:{"claude-sonnet-4-20250514":{in:3,out:15},"claude-opus-4-5":{in:15,out:75},"claude-haiku-4-5-20251001":{in:0.8,out:4}}},
  gemini:   {name:"Gemini",  color:"#1a73e8",logo:"G",supportsFile:true, endpoint:"https://generativelanguage.googleapis.com/v1beta/models",keyPlaceholder:"AIza...",        models:[{id:"gemini-2.0-flash",name:"2.0 Flash",note:"推荐·极速·低价"},{id:"gemini-2.0-flash-lite",name:"2.0 Flash Lite",note:"最低价"},{id:"gemini-1.5-pro",name:"1.5 Pro",note:"长文档"}],pricing:{"gemini-2.0-flash":{in:0.075,out:0.30},"gemini-2.0-flash-lite":{in:0.0375,out:0.15},"gemini-1.5-pro":{in:1.25,out:5}}},
  deepseek: {name:"DeepSeek",color:"#4f46e5",logo:"D",supportsFile:false,endpoint:"https://api.deepseek.com/v1/chat/completions",    keyPlaceholder:"sk-...",           models:[{id:"deepseek-chat",name:"DeepSeek V3",note:"低成本"},{id:"deepseek-reasoner",name:"DeepSeek R1",note:"深度推理"}],pricing:{"deepseek-chat":{in:0.27,out:1.1},"deepseek-reasoner":{in:0.55,out:2.19}}},
  openai:   {name:"ChatGPT", color:"#10a37f",logo:"O",supportsFile:true, endpoint:"https://api.openai.com/v1/chat/completions",      keyPlaceholder:"sk-...",           models:[{id:"gpt-4o",name:"GPT-4o",note:"旗舰"},{id:"gpt-4o-mini",name:"GPT-4o mini",note:"快速"}],pricing:{"gpt-4o":{in:2.5,out:10},"gpt-4o-mini":{in:0.15,out:0.6}}},
  kimi:     {name:"KIMI",    color:"#0ea5e9",logo:"K",supportsFile:false,endpoint:"https://api.moonshot.cn/v1/chat/completions",     keyPlaceholder:"sk-...",           models:[{id:"moonshot-v1-32k",name:"Moonshot 32K",note:"推荐"},{id:"moonshot-v1-8k",name:"8K",note:"极速"},{id:"moonshot-v1-128k",name:"128K",note:"超长"}],pricing:{"moonshot-v1-8k":{in:0.012,out:0.012},"moonshot-v1-32k":{in:0.024,out:0.024},"moonshot-v1-128k":{in:0.06,out:0.06}}},
};

// ─── 智能路由：根据任务类型自动选模型 ─────────────────────────
// routing: { enabled, textProvider, textModel, fileProvider, fileModel }
const getRoutedCfg = (cfg, hasFile=false) => {
  const r = cfg.routing;
  if (!r?.enabled) return cfg; // 未开启路由，用手动选的模型
  const pid = hasFile ? r.fileProvider : r.textProvider;
  const mid = hasFile ? r.fileModel    : r.textModel;
  if (!pid || !mid) return cfg;
  // 如果目标 provider 没有配 key，降级用当前手动配的
  if (!cfg.apiKeys?.[pid]) return cfg;
  return { ...cfg, provider: pid, model: mid };
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

const parseJsonResponse = text => {
  const cleaned=String(text||"").trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
  try{return JSON.parse(cleaned);}
  catch{return{error:"JSON解析失败",raw:text};}
};

// ─── CALL AI（文字任务）─────────────────────────────────────
async function callAI(cfg, system, user, onTokens, dirCtx="") {
  const rc = getRoutedCfg(cfg, false);
  const {provider="claude", model, apiKeys={}} = rc;
  const prov = PROVIDERS[provider]||PROVIDERS.claude;
  const apiKey = apiKeys[provider]||"";
  if (!apiKey) throw new Error(`请先在「设置」中填写 ${prov.name} 的 API Key`);
  const fullSys = dirCtx ? `${system}\n\n${dirCtx}` : system;
  let inputT=0,outputT=0,text="";

  if (provider==="claude") {
    const res=await fetch(prov.endpoint,{method:"POST",headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model,max_tokens:1200,system:fullSys,messages:[{role:"user",content:user}]})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`API Error ${res.status}`);}
    const d=await res.json(); inputT=d.usage?.input_tokens||0; outputT=d.usage?.output_tokens||0; text=d.content?.[0]?.text||"";

  } else if (provider==="gemini") {
    const url=`${prov.endpoint}/${model}:generateContent?key=${apiKey}`;
    const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      system_instruction:{parts:[{text:fullSys}]},
      contents:[{role:"user",parts:[{text:user}]}],
      generationConfig:{maxOutputTokens:1200,temperature:0.3}
    })});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`Gemini API Error ${res.status}`);}
    const d=await res.json();
    inputT=d.usageMetadata?.promptTokenCount||0; outputT=d.usageMetadata?.candidatesTokenCount||0;
    text=d.candidates?.[0]?.content?.parts?.[0]?.text||"";

  } else {
    // OpenAI 兼容接口（openai / deepseek / kimi）
    const res=await fetch(prov.endpoint,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${apiKey}`},body:JSON.stringify({model,max_tokens:1200,messages:[{role:"system",content:fullSys},{role:"user",content:user}]})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`API Error ${res.status}`);}
    const d=await res.json(); inputT=d.usage?.prompt_tokens||0; outputT=d.usage?.completion_tokens||0; text=d.choices?.[0]?.message?.content||"";
  }

  if(onTokens) onTokens(inputT,outputT,provider);
  return parseJsonResponse(text);
}

// ─── FILE HELPERS ─────────────────────────────────────────────
const readFileAsBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = e => { const b64=e.target.result.split(",")[1]; resolve({data:b64,mediaType:file.type||"application/octet-stream",name:file.name}); };
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

const extractDocxText = async (file) => {
  const mammoth = await import("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js").catch(()=>null);
  if (!mammoth) throw new Error("无法加载 .docx 解析库，请使用 PDF 或图片格式");
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return result.value || "";
};

const getFileKind = (file) => {
  const n = file.name.toLowerCase();
  if (n.endsWith(".docx")||n.endsWith(".doc")) return "docx";
  if (file.type==="application/pdf"||n.endsWith(".pdf")) return "pdf";
  if (file.type.startsWith("image/")) return "image";
  return "unknown";
};

// ─── CALL AI WITH FILE（文件任务）────────────────────────────
async function callAIWithFile(cfg, system, userText, file, onTokens, dirCtx="") {
  const rc = getRoutedCfg(cfg, true);
  const {provider="claude", model, apiKeys={}} = rc;
  const prov = PROVIDERS[provider]||PROVIDERS.claude;
  const apiKey = apiKeys[provider]||"";
  if (!apiKey) throw new Error(`请先在「设置」中填写 ${prov.name} 的 API Key`);
  const fullSys = dirCtx ? `${system}\n\n${dirCtx}` : system;

  const kind = getFileKind(file);
  if (kind==="unknown") throw new Error("仅支持 PDF、图片、Word (.docx/.doc) 格式");
  let inputT=0, outputT=0, text="";

  // .docx → 提取纯文字，走文字接口
  if (kind==="docx") {
    const docText = await extractDocxText(file);
    return callAI(cfg, system, `${userText}\n\n【文件内容如下】\n${docText}`, onTokens, dirCtx);
  }

  // 不支持文件的模型（deepseek/kimi）提前报错
  if (!prov.supportsFile) {
    throw new Error(`${prov.name} 不支持文件识别，请在设置中为「文件任务」指定 Claude 或 Gemini`);
  }

  const fileB64 = await readFileAsBase64(file);

  if (provider==="claude") {
    const fileBlock = kind==="pdf"
      ? {type:"document",source:{type:"base64",media_type:"application/pdf",data:fileB64.data}}
      : {type:"image",   source:{type:"base64",media_type:fileB64.mediaType, data:fileB64.data}};
    const res=await fetch(prov.endpoint,{method:"POST",headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model,max_tokens:1500,system:fullSys,messages:[{role:"user",content:[fileBlock,{type:"text",text:userText}]}]})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`API Error ${res.status}`);}
    const d=await res.json(); inputT=d.usage?.input_tokens||0; outputT=d.usage?.output_tokens||0; text=d.content?.[0]?.text||"";

  } else if (provider==="gemini") {
    // Gemini 支持图片和 PDF inline base64
    const mimeType = kind==="pdf" ? "application/pdf" : fileB64.mediaType;
    const url=`${prov.endpoint}/${model}:generateContent?key=${apiKey}`;
    const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      system_instruction:{parts:[{text:fullSys}]},
      contents:[{role:"user",parts:[
        {inline_data:{mime_type:mimeType,data:fileB64.data}},
        {text:userText}
      ]}],
      generationConfig:{maxOutputTokens:1500,temperature:0.3}
    })});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`Gemini API Error ${res.status}`);}
    const d=await res.json();
    inputT=d.usageMetadata?.promptTokenCount||0; outputT=d.usageMetadata?.candidatesTokenCount||0;
    text=d.candidates?.[0]?.content?.parts?.[0]?.text||"";

  } else if (provider==="openai") {
    let fileContent;
    if (kind==="image") fileContent={type:"image_url",image_url:{url:`data:${fileB64.mediaType};base64,${fileB64.data}`}};
    else if (kind==="pdf") fileContent={type:"file",file:{filename:file.name,file_data:`data:application/pdf;base64,${fileB64.data}`}};
    else throw new Error("ChatGPT 暂不支持该格式");
    const res=await fetch(prov.endpoint,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${apiKey}`},body:JSON.stringify({model,max_tokens:1500,messages:[{role:"system",content:fullSys},{role:"user",content:[fileContent,{type:"text",text:userText}]}]})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`API Error ${res.status}`);}
    const d=await res.json(); inputT=d.usage?.prompt_tokens||0; outputT=d.usage?.completion_tokens||0; text=d.choices?.[0]?.message?.content||"";
  }

  if (onTokens) onTokens(inputT, outputT, provider);
  return parseJsonResponse(text);
}

async function callAIWithFiles(cfg, system, userText, files, onTokens, dirCtx="") {
  const picked=(files||[]).filter(Boolean);
  if (!picked.length) throw new Error("请先上传至少 1 个文件");
  if (picked.length===1) return callAIWithFile(cfg, system, userText, picked[0], onTokens, dirCtx);

  const unknown=picked.filter(file=>getFileKind(file)==="unknown");
  if (unknown.length) throw new Error(`存在不支持的文件格式：${unknown.map(f=>f.name).join("、")}`);

  const docxFiles=picked.filter(file=>getFileKind(file)==="docx");
  const binaryFiles=picked.filter(file=>getFileKind(file)!=="docx");
  const docTexts=(await Promise.all(docxFiles.map(async file=>`【${file.name}】\n${await extractDocxText(file)}`))).filter(Boolean);

  if (!binaryFiles.length) {
    return callAI(cfg, system, `${userText}\n\n【文件内容如下】\n${docTexts.join("\n\n")}`, onTokens, dirCtx);
  }

  const rc = getRoutedCfg(cfg, true);
  const {provider="claude", model, apiKeys={}} = rc;
  const prov = PROVIDERS[provider]||PROVIDERS.claude;
  const apiKey = apiKeys[provider]||"";
  if (!apiKey) throw new Error(`请先在「设置」中填写 ${prov.name} 的 API Key`);
  if (!prov.supportsFile) throw new Error(`${prov.name} 不支持文件识别，请在设置中为「文件任务」指定 Claude、Gemini 或 ChatGPT`);

  const fullSys = dirCtx ? `${system}\n\n${dirCtx}` : system;
  let inputT=0, outputT=0, text="";

  if (provider==="claude") {
    const fileBlocks=await Promise.all(binaryFiles.map(async file=>{
      const kind=getFileKind(file);
      const fileB64=await readFileAsBase64(file);
      return kind==="pdf"
        ? {type:"document",source:{type:"base64",media_type:"application/pdf",data:fileB64.data}}
        : {type:"image",source:{type:"base64",media_type:fileB64.mediaType,data:fileB64.data}};
    }));
    const textBlocks=[];
    if (docTexts.length) textBlocks.push({type:"text",text:`【以下为 Word 文件提取文字】\n${docTexts.join("\n\n")}`});
    textBlocks.push({type:"text",text:userText});
    const res=await fetch(prov.endpoint,{method:"POST",headers:{"Content-Type":"application/json","x-api-key":apiKey,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},body:JSON.stringify({model,max_tokens:1800,system:fullSys,messages:[{role:"user",content:[...fileBlocks,...textBlocks]}]})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`API Error ${res.status}`);}
    const d=await res.json(); inputT=d.usage?.input_tokens||0; outputT=d.usage?.output_tokens||0; text=d.content?.[0]?.text||"";
  } else if (provider==="gemini") {
    const fileParts=await Promise.all(binaryFiles.map(async file=>{
      const kind=getFileKind(file);
      const fileB64=await readFileAsBase64(file);
      return {inline_data:{mime_type:kind==="pdf"?"application/pdf":fileB64.mediaType,data:fileB64.data}};
    }));
    const parts=[...fileParts];
    if (docTexts.length) parts.push({text:`【以下为 Word 文件提取文字】\n${docTexts.join("\n\n")}`});
    parts.push({text:userText});
    const url=`${prov.endpoint}/${model}:generateContent?key=${apiKey}`;
    const res=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      system_instruction:{parts:[{text:fullSys}]},
      contents:[{role:"user",parts}],
      generationConfig:{maxOutputTokens:1800,temperature:0.3}
    })});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`Gemini API Error ${res.status}`);}
    const d=await res.json(); inputT=d.usageMetadata?.promptTokenCount||0; outputT=d.usageMetadata?.candidatesTokenCount||0; text=d.candidates?.[0]?.content?.parts?.[0]?.text||"";
  } else if (provider==="openai") {
    const fileContents=await Promise.all(binaryFiles.map(async file=>{
      const kind=getFileKind(file);
      const fileB64=await readFileAsBase64(file);
      if (kind==="image") return {type:"image_url",image_url:{url:`data:${fileB64.mediaType};base64,${fileB64.data}`}};
      if (kind==="pdf") return {type:"file",file:{filename:file.name,file_data:`data:application/pdf;base64,${fileB64.data}`}};
      throw new Error(`ChatGPT 暂不支持 ${file.name} 这种格式`);
    }));
    const content=[...fileContents];
    if (docTexts.length) content.push({type:"text",text:`【以下为 Word 文件提取文字】\n${docTexts.join("\n\n")}`});
    content.push({type:"text",text:userText});
    const res=await fetch(prov.endpoint,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${apiKey}`},body:JSON.stringify({model,max_tokens:1800,messages:[{role:"system",content:fullSys},{role:"user",content}]})});
    if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||`API Error ${res.status}`);}
    const d=await res.json(); inputT=d.usage?.prompt_tokens||0; outputT=d.usage?.completion_tokens||0; text=d.choices?.[0]?.message?.content||"";
  } else {
    throw new Error(`${prov.name} 暂不支持多文件识别`);
  }

  if (onTokens) onTokens(inputT, outputT, provider);
  return parseJsonResponse(text);
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
const fmt=n=>n?.toLocaleString()||"0";
const todayStr=()=>new Date().toISOString().slice(0,10);
const isSoon=s=>{if(!s)return false;const d=(new Date(s)-new Date())/86400000;return d>=-0.1&&d<=7;};
const fmtDate=s=>{if(!s)return "";const d=new Date(s);return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;};

// ─── APP ROOT ────────────────────────────────────────────────
export default function App() {
  const [cfg,setCfg]   =useState(()=>load("hr_cfg",{provider:"claude",model:"claude-sonnet-4-20250514",apiKeys:{},theme:"light",routing:{enabled:false,textProvider:"deepseek",textModel:"deepseek-chat",fileProvider:"gemini",fileModel:"gemini-2.0-flash"}}));
  const [jobs,setJobs] =useState(()=>load("hr_jobs",[]));
  const [cands,setCands]=useState(()=>load("hr_cands",[]));
  const [usageLogs,setUsageLogs]=useState(()=>load("hr_usage",[]));
  const [view,setView] =useState("dashboard");
  const [selJob,setSelJob]=useState(null);
  const [selCand,setSelCand]=useState(null);
  const [candTab,setCandTab]=useState("screening");
  const [compared,setCompared]=useState([]);
  const [showCompare,setShowCompare]=useState(false);

  useEffect(()=>save("hr_cfg",cfg),[cfg]);
  useEffect(()=>save("hr_jobs",jobs),[jobs]);
  useEffect(()=>save("hr_cands",cands),[cands]);
  useEffect(()=>save("hr_usage",usageLogs),[usageLogs]);

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
  const openCand=(cid,jid)=>{if(jid)setSelJob(jid);setSelCand(cid);setCandTab("screening");setView("candidates");};
  const toggleCompare=(id)=>setCompared(p=>p.includes(id)?p.filter(x=>x!==id):[...p,id].slice(-4));

  const upcoming=cands.filter(c=>isSoon(c.scheduledAt)).sort((a,b)=>new Date(a.scheduledAt)-new Date(b.scheduledAt));
  const dirDone=cands.filter(c=>c.directorVerdict?.verdict);
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
              {n.id==="settings"&&!Object.values(cfg.apiKeys||{}).some(Boolean)&&<span style={{width:6,height:6,background:"#ef4444",borderRadius:"50%"}}/>}
              {n.id==="dashboard"&&upcoming.length>0&&<span style={{fontSize:10,fontWeight:700,padding:"1px 6px",background:"#ef4444",color:"#fff",borderRadius:10}}>{upcoming.length}</span>}
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
        {view==="dashboard"  &&<DashboardView T={T} jobs={jobs} cands={cands} upcoming={upcoming} dirStats={dirStats} onJobClick={id=>{setSelJob(id);setView("jobs");}} onCandClick={openCand}/>}
        {view==="jobs"       &&<JobsView T={T} jobs={jobs} setJobs={setJobs} cands={cands} setCands={setCands} selJob={selJob} setSelJob={setSelJob} onCandClick={openCand} cfg={cfg}/>}
        {view==="candidates" &&<CandidatesView T={T} cands={cands} jobs={jobs} selCand={selCand} setSelCand={setSelCand} tab={candTab} setTab={setCandTab} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} compared={compared} toggleCompare={toggleCompare}/>}
        {view==="settings"   &&<SettingsView T={T} cfg={cfg} setCfg={setCfg} usageLogs={usageLogs} dirStats={dirStats} dirDone={dirDone} dirMatch={dirMatch} jobs={jobs}/>}
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
function DashboardView({T,jobs,cands,upcoming,dirStats,onJobClick,onCandClick}) {
  const stats=[
    {label:"简历通过",val:cands.filter(c=>c.status==="screening").length,color:"#2563eb"},
    {label:"观察中",  val:cands.filter(c=>c.status==="watching").length, color:"#d97706"},
    {label:"进入面试",val:cands.filter(c=>c.status==="interview").length,color:"#7c3aed"},
    {label:"已录用",  val:cands.filter(c=>c.status==="offer").length,    color:"#059669"},
    {label:"未通过",  val:cands.filter(c=>c.status==="rejected").length, color:"#dc2626"},
  ];
  const total=cands.length;
  const funnelData=jobs.map(j=>{
    const jc=cands.filter(c=>c.jobId===j.id);
    return{job:j,total:jc.length,screened:jc.filter(c=>["screening","watching","interview","offer"].includes(c.status)).length,interviewed:jc.filter(c=>["interview","offer"].includes(c.status)).length,offered:jc.filter(c=>c.status==="offer").length};
  }).filter(d=>d.total>0);

  return(<Page T={T} title="仪表盘" sub="快手项目组 · 招聘总览">
    {/* 板块1：数据看板 */}
    <SecLabel T={T}>数据看板</SecLabel>
    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12,marginBottom:12}}>
      {stats.map(s=>(
        <div key={s.label} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"16px",borderTop:`3px solid ${s.color}`}}>
          <div style={{fontSize:30,fontWeight:900,color:s.color,lineHeight:1}}>{s.val}</div>
          <div style={{fontSize:12,color:T.text3,marginTop:5}}>{s.label}</div>
        </div>
      ))}
    </div>
    <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:"11px 16px",marginBottom:22}}>
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

    {/* 板块2+3：在招岗位 & 候选人列表 */}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1.7fr",gap:16,marginBottom:22}}>
      <div>
        <SecLabel T={T}>在招岗位 ({jobs.length})</SecLabel>
        <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
          {jobs.length===0?<div style={{padding:"36px 20px",textAlign:"center",color:T.text4,fontSize:13}}>暂无在招岗位</div>
          :jobs.map((j,i)=>{
            const jc=cands.filter(c=>c.jobId===j.id);
            return(<div key={j.id} onClick={()=>onJobClick(j.id)} className="hr" style={{padding:"13px 16px",borderBottom:i<jobs.length-1?`1px solid ${T.border}`:"none",cursor:"pointer"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:5}}>
                <div><div style={{fontSize:14,fontWeight:700,color:T.text}}>{j.title}</div><div style={{fontSize:11,color:T.text4,marginTop:1}}>{[j.department,j.level,j.salary].filter(Boolean).join(" · ")||"未指定部门"}</div></div>
                <span style={{fontSize:12,color:T.text3,flexShrink:0,marginLeft:8}}>{jc.length}人</span>
              </div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {[["screening","#eff6ff","#2563eb","通过"],["watching","#fffbeb","#d97706","观察"],["interview","#f5f3ff","#7c3aed","面试"],["offer","#ecfdf5","#059669","录用"],["rejected","#fef2f2","#dc2626","未过"]].map(([s,bg,c,l])=>{
                  const n=jc.filter(x=>x.status===s).length;
                  return n>0?<span key={s} style={{fontSize:10,padding:"2px 6px",background:bg,color:c,borderRadius:10,fontWeight:600}}>{n}{l}</span>:null;
                })}
              </div>
            </div>);
          })}
        </div>
      </div>
      <div>
        <SecLabel T={T}>候选人列表 ({cands.length})</SecLabel>
        <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
          {cands.length===0?<div style={{padding:"36px 20px",textAlign:"center",color:T.text4,fontSize:13}}>暂无候选人</div>
          :<>
            <div style={{display:"grid",gridTemplateColumns:"2fr 1.3fr 1fr 1fr 1fr",padding:"7px 14px",borderBottom:`1px solid ${T.border}`,fontSize:11,fontWeight:700,color:T.text4}}>
              <span>姓名</span><span>岗位</span><span style={{textAlign:"center"}}>评分</span><span style={{textAlign:"center"}}>状态</span><span style={{textAlign:"center"}}>总监判断</span>
            </div>
            <div style={{maxHeight:340,overflowY:"auto"}}>
              {cands.map(c=>{
                const j=jobs.find(j=>j.id===c.jobId);
                const scr=c.screening;
                const dir=c.directorVerdict;
                return(<div key={c.id} onClick={()=>onCandClick(c.id,c.jobId)} className="hr"
                  style={{display:"grid",gridTemplateColumns:"2fr 1.3fr 1fr 1fr 1fr",padding:"9px 14px",borderBottom:`1px solid ${T.border}`,cursor:"pointer",alignItems:"center"}}>
                  <div style={{display:"flex",gap:7,alignItems:"center"}}><Av name={c.name} T={T} size={26}/><span style={{fontSize:13,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.name||<span style={{color:T.text4}}>未命名</span>}</span></div>
                  <span style={{fontSize:12,color:T.text3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{j?.title||"—"}</span>
                  <span style={{textAlign:"center",fontWeight:700,fontSize:13,color:scr?scColor(scr.overallScore):T.text4}}>{scr?scr.overallScore?.toFixed(1):"—"}</span>
                  <span style={{textAlign:"center"}}><SBadge status={c.status}/></span>
                  <span style={{textAlign:"center",fontSize:12,fontWeight:700,color:dir?.verdict==="录用"?"#059669":dir?.verdict==="淘汰"?"#dc2626":dir?.verdict?"#ca8a04":T.text4}}>{dir?.verdict||"—"}</span>
                </div>);
              })}
            </div>
          </>}
        </div>
      </div>
    </div>

    {/* 板块4：近期面试 */}
    {upcoming.length>0&&(
      <div style={{marginBottom:22}}>
        <SecLabel T={T}>近期面试安排（7天内）</SecLabel>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:12}}>
          {upcoming.map(c=>{
            const j=jobs.find(j=>j.id===c.jobId);
            const diffH=Math.round((new Date(c.scheduledAt)-new Date())/3600000);
            const soon=diffH<=24;
            return(<div key={c.id} onClick={()=>onCandClick(c.id,c.jobId)} className="hr"
              style={{background:T.surface,border:`1px solid ${soon?"#f59e0b":T.border}`,borderRadius:10,padding:"14px 16px",cursor:"pointer",borderLeft:`4px solid ${soon?"#f59e0b":"#7c3aed"}`}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <Av name={c.name} T={T} size={28}/>
                  <div><div style={{fontSize:13,fontWeight:700,color:T.text}}>{c.name||"未命名"}</div><div style={{fontSize:11,color:T.text4}}>{j?.title||""}</div></div>
                </div>
                {soon&&<span style={{fontSize:10,fontWeight:700,padding:"2px 7px",background:"#fef3c7",color:"#d97706",borderRadius:10,alignSelf:"flex-start"}}>即将</span>}
              </div>
              <div style={{fontSize:12,color:"#7c3aed",fontWeight:600}}>📅 {fmtDate(c.scheduledAt)}</div>
              {c.interviewRound&&<div style={{fontSize:11,color:T.text4,marginTop:3}}>{c.interviewRound}</div>}
            </div>);
          })}
        </div>
      </div>
    )}

    {/* 板块5：招聘漏斗分析 */}
    {funnelData.length>0&&(
      <div>
        <SecLabel T={T}>招聘漏斗分析</SecLabel>
        <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,padding:"0 0 12px",borderBottom:`1px solid ${T.border}`,marginBottom:16,fontSize:11,fontWeight:700,color:T.text4}}>
            <span>岗位</span><span style={{textAlign:"center"}}>简历通过率</span><span style={{textAlign:"center"}}>面试转化率</span><span style={{textAlign:"center"}}>录用率</span>
          </div>
          {funnelData.map(({job:j,total,screened,interviewed,offered})=>{
            const r1=total>0?Math.round(screened/total*100):0;
            const r2=screened>0?Math.round(interviewed/screened*100):0;
            const r3=interviewed>0?Math.round(offered/interviewed*100):0;
            return(<div key={j.id} style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,padding:"12px 0",borderBottom:`1px solid ${T.border}`,alignItems:"center"}}>
              <div><div style={{fontSize:13,fontWeight:700,color:T.text}}>{j.title}</div><div style={{fontSize:11,color:T.text4}}>{j.department||""}</div></div>
              <FunnelBar label={`${screened}/${total}`} rate={r1}/>
              <FunnelBar label={`${interviewed}/${screened}`} rate={r2}/>
              <FunnelBar label={`${offered}/${interviewed}`} rate={r3} highlight={offered>0}/>
            </div>);
          })}
        </div>
      </div>
    )}
  </Page>);
}
const FunnelBar=({label,rate,highlight})=>(
  <div style={{textAlign:"center"}}>
    <div style={{fontSize:14,fontWeight:700,color:highlight?"#059669":rate>=50?"#16a34a":rate>=25?"#ca8a04":"#dc2626"}}>{rate}%</div>
    <div style={{height:4,background:"#f3f4f6",borderRadius:2,margin:"5px 8px"}}><div style={{width:`${rate}%`,height:"100%",background:highlight?"#059669":rate>=50?"#16a34a":rate>=25?"#ca8a04":"#dc2626",borderRadius:2,transition:"width 0.5s"}}/></div>
    <div style={{fontSize:11,color:"#9ca3af"}}>{label}</div>
  </div>
);

// ─── JOBS VIEW ───────────────────────────────────────────────
function JobsView({T,jobs,setJobs,cands,setCands,selJob,setSelJob,onCandClick,cfg}) {
  const [open,setOpen]=useState(false);
  const [form,setForm]=useState({title:"",department:"",level:"",requirements:"",t0:"",t1:"",salary:""});
  const [jdFile,setJdFile]=useState(null);
  const [jdLoading,setJdLoading]=useState(false);
  const [jdErr,setJdErr]=useState("");
  const [jdDrag,setJdDrag]=useState(false);
  const ff=k=>e=>setForm(p=>({...p,[k]:e.target.value}));

  const parseJD=async(file)=>{
    setJdFile(file);setJdErr("");setJdLoading(true);
    try{
      const res=await callAIWithFile(cfg,
        `你是资深HR，请从JD文件中提取岗位信息，严格按JSON格式输出，不含任何markdown标记。`,
        `请识别这份招聘JD文件，提取关键信息，返回JSON：
{"title":"职位名称","department":"部门","level":"级别/序列","salary":"薪资范围","requirements":"完整的岗位职责和任职要求（保留原文，段落清晰）","t0":"每行一条硬性必须满足的条件","t1":"每行一条核心评估维度（5-8个）"}
注意：t0和t1用换行符分隔多条内容`,
        file, null
      );
      if(res.error) throw new Error(res.raw||res.error);
      setForm({
        title:res.title||"",department:res.department||"",level:res.level||"",
        salary:res.salary||"",requirements:res.requirements||"",
        t0:res.t0||"",t1:res.t1||""
      });
    }catch(e){setJdErr(e.message);}
    setJdLoading(false);
  };

  const onJdDrop=e=>{e.preventDefault();setJdDrag(false);const f=e.dataTransfer.files?.[0];if(f)parseJD(f);};
  const saveJob=()=>{
    if(!form.title||!form.requirements)return;
    const j={...form,id:Date.now()};
    setJobs(p=>[...p,j]);setSelJob(j.id);setOpen(false);setJdFile(null);
    setForm({title:"",department:"",level:"",requirements:"",t0:"",t1:"",salary:""});
  };
  const delJob=id=>{if(window.confirm("确认删除该岗位及所有候选人？")){setJobs(p=>p.filter(j=>j.id!==id));setCands(p=>p.filter(c=>c.jobId!==id));if(selJob===id)setSelJob(null);}};
  const job=jobs.find(j=>j.id===selJob);
  const jobCands=cands.filter(c=>c.jobId===selJob);
  const addCand=()=>{
    const id=Date.now();
    setCands(p=>[...p,{id,jobId:selJob,name:"",status:"pending",resume:"",resumeFiles:[],screening:null,questions:null,interviews:[],scheduledAt:null,interviewRound:null,directorVerdict:null}]);
    onCandClick(id,selJob);
  };
  return(<Page T={T} title="岗位管理" sub="创建和管理在招职位">
    <div style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:20}}>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
        <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:13,fontWeight:700,color:T.text}}>岗位列表</span>
          <button onClick={()=>{setOpen(!open);setJdFile(null);setJdErr("");}} style={{padding:"4px 10px",background:T.accent,color:T.accentFg,border:"none",borderRadius:6,fontSize:12,fontWeight:600,cursor:"pointer"}}>+ 新建</button>
        </div>
        {open&&(<div style={{padding:14,borderBottom:`1px solid ${T.border}`,background:T.card2}}>
          {/* JD 文件上传区 */}
          <div style={{marginBottom:12}}>
            <label style={lbSt(T)}>上传 JD 文件（AI 自动识别）</label>
            <div
              onDragOver={e=>{e.preventDefault();setJdDrag(true);}}
              onDragLeave={()=>setJdDrag(false)}
              onDrop={onJdDrop}
              style={{border:`2px dashed ${jdDrag?T.accent:T.border2}`,borderRadius:9,padding:"14px",textAlign:"center",cursor:"pointer",background:jdDrag?`${T.accent}08`:T.inputBg,transition:"all 0.15s"}}
              onClick={()=>document.getElementById("jd-file-input").click()}>
              <input id="jd-file-input" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.doc" style={{display:"none"}}
                onChange={e=>{const f=e.target.files?.[0];if(f)parseJD(f);e.target.value="";}}/>
              {jdLoading
                ?<div style={{fontSize:13,color:T.accent}}><Spin text="AI 正在识别 JD..."/></div>
                :jdFile
                  ?<div><div style={{fontSize:13,color:"#16a34a",fontWeight:600}}>✓ {jdFile.name}</div><div style={{fontSize:11,color:T.text4,marginTop:3}}>点击重新上传</div></div>
                  :<div><div style={{fontSize:13,color:T.text3}}>📄 拖入或点击上传 JD</div><div style={{fontSize:11,color:T.text4,marginTop:3}}>支持 PDF · 图片 · Word</div></div>
              }
            </div>
            {jdErr&&<div style={{fontSize:11,color:"#dc2626",marginTop:5}}>{jdErr}</div>}
            {jdFile&&!jdLoading&&<div style={{fontSize:11,color:T.text4,marginTop:4}}>AI已自动填写以下字段，可手动修改 ↓</div>}
          </div>

          <div style={{height:1,background:T.border,marginBottom:12}}/>
          {[["职位名称 *","title","短视频剪辑师"],["所属部门","department","AI MCN"],["级别","level","mid"],["薪酬","salary","15-25K"]].map(([l,k,ph])=>(
            <Inp key={k} T={T} label={l} placeholder={ph} value={form[k]} onChange={ff(k)}/>
          ))}
          <div style={{marginBottom:9}}><label style={lbSt(T)}>岗位要求 *</label><textarea rows={4} style={{...inSt(T),resize:"vertical",lineHeight:1.6}} placeholder="岗位职责与任职要求..." value={form.requirements} onChange={ff("requirements")}/></div>
          <div style={{marginBottom:9}}><label style={lbSt(T)}>T0 硬性条件（每行一条）</label><textarea rows={2} style={{...inSt(T),resize:"vertical"}} placeholder={"2年以上经验\n熟练使用剪映"} value={form.t0} onChange={ff("t0")}/></div>
          <div style={{marginBottom:12}}><label style={lbSt(T)}>T1 核心维度（每行一条）</label><textarea rows={2} style={{...inSt(T),resize:"vertical"}} placeholder={"目标导向\n团队协作\n自驱力"} value={form.t1} onChange={ff("t1")}/></div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>{setOpen(false);setJdFile(null);setJdErr("");}} style={{flex:1,padding:"8px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:7,color:T.text3,cursor:"pointer",fontSize:12}}>取消</button>
            <button onClick={saveJob} style={{flex:2,padding:"8px",background:T.accent,color:T.accentFg,border:"none",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:700,opacity:form.title&&form.requirements?1:0.4}} disabled={!form.title||!form.requirements||jdLoading}>保存岗位</button>
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
function CandidatesView({T,cands,jobs,selCand,setSelCand,tab,setTab,cfg,updCand,recordTokens,dirCtx,compared,toggleCompare}) {
  const cand=cands.find(c=>c.id===selCand);
  const job=jobs.find(j=>j.id===cand?.jobId);
  return(<Page T={T} title="候选人" sub="管理所有候选人及评估进度">
    <div style={{display:"grid",gridTemplateColumns:"256px 1fr",gap:20}}>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
        <div style={{padding:"11px 14px",borderBottom:`1px solid ${T.border}`,fontSize:13,fontWeight:700,color:T.text}}>全部候选人 ({cands.length})</div>
        <div style={{overflowY:"auto",maxHeight:"calc(100vh - 160px)"}}>
          {cands.length===0?<div style={{padding:"32px 16px",textAlign:"center",color:T.text4,fontSize:13}}>暂无候选人</div>
          :cands.map(c=>{
            const j=jobs.find(j=>j.id===c.jobId);
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
                  <div style={{fontSize:11,color:T.text4,marginTop:1}}>{j?.title||"未知岗位"}</div>
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
      {cand?<CandDetail T={T} cand={cand} job={job} tab={tab} setTab={setTab} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx}/>
      :<Empty T={T} icon="◉" title="选择候选人" sub="从左侧选择，或勾选多人后点击「对比」"/>}
    </div>
  </Page>);
}

// ─── CAND DETAIL ─────────────────────────────────────────────
function CandDetail({T,cand,job,tab,setTab,cfg,updCand,recordTokens,dirCtx}) {
  const tabs=[
    {id:"screening",label:"① 简历筛选"},
    {id:"questions",label:"② 面试题",disabled:!cand.screening},
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
        <div style={{fontSize:12,color:T.text3,marginTop:2}}>{job?.title||""}</div>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {dir?.verdict&&<span style={{fontSize:12,fontWeight:700,padding:"4px 12px",borderRadius:20,background:dir.verdict==="录用"?"#ecfdf5":dir.verdict==="淘汰"?"#fef2f2":"#fffbeb",color:dir.verdict==="录用"?"#059669":dir.verdict==="淘汰"?"#dc2626":"#ca8a04"}}>总监：{dir.verdict}</span>}
        {cand.scheduledAt&&<span style={{fontSize:12,color:"#7c3aed",fontWeight:600}}>📅 {fmtDate(cand.scheduledAt)}</span>}
        <select value={cand.status} onChange={e=>updCand(cand.id,{status:e.target.value})} style={{...inSt(T),width:"auto",fontSize:12,padding:"6px 8px"}}>
          {Object.entries(STATUS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
        </select>
        {cand.screening&&<div style={{textAlign:"center",padding:"4px 12px",background:T.card2,borderRadius:8,border:`1px solid ${T.border}`}}>
          <div style={{fontSize:20,fontWeight:900,color:scColor(cand.screening.overallScore)}}>{cand.screening.overallScore?.toFixed(1)}</div>
          <div style={{fontSize:10,color:T.text4}}>AI评分</div>
        </div>}
      </div>
    </div>
    <div style={{display:"flex",gap:0,marginBottom:14,background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:4}}>
      {tabs.map(t=><button key={t.id}
        style={{flex:1,padding:"7px 4px",border:"none",background:tab===t.id?T.tabActive:"transparent",color:tab===t.id?T.tabActiveFg:T.text3,borderRadius:7,cursor:t.disabled?"not-allowed":"pointer",fontSize:12,fontWeight:tab===t.id?700:400,opacity:t.disabled?0.4:1,transition:"all 0.1s"}}
        disabled={t.disabled} onClick={()=>setTab(t.id)}>{t.label}</button>)}
    </div>
    {tab==="screening"&&<ScreenTab  key={`screening-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx}/>}
    {tab==="questions"&&<QuestionTab key={`questions-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx}/>}
    {tab==="interview"&&<InterviewTab key={`interview-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx}/>}
    {tab==="director" &&<DirectorTab  key={`director-${cand.id}`} T={T} cand={cand} updCand={updCand}/>}
    {tab==="result"   &&<ResultTab    key={`result-${cand.id}`} T={T} cand={cand}/>}
  </div>);
}

// ─── SCREEN TAB ──────────────────────────────────────────────
function ScreenTab({T,cand,job,cfg,updCand,recordTokens,dirCtx}) {
  const [name,setName]=useState(cand.name||"");
  const [resume,setResume]=useState(isStoredFileResume(cand.resume)?"":(cand.resume||""));
  const [resumeFiles,setResumeFiles]=useState(()=>getCachedResumeFiles(cand.id));
  const [resumeFileNames,setResumeFileNames]=useState(()=>getStoredResumeFileNames(cand));
  const [inputMode,setInputMode]=useState(getStoredResumeFileNames(cand).length?"file":(cand.resume?"text":"file"));
  const [drag,setDrag]=useState(false);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const fileInputRef = useRef(null);

  const t0=job?.t0?.split("\n").filter(Boolean).map(l=>`"${l.trim()}"`).join(",")||"";
  const t1=job?.t1?.split("\n").filter(Boolean).map(l=>`"${l.trim()}"`).join(",")||"";
  const screeningPrompt=`岗位：${job?.title||"未知"} 部门：${job?.department||""} 要求：${job?.requirements||""}
${t0?`T0硬性条件：[${t0}]`:"请自行从要求中提取T0硬性条件"}
${t1?`T1核心维度：[${t1}]`:"请自行提取T1核心评估维度(6-8个)"}
薪酬：${job?.salary||"不限"}
输出JSON：{"candidateName":"候选人姓名（从简历中提取）","summary":"2-3句综合评价","recommendation":"建议通过|待定|建议淘汰","overallScore":4.5,
"t0":{"score":4.2,"items":[{"requirement":"条件","level":"高|中|低","score":4,"maxScore":5,"note":"说明"}]},
"t1":{"items":[{"dimension":"维度","note":"依据","score":4,"maxScore":5}]},
"t2":{"items":[{"item":"加分项","has":true,"note":"依据"}]},
"fineScreen":{"education":{"score":3,"maxScore":5,"note":""},"industryRisk":{"score":3,"maxScore":5,"note":""},"tenureMatch":{"score":4,"maxScore":5,"note":""},"salaryReason":{"score":5,"maxScore":5,"note":""}},
"risks":["风险1"]}`;

  const syncFiles=(files)=>{
    setResumeFiles(files);
    setResumeFileNames(files.map(file=>file.name));
    setCachedResumeFiles(cand.id, files);
    updCand(cand.id,{resumeFiles:storeResumeFilesMeta(files)});
  };

  const queueFiles=list=>{
    const picked=Array.from(list||[]).filter(Boolean);
    if(!picked.length) return;
    const bad=picked.filter(file=>getFileKind(file)==="unknown").map(file=>file.name);
    const valid=picked.filter(file=>getFileKind(file)!=="unknown");
    const merged=uniqFiles([...resumeFiles,...valid]).slice(0,MAX_RESUME_FILES);
    syncFiles(merged);
    if (bad.length) setErr(`以下文件格式暂不支持：${bad.join("、")}`);
    else if (resumeFiles.length+valid.length>MAX_RESUME_FILES) setErr(`最多上传 ${MAX_RESUME_FILES} 个文件`);
    else setErr("");
  };

  const removeQueuedFile=index=>{
    const next=resumeFiles.length?resumeFiles.filter((_,i)=>i!==index):[];
    const nextNames=resumeFiles.length?next.map(file=>file.name):resumeFileNames.filter((_,i)=>i!==index);
    setResumeFiles(next);
    setResumeFileNames(nextNames);
    setCachedResumeFiles(cand.id, next);
    updCand(cand.id,{resumeFiles:resumeFiles.length?storeResumeFilesMeta(next):nextNames.map(name=>({name}))});
    setErr("");
  };

  const handleFilesAnalyze=async()=>{
    if(!resumeFiles.length){
      setErr(resumeFileNames.length?"这些历史文件需要重新上传后才能重新分析":"请先上传至少 1 个简历文件");
      return;
    }
    setErr("");setLoading(true);setResume("");
    try{
      const res=await callAIWithFiles(cfg,
        `你是资深HR顾问，请分析简历文件，严格按JSON格式输出，不含任何markdown标记。`,
        `请识别简历文件并按以下格式评估：\n${screeningPrompt}`,
        resumeFiles, recordTokens, dirCtx
      );
      if(res.error) throw new Error(res.raw||res.error);
      const candName=res.candidateName||name||cand.name||"";
      const names=resumeFiles.map(file=>file.name);
      updCand(cand.id,{name:candName,resume:fileMarkerFromNames(names),resumeFiles:storeResumeFilesMeta(resumeFiles),screening:res,
        status:res.recommendation==="建议通过"?"screening":res.recommendation==="待定"?"watching":"rejected"});
      if(candName&&!name) setName(candName);
    }catch(e){setErr(e.message);}
    setLoading(false);
  };

  const handleTextAnalyze=async()=>{
    if(!resume.trim()){setErr("请粘贴简历内容");return;}
    setErr("");setLoading(true);setResumeFiles([]);setResumeFileNames([]);setCachedResumeFiles(cand.id, []);
    updCand(cand.id,{name:name||cand.name,resume,resumeFiles:[]});
    try{
      const res=await callAI(cfg,
        `你是资深HR顾问，请严格按JSON格式输出，不含任何markdown标记或额外文字。`,
        `简历内容：${resume}\n\n${screeningPrompt}`,
        recordTokens,dirCtx
      );
      if(res.error) throw new Error(res.error);
      const candName=res.candidateName||name||cand.name||"";
      updCand(cand.id,{name:candName,screening:res,
        status:res.recommendation==="建议通过"?"screening":res.recommendation==="待定"?"watching":"rejected"});
    }catch(e){setErr(e.message);}
    setLoading(false);
  };

  const onDrop=e=>{e.preventDefault();setDrag(false);queueFiles(e.dataTransfer.files);};
  const scr=cand.screening;
  const hasActualFiles=resumeFiles.length>0;
  const previewFileNames=hasActualFiles?resumeFiles.map(file=>file.name):resumeFileNames;

  return(<div>
    {!scr&&(<SCard T={T} title="简历筛选">
      <Inp T={T} label="候选人姓名（可选，AI会从简历自动提取）" placeholder="手动填写或自动识别" value={name} onChange={e=>setName(e.target.value)}/>

      {/* 模式切换 */}
      <div style={{display:"flex",gap:0,marginBottom:14,border:`1px solid ${T.border2}`,borderRadius:8,overflow:"hidden",width:"fit-content"}}>
        {[["file","📄 上传文件"],["text","✏️ 粘贴文字"]].map(([m,l])=>(
          <button key={m} onClick={()=>setInputMode(m)}
            style={{padding:"7px 16px",border:"none",background:inputMode===m?T.accent:T.inputBg,color:inputMode===m?T.accentFg:T.text3,cursor:"pointer",fontSize:12,fontWeight:inputMode===m?700:400,transition:"all 0.1s"}}>
            {l}
          </button>
        ))}
      </div>

      {/* 文件上传区 */}
      {inputMode==="file"&&(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
            <div style={{fontSize:12,color:T.text3}}>支持拖拽上传，也可以直接点按钮选择简历文件</div>
            <button onClick={e=>{e.stopPropagation();if(!loading)fileInputRef.current?.click();}}
              style={{padding:"7px 14px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,cursor:loading?"not-allowed":"pointer",fontSize:12,fontWeight:700,opacity:loading?0.5:1}}>
              选择简历文件
            </button>
          </div>
          <div
            onDragOver={e=>{e.preventDefault();setDrag(true);}}
            onDragLeave={()=>setDrag(false)}
            onDrop={onDrop}
            style={{border:`2px dashed ${drag?T.accent:loading?"#7c3aed":T.border2}`,borderRadius:12,padding:"32px 20px",textAlign:"center",cursor:loading?"default":"pointer",background:drag?`${T.accent}08`:loading?"#f5f3ff":T.inputBg,transition:"all 0.15s",marginBottom:10}}
            onClick={()=>!loading&&fileInputRef.current?.click()}>
            <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.doc" multiple style={{display:"none"}}
              onChange={e=>{queueFiles(e.target.files);e.target.value="";}}/>
            {loading
              ?<div><div style={{marginBottom:10,fontSize:22}}>⏳</div><Spin text="AI 正在读取并分析简历..."/><div style={{fontSize:11,color:"#7c3aed",marginTop:8}}>识别内容 → 对照岗位要求 → 生成评估报告</div></div>
              :previewFileNames.length
                ?<div><div style={{fontSize:28,marginBottom:8}}>✅</div><div style={{fontSize:14,fontWeight:700,color:"#16a34a"}}>已加入 {previewFileNames.length} 个文件</div><div style={{fontSize:12,color:T.text4,marginTop:4}}>继续添加，或在下方删除后再开始分析</div></div>
                :<div>
                  <div style={{fontSize:32,marginBottom:10}}>📄</div>
                  <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:6}}>拖入简历文件，或点击上传</div>
                  <div style={{fontSize:12,color:T.text3,marginBottom:4}}>支持格式：PDF · JPG/PNG（截图扫描件）· Word (.docx)</div>
                  <div style={{fontSize:11,color:T.text4}}>可一次上传多份简历附件，先预览再统一分析</div>
                </div>
            }
          </div>
          <div style={{fontSize:11,color:T.text4,marginBottom:10,textAlign:"center"}}>
            📌 最多 {MAX_RESUME_FILES} 个文件 · PDF/图片支持 Claude、Gemini、GPT-4o · Word 支持所有模型
          </div>
          {previewFileNames.length>0&&<div style={{marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:8}}>待分析文件</div>
            <div style={{display:"grid",gap:8}}>
              {previewFileNames.map((fileName,index)=>(
                <div key={`${fileName}-${index}`} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,padding:"9px 12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:8}}>
                  <div style={{minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fileName}</div>
                    <div style={{fontSize:11,color:T.text4,marginTop:2}}>{hasActualFiles?"已上传，可参与本次分析":"历史记录文件名，若要重新分析请重新上传"}</div>
                  </div>
                  <button onClick={e=>{e.stopPropagation();removeQueuedFile(index);}}
                    style={{padding:"5px 10px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:7,color:"#dc2626",cursor:"pointer",fontSize:12,flexShrink:0}}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          </div>}
        </div>
      )}

      {/* 文字粘贴区 */}
      {inputMode==="text"&&(
        <div style={{marginBottom:12}}>
          <label style={lbSt(T)}>粘贴简历文字内容</label>
          <textarea rows={12} value={resume} onChange={e=>setResume(e.target.value)} style={{...inSt(T),resize:"vertical",lineHeight:1.6}}
            placeholder={"将简历文字粘贴到此处...\n包括：基本信息、教育背景、工作经历、技能特长等"}/>
        </div>
      )}

      {dirCtx&&<div style={{fontSize:11,color:T.accent,marginBottom:10,padding:"7px 11px",background:`${T.accent}10`,borderRadius:7}}>✦ 已融入你的历史判断标准，AI评估将更贴近你的用人偏好</div>}
      {err&&<ErrBox>{err}</ErrBox>}
      {inputMode==="file"&&<BtnPrimary T={T} loading={loading} disabled={loading||!hasActualFiles} onClick={handleFilesAnalyze}>
        {loading?<Spin text="AI 正在分析已上传文件..."/>:`分析已上传文件 (${previewFileNames.length}) →`}
      </BtnPrimary>}
      {inputMode==="text"&&<BtnPrimary T={T} loading={loading} disabled={loading||!resume.trim()} onClick={handleTextAnalyze}>{loading?<Spin text="AI 正在分析简历..."/>:"AI 智能筛选 →"}</BtnPrimary>}
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
        setResume("");
        setResumeFiles([]);
        setResumeFileNames([]);
        setCachedResumeFiles(cand.id, []);
        setErr("");
        updCand(cand.id,{screening:null,questions:null,resume:"",resumeFiles:[]});
      }} style={{padding:"7px 14px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:7,color:T.text3,cursor:"pointer",fontSize:12}}>重新筛选</button>
    </div>)}
  </div>);
}

// ─── QUESTION TAB ────────────────────────────────────────────
function QuestionTab({T,cand,job,cfg,updCand,recordTokens,dirCtx}) {
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const gen=async()=>{
    setErr("");setLoading(true);
    try{
      const res=await callAI(cfg,
        `你是资深HR面试官，请严格按JSON格式输出，不含任何markdown标记。`,
        `岗位：${job?.title} 要求：${job?.requirements}
简历摘要：${cand.resume?.slice(0,500)} 筛选结论：${cand.screening?.summary}
风险：${JSON.stringify(cand.screening?.risks||[])}
生成10道结构化面试题，返回JSON：
{"questions":[{"step":1,"stepName":"开场破冰","tag":"破冰","subTag":"综合观察","question":"问题","purpose":"目的","goodAnswer":"好的回答...","okAnswer":"一般回答...","badAnswer":"差的回答...","redFlag":"红旗回答...","followUp":"追问方向..."}]}
步骤：1.开场破冰 2.自我介绍 3.离职动机 4.行为面试STAR(4-5题) 5.专业题(2题) 6.反问`,
        recordTokens,dirCtx
      );
      if(res.error) throw new Error(res.error);
      updCand(cand.id,{questions:res.questions});
    }catch(e){setErr(e.message);}
    setLoading(false);
  };
  const qs=cand.questions;
  return(<div>
    {!qs?(<SCard T={T} title="生成面试题">
      <div style={{fontSize:13,color:T.text3,marginBottom:14}}>基于岗位要求和简历分析，AI 生成结构化面试题，含好/差/红旗回答参考</div>
      {dirCtx&&<div style={{fontSize:11,color:T.accent,marginBottom:10,padding:"6px 10px",background:`${T.accent}10`,borderRadius:6}}>✦ 已融入总监历史判断标准，面试题将更贴近你的用人偏好</div>}
      {err&&<ErrBox>{err}</ErrBox>}
      <BtnPrimary T={T} loading={loading} disabled={loading} onClick={gen}>{loading?<Spin text="生成中..."/>:"生成面试题 →"}</BtnPrimary>
    </SCard>):(<div>
      {[...new Set(qs.map(q=>q.step))].sort().map(step=>{
        const sq=qs.filter(q=>q.step===step);
        return(<div key={step} style={{marginBottom:18}}>
          <div style={{fontSize:12,fontWeight:700,color:T.text2,padding:"6px 12px",background:T.navActive,borderRadius:6,marginBottom:9,borderLeft:`3px solid ${T.accent}`}}>第{step}步 · {sq[0]?.stepName}</div>
          {sq.map((q,i)=><QCard key={i} T={T} q={q}/>)}
        </div>);
      })}
      <button onClick={()=>updCand(cand.id,{questions:null})} style={{padding:"7px 14px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:7,color:T.text3,cursor:"pointer",fontSize:12}}>重新生成</button>
    </div>)}
  </div>);
}
function QCard({T,q}) {
  const [open,setOpen]=useState(false);
  return(<div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:10,padding:14,marginBottom:9}}>
    <div style={{cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}} onClick={()=>setOpen(!open)}>
      <div style={{flex:1,marginRight:10}}>
        <div style={{display:"flex",gap:5,marginBottom:6}}><Chip c={T.text2} bg={T.navActive}>{q.tag}</Chip>{q.subTag&&<Chip c={T.text3} bg={T.card2}>{q.subTag}</Chip>}</div>
        <div style={{fontSize:14,color:T.text,fontWeight:500,lineHeight:1.5}}>{q.question}</div>
      </div>
      <span style={{fontSize:11,color:T.text4,flexShrink:0}}>{open?"▲":"▼"}</span>
    </div>
    {open&&<div style={{marginTop:13,paddingTop:13,borderTop:`1px solid ${T.border}`}}>
      {[["考察目标","#374151","#f9fafb",q.purpose],["好的回答","#16a34a","#f0fdf4",q.goodAnswer],["一般回答","#ca8a04","#fefce8",q.okAnswer],["差的回答","#dc2626","#fff5f5",q.badAnswer],q.redFlag&&["红旗回答","#7f1d1d","#fef2f2",q.redFlag],["追问方向","#4f46e5","#eef2ff",q.followUp]].filter(Boolean).map(([l,c,bg,t])=>(
        <div key={l} style={{padding:"7px 9px",borderRadius:6,background:bg,marginBottom:7}}><span style={{fontSize:10,fontWeight:700,color:c,marginRight:5}}>{l}</span><span style={{fontSize:13,color:"#374151",lineHeight:1.6}}>{t}</span></div>
      ))}
    </div>}
  </div>);
}

// ─── INTERVIEW TAB ───────────────────────────────────────────
function InterviewTab({T,cand,job,cfg,updCand,recordTokens,dirCtx}) {
  const [round,setRound]=useState("一面");
  const [notes,setNotes]=useState("");
  const [schedDate,setSchedDate]=useState("");
  const [schedTime,setSchedTime]=useState("10:00");
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");

  const saveSchedule=()=>{
    if(!schedDate)return;
    updCand(cand.id,{scheduledAt:`${schedDate}T${schedTime}:00`,interviewRound:round,status:"interview"});
  };

  const assess=async()=>{
    if(!notes.trim()){setErr("请填写面试笔记");return;}
    setErr("");setLoading(true);
    try{
      const res=await callAI(cfg,
        `你是资深HR，请严格按JSON格式输出，不含任何markdown标记。`,
        `岗位：${job?.title} 要求：${job?.requirements}
候选人：${cand.name} 简历评分：${cand.screening?.overallScore}/5.0 结论：${cand.screening?.recommendation}
T1维度(简历)：${JSON.stringify(cand.screening?.t1?.items?.map(i=>({d:i.dimension,s:i.score}))||[])}
面试轮次：${round} 笔记：${notes}
输出JSON：{"round":"${round}","jdMatch":"高度匹配|基本匹配|部分匹配|不匹配","score":4.5,"decision":"通过|待定|淘汰","suggestion":"建议后续行动",
"dimensions":[{"name":"维度","note":"表现","score":4,"maxScore":5,"vsResume":"一致|存疑|不符","evidence":"依据"}],
"emotions":{"trueMotivation":"真实动机","needsPriority":"成长>薪酬>稳定","stabilityRisk":"低|中|高","managementDifficulty":"低|中|高","stabilityNote":"说明","managementNote":"说明"},
"highlights":["亮点"],"concerns":["顾虑"],"interviewerReview":"面试官复盘"}`,
        recordTokens,dirCtx
      );
      if(res.error) throw new Error(res.error);
      const ni={round,notes,date:new Date().toLocaleDateString("zh-CN"),assessment:res};
      updCand(cand.id,{
        interviews:[...(cand.interviews||[]),ni],
        scheduledAt:null,
        status:res.decision==="通过"?(round.includes("终")?"offer":"interview"):res.decision==="淘汰"?"rejected":"watching"
      });
      setNotes("");setRound("一面");
    }catch(e){setErr(e.message);}
    setLoading(false);
  };

  return(<div>
    {(cand.interviews||[]).map((ir,i)=><IRecord key={i} T={T} record={ir}/>)}
    <SCard T={T} title="📅 安排面试时间">
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr auto",gap:10,alignItems:"flex-end"}}>
        <div><label style={lbSt(T)}>面试轮次</label>
          <select value={round} onChange={e=>setRound(e.target.value)} style={{...inSt(T)}}>
            {["一面","二面","三面","终面","HR面"].map(r=><option key={r}>{r}</option>)}
          </select>
        </div>
        <div><label style={lbSt(T)}>面试日期</label><input type="date" value={schedDate} onChange={e=>setSchedDate(e.target.value)} style={{...inSt(T)}}/></div>
        <div><label style={lbSt(T)}>面试时间</label><input type="time" value={schedTime} onChange={e=>setSchedTime(e.target.value)} style={{...inSt(T)}}/></div>
        <button onClick={saveSchedule} disabled={!schedDate}
          style={{padding:"8px 16px",background:schedDate?T.accent:"#e5e7eb",color:schedDate?T.accentFg:T.text4,border:"none",borderRadius:7,cursor:schedDate?"pointer":"not-allowed",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>
          确认预约
        </button>
      </div>
      {cand.scheduledAt&&<div style={{marginTop:10,fontSize:13,color:"#7c3aed",fontWeight:600}}>✓ 已预约：{cand.interviewRound} · {fmtDate(cand.scheduledAt)}</div>}
    </SCard>
    <SCard T={T} title="录入面试记录">
      <div style={{marginBottom:12}}><label style={lbSt(T)}>面试笔记 *</label>
        <textarea rows={10} value={notes} onChange={e=>setNotes(e.target.value)} style={{...inSt(T),resize:"vertical",lineHeight:1.7}}
          placeholder={"记录候选人表现、回答要点、你的观察...\n例：\n- 自我介绍流畅，突出5年短视频经验\n- 团队协作举了具体项目，数据清晰（粉丝增长40%）\n- 离职原因：想要更大平台\n- 薪资期望20K，目前18K，有弹性"}/>
      </div>
      {dirCtx&&<div style={{fontSize:11,color:T.accent,marginBottom:8,padding:"6px 10px",background:`${T.accent}10`,borderRadius:6}}>✦ AI将参考你的历史判断标准进行评估</div>}
      {err&&<ErrBox>{err}</ErrBox>}
      <BtnPrimary T={T} loading={loading} disabled={loading||!notes.trim()} onClick={assess}>{loading?<Spin text="AI 三源综合评估中..."/>:`AI ${round}综合评估 →`}</BtnPrimary>
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

// ─── DIRECTOR TAB ────────────────────────────────────────────
function DirectorTab({T,cand,updCand}) {
  const dir=cand.directorVerdict||{};
  const [verdict,setVerdict]=useState(dir.verdict||"");
  const [reason,setReason]=useState(dir.reason||"");
  const saved=dir.verdict&&dir.reason;
  const aiRec=cand.screening?.recommendation;
  const match=saved&&((aiRec==="建议通过"&&["录用","通过"].includes(dir.verdict))||(aiRec==="建议淘汰"&&dir.verdict==="淘汰"));

  const save=()=>{
    if(!verdict||!reason.trim())return;
    updCand(cand.id,{
      directorVerdict:{verdict,reason,date:new Date().toLocaleDateString("zh-CN"),aiRec},
      status:verdict==="录用"?"offer":verdict==="淘汰"?"rejected":cand.status
    });
  };

  return(<div>
    <div style={{...cardSt(T),borderLeft:`4px solid ${T.accent}`,marginBottom:14}}>
      <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:6}}>🧠 总监判断沉淀系统</div>
      <div style={{fontSize:13,color:T.text2,lineHeight:1.7}}>
        你对候选人的最终判断和点评，将自动积累成 AI 的参考标准。<br/>
        <strong style={{color:T.accent}}>积累越多，AI 越懂你的用人偏好，评估越准。</strong>
      </div>
    </div>

    {cand.screening&&(
      <div style={{...cardSt(T),marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:12}}>AI 建议 vs 总监判断</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div style={{padding:"14px",background:T.card2,borderRadius:9,textAlign:"center"}}>
            <div style={{fontSize:11,color:T.text4,marginBottom:6}}>AI 建议</div>
            <div style={{fontSize:16,fontWeight:700,color:recSt(aiRec).c}}>{aiRec||"未评估"}</div>
            <div style={{fontSize:28,fontWeight:900,color:scColor(cand.screening.overallScore),marginTop:4}}>{cand.screening.overallScore?.toFixed(1)}</div>
          </div>
          <div style={{padding:"14px",background:T.card2,borderRadius:9,textAlign:"center",border:saved?`2px solid ${verdict==="录用"?"#059669":verdict==="淘汰"?"#dc2626":"#ca8a04"}`:undefined}}>
            <div style={{fontSize:11,color:T.text4,marginBottom:6}}>总监最终判断</div>
            {saved?<div style={{fontSize:16,fontWeight:700,color:verdict==="录用"?"#059669":verdict==="淘汰"?"#dc2626":"#ca8a04"}}>{verdict}</div>
            :<div style={{fontSize:13,color:T.text4}}>待填写</div>}
            {saved&&aiRec&&<div style={{marginTop:8,fontSize:12,fontWeight:700,color:match?"#16a34a":"#dc2626"}}>{match?"✓ 与AI一致":"✗ 与AI不同，将修正AI标准"}</div>}
          </div>
        </div>
      </div>
    )}

    <SCard T={T} title={saved?"更新我的判断":"填写我的判断"}>
      <div style={{marginBottom:14}}>
        <label style={lbSt(T)}>最终决定</label>
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
      <BtnPrimary T={T} onClick={save} disabled={!verdict||!reason.trim()}>
        {saved?"更新判断":"保存判断 · 沉淀为AI参考"}
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
  const rec=allOk?"建议录用":lat.assessment?.decision==="待定"?"待最终确认":"建议淘汰";
  const rs2=allOk?{c:"#16a34a",bg:"#dcfce7"}:rec==="待最终确认"?{c:"#ca8a04",bg:"#fef9c3"}:{c:"#dc2626",bg:"#fee2e2"};
  return(<div>
    <div style={{...cardSt(T),borderLeft:`4px solid ${rs2.c}`,marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:15,fontWeight:700,color:T.text,marginBottom:4}}>AI 综合录用建议</div>
          <div style={{fontSize:13,color:T.text2}}>完成 {ivs.length} 轮面试 · 最终评分 <strong style={{color:scColor(lat.assessment.score)}}>{lat.assessment.score?.toFixed(1)}/5.0</strong></div>
          <div style={{fontSize:13,color:T.text3,marginTop:4}}>{lat.assessment.suggestion}</div>
        </div>
        <Chip c={rs2.c} bg={rs2.bg} lg>{rec}</Chip>
      </div>
    </div>
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
function SettingsView({T,cfg,setCfg,usageLogs,dirStats,dirDone,dirMatch,jobs}) {
  const [keys,setKeys]=useState(cfg.apiKeys||{});
  const [saved,setSaved]=useState("");
  const [testing,setTesting]=useState("");
  const [testResult,setTestResult]=useState({});

  const saveKey=pid=>{setCfg(p=>({...p,apiKeys:{...p.apiKeys,[pid]:keys[pid]}}));setSaved(pid);setTimeout(()=>setSaved(""),1500);};

  const testKey=async(pid)=>{
    const k=keys[pid]; if(!k){setTestResult(p=>({...p,[pid]:{ok:false,msg:"请先填写 Key"}}));return;}
    setTesting(pid);
    try{
      const testCfg={provider:pid,model:PROVIDERS[pid].models[0].id,apiKeys:{[pid]:k},routing:{enabled:false}};
      const r=await callAI(testCfg,"你是连接测试助手，只返回 JSON。","请只返回 JSON：{\"reply\":\"OK\"}",null);
      const ok=r?.reply==="OK";
      if(!ok) throw new Error(r?.raw||r?.error||"返回格式异常");
      setTestResult(p=>({...p,[pid]:{ok:true,msg:"连接正常 ✓"}}));
    }catch(e){setTestResult(p=>({...p,[pid]:{ok:false,msg:e.message?.slice(0,40)||"连接失败"}}));}
    setTesting("");
  };

  const r=cfg.routing||{};
  const setRouting=patch=>setCfg(p=>({...p,routing:{...p.routing,...patch}}));
  const fileProviders=Object.entries(PROVIDERS).filter(([,v])=>v.supportsFile);
  const allProviders=Object.entries(PROVIDERS);

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

      {/* ── 智能路由 ── */}
      <SecLabel T={T}>智能路由</SecLabel>
      <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px",marginBottom:22}}>
        {/* 开关 */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:r.enabled?18:0}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:T.text}}>自动选择模型</div>
            <div style={{fontSize:12,color:T.text3,marginTop:3}}>开启后，文字任务和文件任务分别用不同模型，自动降本提效</div>
          </div>
          <div onClick={()=>setRouting({enabled:!r.enabled})}
            style={{width:44,height:24,borderRadius:12,background:r.enabled?T.accent:T.border2,cursor:"pointer",position:"relative",transition:"background 0.2s",flexShrink:0}}>
            <div style={{position:"absolute",top:3,left:r.enabled?23:3,width:18,height:18,borderRadius:9,background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"}}/>
          </div>
        </div>

        {r.enabled&&<>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            {/* 文字任务 */}
            <div style={{background:T.card2,borderRadius:10,padding:"14px 16px",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:3}}>✏️ 文字任务</div>
              <div style={{fontSize:11,color:T.text4,marginBottom:12}}>简历筛选（文字）/ 生成面试题 / 评估记录</div>
              <div style={{marginBottom:8}}>
                <label style={lbSt(T)}>模型平台</label>
                <select value={r.textProvider||"deepseek"} onChange={e=>{
                  const pid=e.target.value;
                  setRouting({textProvider:pid,textModel:PROVIDERS[pid]?.models[0]?.id||""});
                }} style={{...inSt(T)}}>
                  {allProviders.map(([pid,pv])=><option key={pid} value={pid}>{pv.name}</option>)}
                </select>
              </div>
              <div>
                <label style={lbSt(T)}>具体模型</label>
                <select value={r.textModel||""} onChange={e=>setRouting({textModel:e.target.value})} style={{...inSt(T)}}>
                  {(PROVIDERS[r.textProvider||"deepseek"]?.models||[]).map(m=>(
                    <option key={m.id} value={m.id}>{m.name} — {m.note}{PROVIDERS[r.textProvider]?.pricing?.[m.id]?` · $${PROVIDERS[r.textProvider].pricing[m.id].in}/M`:""}</option>
                  ))}
                </select>
              </div>
            </div>
            {/* 文件任务 */}
            <div style={{background:T.card2,borderRadius:10,padding:"14px 16px",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:3}}>📄 文件任务</div>
              <div style={{fontSize:11,color:T.text4,marginBottom:12}}>上传 JD / 上传简历（PDF、图片识别）</div>
              <div style={{marginBottom:8}}>
                <label style={lbSt(T)}>模型平台（需支持文件）</label>
                <select value={r.fileProvider||"gemini"} onChange={e=>{
                  const pid=e.target.value;
                  setRouting({fileProvider:pid,fileModel:PROVIDERS[pid]?.models[0]?.id||""});
                }} style={{...inSt(T)}}>
                  {fileProviders.map(([pid,pv])=><option key={pid} value={pid}>{pv.name}</option>)}
                </select>
              </div>
              <div>
                <label style={lbSt(T)}>具体模型</label>
                <select value={r.fileModel||""} onChange={e=>setRouting({fileModel:e.target.value})} style={{...inSt(T)}}>
                  {(PROVIDERS[r.fileProvider||"gemini"]?.models||[]).map(m=>(
                    <option key={m.id} value={m.id}>{m.name} — {m.note}{PROVIDERS[r.fileProvider]?.pricing?.[m.id]?` · $${PROVIDERS[r.fileProvider].pricing[m.id].in}/M`:""}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div style={{marginTop:12,padding:"9px 12px",background:`${T.accent}0d`,borderRadius:8,fontSize:12,color:T.text3}}>
            💡 推荐组合：文字任务用 <strong style={{color:T.text}}>DeepSeek V3</strong>（$0.27/M 极低价）· 文件任务用 <strong style={{color:T.text}}>Gemini 2.0 Flash</strong>（$0.075/M，支持 PDF+图片）
          </div>
        </>}
      </div>

      {/* ── API 模型配置 ── */}
      <SecLabel T={T}>API 模型配置（手动模式 / 路由备用）</SecLabel>
      <div style={{display:"grid",gap:12,marginBottom:24}}>
        {Object.entries(PROVIDERS).map(([pid,prov])=>{
          const isActive=cfg.provider===pid;
          const tr=testResult[pid];
          const getKeyUrl = pid==="gemini"?"https://aistudio.google.com/app/apikey":pid==="claude"?"https://console.anthropic.com/":pid==="openai"?"https://platform.openai.com/api-keys":pid==="deepseek"?"https://platform.deepseek.com/api_keys":pid==="kimi"?"https://platform.moonshot.cn/console/api-keys":null;
          return(<div key={pid} style={{background:T.surface,border:`2px solid ${isActive?prov.color:T.border}`,borderRadius:12,padding:"16px 18px",transition:"border 0.15s"}}>
            <div style={{display:"flex",alignItems:"center",gap:11,marginBottom:12}}>
              <div style={{width:32,height:32,borderRadius:7,background:prov.color,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:14,flexShrink:0}}>{prov.logo}</div>
              <div style={{flex:1}}>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <div style={{fontSize:14,fontWeight:800,color:T.text}}>{prov.name}</div>
                  {prov.supportsFile&&<Chip c="#059669" bg="#dcfce7">支持文件</Chip>}
                  {!prov.supportsFile&&<Chip c={T.text4} bg={T.navActive}>仅文字</Chip>}
                </div>
                <div style={{fontSize:11,color:T.text4,marginTop:2}}>{prov.models.length} 个可用模型 · {getKeyUrl&&<a href={getKeyUrl} target="_blank" rel="noreferrer" style={{color:prov.color,textDecoration:"none"}}>获取 API Key ↗</a>}</div>
              </div>
              {isActive&&<span style={{fontSize:11,fontWeight:700,padding:"3px 9px",background:`${prov.color}18`,color:prov.color,borderRadius:20}}>当前使用</span>}
            </div>
            <div style={{marginBottom:11}}>
              <label style={lbSt(T)}>API Key</label>
              <div style={{display:"flex",gap:7}}>
                <input type="password" value={keys[pid]||""} onChange={e=>setKeys(p=>({...p,[pid]:e.target.value}))} placeholder={prov.keyPlaceholder} style={{...inSt(T),flex:1,fontSize:12}}/>
                <button onClick={()=>saveKey(pid)} style={{padding:"7px 10px",background:saved===pid?"#059669":prov.color,color:"#fff",border:"none",borderRadius:7,fontSize:12,fontWeight:700,cursor:"pointer",flexShrink:0,transition:"background 0.2s"}}>{saved===pid?"✓ 已保存":"保存"}</button>
                <button onClick={()=>testKey(pid)} disabled={testing===pid} style={{padding:"7px 10px",background:T.navActive,color:T.text3,border:`1px solid ${T.border2}`,borderRadius:7,fontSize:12,cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"}}>{testing===pid?"测试中…":"测试连接"}</button>
              </div>
              {tr&&<div style={{fontSize:11,marginTop:5,color:tr.ok?"#16a34a":"#dc2626",fontWeight:600}}>{tr.msg}</div>}
            </div>
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
const Page=({T,title,sub,children})=>(<div style={{padding:"26px 30px",maxWidth:1080,margin:"0 auto"}}><div style={{marginBottom:20,paddingBottom:14,borderBottom:`1px solid ${T.border}`}}><h1 style={{fontSize:21,fontWeight:800,color:T.text,margin:0}}>{title}</h1>{sub&&<div style={{fontSize:13,color:T.text4,marginTop:3}}>{sub}</div>}</div>{children}</div>);
const SCard=({T,title,children})=>(<div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 20px",marginBottom:14}}>{title&&<div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:14,paddingBottom:10,borderBottom:`1px solid ${T.border}`}}>{title}</div>}{children}</div>);
const cardSt=T=>({background:T.surface,border:`1px solid ${T.border}`,borderRadius:11,padding:"18px 20px",marginBottom:12});
const ScoreSection=({T,title,children})=>(<div style={{...cardSt(T),marginBottom:12}}><div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:12,paddingBottom:7,borderBottom:`1px solid ${T.border}`}}>{title}</div>{children}</div>);
const ScoreBar=({T,label,score,max,badge,note})=>{const c=scColor(score,max||5);return(<div style={{padding:"9px 0",borderBottom:`1px solid ${T.border}`}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}><div style={{display:"flex",gap:7,alignItems:"center"}}><span style={{fontSize:13,color:T.text,fontWeight:500}}>{label}</span>{badge&&<Chip c={T.text3} bg={T.navActive}>{badge}</Chip>}</div><span style={{fontWeight:700,color:c,fontSize:13}}>{score}/{max}</span></div><MiniBar score={score} max={max} color={c}/>{note&&<div style={{fontSize:11,color:T.text4,marginTop:4}}>{note}</div>}</div>);};
const MiniBar=({score,max,color})=>(<div style={{height:3,background:"#e5e7eb",borderRadius:2}}><div style={{width:`${(score/(max||5))*100}%`,height:"100%",background:color||"#111827",borderRadius:2,transition:"width 0.4s ease"}}/></div>);
const SecLabel=({T,children})=><div style={{fontSize:11,fontWeight:800,color:T.text4,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:9,marginTop:2}}>{children}</div>;
const Chip=({c,bg,children,lg})=><span style={{display:"inline-block",padding:lg?"5px 14px":"2px 7px",borderRadius:20,fontSize:lg?13:11,fontWeight:700,color:c,background:bg,whiteSpace:"nowrap"}}>{children}</span>;
const SBadge=({status})=>{const s=STATUS[status]||STATUS.pending;return <Chip c={s.color} bg={s.bg}>{s.label}</Chip>;};
const Av=({name,T,size=36})=><div style={{width:size,height:size,borderRadius:"50%",background:`${T.accent}22`,color:T.accent,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:size*0.38,flexShrink:0}}>{(name||"?")[0]?.toUpperCase()}</div>;
const Inp=({T,label,...props})=><div style={{marginBottom:9}}>{label&&<label style={lbSt(T)}>{label}</label>}<input style={inSt(T)} {...props}/></div>;
const Empty=({T,icon,title,sub})=><div style={{textAlign:"center",padding:"56px 24px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:12}}><div style={{fontSize:32,color:T.border2,marginBottom:10}}>{icon}</div><div style={{fontSize:15,fontWeight:600,color:T.text2,marginBottom:5}}>{title}</div><div style={{fontSize:13,color:T.text4}}>{sub}</div></div>;
const ErrBox=({children})=><div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:7,padding:"8px 12px",fontSize:13,color:"#dc2626",marginBottom:9}}>{children}</div>;
const BtnPrimary=({T,children,loading,disabled,onClick})=><button onClick={onClick} disabled={disabled} style={{padding:"11px",background:T.accent,color:T.accentFg,border:"none",borderRadius:8,fontSize:14,fontWeight:700,cursor:disabled?"not-allowed":"pointer",width:"100%",opacity:disabled?0.5:1,transition:"opacity 0.1s"}}>{children}</button>;
const Spin=({text})=><span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7}}><span style={{width:13,height:13,border:"2px solid rgba(255,255,255,0.3)",borderTopColor:"#fff",borderRadius:"50%",animation:"spin 0.7s linear infinite",display:"inline-block"}}/>{text}</span>;
const lbSt=T=>({fontSize:11,fontWeight:600,color:T.text3,display:"block",marginBottom:5});
const inSt=T=>({width:"100%",padding:"8px 10px",border:`1px solid ${T.border2}`,borderRadius:7,fontSize:13,color:T.text,outline:"none",boxSizing:"border-box",fontFamily:"inherit",background:T.inputBg});
function Css({T}) {
  return <style>{`
    @keyframes spin{to{transform:rotate(360deg)}}
    *{box-sizing:border-box;margin:0;padding:0}
    input:focus,textarea:focus,select:focus{border-color:${T.accent}!important;outline:none;box-shadow:0 0 0 3px ${T.accent}15}
    button,textarea{font-family:inherit}
    .hr:hover{background:${T.navActive}!important}
    ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:${T.border2};border-radius:2px}
    details summary{list-style:none}details summary::-webkit-details-marker{display:none}
  `}</style>;
}
