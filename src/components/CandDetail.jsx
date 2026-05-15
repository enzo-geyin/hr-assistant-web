import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  STATUS, SOFT_SHADOW, CARD_RADIUS, fmt, fmtDate, cardSt, lbSt, inSt,
  Page, SCard, ScoreSection, ScoreBar, MiniBar, SecLabel, Chip, SBadge, Av, Inp, Empty, ErrBox, BtnPrimary, Spin,
  fetchKnowledgeState, resolveMatchedJob, buildReadableResumePreview, extractRoleKeywordHits,
  createResumeVisualPreview, createCloudResumePreview, extractFileText, getFileKind, normalizeExtractedText,
  buildResumeSignature, runResumeScreening, resolveScreeningStatusPatch, recSt, scColor, highlightTextByKeywords,
  formatRubricContext, formatQuestionBankContext, mergeQuestionFeedbackHistory, getQuestionBankSourceMeta,
  getQuestionFeedbackOption, QUESTION_FEEDBACK_OPTIONS, getInterviewRoundsForJob, isSingleRoundLevel,
  transcribeAudioFile, learnFromDirectorFeedback, KNOWLEDGE_MIN_SAMPLES, getFinalAiRecommendation, cleanListLine,
  getAiVerdictTone, getHumanVerdictTone, fetchCloudPreview
} from "../App.jsx";

function CandDetail({T,cand,job,jobs,allCandidates=[],tab,setTab,cfg,updCand,recordTokens,dirCtx,questionTask,interviewTask,startQuestionGeneration,startInterviewAssessment,onDelete,onReplaceResume}) {
  const [learning,setLearning]=useState({sampleCount:0,recentSamples:[],rubric:null,questionBank:null});
  const [learningState,setLearningState]=useState({loading:!!job?.id,error:""});
  const [showResumePreview,setShowResumePreview]=useState(true);
  const [showPreviewLightbox,setShowPreviewLightbox]=useState(false);
  const [previewZoom,setPreviewZoom]=useState(1);
  const [previewPage,setPreviewPage]=useState(0);
  const [replaceLoading,setReplaceLoading]=useState(false);
  const [replaceErr,setReplaceErr]=useState("");
  const [cloudPreview,setCloudPreview]=useState(null);
  const [cloudPreviewLoading,setCloudPreviewLoading]=useState(false);
  const [cloudPreviewError,setCloudPreviewError]=useState("");
  const aiSuggestedJob=resolveMatchedJob(jobs, cand?.screening || {}, cand?.resume || "");
  const previewResume=(cand?.resume||"").trim();
  const readablePreview=buildReadableResumePreview(previewResume);
  // 优先用 AI 筛选时抽取的 skillTags（任意领域都准），老候选人没有时回退到本地词典。
  const aiSkillTags = Array.isArray(cand?.screening?.skillTags)
    ? cand.screening.skillTags.filter(tag => typeof tag === "string" && tag.trim()).slice(0, 30)
    : [];
  const resumeKeywordHits = aiSkillTags.length ? aiSkillTags : extractRoleKeywordHits(previewResume);
  const localPreview=cand?.resumePreview || cand?.resumePreviewCloud || null;
  const visualPreview=localPreview?.src ? localPreview : (cloudPreview || null);
  const proxyTokenRef = useRef(cfg?.proxyToken || "");
  useEffect(()=>{ proxyTokenRef.current = cfg?.proxyToken || ""; }, [cfg?.proxyToken]);
  // 只依赖候选人本身（id / 状态 / 本地预览是否存在），不再因为 token 输入框
  // 每改一个字就重发请求，避免设置页编辑 token 时简历预览反复闪烁。
  useEffect(()=>{
    setCloudPreview(null);
    setCloudPreviewError("");
    if(localPreview?.src) return;
    if(!cand?.id) return;
    // 不再依据 resumePreviewStatus==="none" 跳过云端 fetch：
    // 历史候选人可能被旧代码误标 none（其实云端有 preview）。
    // 单次 D1 SELECT 开销很小，宁可多查 404 也别让历史数据看上去"丢了"。
    let cancelled=false;
    setCloudPreviewLoading(true);
    fetchCloudPreview(proxyTokenRef.current, cand.id)
      .then(preview=>{
        if(cancelled) return;
        setCloudPreview(preview||null);
      })
      .catch(error=>{
        if(cancelled) return;
        setCloudPreviewError(error?.message||"加载云端简历快照失败");
      })
      .finally(()=>{
        if(cancelled) return;
        setCloudPreviewLoading(false);
      });
    return ()=>{cancelled=true;};
  },[cand?.id, localPreview?.src]);
  const previewPages = visualPreview?.pages?.length ? visualPreview.pages : (visualPreview?.src ? [visualPreview.src] : []);
  const currentPreviewSrc = previewPages[previewPage] || visualPreview?.src || "";
  const assignJob=jobIdValue=>{
    const nextJob=(jobs||[]).find(item=>String(item.id)===String(jobIdValue));
    updCand(cand.id,{jobId:nextJob?.id??null,questions:null});
  };
  useEffect(()=>{
    setPreviewPage(0);
    setPreviewZoom(1);
    setShowPreviewLightbox(false);
  },[cand?.id, visualPreview?.src]);
  useEffect(()=>{
    setReplaceLoading(false);
    setReplaceErr("");
  },[cand?.id]);
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
  const handleReplaceResumeFile=async file=>{
    if(!file || !onReplaceResume) return;
    setReplaceErr("");
    setReplaceLoading(true);
    try{
      await onReplaceResume(cand.id,file);
      setTab("screening");
    }catch(error){
      setReplaceErr(error?.message||"更新简历失败");
    }
    setReplaceLoading(false);
  };

  const tabs=[
    {id:"screening",label:"① 简历筛选"},
    {id:"questions",label:`② 面试题${questionTask?.loading?" · 生成中":""}`,disabled:!cand.screening},
    {id:"interview",label:"③ 面试记录",disabled:!cand.screening},
    {id:"director", label:"④ 总监判断"},
    {id:"result",   label:"⑤ 评估结果",disabled:!cand.interviews?.some(i=>i.assessment)},
  ];
  const dir=cand.directorVerdict;
  const currentStatusMeta=STATUS[cand.status]||STATUS.pending;
  const previewTitle=visualPreview?.src?"简历版式预览":"简历识别文本";
  const accentRole = job?.title || cand.screening?.roleDirection || "未绑定岗位";
  const overviewFacts = [
    { label: "简历来源", value: cand.resumeFileName || "手动录入 / 识别文本", tone: "#111827" },
    { label: "岗位模板", value: accentRole, tone: "#2563eb" },
    { label: "下一动作", value: cand.scheduledAt ? `${currentStatusMeta?.label || "待处理"} · ${fmtDate(cand.scheduledAt)}` : (currentStatusMeta?.label || "待处理"), tone: currentStatusMeta?.c || T.text },
  ];
  const shellCard={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:CARD_RADIUS,
    boxShadow:SOFT_SHADOW,
  };
  const minorPanel={
    background:T.surface,
    border:`1px solid ${T.border}`,
    borderRadius:14,
    boxShadow:"0 10px 24px rgba(15,23,42,0.05)",
  };
  return(<div>
    {showPreviewLightbox&&currentPreviewSrc&&<div
      onClick={()=>setShowPreviewLightbox(false)}
      style={{position:"fixed",inset:0,zIndex:260,background:"rgba(15,23,42,0.74)",display:"flex",alignItems:"center",justifyContent:"center",padding:24}}
    >
      <div
        onClick={e=>e.stopPropagation()}
        style={{width:"min(96vw, 1280px)",height:"min(92vh, 980px)",background:"#0f172a",borderRadius:18,boxShadow:"0 32px 100px rgba(15,23,42,0.4)",display:"flex",flexDirection:"column",overflow:"hidden"}}
      >
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",borderBottom:"1px solid rgba(255,255,255,0.08)",color:"#e2e8f0",gap:12}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:14,fontWeight:800,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{cand.resumeFileName||"简历预览"}</div>
            <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>
              {visualPreview.kind==="pdf"
                ? `PDF 第${previewPage+1}页${visualPreview.pageCount ? ` / 共 ${visualPreview.pageCount} 页` : ""}`
                : "原始图片预览"}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            {visualPreview.kind==="pdf"&&previewPages.length>1&&<>
              <button onClick={()=>setPreviewPage(page=>Math.max(0,page-1))} disabled={previewPage===0} style={{padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.14)",background:"rgba(255,255,255,0.06)",color:"#fff",cursor:previewPage===0?"not-allowed":"pointer",fontSize:13,fontWeight:700,opacity:previewPage===0?0.45:1}}>上一页</button>
              <button onClick={()=>setPreviewPage(page=>Math.min(previewPages.length-1,page+1))} disabled={previewPage>=previewPages.length-1} style={{padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.14)",background:"rgba(255,255,255,0.06)",color:"#fff",cursor:previewPage>=previewPages.length-1?"not-allowed":"pointer",fontSize:13,fontWeight:700,opacity:previewPage>=previewPages.length-1?0.45:1}}>下一页</button>
            </>}
            <button onClick={()=>setPreviewZoom(z=>Math.max(0.8, Number((z-0.2).toFixed(2))))} style={{padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.14)",background:"rgba(255,255,255,0.06)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700}}>缩小</button>
            <button onClick={()=>setPreviewZoom(1)} style={{padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.14)",background:"rgba(255,255,255,0.06)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700}}>100%</button>
            <button onClick={()=>setPreviewZoom(z=>Math.min(3, Number((z+0.2).toFixed(2))))} style={{padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.14)",background:"rgba(255,255,255,0.06)",color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700}}>放大</button>
            <button onClick={()=>setShowPreviewLightbox(false)} style={{padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,0.14)",background:"#fff",color:"#111827",cursor:"pointer",fontSize:13,fontWeight:800}}>关闭</button>
          </div>
        </div>
        <div style={{flex:1,overflow:"auto",padding:20,display:"flex",justifyContent:"center",alignItems:"flex-start",background:"#111827"}}>
          <div style={{display:"grid",gridTemplateColumns:visualPreview.kind==="pdf"&&previewPages.length>1?"120px minmax(0,1fr)":"minmax(0,1fr)",gap:16,width:"100%",alignItems:"start"}}>
            {visualPreview.kind==="pdf"&&previewPages.length>1&&<div style={{display:"flex",flexDirection:"column",gap:10,maxHeight:"100%",overflow:"auto",paddingRight:4}}>
              {previewPages.map((pageSrc,index)=>(
                <button
                  key={`preview-page-${index}`}
                  onClick={()=>setPreviewPage(index)}
                  style={{padding:0,border:index===previewPage?"2px solid #60a5fa":"1px solid rgba(255,255,255,0.12)",background:index===previewPage?"rgba(96,165,250,0.14)":"rgba(255,255,255,0.04)",borderRadius:12,cursor:"pointer",overflow:"hidden"}}
                >
                  <img src={pageSrc} alt={`第${index+1}页`} style={{display:"block",width:"100%",height:"auto"}} />
                  <div style={{padding:"6px 8px",fontSize:11,fontWeight:700,color:index===previewPage?"#bfdbfe":"#cbd5e1",textAlign:"center"}}>{`第${index+1}页`}</div>
                </button>
              ))}
            </div>}
            <div style={{display:"flex",justifyContent:"center",alignItems:"flex-start",overflow:"auto"}}>
              <img
                src={currentPreviewSrc}
                alt={cand.resumeFileName||"简历预览"}
                style={{display:"block",width:`${Math.round(previewZoom*100)}%`,maxWidth:"none",height:"auto",borderRadius:12,boxShadow:"0 20px 60px rgba(0,0,0,0.35)",background:"#fff"}}
              />
            </div>
          </div>
        </div>
      </div>
    </div>}
    <div style={{...shellCard,padding:"22px 22px 18px",marginBottom:16}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.15fr) minmax(360px,0.95fr)",gap:18,alignItems:"start"}}>
        <div style={{display:"grid",gap:14,minWidth:0}}>
          <div style={{display:"grid",gridTemplateColumns:"auto minmax(0,1fr)",gap:16,alignItems:"start"}}>
            <Av name={cand.name} T={T} size={58}/>
            <div style={{minWidth:0}}>
              <div style={{fontSize:28,fontWeight:900,color:T.text,letterSpacing:"-0.035em",lineHeight:1.04}}>{cand.name||"未命名候选人"}</div>
              <div style={{fontSize:13,color:T.text3,marginTop:7,lineHeight:1.7}}>当前岗位：<strong style={{color:T.text}}>{accentRole}</strong></div>
              {cand.screening?.summary&&<div style={{fontSize:13,color:T.text2,lineHeight:1.82,marginTop:10,maxWidth:760}}>{cand.screening.summary}</div>}
            </div>
          </div>

          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            {cand.screening?.roleDirection&&<Chip c="#1d4ed8" bg="#dbeafe">{`识别岗位方向：${cand.screening.roleDirection}`}</Chip>}
            {cand.screening?.matchedJobTitle&&<Chip c="#0f766e" bg="#ccfbf1">{`AI建议岗位：${cand.screening.matchedJobTitle}`}</Chip>}
            {cand.screening?.matchedJobConfidence&&<Chip c="#7c3aed" bg="#f3e8ff">{`匹配置信度：${cand.screening.matchedJobConfidence}`}</Chip>}
            {dir?.verdict&&<span style={{fontSize:12,fontWeight:700,padding:"5px 12px",borderRadius:20,background:dir.verdict==="录用"?"#ecfdf5":dir.verdict==="淘汰"?"#fef2f2":"#fffbeb",color:dir.verdict==="录用"?"#059669":dir.verdict==="淘汰"?"#dc2626":"#ca8a04"}}>总监：{dir.verdict}</span>}
            {cand.statusSource==="manual"&&<span style={{fontSize:12,fontWeight:700,padding:"5px 12px",borderRadius:20,background:"#eff6ff",color:"#2563eb"}}>状态已手动锁定</span>}
            {!cand.jobId&&job&&<span style={{fontSize:12,fontWeight:700,padding:"5px 12px",borderRadius:20,background:"#eff6ff",color:"#2563eb"}}>当前按识别岗位出题</span>}
            {cand.resumePreviewStatus==="generating"&&<span style={{fontSize:12,fontWeight:700,padding:"5px 12px",borderRadius:20,background:"#dbeafe",color:"#1d4ed8"}}>完整预览后台补全中</span>}
            {cand.resumePreviewStatus==="failed"&&<span style={{fontSize:12,fontWeight:700,padding:"5px 12px",borderRadius:20,background:"#fee2e2",color:"#dc2626"}}>完整预览补全失败</span>}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:10}}>
            {overviewFacts.map(fact=>(
              <div key={fact.label} style={{padding:"12px 14px 11px",borderRadius:16,background:"#ffffff",border:`1px solid ${T.border}`}}>
                <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>{fact.label}</div>
                <div style={{fontSize:13,fontWeight:800,color:fact.tone||T.text,wordBreak:"break-word",lineHeight:1.55,marginTop:8}}>{fact.value}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{display:"grid",gap:12}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            {cand.screening&&<div style={{padding:"16px 18px",borderRadius:18,background:"#f8fbff",border:`1px solid ${T.border}`,textAlign:"left",boxShadow:"0 10px 24px rgba(15,23,42,0.05)"}}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>AI 评分</div>
              <div style={{fontSize:42,fontWeight:900,color:scColor(cand.screening.overallScore),lineHeight:1,marginTop:10}}>{cand.screening.overallScore?.toFixed(1)}</div>
              <div style={{fontSize:11,color:T.text4,marginTop:6}}>/ 5.0</div>
            </div>}
            <div style={{padding:"14px 16px",borderRadius:18,background:"#f8fafc",border:`1px solid ${T.border}`,boxShadow:"0 10px 24px rgba(15,23,42,0.05)"}}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>当前进度</div>
              <div style={{fontSize:17,fontWeight:900,color:currentStatusMeta?.c||T.text,marginTop:10}}>{currentStatusMeta?.label||"待处理"}</div>
              {cand.scheduledAt&&<div style={{fontSize:11,color:"#7c3aed",marginTop:6,fontWeight:700}}>{fmtDate(cand.scheduledAt)}{(cand.interviewLocation ?? "")?` · 📍 ${cand.interviewLocation ?? ""}`:""}</div>}
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.12fr) minmax(0,0.88fr)",gap:12}}>
            <div style={{...minorPanel,padding:"16px 16px 14px",minWidth:0}}>
              <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:10}}>岗位与状态</div>
              <div style={{display:"grid",gap:12}}>
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:T.text4,marginBottom:8}}>岗位匹配</div>
                  <select value={cand.jobId??""} onChange={e=>assignJob(e.target.value)} style={{...inSt(T),width:"100%",fontSize:12,background:"#fff"}}>
                    <option value="">未绑定岗位</option>
                    {jobs.map(item=><option key={item.id} value={item.id}>{item.title}{item.department?` · ${item.department}`:""}</option>)}
                  </select>
                  {aiSuggestedJob&&cand.jobId!==aiSuggestedJob.id&&<button onClick={()=>assignJob(aiSuggestedJob.id)} style={{marginTop:8,padding:"8px 12px",background:"#eff6ff",color:"#2563eb",border:"1px solid #bfdbfe",borderRadius:10,cursor:"pointer",fontSize:12,fontWeight:800,whiteSpace:"nowrap",width:"100%"}}>套用AI匹配：{aiSuggestedJob.title}</button>}
                </div>
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:T.text4,marginBottom:8}}>候选人进度</div>
                  <select value={cand.status} onChange={e=>updCand(cand.id,{status:e.target.value,statusSource:"manual"})} style={{...inSt(T),width:"100%",fontSize:12,background:"#fff"}}>
                    {Object.entries(STATUS).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                  </select>
                </div>
              </div>
              <div style={{fontSize:11,color:T.text4,marginTop:10,lineHeight:1.7}}>切换岗位后，建议到“简历筛选”里点一次“重新筛选”，让评分和后续面试题按新岗位重算。</div>
            </div>

            <div style={{...minorPanel,padding:"16px 16px 14px",minWidth:0}}>
              <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:10}}>快速操作</div>
              <div style={{display:"grid",gap:10}}>
                <input
                  id={`candidate-resume-replace-${cand.id}`}
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.md"
                  style={{display:"none"}}
                  onChange={e=>{handleReplaceResumeFile(e.target.files?.[0]);e.target.value="";}}
                />
                <button
                  onClick={()=>!replaceLoading&&document.getElementById(`candidate-resume-replace-${cand.id}`)?.click()}
                  style={{padding:"11px 14px",background:"#eff6ff",color:"#2563eb",border:"1px solid #bfdbfe",borderRadius:12,cursor:replaceLoading?"not-allowed":"pointer",fontSize:12,fontWeight:800,minHeight:44,opacity:replaceLoading?0.55:1}}
                >
                  {replaceLoading?"更新中...":"重新上传原始简历"}
                </button>
                <button onClick={onDelete} style={{padding:"11px 14px",background:"#fff5f5",color:"#dc2626",border:"1px solid #fecaca",borderRadius:12,cursor:"pointer",fontSize:12,fontWeight:800,minHeight:44}}>删除简历</button>
              </div>
              {replaceErr&&<div style={{marginTop:10}}><ErrBox>{replaceErr}</ErrBox></div>}
            </div>
          </div>
        </div>
      </div>
    </div>

    <div style={{display:"grid",gap:16,marginBottom:16}}>
      {previewResume&&<div style={{...minorPanel,padding:"18px 20px",minWidth:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,marginBottom:12,flexWrap:"wrap"}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:16,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>{previewTitle}</div>
            <div style={{fontSize:11,color:T.text4,marginTop:5,lineHeight:1.7}}>
              {cand.resumeFileName?`来源文件：${cand.resumeFileName}`:"来源：手动录入 / 识别结果"}
              {!visualPreview?.src&&cand.resumeFileName&&!cloudPreviewLoading?" · 当前未保存原始版式预览":""}
              {visualPreview?.previewMode==="light"?" · 当前先展示批量导入轻量预览":""}
              {cand.resumePreviewStatus==="generating"?" · 完整预览正在后台生成，稍后会自动补齐":""}
              {cloudPreviewLoading?" · 正在按需加载云端简历快照…":""}
              {cloudPreviewError?` · 云端简历快照加载失败：${cloudPreviewError}`:""}
            </div>
          </div>
          <button
            onClick={()=>setShowResumePreview(prev=>!prev)}
            style={{padding:"8px 12px",background:T.card2,color:T.text3,border:`1px solid ${T.border}`,borderRadius:10,cursor:"pointer",fontSize:12,fontWeight:700}}
          >
            {showResumePreview?"收起预览":"展开预览"}
          </button>
        </div>
        {resumeKeywordHits.length>0&&<div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
          {resumeKeywordHits.map(hit=><Chip key={hit} c="#92400e" bg="#fef3c7">{hit}</Chip>)}
        </div>}
        {cand.screening?.matchedJobReason&&<div style={{fontSize:12,color:T.text3,lineHeight:1.8,padding:"12px 14px",background:"#f8fafc",border:`1px solid ${T.border}`,borderRadius:12,marginBottom:12}}>
          <strong style={{color:T.text}}>AI 岗位判断依据：</strong>{cand.screening.matchedJobReason}
        </div>}
        {showResumePreview&&(
          currentPreviewSrc
            ? <div style={{padding:"14px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"}}>
                  <div style={{fontSize:11,color:T.text4}}>
                  {visualPreview.kind==="pdf"
                    ? `直观预览：PDF 第${previewPage+1}页${visualPreview.pageCount ? ` / 共 ${visualPreview.pageCount} 页` : ""}`
                    : "直观预览：原始图片"}
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    {visualPreview.kind==="pdf"&&previewPages.length>1&&<>
                      <button onClick={()=>setPreviewPage(page=>Math.max(0,page-1))} disabled={previewPage===0} style={{padding:"7px 11px",background:"#ffffff",color:T.text3,border:`1px solid ${T.border2}`,borderRadius:9,cursor:previewPage===0?"not-allowed":"pointer",fontSize:12,fontWeight:700,opacity:previewPage===0?0.45:1}}>上一页</button>
                      <button onClick={()=>setPreviewPage(page=>Math.min(previewPages.length-1,page+1))} disabled={previewPage>=previewPages.length-1} style={{padding:"7px 11px",background:"#ffffff",color:T.text3,border:`1px solid ${T.border2}`,borderRadius:9,cursor:previewPage>=previewPages.length-1?"not-allowed":"pointer",fontSize:12,fontWeight:700,opacity:previewPage>=previewPages.length-1?0.45:1}}>下一页</button>
                    </>}
                    <button onClick={()=>{setPreviewZoom(1);setShowPreviewLightbox(true);}} style={{padding:"7px 11px",background:"#eff6ff",color:"#2563eb",border:"1px solid #bfdbfe",borderRadius:9,cursor:"pointer",fontSize:12,fontWeight:800}}>点击放大查看</button>
                  </div>
                </div>
                <img
                  src={currentPreviewSrc}
                  alt={cand.resumeFileName||"简历预览"}
                  onClick={()=>{setPreviewZoom(1);setShowPreviewLightbox(true);}}
                  style={{display:"block",width:"100%",maxHeight:520,objectFit:"contain",borderRadius:10,border:`1px solid ${T.border}`,background:"#f8fafc",cursor:"zoom-in"}}
                />
                {visualPreview.kind==="pdf"&&visualPreview.previewMode==="light"&&visualPreview.pageCount>previewPages.length&&<div style={{fontSize:11,color:T.text4,marginTop:10,lineHeight:1.7}}>
                  这是批量导入时保存的轻量预览，为了加速导入仅展示第一页。若需要完整页数预览，可在候选人详情里重新上传该简历。
                </div>}
                {visualPreview.kind==="pdf"&&previewPages.length>1&&<div style={{display:"flex",gap:8,marginTop:12,overflowX:"auto",paddingBottom:4}}>
                  {previewPages.map((pageSrc,index)=>(
                    <button
                      key={`inline-preview-page-${index}`}
                      onClick={()=>setPreviewPage(index)}
                      style={{padding:0,border:index===previewPage?"2px solid #60a5fa":"1px solid #dbe3ef",background:index===previewPage?"#eff6ff":"#fff",borderRadius:10,cursor:"pointer",overflow:"hidden",minWidth:76,flexShrink:0}}
                    >
                      <img src={pageSrc} alt={`第${index+1}页`} style={{display:"block",width:74,height:96,objectFit:"cover",background:"#f8fafc"}} />
                      <div style={{padding:"4px 6px",fontSize:10,fontWeight:700,color:index===previewPage?"#2563eb":T.text4,textAlign:"center"}}>{`第${index+1}页`}</div>
                    </button>
                  ))}
                </div>}
              </div>
            : <div>
                <div style={{fontSize:11,color:"#92400e",marginBottom:10,padding:"12px 14px",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:12,lineHeight:1.7}}>
                  当前这份候选人没有保存到上传时的原始版式预览，所以这里展示的是识别后的文本，不是 PDF / 图片原样。
                  如果你想看直观版式，需要重新上传一次原始简历文件。
                </div>
                <div style={{fontSize:12,color:T.text2,lineHeight:1.9,whiteSpace:"pre-wrap",padding:"14px 16px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:14,maxHeight:420,overflow:"auto"}}>
                  {highlightTextByKeywords(readablePreview, resumeKeywordHits)}
                </div>
              </div>
        )}
      </div>}

    </div>

    <div style={{...minorPanel,padding:10,marginBottom:16}}>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",padding:"4px 4px 0"}}>
      {tabs.map(t=><button key={t.id}
        style={{flex:"1 1 140px",padding:"12px 12px",border:"none",background:tab===t.id?T.tabActive:"transparent",color:tab===t.id?T.tabActiveFg:T.text3,borderRadius:12,cursor:t.disabled?"not-allowed":"pointer",fontSize:12,fontWeight:tab===t.id?800:600,opacity:t.disabled?0.4:1,transition:"all 0.1s",boxShadow:tab===t.id?"0 12px 28px rgba(15,23,42,0.1)":"none"}}
        disabled={t.disabled} onClick={()=>setTab(t.id)}>{t.label}</button>)}
      </div>
      <div style={{padding:"16px 12px 10px"}}>
        {tab==="screening"&&<ScreenTab  key={`screening-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} learning={learning} learningState={learningState}/>}
        {tab==="questions"&&<QuestionTab key={`questions-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} learning={learning} learningState={learningState} questionTask={questionTask} startQuestionGeneration={startQuestionGeneration}/>}
        {tab==="interview"&&<InterviewTab key={`interview-${cand.id}`} T={T} cand={cand} job={job} allCandidates={allCandidates} cfg={cfg} updCand={updCand} recordTokens={recordTokens} dirCtx={dirCtx} interviewTask={interviewTask} startInterviewAssessment={startInterviewAssessment}/>}
        {tab==="director" &&<DirectorTab  key={`director-${cand.id}`} T={T} cand={cand} job={job} cfg={cfg} updCand={updCand} recordTokens={recordTokens} learning={learning} learningState={learningState} refreshLearning={refreshLearning}/>}
        {tab==="result"   &&<ResultTab    key={`result-${cand.id}`} T={T} cand={cand}/>}
      </div>
    </div>
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
  const workPanel={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:18,
    boxShadow:"0 14px 32px rgba(15,23,42,0.06)",
  };
  const workspaceShell={
    ...workPanel,
    padding:0,
    overflow:"hidden",
  };
  const workspaceRail={
    padding:"20px 18px 18px",
    background:"#fcfdff",
    borderLeft:`1px solid ${T.border}`,
    display:"grid",
    gap:16,
    alignContent:"start",
  };
  const railCard={
    padding:"14px 16px",
    background:"#ffffff",
    border:`1px solid ${T.border}`,
    borderRadius:16,
  };

  useEffect(()=>{
    setName(cand.name||"");
    setResume(cand.resume||"");
    setResumeFile(null);
    setResumeFileName(cand.resumeFileName||"");
    setInputMode(cand.resumeFileName?"file":"text");
    setErr("");
  },[cand.id,cand.updatedAt,cand.resume,cand.resumeFileName,cand.name]);

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
    updCand(cand.id,{name:name||cand.name,resume:normalizedResume,resumeSignature:buildResumeSignature(normalizedResume),resumeFileName:nextResumeFileName});
    try{
      const { screening:res }=await runResumeScreening(cfg, job, normalizedResume, recordTokens, dirCtx);
      const candName=res.candidateName||name||cand.name||"";
      if(candName&&!name) setName(candName);
      updCand(cand.id,{
        name:candName,
        resume:normalizedResume,
        resumeSignature:buildResumeSignature(normalizedResume),
        resumeFileName:nextResumeFileName,
        screening:res,
        ...resolveScreeningStatusPatch(cand, res.overallScore)
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
        const resumePreview = await createResumeVisualPreview(resumeFile).catch(() => null);
        const resumePreviewCloud = await createCloudResumePreview(resumeFile).catch(() => null);
        const extractedResume = await extractFileText(resumeFile);
        await analyzeExtractedResume(extractedResume,resumeFile.name);
        updCand(cand.id,{resumePreview,resumePreviewCloud});
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
    {!scr&&(<div>
      <div style={{...workPanel,padding:"18px 20px 16px",marginBottom:16}}>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.12fr) minmax(260px,0.88fr)",gap:16,alignItems:"start"}}>
          <div>
            <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>简历筛选工作台</div>
            <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.8,maxWidth:760}}>先把候选人资料和简历收进来，再让系统按岗位要求做首轮判断。左侧负责输入与上传，右侧给你看当前状态、岗位上下文和本轮筛选会参考的规则。</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
              <Chip c={resumeFileName?"#16a34a":T.text3} bg={resumeFileName?"#ecfdf5":T.card2}>
                {resumeFileName?`已载入：${resumeFileName}`:"待上传原始简历"}
              </Chip>
              <Chip c={inputMode==="file"?"#1d4ed8":T.text3} bg={inputMode==="file"?"#dbeafe":T.card2}>{inputMode==="file"?"文件模式":"文字模式"}</Chip>
              <Chip c={loading?"#7c3aed":T.text3} bg={loading?"#f5f3ff":T.card2}>{loading?"后台筛选中":"等待开始分析"}</Chip>
            </div>
          </div>
          <div style={railCard}>
            <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>当前候选人快照</div>
            <div style={{fontSize:15,fontWeight:800,color:T.text}}>{name||cand.name||"未命名候选人"}</div>
            <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.75}}>
              当前岗位：{job?.title||cand.screening?.matchedJobTitle||"待匹配"}<br/>
              已有简历文本：{(resume||cand.resume)?.trim()?"已识别":"未录入"}
            </div>
          </div>
        </div>
      </div>

      <div style={workspaceShell}>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.18fr) minmax(300px,0.82fr)",alignItems:"stretch"}}>
          <div style={{padding:"20px 22px 18px"}}>
            <div style={{display:"flex",gap:0,marginBottom:14,border:`1px solid ${T.border2}`,borderRadius:10,overflow:"hidden",width:"fit-content"}}>
              {[["file","📄 上传简历文件"],["text","✏️ 粘贴文字"]].map(([mode,label])=>(
                <button key={mode} onClick={()=>setInputMode(mode)}
                  style={{padding:"8px 16px",border:"none",background:inputMode===mode?T.accent:T.inputBg,color:inputMode===mode?T.accentFg:T.text3,cursor:"pointer",fontSize:12,fontWeight:inputMode===mode?700:500}}>
                  {label}
                </button>
              ))}
            </div>

            <Inp T={T} label="候选人姓名" placeholder="姓名（可选）" value={name} onChange={e=>setName(e.target.value)}/>

            {inputMode==="file"&&<div style={{marginBottom:14,padding:"14px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:14}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                <label style={{...lbSt(T),marginBottom:0}}>上传简历文件（AI 自动识别并规整）</label>
                <button onClick={()=>!loading&&document.getElementById(`resume-file-input-${cand.id}`)?.click()}
                  style={{padding:"8px 12px",background:T.accent,color:T.accentFg,border:"none",borderRadius:9,cursor:loading?"not-allowed":"pointer",fontSize:12,fontWeight:700,opacity:loading?0.5:1}}>
                  选择文件
                </button>
              </div>
              <div
                onDragOver={e=>{e.preventDefault();setDrag(true);}}
                onDragLeave={()=>setDrag(false)}
                onDrop={e=>{e.preventDefault();setDrag(false);queueResumeFile(e.dataTransfer.files?.[0]);}}
                onClick={()=>!loading&&document.getElementById(`resume-file-input-${cand.id}`)?.click()}
                style={{border:`2px dashed ${drag?T.accent:T.border2}`,borderRadius:14,padding:"28px 16px",textAlign:"center",cursor:loading?"default":"pointer",background:drag?`${T.accent}10`:"#fbfcfe",transition:"all 0.15s"}}>
                <input id={`resume-file-input-${cand.id}`} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.md" style={{display:"none"}}
                  onChange={e=>{queueResumeFile(e.target.files?.[0]);e.target.value="";}}/>
                {loading
                  ?<div><Spin text="正在识别并规整简历..." /><div style={{fontSize:11,color:T.text4,marginTop:6}}>会先抽取文字，再按岗位要求做智能筛选</div></div>
                  :resumeFileName
                    ?<div><div style={{fontSize:13,fontWeight:700,color:"#16a34a"}}>已选择：{resumeFileName}</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>可直接开始筛选，或继续替换文件</div></div>
                    :<div><div style={{fontSize:13,fontWeight:700,color:T.text}}>拖入简历文件，或点击上传</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>支持 PDF、图片、Word(.docx) 和纯文本简历</div></div>
                }
              </div>
            </div>}

            {inputMode==="text"&&<div style={{marginBottom:14}}>
              <label style={lbSt(T)}>粘贴简历内容 *</label>
              <textarea rows={13} value={resume} onChange={e=>setResume(e.target.value)} style={{...inSt(T),resize:"vertical",lineHeight:1.7,background:"#fff"}} placeholder={"将简历文字粘贴到此处...\n包括：基本信息、教育背景、工作经历、技能特长等"}/>
            </div>}

            {err&&<ErrBox>{err}</ErrBox>}
            {inputMode==="file"&&<BtnPrimary T={T} loading={loading} disabled={loading||(!resumeFile&&!resumeFileName)} onClick={analyzeFile}>{loading?<Spin text="AI 正在分析简历文件..."/>:"识别并智能筛选 →"}</BtnPrimary>}
            {inputMode==="text"&&<BtnPrimary T={T} loading={loading} disabled={loading||!resume.trim()} onClick={analyzeText}>{loading?<Spin text="AI 正在分析简历..."/>:"AI 智能筛选 →"}</BtnPrimary>}
          </div>

          <div style={workspaceRail}>
            <div style={railCard}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>筛选规则上下文</div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.8}}>
                系统会优先参考岗位要求、历史总监判断和已学习的风险规则来做首轮筛选，而不是只看简历关键词。
              </div>
            </div>
            {dirCtx&&<div style={{...railCard,background:`linear-gradient(180deg, ${T.surface} 0%, ${T.accent}10 100%)`}}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>历史判断标准</div>
              <div style={{fontSize:12,color:T.text2,lineHeight:1.8}}>已融入你的历史判断标准，AI 评估会更贴近你的用人偏好。</div>
            </div>}
            {learningState?.loading&&<div style={{...railCard,background:"#eff6ff"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#2563eb",letterSpacing:"0.08em",marginBottom:8}}>学习规则载入中</div>
              <div style={{fontSize:12,color:"#1d4ed8",lineHeight:1.8}}>正在加载该岗位最近沉淀出的硬门槛、风险信号与评分校准。</div>
            </div>}
            {!learningState?.loading&&learningHint&&<div style={{...railCard,background:"#ecfeff"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#0f766e",letterSpacing:"0.08em",marginBottom:8}}>已加载岗位学习规则</div>
              <div style={{fontSize:12,color:"#115e59",lineHeight:1.8}}>{learningHint}</div>
            </div>}
          </div>
        </div>
      </div>
    </div>)}
    {scr&&(<div>
      <div style={{...workPanel,padding:"18px 20px 16px",marginBottom:16,borderLeft:`4px solid ${recSt(scr.recommendation).c}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div style={{flex:1,marginRight:20}}>
            <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em",marginBottom:8}}>筛选结论</div>
            <div style={{fontSize:14,color:T.text2,lineHeight:1.8,maxWidth:860}}>{scr.summary}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
              {cand.screening?.roleDirection&&<Chip c="#1d4ed8" bg="#dbeafe">{`识别岗位方向：${cand.screening.roleDirection}`}</Chip>}
              {cand.screening?.matchedJobTitle&&<Chip c="#0f766e" bg="#ccfbf1">{`AI建议岗位：${cand.screening.matchedJobTitle}`}</Chip>}
              {cand.screening?.matchedJobConfidence&&<Chip c="#7c3aed" bg="#f3e8ff">{`匹配置信度：${cand.screening.matchedJobConfidence}`}</Chip>}
            </div>
          </div>
          <div style={{textAlign:"center",flexShrink:0}}>
            <div style={{fontSize:42,fontWeight:900,lineHeight:1,color:scColor(scr.overallScore)}}>{scr.overallScore?.toFixed(1)}</div>
            <div style={{fontSize:11,color:T.text4,marginBottom:7}}>/ 5.0</div>
            <Chip c={recSt(scr.recommendation).c} bg={recSt(scr.recommendation).bg}>{scr.recommendation}</Chip>
          </div>
        </div>
      </div>

      <div style={workspaceShell}>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.2fr) minmax(300px,0.8fr)",alignItems:"stretch"}}>
          <div style={{padding:"20px 22px 18px"}}>
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
          </div>

          <div style={workspaceRail}>
            <div style={railCard}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>筛选结论摘要</div>
              <div style={{display:"grid",gap:10}}>
                <div style={{fontSize:12,color:T.text2,lineHeight:1.75}}>当前建议：<strong style={{color:T.text}}>{scr.recommendation}</strong></div>
                {scr.matchedJobReason&&<div style={{fontSize:12,color:T.text3,lineHeight:1.75}}>{scr.matchedJobReason}</div>}
              </div>
            </div>
            {scr.risks?.length>0&&<div style={{...railCard,background:"#fffbeb",borderColor:"#fed7aa"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#92400e",letterSpacing:"0.08em",marginBottom:8}}>风险提示</div>
              <div style={{display:"grid",gap:6}}>
                {scr.risks.map((r,i)=><div key={i} style={{fontSize:12,color:"#78350f",lineHeight:1.75}}>• {r}</div>)}
              </div>
            </div>}
            <div style={railCard}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>快速操作</div>
              <button onClick={()=>{
                setErr("");
                setResumeFile(null);
                setResumeFileName(cand.resumeFileName||"");
                setInputMode(cand.resumeFileName?"file":"text");
                updCand(cand.id,{screening:null,questions:null});
              }} style={{width:"100%",padding:"11px 14px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:10,color:T.text3,cursor:"pointer",fontSize:12,fontWeight:700}}>重新筛选</button>
            </div>
          </div>
        </div>
      </div>
    </div>)}
  </div>);
}

// ─── QUESTION TAB ────────────────────────────────────────────
function QuestionTab({T,cand,job,cfg,updCand,recordTokens,dirCtx,learning,learningState,questionTask,startQuestionGeneration}) {
  const loading=!!questionTask?.loading;
  const err=questionTask?.error||"";
  const feedbackHistory = mergeQuestionFeedbackHistory(cand.questionFeedbackHistory, cand.questions || []);
  const workPanel={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:18,
    boxShadow:"0 14px 32px rgba(15,23,42,0.06)",
  };
  const workspaceShell={
    ...workPanel,
    padding:0,
    overflow:"hidden",
  };
  const workspaceRail={
    padding:"20px 18px 18px",
    background:"#fcfdff",
    borderLeft:`1px solid ${T.border}`,
    display:"grid",
    gap:16,
    alignContent:"start",
  };
  const railCard={
    padding:"14px 16px",
    background:"#ffffff",
    border:`1px solid ${T.border}`,
    borderRadius:16,
  };
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
  const questionCount = qs?.length || 0;
  const questionSteps = qs ? [...new Set(qs.map(q=>Number(q.step)||0))].sort((a,b)=>a-b) : [];
  const highValueCount = (qs||[]).filter(q=>q.feedbackTag==="high_value").length;
  const blockedCount = (feedbackHistory||[]).filter(item=>["duplicate","invalid","remove"].includes(item?.feedbackTag)).length;
  return(<div>
    {!qs?(<div>
      <div style={{...workPanel,padding:"18px 20px 16px",marginBottom:16}}>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.08fr) minmax(260px,0.92fr)",gap:16,alignItems:"start"}}>
          <div>
            <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>面试题工作台</div>
            <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.8,maxWidth:760}}>这里负责把岗位要求、简历锚点、历史反馈和题库偏好收成一套更具体的问题。系统会优先问真实经历、当前岗位最在意的能力，以及你上一轮反馈里觉得有价值的方向。</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
              <Chip c={loading?"#7c3aed":T.text3} bg={loading?"#f5f3ff":T.card2}>{loading?"后台生成中":"待生成题目"}</Chip>
              <Chip c={feedbackHistory.length?"#0f766e":T.text3} bg={feedbackHistory.length?"#ccfbf1":T.card2}>{feedbackHistory.length?`已有 ${feedbackHistory.length} 条反馈`:"暂无历史反馈"}</Chip>
            </div>
          </div>
          <div style={railCard}>
            <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>当前出题原则</div>
            <div style={{fontSize:12,color:T.text3,lineHeight:1.8}}>系统会优先绑定简历真实经历、当前岗位模板和你的历史反馈，避免泛泛问题、重复题和明显跑偏的提问。</div>
          </div>
        </div>
      </div>
      <div style={workspaceShell}>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.18fr) minmax(300px,0.82fr)",alignItems:"stretch"}}>
          <div style={{padding:"20px 22px 18px"}}>
            <div style={{fontSize:14,color:T.text2,fontWeight:800,marginBottom:8}}>准备生成这一轮面试题</div>
            <div style={{fontSize:13,color:T.text3,marginBottom:14,lineHeight:1.8}}>基于岗位要求和简历分析，AI 会生成结构化面试题，并补上考察目标、好/差回答、红旗回答与追问方向。</div>
            {err&&<ErrBox>{err}</ErrBox>}
            <BtnPrimary T={T} loading={loading} disabled={loading} onClick={gen}>{loading?<Spin text="生成中..."/>:"生成面试题 →"}</BtnPrimary>
          </div>
          <div style={workspaceRail}>
            {dirCtx&&<div style={{...railCard,background:`linear-gradient(180deg, ${T.surface} 0%, ${T.accent}10 100%)`}}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>历史判断标准</div>
              <div style={{fontSize:12,color:T.text2,lineHeight:1.8}}>已融入总监历史判断标准，面试题会更贴近你的用人偏好。</div>
            </div>}
            {learningState?.loading&&<div style={{...railCard,background:"#eff6ff"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#2563eb",letterSpacing:"0.08em",marginBottom:8}}>题库规则载入中</div>
              <div style={{fontSize:12,color:"#1d4ed8",lineHeight:1.8}}>正在加载该岗位最新规则与题库，当前先按岗位要求生成面试题。</div>
            </div>}
            {!learningState?.loading&&formatQuestionBankContext(learning)&&<div style={{...railCard,background:"#ecfeff"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#0f766e",letterSpacing:"0.08em",marginBottom:8}}>已加载题库偏好</div>
              <div style={{fontSize:12,color:"#115e59",lineHeight:1.8}}>已加载学习后的题库偏好，面试题会优先覆盖高区分度问题和风险排查。</div>
            </div>}
            {!!feedbackHistory.length&&<div style={{...railCard,background:"#f5f3ff"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#7c3aed",letterSpacing:"0.08em",marginBottom:8}}>上一轮题目反馈</div>
              <div style={{fontSize:12,color:"#6d28d9",lineHeight:1.8}}>重复/无效题会被避开，高价值题会优先保留相近问法。</div>
            </div>}
            {loading&&<div style={{...railCard,background:"#eef2ff"}}>
              <div style={{fontSize:10,fontWeight:800,color:"#4338ca",letterSpacing:"0.08em",marginBottom:8}}>后台生成中</div>
              <div style={{fontSize:12,color:"#4338ca",lineHeight:1.8}}>你现在切换到其他窗口也不会中断，回来后结果会自动保留。</div>
            </div>}
          </div>
        </div>
      </div>
    </div>):(<div>
      <div style={{...workPanel,padding:"18px 20px 16px",marginBottom:16}}>
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.08fr) minmax(260px,0.92fr)",gap:16,alignItems:"start"}}>
          <div>
            <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>本轮面试题总览</div>
            <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.8,maxWidth:760}}>题目会优先围绕岗位强匹配能力、候选人真实经历和历史反馈来出。你可以继续在下方逐题打标，系统会据此收敛下一轮问法。</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
              <Chip c="#1d4ed8" bg="#dbeafe">{`${questionCount} 道题`}</Chip>
              <Chip c="#0f766e" bg="#ccfbf1">{`${questionSteps.length} 个步骤`}</Chip>
              <Chip c={highValueCount?"#16a34a":T.text3} bg={highValueCount?"#dcfce7":T.card2}>{`高价值 ${highValueCount}`}</Chip>
              <Chip c={blockedCount?"#b45309":T.text3} bg={blockedCount?"#fef3c7":T.card2}>{`已避开 ${blockedCount}`}</Chip>
            </div>
          </div>
          <div style={railCard}>
            <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>当前生成口径</div>
            <div style={{fontSize:12,color:T.text3,lineHeight:1.8}}>当前题目会优先绑定简历锚点和岗位风险点。你后面标成重复、无效或高价值的反馈，会直接影响下一轮重生。</div>
          </div>
        </div>
      </div>

      {questionTask?.loading&&<div style={{fontSize:11,color:"#7c3aed",marginBottom:12,padding:"6px 10px",background:"#f5f3ff",borderRadius:6}}>✦ 正在后台重新生成面试题。你切换页面后任务仍会继续。</div>}
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.18fr) minmax(300px,0.82fr)",gap:16,alignItems:"start"}}>
        <div>
          {questionSteps.map(step=>{
        const sq=qs.map((q,index)=>({q,index})).filter(item=>item.q.step===step);
        return(<div key={step} style={{marginBottom:18}}>
          <div style={{fontSize:12,fontWeight:800,color:T.text2,padding:"9px 14px",background:"#f8fafc",borderRadius:10,marginBottom:10,border:`1px solid ${T.border}`,borderLeft:`4px solid ${T.accent}`,boxShadow:"0 6px 18px rgba(15,23,42,0.04)"}}>第{step}步 · {sq[0]?.q?.stepName}</div>
          {sq.map(({q,index})=><QCard key={`${step}-${index}`} T={T} q={q} sourceMeta={getQuestionBankSourceMeta(q, learning)} onFeedbackChange={patch=>updateQuestionFeedback(index,patch)}/>)}
        </div>);
      })}
          <button onClick={()=>updCand(cand.id,{
            questions:null,
            questionFeedbackHistory:mergeQuestionFeedbackHistory(cand.questionFeedbackHistory,cand.questions||[]),
          })} style={{padding:"7px 14px",background:"transparent",border:`1px solid ${T.border2}`,borderRadius:7,color:T.text3,cursor:"pointer",fontSize:12}}>重新生成</button>
        </div>

        <div style={workspaceRail}>
          <div style={railCard}>
            <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>使用说明</div>
            <div style={{fontSize:12,color:T.text3,lineHeight:1.8}}>面试后可直接给每道题打标：高价值 / 一般 / 重复 / 无效。系统后续会把这些反馈沉淀进岗位题库学习。</div>
          </div>
          {feedbackHistory.length>0&&<div style={railCard}>
            <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>候选人反馈快照</div>
            <div style={{display:"grid",gap:8,fontSize:12,color:T.text3,lineHeight:1.8}}>
              <div>累计反馈：{feedbackHistory.length} 条</div>
              <div>高价值：{feedbackHistory.filter(item=>item.feedbackTag==="high_value").length} 条</div>
              <div>重复 / 无效：{feedbackHistory.filter(item=>["duplicate","invalid","remove"].includes(item.feedbackTag)).length} 条</div>
            </div>
          </div>}
        </div>
      </div>
    </div>)}
  </div>);
}
function QCard({T,q,sourceMeta,onFeedbackChange}) {
  const [open,setOpen]=useState(false);
  const feedbackOption = getQuestionFeedbackOption(q.feedbackTag);
  const detailRows = [
    q.riskPoint && ["验证风险点","#9333ea","#faf5ff",q.riskPoint],
    ["考察目标","#374151","#f9fafb",q.purpose],
    ["好的回答","#16a34a","#f0fdf4",q.goodAnswer],
    ["一般回答","#ca8a04","#fefce8",q.okAnswer],
    ["差的回答","#dc2626","#fff5f5",q.badAnswer],
    q.redFlag&&["红旗回答","#7f1d1d","#fef2f2",q.redFlag],
    ["追问方向","#4f46e5","#eef2ff",q.followUp]
  ].filter(Boolean);
  return(<div style={{background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,border:`1px solid ${T.border}`,borderRadius:16,padding:16,marginBottom:10,boxShadow:"0 12px 28px rgba(15,23,42,0.06)"}}>
    <div style={{cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}} onClick={()=>setOpen(!open)}>
      <div style={{flex:1,marginRight:10}}>
        <div style={{display:"flex",gap:5,marginBottom:6,flexWrap:"wrap"}}>
          <Chip c={T.text2} bg={T.navActive}>{q.tag}</Chip>
          {q.subTag&&<Chip c={T.text3} bg={T.card2}>{q.subTag}</Chip>}
          {q.principle&&<Chip c="#7c3aed" bg="#f3e8ff">{q.principle}</Chip>}
          {sourceMeta&&<Chip c={sourceMeta.kind==="应少问/淘汰题"?"#b91c1c":"#1d4ed8"} bg={sourceMeta.kind==="应少问/淘汰题"?"#fee2e2":"#dbeafe"}>{`来源：${sourceMeta.kind}`}</Chip>}
          {feedbackOption&&<Chip c={feedbackOption.color} bg={feedbackOption.bg}>{feedbackOption.label}</Chip>}
        </div>
        <div style={{fontSize:15,color:T.text,fontWeight:700,lineHeight:1.6,letterSpacing:"-0.01em"}}>{q.question}</div>
        {q.resumeEvidence&&<div style={{fontSize:11,color:T.text4,marginTop:6,lineHeight:1.6}}>简历锚点：{q.resumeEvidence}</div>}
      </div>
      <span style={{fontSize:11,color:T.text4,flexShrink:0,paddingTop:2}}>{open?"▲":"▼"}</span>
    </div>
    {open&&<div style={{marginTop:13,paddingTop:13,borderTop:`1px solid ${T.border}`}}>
      {sourceMeta&&<div style={{padding:"7px 9px",borderRadius:6,background:sourceMeta.kind==="应少问/淘汰题"?"#fff5f5":"#eff6ff",marginBottom:8}}>
        <span style={{fontSize:10,fontWeight:700,color:sourceMeta.kind==="应少问/淘汰题"?"#b91c1c":"#1d4ed8",marginRight:6}}>题库来源</span>
        <span style={{fontSize:12,color:"#374151"}}>{sourceMeta.text}{sourceMeta.hint?` · ${sourceMeta.hint}`:""}</span>
      </div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(230px, 1fr))",gap:8}}>
        {detailRows.map(([l,c,bg,t])=>(
          <div key={l} style={{padding:"9px 10px",borderRadius:10,background:bg,border:"1px solid rgba(255,255,255,0.6)",minHeight:74}}>
            <div style={{fontSize:10,fontWeight:800,color:c,marginBottom:5}}>{l}</div>
            <div style={{fontSize:13,color:"#374151",lineHeight:1.65}}>{t}</div>
          </div>
        ))}
      </div>
      <div style={{marginTop:12,padding:"12px",borderTop:`1px dashed ${T.border}`,background:"#fbfcfe",borderRadius:12}}>
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
          style={{...inSt(T),resize:"vertical",lineHeight:1.6,fontSize:12,background:"#fff"}}
          placeholder="记录这道题为什么有效、重复，或需要怎样优化问法..."
        />
      </div>
    </div>}
  </div>);
}

// ─── INTERVIEW TAB ───────────────────────────────────────────
function InterviewTab({T,cand,job,allCandidates=[],cfg,updCand,recordTokens,dirCtx,interviewTask,startInterviewAssessment}) {
  const roundOptions = useMemo(()=>getInterviewRoundsForJob(job),[job?.id,job?.level,job?.title]);
  const [round,setRound]=useState(roundOptions[0] || "一面");
  const [notes,setNotes]=useState("");
  const [schedDate,setSchedDate]=useState("");
  const [schedTime,setSchedTime]=useState("10:00");
  const [interviewLocation,setInterviewLocation]=useState(cand.interviewLocation ?? "");
  const [interviewLink,setInterviewLink]=useState(cand.interviewLink ?? "");
  const [interviewNotes,setInterviewNotes]=useState(cand.interviewNotes ?? "");
  const [conflictWarning,setConflictWarning]=useState("");
  const [noteFile,setNoteFile]=useState(null);
  const [noteFileName,setNoteFileName]=useState("");
  const [noteDrag,setNoteDrag]=useState(false);
  const [fileLoading,setFileLoading]=useState(false);
  const [fileInfo,setFileInfo]=useState("");
  const [fileStage,setFileStage]=useState("idle");
  const [localErr,setLocalErr]=useState("");
  const loading=!!interviewTask?.loading;
  const err=interviewTask?.error||localErr||"";
  const rawErr=interviewTask?.raw||"";
  const dateInputRef=useRef(null);
  const timeInputRef=useRef(null);
  const prevInterviewCountRef=useRef((cand.interviews||[]).length);
  const currentFileKind=noteFile?getFileKind(noteFile):"unknown";
  const latestInterviewRecord=(cand.interviews||[]).slice(-1)[0] || null;
  const pad=n=>String(n).padStart(2,"0");
  const fmtYmd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const tomorrow=new Date(Date.now()+24*3600*1000);
  const dayAfter=new Date(Date.now()+48*3600*1000);
  const quickSlots=[
    {label:"明天上午 10:00",date:fmtYmd(tomorrow),time:"10:00"},
    {label:"明天下午 14:00",date:fmtYmd(tomorrow),time:"14:00"},
    {label:"后天上午 10:00",date:fmtYmd(dayAfter),time:"10:00"},
  ];
  const checkConflict=(date,time)=>{
    if(!date || !time) return "";
    const target=new Date(`${date}T${time}:00`).getTime();
    const conflicts=(allCandidates||[]).filter(c=>{
      if(c.id===cand.id || !c.scheduledAt) return false;
      const t=new Date(c.scheduledAt).getTime();
      return Math.abs(t-target)<=30*60*1000;
    });
    return conflicts.length
      ? `提示：${date} ${time} 前后 30 分钟已安排 ${conflicts.length} 个面试`
      : "";
  };
  const workPanel={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:18,
    boxShadow:"0 14px 32px rgba(15,23,42,0.06)",
  };
  const workspaceShell={
    ...workPanel,
    padding:0,
    overflow:"hidden",
  };
  const workspaceRail={
    padding:"20px 18px 18px",
    background:"#fcfdff",
    borderRight:`1px solid ${T.border}`,
    display:"grid",
    gap:16,
    alignContent:"start",
  };
  const railDivider={paddingTop:16,borderTop:`1px solid ${T.border}`};
  const fileStageMeta={
    idle:{label:"未上传",bg:T.card2,color:T.text4},
    queued:{label:"已选择",bg:"#eff6ff",color:"#2563eb"},
    processing:{label:currentFileKind==="audio"?"转写中":"识别中",bg:"#f5f3ff",color:"#7c3aed"},
    done:{label:"已追加",bg:"#ecfdf5",color:"#16a34a"},
    failed:{label:"失败",bg:"#fef2f2",color:"#dc2626"}
  }[fileStage] || {label:"未上传",bg:T.card2,color:T.text4};

  useEffect(()=>{
    const currentCount=(cand.interviews||[]).length;
    if(currentCount>prevInterviewCountRef.current){
      setNotes("");
      setRound(roundOptions[0] || "一面");
      setNoteFile(null);
      setNoteFileName("");
      setFileInfo("");
      setFileStage("idle");
      setLocalErr("");
    }
    prevInterviewCountRef.current=currentCount;
  },[cand.interviews,roundOptions]);

  useEffect(()=>{
    if(!roundOptions.includes(round)) setRound(roundOptions[0] || "一面");
  },[round,roundOptions]);

  useEffect(()=>{
    if(cand.scheduledAt){
      const [datePart="", timePart=""] = String(cand.scheduledAt).split("T");
      setSchedDate(datePart || "");
      setSchedTime((timePart || "").slice(0,5) || "10:00");
      setRound(cand.interviewRound || roundOptions[0] || "一面");
      setInterviewLocation(cand.interviewLocation ?? "");
      setInterviewLink(cand.interviewLink ?? "");
      setInterviewNotes(cand.interviewNotes ?? "");
      setConflictWarning("");
      return;
    }
    setSchedDate("");
    setSchedTime("10:00");
    setRound(cand.interviewRound || roundOptions[0] || "一面");
    setInterviewLocation(cand.interviewLocation ?? "");
    setInterviewLink(cand.interviewLink ?? "");
    setInterviewNotes(cand.interviewNotes ?? "");
    setConflictWarning("");
  },[cand.id,cand.scheduledAt,cand.interviewRound,cand.interviewLocation,cand.interviewLink,cand.interviewNotes,job?.id,job?.level,job?.title]);

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
    if(getFileKind(file)==="unknown"){setLocalErr("仅支持 PDF、图片、Word(.docx)、txt / md 或录音文件");return;}
    setNoteFile(file);
    setNoteFileName(file.name);
    setLocalErr("");
    setFileInfo("");
    setFileStage("queued");
  };

  const extractSelectedNoteFile=async()=>{
    if(!noteFile) return "";
    const extracted=normalizeExtractedText(
      getFileKind(noteFile)==="audio"
        ? await transcribeAudioFile(cfg, noteFile)
        : await extractFileText(noteFile)
    ).slice(0,20000);
    if(!extracted) throw new Error("未能从面试记录文件中提取到有效文字，请换一个更清晰的文件");
    return extracted;
  };

  const appendInterviewFile=async()=>{
    if(!noteFile){setLocalErr("请先上传面试记录文件");return;}
    setLocalErr("");
    setFileInfo("");
    setFileLoading(true);
    setFileStage("processing");
    try{
      const extracted=await extractSelectedNoteFile();
      const merged=notes.trim()
        ? `${notes.trim()}\n\n【上传文件：${noteFile.name}】\n${extracted}`
        : `【上传文件：${noteFile.name}】\n${extracted}`;
      setNotes(merged);
      setFileInfo(`已识别并追加：${noteFile.name}`);
      setFileStage("done");
    }catch(error){
      setLocalErr(error?.message||"面试记录文件识别失败");
      setFileStage("failed");
    }
    setFileLoading(false);
  };

  const saveSchedule=()=>{
    if(!schedDate)return;
    updCand(cand.id,{
      scheduledAt:`${schedDate}T${schedTime}:00`,
      interviewRound:round,
      interviewLocation:interviewLocation ?? null,
      interviewLink:interviewLink ?? null,
      interviewNotes:interviewNotes ?? null,
      status:"interview",
      statusSource:"system"
    });
  };
  const clearSchedule=()=>{
    const ok=window.confirm(`确认删除 ${cand.name||"该候选人"} 的面试预约时间吗？`);
    if(!ok) return;
    updCand(cand.id,{scheduledAt:null,interviewRound:null});
    setSchedDate("");
    setSchedTime("10:00");
    setRound(roundOptions[0] || "一面");
    setConflictWarning("");
  };

  const assess=async()=>{
    setLocalErr("");
    setFileInfo("");
    let finalNotes=notes.trim();
    if(noteFile && fileStage!=="done"){
      setFileLoading(true);
      setFileStage("processing");
      try{
        const extracted=await extractSelectedNoteFile();
        finalNotes=finalNotes
          ? `${finalNotes}\n\n【上传文件：${noteFile.name}】\n${extracted}`
          : `【上传文件：${noteFile.name}】\n${extracted}`;
        setNotes(finalNotes);
        setFileInfo(`已识别并用于评估：${noteFile.name}`);
        setFileStage("done");
      }catch(error){
        setLocalErr(error?.message||"面试记录文件识别失败");
        setFileStage("failed");
        setFileLoading(false);
        return;
      }
      setFileLoading(false);
    }
    if(!finalNotes.trim()){setLocalErr("请填写面试笔记，或上传一份面试记录文件");return;}
    startInterviewAssessment?.(cand,job,round,finalNotes);
  };

  return(<div>
    <div style={{...workPanel,padding:"18px 20px 16px",marginBottom:16}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.1fr) minmax(260px,0.9fr)",gap:16,alignItems:"start"}}>
        <div>
          <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>面试记录工作台</div>
          <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.8,maxWidth:720}}>左侧负责安排面试和补充文件，右侧专注记录真实面试笔记与综合评估。这样你在同一屏里就能完成预约、补充材料和最终回放。</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
            <Chip c={cand.scheduledAt?"#7c3aed":T.text3} bg={cand.scheduledAt?"#f5f3ff":T.card2}>
              {cand.scheduledAt?`已预约：${fmtDate(cand.scheduledAt)}`:"待安排面试时间"}
            </Chip>
            <Chip c={(cand.interviews||[]).length?"#059669":T.text3} bg={(cand.interviews||[]).length?"#ecfdf5":T.card2}>
              {`${(cand.interviews||[]).length} 轮面试记录`}
            </Chip>
            <Chip c={fileStageMeta.color} bg={fileStageMeta.bg}>
              {currentFileKind==="audio"&&fileStage!=="idle"?"录音材料":"面试材料"} · {fileStageMeta.label}
            </Chip>
          </div>
        </div>
        <div style={{padding:"14px 16px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:16}}>
          <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>最近一轮回放</div>
          {latestInterviewRecord?.assessment
            ?<>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:12,marginTop:10}}>
                <div style={{fontSize:16,fontWeight:900,color:T.text}}>{latestInterviewRecord.round}</div>
                <div style={{fontSize:26,fontWeight:950,color:scColor(latestInterviewRecord.assessment.score),lineHeight:1}}>{latestInterviewRecord.assessment.score?.toFixed(1)}</div>
              </div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.75,marginTop:8}}>{latestInterviewRecord.assessment.suggestion}</div>
            </>
            :<div style={{fontSize:12,color:T.text4,lineHeight:1.75,marginTop:10}}>还没有完成综合评估。先记录面试笔记，再让系统给出这一轮的判断。</div>}
        </div>
      </div>
    </div>
    {(cand.interviews||[]).length>0&&<div style={{marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:10}}>面试轨迹</div>
      {(cand.interviews||[]).map((ir,i)=><IRecord key={i} T={T} record={ir}/>)}
    </div>}
    <div style={{...workspaceShell,marginBottom:16}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(280px,360px) minmax(0,1fr)",alignItems:"stretch"}}>
        <div style={{...workspaceRail,minWidth:0}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:10}}>安排面试</div>
            <div style={{marginBottom:12}}>
              <SecLabel T={T}>快捷时段</SecLabel>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:6}}>
                {quickSlots.map((slot,idx)=>(
                  <button
                    key={idx}
                    type="button"
                    onClick={()=>{
                      setSchedDate(slot.date);
                      setSchedTime(slot.time);
                      setConflictWarning(checkConflict(slot.date,slot.time));
                    }}
                    style={{padding:"6px 12px",border:"1px solid #ddd",borderRadius:6,background:"#f8f9fa",cursor:"pointer",fontSize:13}}
                  >
                    {slot.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <div><label style={lbSt(T)}>面试轮次</label>
                <select value={round} onChange={e=>setRound(e.target.value)} style={{...inSt(T),background:"#fff"}}>
                  {roundOptions.map(r=><option key={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label style={lbSt(T)}>面试日期</label>
                <div style={{display:"flex",gap:8}}>
                  <input ref={dateInputRef} type="date" value={schedDate} onChange={e=>{const nextDate=e.target.value;setSchedDate(nextDate);setConflictWarning(checkConflict(nextDate,schedTime));}} style={{...inSt(T),flex:1,background:"#fff"}}/>
                  <button type="button" onClick={()=>openPicker(dateInputRef)} style={{padding:"0 12px",border:`1px solid ${T.border2}`,borderRadius:10,background:"#fff",color:T.text2,cursor:"pointer",fontSize:16}}>📅</button>
                </div>
              </div>
              <div>
                <label style={lbSt(T)}>面试时间</label>
                <div style={{display:"flex",gap:8}}>
                  <input ref={timeInputRef} type="time" value={schedTime} onChange={e=>{const nextTime=e.target.value;setSchedTime(nextTime);setConflictWarning(checkConflict(schedDate,nextTime));}} style={{...inSt(T),flex:1,background:"#fff"}}/>
                  <button type="button" onClick={()=>openPicker(timeInputRef)} style={{padding:"0 12px",border:`1px solid ${T.border2}`,borderRadius:10,background:"#fff",color:T.text2,cursor:"pointer",fontSize:15}}>🕒</button>
                </div>
              </div>
              <div style={{display:"grid",gap:8,alignContent:"end"}}>
                {conflictWarning&&<div style={{padding:"8px 12px",background:"#fff3cd",border:"1px solid #ffc107",borderRadius:6,fontSize:13,color:"#856404",marginBottom:8}}>
                  {conflictWarning}
                </div>}
                <button onClick={saveSchedule} disabled={!schedDate}
                  style={{padding:"10px 16px",background:schedDate?T.accent:"#e5e7eb",color:schedDate?T.accentFg:T.text4,border:"none",borderRadius:10,cursor:schedDate?"pointer":"not-allowed",fontSize:12,fontWeight:800,whiteSpace:"nowrap"}}>
                  {cand.scheduledAt?"更新预约":"确认预约"}
                </button>
                {cand.scheduledAt&&<button
                  onClick={clearSchedule}
                  style={{padding:"10px 14px",background:"#fff5f5",color:"#dc2626",border:"1px solid #fecaca",borderRadius:10,cursor:"pointer",fontSize:12,fontWeight:800,whiteSpace:"nowrap"}}
                >
                  删除预约
                </button>}
              </div>
            </div>
            <div style={{marginTop:16,paddingTop:16,borderTop:"1px solid #eee"}}>
              <div style={{marginBottom:10}}>
                <SecLabel T={T}>面试地点</SecLabel>
                <Inp T={T} value={interviewLocation} onChange={e=>setInterviewLocation(e.target.value)} placeholder="如：会议室A / 线上 / 公司前台" />
              </div>
              <div style={{marginBottom:10}}>
                <SecLabel T={T}>会议链接</SecLabel>
                <Inp T={T} value={interviewLink} onChange={e=>setInterviewLink(e.target.value)} placeholder="飞书/腾讯会议链接（可选）" />
              </div>
              <div>
                <SecLabel T={T}>备注</SecLabel>
                <textarea value={interviewNotes} onChange={e=>setInterviewNotes(e.target.value)} placeholder="给候选人的注意事项、自我介绍重点等" rows={3} style={{...inSt(T),resize:"vertical",fontFamily:"inherit"}} />
              </div>
            </div>
            {isSingleRoundLevel(job?.level)&&<div style={{marginTop:12,fontSize:12,color:T.text3,lineHeight:1.75,padding:"10px 12px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:12}}>
              当前岗位职级为 <strong style={{color:T.text}}>{job?.level||"专员/组长/主管"}</strong>，默认只安排一面；一面通过后直接进入最终判断，不再默认进入二面。
            </div>}
            {cand.scheduledAt&&<div style={{marginTop:12,fontSize:13,color:"#7c3aed",fontWeight:700}}>✓ 已预约：{cand.interviewRound} · {fmtDate(cand.scheduledAt)}{(cand.interviewLocation ?? "")?` · 📍 ${cand.interviewLocation ?? ""}`:""}</div>}
          </div>

          <div style={railDivider}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:12,flexWrap:"wrap"}}>
              <div>
                <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:6}}>面试材料</div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.75}}>支持 PDF、图片、Word、txt / md 和录音。材料和文字笔记属于同一份面试反馈，任选其一即可评估。</div>
              </div>
              {fileStage!=="idle"&&<span style={{padding:"5px 10px",borderRadius:999,fontSize:11,fontWeight:700,background:fileStageMeta.bg,color:fileStageMeta.color}}>{fileStageMeta.label}</span>}
            </div>
            <div
              onDragOver={e=>{e.preventDefault();setNoteDrag(true);}}
              onDragLeave={()=>setNoteDrag(false)}
              onDrop={e=>{e.preventDefault();setNoteDrag(false);queueNoteFile(e.dataTransfer.files?.[0]);}}
              onClick={()=>!fileLoading&&document.getElementById(`interview-file-input-${cand.id}`)?.click()}
              style={{border:`2px dashed ${noteDrag?T.accent:T.border2}`,borderRadius:14,padding:"22px 16px",textAlign:"center",cursor:fileLoading?"default":"pointer",background:noteDrag?`${T.accent}10`:"#ffffff",transition:"all 0.15s",marginBottom:12}}>
              <input id={`interview-file-input-${cand.id}`} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.txt,.md,.markdown,.mp3,.m4a,.wav,.aac,.ogg,.oga,.webm,.mp4,audio/*" style={{display:"none"}} onChange={e=>{queueNoteFile(e.target.files?.[0]);e.target.value="";}}/>
              {fileLoading
                ?<div><Spin text={currentFileKind==="audio"?"正在转写录音文件...":"正在识别面试记录文件..."} /><div style={{fontSize:11,color:T.text4,marginTop:6}}>识别完成后会自动追加到右侧笔记</div></div>
                :noteFileName
                  ?<div><div style={{fontSize:13,fontWeight:700,color:"#16a34a"}}>已选择：{noteFileName}</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>点击下方按钮即可识别并追加到笔记</div></div>
                  :<div><div style={{fontSize:13,fontWeight:700,color:T.text}}>拖入面试记录文件，或点击上传</div><div style={{fontSize:11,color:T.text4,marginTop:4}}>适合上传面评表、会议纪要、txt / md 文本、录音与语音转写稿</div></div>}
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <div style={{fontSize:11,color:T.text4,lineHeight:1.7}}>{fileInfo||"可先追加到笔记，也可以直接点击右侧 AI 评估"}</div>
              <button onClick={appendInterviewFile} disabled={fileLoading||!noteFile} style={{padding:"9px 12px",background:fileLoading||!noteFile?"#e5e7eb":T.accent,color:fileLoading||!noteFile?T.text4:T.accentFg,border:"none",borderRadius:10,cursor:fileLoading||!noteFile?"not-allowed":"pointer",fontSize:12,fontWeight:800}}>
                {fileLoading?"识别中...":"识别并追加到笔记"}
              </button>
            </div>
          </div>
        </div>

        <div style={{padding:"20px 22px 18px",minWidth:0}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:14}}>
            <div>
              <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>面试笔记与综合评估</div>
              <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.75,maxWidth:760}}>把人工笔记、补充材料和历史判断标准收进一处，当前页就能完成这一轮评估，不用再在多个卡片之间来回跳转。</div>
            </div>
            {loading&&<span style={{fontSize:11,color:"#2563eb",padding:"5px 10px",background:"#eff6ff",borderRadius:999,fontWeight:700}}>后台评估运行中</span>}
          </div>
          <div style={{display:"grid",gap:14,alignItems:"start",marginBottom:12}}>
            <div>
              <label style={lbSt(T)}>面试反馈 *</label>
              <textarea rows={15} value={notes} onChange={e=>setNotes(e.target.value)} style={{...inSt(T),resize:"vertical",lineHeight:1.8,background:"#fff"}}
                placeholder={"记录候选人表现、回答要点、你的观察...\n例：\n- 自我介绍流畅，突出5年短视频经验\n- 团队协作举了具体项目，数据清晰（粉丝增长40%）\n- 离职原因：想要更大平台\n- 薪资期望20K，目前18K，有弹性"}/>
            </div>
            <div style={{padding:"12px 14px",background:"#fbfcfe",border:`1px solid ${T.border}`,borderRadius:14}}>
              <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) minmax(160px,auto)",gap:12,alignItems:"center"}}>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.75}}>优先记录候选人真实做过的事、你追问后的反应，以及现场最打动或最让你警惕的点。</div>
                <div style={{display:"grid",gap:8}}>
                  {dirCtx&&<div style={{fontSize:12,color:T.accent,lineHeight:1.75,padding:"8px 10px",background:`${T.accent}10`,borderRadius:10}}>AI 将参考你的历史判断标准。</div>}
                  {loading&&<div style={{fontSize:12,color:"#2563eb",lineHeight:1.75,padding:"8px 10px",background:"#eff6ff",borderRadius:10}}>后台评估中，切换窗口不会中断。</div>}
                  {!notes.trim()&&noteFile&&fileStage!=="done"&&<div style={{fontSize:12,color:"#7c3aed",lineHeight:1.75,padding:"8px 10px",background:"#f5f3ff",borderRadius:10}}>当前将先识别已选文件，再进行 AI 评估。</div>}
                </div>
              </div>
            </div>
          </div>
          {err&&<ErrBox>{err}</ErrBox>}
          {!!rawErr&&<details style={{marginBottom:10}}>
            <summary style={{fontSize:11,color:T.text4,cursor:"pointer"}}>查看模型原始返回</summary>
            <pre style={{marginTop:8,padding:"10px 12px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:8,fontSize:11,color:T.text2,whiteSpace:"pre-wrap",wordBreak:"break-word",lineHeight:1.6,maxHeight:220,overflow:"auto"}}>{rawErr}</pre>
          </details>}
          <BtnPrimary T={T} loading={loading||fileLoading} disabled={loading||fileLoading||(!notes.trim()&&!noteFile)} onClick={assess}>{loading?<Spin text="AI 三源综合评估中..."/>:fileLoading?<Spin text="文件识别中..."/>:!notes.trim()&&noteFile?`识别文件并进行 ${round}评估 →`:`AI ${round}综合评估 →`}</BtnPrimary>
        </div>
      </div>
    </div>
  </div>);
}
function IRecord({T,record}) {
  const [open,setOpen]=useState(true);
  const ast=record.assessment;
  const dc=ast?.decision==="通过"?{c:"#16a34a",bg:"#dcfce7"}:ast?.decision==="淘汰"?{c:"#dc2626",bg:"#fee2e2"}:{c:"#ca8a04",bg:"#fef9c3"};
  const panel={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:18,
    boxShadow:"0 14px 32px rgba(15,23,42,0.06)",
    overflow:"hidden",
  };
  const statBlock=(label,value,tone=dc.c,bg=T.card2)=>(
    <div style={{padding:"12px 13px",borderRadius:14,background:bg,border:`1px solid ${T.border}`}}>
      <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:6}}>{label}</div>
      <div style={{fontSize:20,fontWeight:900,color:tone,lineHeight:1.15}}>{value}</div>
    </div>
  );
  return(<div style={{...panel,marginBottom:16}}>
    <div style={{padding:"18px 20px 16px",display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:16,alignItems:"center",cursor:"pointer"}} onClick={()=>setOpen(!open)}>
      <div>
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:8}}>
          <Chip c={dc.c} bg={dc.bg}>{record.round}</Chip>
          <span style={{fontSize:12,color:T.text4,fontWeight:600}}>{record.date}</span>
          {ast&&<Chip c={dc.c} bg={dc.bg}>{ast.decision}</Chip>}
        </div>
        <div style={{fontSize:15,fontWeight:850,color:T.text,letterSpacing:"-0.02em",lineHeight:1.45}}>
          {ast?.suggestion || "等待综合评估结论"}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:16}}>
        {ast&&<div style={{textAlign:"right"}}>
          <div style={{fontSize:11,color:T.text4,marginBottom:4}}>综合评分</div>
          <div style={{fontSize:30,fontWeight:950,color:scColor(ast.score),lineHeight:1}}>{ast.score?.toFixed(1)}</div>
          <div style={{fontSize:11,color:T.text4,marginTop:4}}>/ 5.0</div>
        </div>}
        <span style={{fontSize:16,color:T.text4}}>{open?"▾":"▸"}</span>
      </div>
    </div>
    {open&&ast&&<div style={{padding:"0 20px 20px",display:"grid",gap:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
        {statBlock("JD 匹配",ast.jdMatch||"待确认",dc.c,dc.bg)}
        {ast.emotions?.stabilityRisk && statBlock("稳定性",ast.emotions.stabilityRisk,ast.emotions.stabilityRisk==="低"?"#16a34a":ast.emotions.stabilityRisk==="高"?"#dc2626":"#ca8a04")}
        {ast.emotions?.managementDifficulty && statBlock("管理难度",ast.emotions.managementDifficulty,ast.emotions.managementDifficulty==="低"?"#16a34a":ast.emotions.managementDifficulty==="高"?"#dc2626":"#ca8a04")}
      </div>

      {ast.dimensions?.length>0&&<div style={{padding:"16px 18px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:12,flexWrap:"wrap"}}>
          <div style={{fontSize:13,fontWeight:800,color:T.text,letterSpacing:"0.04em"}}>维度回放</div>
          <div style={{fontSize:11,color:T.text4}}>把每个维度拆开看，方便快速回忆这一轮到底凭什么通过或卡住。</div>
        </div>
        <div style={{display:"grid",gap:12}}>
          {ast.dimensions.map((d,i)=>(<div key={i} style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:12,alignItems:"start",paddingBottom:12,borderBottom:i===ast.dimensions.length-1?"none":`1px solid ${T.border}`}}>
            <div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:6}}>
                <span style={{fontSize:13,fontWeight:800,color:T.text}}>{d.name}</span>
                {d.vsResume&&<Chip c={d.vsResume==="一致"?"#16a34a":d.vsResume==="存疑"?"#ca8a04":"#dc2626"} bg={d.vsResume==="一致"?"#dcfce7":d.vsResume==="存疑"?"#fef9c3":"#fee2e2"}>vs简历:{d.vsResume}</Chip>}
              </div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.75}}>{d.note}</div>
            </div>
            <div style={{minWidth:120}}>
              <div style={{fontSize:18,fontWeight:900,color:scColor(d.score,d.maxScore||5),textAlign:"right"}}>{d.score}/{d.maxScore||5}</div>
              <MiniBar score={d.score} max={d.maxScore||5} color={scColor(d.score,d.maxScore||5)}/>
            </div>
          </div>))}
        </div>
      </div>}

      {(ast.highlights?.length>0 || ast.concerns?.length>0 || ast.interviewerReview)&&<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:12}}>
        {ast.highlights?.length>0&&<div style={{padding:"14px 16px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:16}}>
          <div style={{fontSize:12,fontWeight:800,color:"#166534",letterSpacing:"0.04em",marginBottom:8}}>亮点</div>
          <div style={{display:"grid",gap:6}}>
            {ast.highlights.map((h,i)=><div key={i} style={{fontSize:12,color:"#14532d",lineHeight:1.75}}>✓ {h}</div>)}
          </div>
        </div>}
        {ast.concerns?.length>0&&<div style={{padding:"14px 16px",background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:16}}>
          <div style={{fontSize:12,fontWeight:800,color:"#9a3412",letterSpacing:"0.04em",marginBottom:8}}>顾虑</div>
          <div style={{display:"grid",gap:6}}>
            {ast.concerns.map((c,i)=><div key={i} style={{fontSize:12,color:"#9a3412",lineHeight:1.75}}>• {c}</div>)}
          </div>
        </div>}
        {ast.interviewerReview&&<div style={{padding:"14px 16px",background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:16}}>
          <div style={{fontSize:12,fontWeight:800,color:"#1d4ed8",letterSpacing:"0.04em",marginBottom:8}}>面试官复盘</div>
          <div style={{fontSize:12,color:"#1e3a8a",lineHeight:1.8}}>{ast.interviewerReview}</div>
        </div>}
      </div>}

      {ast.emotions&&<div style={{padding:"14px 16px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:16}}>
        <div style={{fontSize:12,fontWeight:800,color:T.text,letterSpacing:"0.04em",marginBottom:10}}>真实动机与管理判断</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12}}>
          <div style={{fontSize:12,color:T.text2,lineHeight:1.8}}><span style={{color:T.text4}}>真实动机：</span>{ast.emotions.trueMotivation}</div>
          <div style={{fontSize:12,color:T.text2,lineHeight:1.8}}><span style={{color:T.text4}}>诉求优先：</span>{ast.emotions.needsPriority}</div>
          <div style={{fontSize:12,color:T.text2,lineHeight:1.8}}><span style={{color:T.text4}}>稳定性说明：</span>{ast.emotions.stabilityNote||"未补充"}</div>
          <div style={{fontSize:12,color:T.text2,lineHeight:1.8}}><span style={{color:T.text4}}>管理难度说明：</span>{ast.emotions.managementNote||"未补充"}</div>
        </div>
      </div>}

      <details>
        <summary style={{fontSize:11,color:T.text4,cursor:"pointer",fontWeight:700,letterSpacing:"0.04em"}}>查看笔记原文</summary>
        <div style={{fontSize:12,color:T.text3,padding:"12px 14px",background:T.card2,borderRadius:12,marginTop:8,whiteSpace:"pre-wrap",lineHeight:1.8,border:`1px solid ${T.border}`}}>{record.notes}</div>
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
    <div style={{background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,border:`1px solid ${T.border}`,borderRadius:18,boxShadow:"0 14px 32px rgba(15,23,42,0.06)",padding:"18px 20px",marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginBottom:14,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:16,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>题库优化面板</div>
          {learning?.questionBankSummary&&<div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.75,maxWidth:760}}>{learning.questionBankSummary}</div>}
        </div>
        {learning?.questionBankVersion&&<Chip c="#7c3aed" bg="#f5f3ff">题库 v{learning.questionBankVersion}</Chip>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:12}}>
        {sections.map(([key,label,fmtItem])=>{
          const items = Array.isArray(bank?.[key]) ? bank[key].slice(0,4) : [];
          if (!items.length) return null;
          return (
            <div key={key} style={{padding:"14px 16px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:16}}>
              <div style={{fontSize:12,fontWeight:800,color:T.text,letterSpacing:"0.04em",marginBottom:10}}>{label}</div>
              <div style={{display:"grid",gap:8}}>
                {items.map((item,index)=>(
                  <div key={index} style={{fontSize:12,color:T.text2,lineHeight:1.75,paddingBottom:10,borderBottom:index===items.length-1?"none":`1px solid ${T.border}`}}>
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

const buildVerdictGapAnalysis = cand => {
  const aiRec = getFinalAiRecommendation(cand);
  const screeningRec = cand.screening?.recommendation || "";
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
        screeningRec && screeningRec !== aiRec ? `简历初筛建议：${screeningRec}` : "",
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
      screeningRec && screeningRec !== aiRec ? `简历初筛建议：${screeningRec}` : "",
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
  const aiRec=getFinalAiRecommendation(cand);
  const screeningRec=cand.screening?.recommendation||"";
  const gapAnalysis=saved?buildVerdictGapAnalysis(cand):null;
  const match=!!gapAnalysis?.same;

  const save=async()=>{
    if(!verdict||!reason.trim())return;
    setSaving(true);
    setLearningMsg("正在保存判断并沉淀学习样本...");
    updCand(cand.id,{
      directorVerdict:{verdict,reason,date:new Date().toLocaleDateString("zh-CN"),aiRec},
      status:verdict==="录用"?"offer":verdict==="淘汰"?"rejected":cand.status,
      statusSource:"system"
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

  const panel={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:18,
    boxShadow:"0 14px 32px rgba(15,23,42,0.06)",
  };
  const decisionShell={
    ...panel,
    padding:0,
    overflow:"hidden",
  };

  return(<div>
    <div style={{...panel,padding:"18px 20px 16px",marginBottom:16}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.12fr) minmax(280px,0.88fr)",gap:16,alignItems:"start"}}>
        <div>
          <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>最终决策台</div>
          <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.8,maxWidth:760}}>这里不是简单给结论，而是把你真正的判断依据沉淀成可学习规则。AI 录用建议只做参考，最终结果始终以面试官或总监判断为准。</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
            <Chip c={recSt(aiRec).c} bg={recSt(aiRec).bg}>{`AI建议：${aiRec||"未评估"}`}</Chip>
            <Chip c={saved?(verdict==="录用"?"#059669":verdict==="淘汰"?"#dc2626":"#ca8a04"):T.text4} bg={saved?(verdict==="录用"?"#ecfdf5":verdict==="淘汰"?"#fef2f2":"#fffbeb"):T.card2}>
              {saved?`人工最终：${verdict}`:"等待人工判断"}
            </Chip>
            {gapAnalysis&&<Chip c={match?"#059669":"#c2410c"} bg={match?"#ecfdf5":"#fff7ed"}>{match?"AI 与人工一致":"AI 与人工有分歧"}</Chip>}
          </div>
        </div>
        <div style={{padding:"14px 16px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:16}}>
          <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>学习沉淀</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:10,marginTop:10}}>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>样本数</div>
              <div style={{fontSize:18,fontWeight:900,color:T.text,marginTop:6}}>{Number(learning?.sampleCount)||0}</div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>规则版本</div>
              <div style={{fontSize:18,fontWeight:900,color:"#059669",marginTop:6}}>{learning?.rubricVersion||"—"}</div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>题库版本</div>
              <div style={{fontSize:18,fontWeight:900,color:"#7c3aed",marginTop:6}}>{learning?.questionBankVersion||"—"}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div style={{...decisionShell,marginBottom:16}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.12fr) minmax(320px,0.88fr)",alignItems:"stretch"}}>
        <div style={{padding:"22px 24px 20px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,marginBottom:16,flexWrap:"wrap"}}>
            <div>
              <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>{saved?"更新我的判断":"填写我的判断"}</div>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.8,marginTop:6,maxWidth:620}}>最终结果以面试官/总监判断为准。这里不是简单给结论，而是把你真正的判断依据沉淀成规则样本，反过来校正后续的 AI 录用建议。</div>
            </div>
            {saved&&<Chip c="#059669" bg="#ecfdf5">已保存于 {dir.date}</Chip>}
          </div>

          <div style={{padding:"14px 16px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:16,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:8}}>最终决定</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4, minmax(0, 1fr))",gap:10}}>
              {[["录用","#059669","#ecfdf5"],["通过","#2563eb","#eff6ff"],["待定","#ca8a04","#fef9c3"],["淘汰","#dc2626","#fef2f2"]].map(([v,c,bg])=>(
                <div key={v} onClick={()=>setVerdict(v)}
                  style={{padding:"13px 10px",textAlign:"center",borderRadius:14,border:`2px solid ${verdict===v?c:T.border}`,cursor:"pointer",background:verdict===v?bg:"#ffffff",fontWeight:850,fontSize:13,color:verdict===v?c:T.text3,transition:"all 0.1s"}}>
                  {v}
                </div>
              ))}
            </div>
          </div>

          <div style={{padding:"14px 16px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:16}}>
            <label style={{...lbSt(T),marginBottom:8}}>我的点评（这将成为 AI 的学习参考）</label>
            <textarea rows={9} value={reason} onChange={e=>setReason(e.target.value)} style={{...inSt(T),resize:"vertical",lineHeight:1.9}}
              placeholder={"请写出你真正的判断依据。\n建议至少覆盖：\n· 为什么录用/淘汰/待定\n· 现场最打动你的地方\n· 你最不放心的风险点\n· 如果推进，下一步要继续验证什么"} />
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,marginTop:12,flexWrap:"wrap"}}>
              <div style={{fontSize:12,color:T.text4,lineHeight:1.75}}>这段文字会被保存成学习样本，用来校正后续的 AI 录用建议和题库走向。</div>
              <BtnPrimary T={T} onClick={save} disabled={saving||!verdict||!reason.trim()}>
                {saving?<Spin text="沉淀学习中..."/>:(saved?"更新判断":"保存判断 · 沉淀为AI参考")}
              </BtnPrimary>
            </div>
          </div>
        </div>

        <div style={{padding:"22px 20px 20px",background:"#fcfdff",borderLeft:`1px solid ${T.border}`,display:"grid",gap:16,alignContent:"start"}}>
          <div>
            <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:10}}>AI 对照</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <div style={{padding:"16px 14px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:16,textAlign:"center"}}>
                <div style={{fontSize:11,color:T.text4,marginBottom:6}}>AI 录用建议</div>
                <div style={{fontSize:18,fontWeight:800,color:recSt(aiRec).c}}>{aiRec||"未评估"}</div>
                <div style={{fontSize:34,fontWeight:950,color:scColor(cand.screening?.overallScore),marginTop:10,lineHeight:1}}>{cand.screening?.overallScore?.toFixed(1)||"—"}</div>
                <div style={{fontSize:11,color:T.text4,marginTop:4}}>/ 5.0</div>
                {screeningRec && screeningRec!==aiRec && <div style={{fontSize:11,color:T.text4,marginTop:8}}>简历初筛：{screeningRec}</div>}
              </div>
              <div style={{padding:"16px 14px",background:"#ffffff",borderRadius:16,textAlign:"center",border:`2px solid ${saved?(verdict==="录用"?"#059669":verdict==="淘汰"?"#dc2626":"#ca8a04"):T.border}`}}>
                <div style={{fontSize:11,color:T.text4,marginBottom:6}}>最终结果（面试官/总监）</div>
                {saved?<div style={{fontSize:18,fontWeight:800,color:verdict==="录用"?"#059669":verdict==="淘汰"?"#dc2626":"#ca8a04"}}>{verdict}</div>:<div style={{fontSize:13,color:T.text4}}>待填写</div>}
                {saved&&aiRec&&<div style={{marginTop:10,fontSize:12,fontWeight:800,color:match?"#16a34a":"#dc2626"}}>{match?"✓ 判断一致":"✗ 以人工判断为准"}</div>}
              </div>
            </div>
            {gapAnalysis&&<div style={{marginTop:14,padding:"14px 16px",background:match?"#f0fdf4":"#fff7ed",borderRadius:16,border:`1px solid ${match?"#bbf7d0":"#fed7aa"}`}}>
              <div style={{fontSize:12,fontWeight:800,color:match?"#166534":"#9a3412",letterSpacing:"0.04em",marginBottom:6}}>{gapAnalysis.title}</div>
              <div style={{fontSize:12,color:T.text2,lineHeight:1.85}}>{gapAnalysis.summary}</div>
              {gapAnalysis.reasons?.length>0&&<div style={{marginTop:10,display:"grid",gap:6}}>
                {gapAnalysis.reasons.map((item,index)=><div key={index} style={{fontSize:12,color:T.text2,lineHeight:1.75}}>• {item}</div>)}
              </div>}
            </div>}
          </div>

          <div style={{paddingTop:16,borderTop:`1px solid ${T.border}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",marginBottom:10}}>
              <div>
                <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:6}}>学习沉淀</div>
                <div style={{fontSize:12,color:T.text4,lineHeight:1.75}}>
                  当前岗位已沉淀 {Number(learning?.sampleCount)||0} 条样本
                  {learning?.rubricVersion?` · 规则 v${learning.rubricVersion}`:" · 暂无规则版本"}
                  {learning?.questionBankVersion?` · 题库 v${learning.questionBankVersion}`:" · 暂无题库版本"}
                </div>
              </div>
              {learningState?.loading&&<Chip c="#2563eb" bg="#eff6ff">学习数据加载中</Chip>}
              {!learningState?.loading&&learning?.rubricVersion&&<Chip c="#059669" bg="#ecfdf5">已启用学习规则</Chip>}
            </div>
            {learningMsg&&<div style={{fontSize:12,color:T.text3,lineHeight:1.75,marginBottom:10}}>{learningMsg}</div>}
            <div style={{padding:"14px 16px",background:"#ffffff",borderRadius:16,border:`1px solid ${T.border}`}}>
              <div style={{fontSize:12,color:T.text3,lineHeight:1.85}}>
                <strong style={{color:T.text}}>如何让 AI 越来越懂你：</strong><br/>
                积累 <strong style={{color:T.accent}}>10 个以上</strong> 案例后，AI 对你用人偏好的理解会明显提升。和 AI 意见不一致的案例价值最高。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <QuestionBankPanel T={T} learning={learning}/>
  </div>);
}

// ─── RESULT TAB ──────────────────────────────────────────────
function ResultTab({T,cand}) {
  const ivs=(cand.interviews||[]).filter(i=>i.assessment);
  if(!ivs.length) return <Empty T={T} icon="◎" title="暂无评估结果" sub="完成面试记录并进行AI评估后显示"/>;
  const lat=ivs[ivs.length-1];
  const aiRec=getFinalAiRecommendation(cand);
  const aiTone=getAiVerdictTone(aiRec);
  const aiChip=aiTone==="positive"?{c:"#16a34a",bg:"#dcfce7"}:aiTone==="negative"?{c:"#dc2626",bg:"#fee2e2"}:{c:"#ca8a04",bg:"#fef9c3"};
  const humanVerdict=cand.directorVerdict?.verdict||"";
  const humanTone=getHumanVerdictTone(humanVerdict);
  const humanChip=humanTone==="positive"?{c:"#16a34a",bg:"#dcfce7"}:humanTone==="negative"?{c:"#dc2626",bg:"#fee2e2"}:humanTone==="neutral"?{c:"#ca8a04",bg:"#fef9c3"}:{c:T.text4,bg:T.card2};
  const gapAnalysis=buildVerdictGapAnalysis({
    ...cand,
    screening:{...(cand.screening||{}),recommendation:aiRec}
  });
  const panel={
    background:`linear-gradient(180deg, #ffffff 0%, ${T.surface} 100%)`,
    border:`1px solid ${T.border}`,
    borderRadius:18,
    boxShadow:"0 14px 32px rgba(15,23,42,0.06)",
  };
  const resultShell={
    ...panel,
    padding:0,
    overflow:"hidden",
  };
  return(<div>
    <div style={{...panel,padding:"18px 20px 16px",marginBottom:16}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.14fr) minmax(280px,0.86fr)",gap:16,alignItems:"start"}}>
        <div>
          <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>评估结果总览</div>
          <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.8,maxWidth:760}}>这里把面试评估、人工最终结论和判断分歧收在一处。你可以先看最终是否推进，再回看每轮为什么会通过、待定或淘汰。</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:12}}>
            <Chip c={aiChip.c} bg={aiChip.bg}>{`AI建议：${aiRec}`}</Chip>
            <Chip c={humanVerdict?humanChip.c:T.text4} bg={humanVerdict?humanChip.bg:T.card2}>
              {humanVerdict?`人工最终：${humanVerdict}`:"等待人工判断"}
            </Chip>
            <Chip c={gapAnalysis?(gapAnalysis.same?"#059669":"#c2410c"):T.text4} bg={gapAnalysis?(gapAnalysis.same?"#ecfdf5":"#fff7ed"):T.card2}>
              {gapAnalysis?(gapAnalysis.same?"判断一致":"判断不一致"):"等待分歧分析"}
            </Chip>
          </div>
        </div>
        <div style={{padding:"14px 16px",background:"#ffffff",border:`1px solid ${T.border}`,borderRadius:16}}>
          <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>轮次摘要</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:10,marginTop:10}}>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>已完成面试</div>
              <div style={{fontSize:18,fontWeight:900,color:T.text,marginTop:6}}>{ivs.length}</div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>最新评分</div>
              <div style={{fontSize:18,fontWeight:900,color:scColor(lat.assessment.score),marginTop:6}}>{lat.assessment.score?.toFixed(1)}</div>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em"}}>当前结论</div>
              <div style={{fontSize:18,fontWeight:900,color:humanVerdict?humanChip.c:aiChip.c,marginTop:6}}>{humanVerdict||aiRec}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div style={{...resultShell,marginBottom:16}}>
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.18fr) minmax(320px,0.82fr)",alignItems:"stretch"}}>
        <div style={{padding:"22px 24px 20px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,flexWrap:"wrap",marginBottom:14}}>
            <div>
              <div style={{fontSize:17,fontWeight:900,color:T.text,letterSpacing:"-0.02em"}}>最终结论与推进建议</div>
              <div style={{fontSize:12,color:T.text4,marginTop:6,lineHeight:1.75}}>完成 {ivs.length} 轮面试后，把 AI 建议、人工最终判断和当下建议动作收在一处。先看这次要不要推进，再回头复盘每轮为什么会通过、待定或淘汰。</div>
            </div>
            <div style={{padding:"12px 14px",borderRadius:16,background:T.card2,border:`1px solid ${T.border}`,minWidth:180}}>
              <div style={{fontSize:10,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:6}}>AI 最终评分</div>
              <div style={{fontSize:34,fontWeight:950,color:scColor(lat.assessment.score),lineHeight:1}}>{lat.assessment.score?.toFixed(1)}</div>
              <div style={{fontSize:11,color:T.text4,marginTop:4}}>/ 5.0</div>
            </div>
          </div>
          <div style={{fontSize:13,color:T.text2,lineHeight:1.85,marginBottom:16}}>{lat.assessment.suggestion}</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <div style={{padding:"16px 14px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:16}}>
              <div style={{fontSize:11,color:T.text4,marginBottom:6}}>AI 录用建议</div>
              <Chip c={aiChip.c} bg={aiChip.bg} lg>{aiRec}</Chip>
            </div>
            <div style={{padding:"16px 14px",background:T.card2,border:`1px solid ${T.border}`,borderRadius:16}}>
              <div style={{fontSize:11,color:T.text4,marginBottom:6}}>最终结果（面试官/总监）</div>
              <Chip c={humanVerdict?humanChip.c:T.text4} bg={humanVerdict?humanChip.bg:T.card2} lg>{humanVerdict||"待面试官/总监确认"}</Chip>
            </div>
          </div>
        </div>
        <div style={{padding:"22px 20px 20px",background:"#fcfdff",borderLeft:`1px solid ${T.border}`,display:"grid",alignContent:"start"}}>
          <div style={{padding:"16px 16px 14px",background:"#ffffff",border:`1px solid ${gapAnalysis?(gapAnalysis.same?"#bbf7d0":"#fed7aa"):T.border}`,borderRadius:18}}>
            <div style={{fontSize:16,fontWeight:900,color:T.text,letterSpacing:"-0.02em",marginBottom:8}}>
              {gapAnalysis?(gapAnalysis.same?"AI 与人工判断一致":"AI 与人工判断不一致"):"等待人工判断"}
            </div>
            <div style={{fontSize:12,color:T.text2,lineHeight:1.85}}>
              {gapAnalysis?gapAnalysis.summary:"总监/面试官给出最终结论后，这里会自动生成分歧分析，解释为什么 AI 和人工会一致或不一致。"}
            </div>
            {gapAnalysis?.reasons?.length>0&&<div style={{marginTop:12,display:"grid",gap:6}}>
              {gapAnalysis.reasons.map((item,index)=><div key={index} style={{fontSize:12,color:T.text2,lineHeight:1.75}}>• {item}</div>)}
            </div>}
          </div>
        </div>
      </div>
    </div>
    <div style={{fontSize:12,fontWeight:800,color:T.text4,letterSpacing:"0.08em",marginBottom:10}}>轮次回放</div>
    <div style={{display:"grid",gap:12}}>
      {ivs.map((ir,i)=>{
        const dc=ir.assessment.decision==="通过"?{c:"#16a34a",bg:"#dcfce7"}:ir.assessment.decision==="淘汰"?{c:"#dc2626",bg:"#fee2e2"}:{c:"#ca8a04",bg:"#fef9c3"};
        return(<div key={i} style={{...panel,padding:"18px 20px 16px",borderLeft:`4px solid ${dc.c}`}}>
          <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) auto",gap:16,alignItems:"center"}}>
            <div>
              <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:8}}>
                <span style={{fontWeight:850,color:T.text,fontSize:14}}>{ir.round}</span>
                <Chip c={dc.c} bg={dc.bg}>{ir.assessment.decision}</Chip>
                <span style={{fontSize:11,color:T.text4}}>{ir.date}</span>
              </div>
              <div style={{fontSize:12,color:T.text2,lineHeight:1.8}}>{ir.assessment.suggestion}</div>
            </div>
            <div style={{textAlign:"right",minWidth:100}}>
              <div style={{fontSize:28,fontWeight:950,color:scColor(ir.assessment.score),lineHeight:1}}>{ir.assessment.score?.toFixed(1)}</div>
              <div style={{fontSize:11,color:T.text4,marginTop:4}}>/ 5.0</div>
            </div>
          </div>
        </div>);
      })}
    </div>
  </div>);
}

export { CandDetail, ScreenTab, QuestionTab, QCard, InterviewTab, IRecord, QuestionBankPanel, DirectorTab, ResultTab };
