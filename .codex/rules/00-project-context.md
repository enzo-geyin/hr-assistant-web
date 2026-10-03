# Project Context

## Product Scope

本项目是 AI 招聘助手，服务个人或小团队的招聘筛选与面试流程。目标不是替代面试官，而是把简历识别、初筛、问题生成、面试记录整理、录用建议和经验沉淀串成一个可复用流程。

主要场景：

- 上传 JD 或手动创建岗位。
- 批量上传简历，自动识别文本和视觉快照。
- 根据岗位标准完成 0-5 分初筛。
- 按候选人过往真实经历生成面试问题。
- 上传或录入面试记录，AI 做结构化评估。
- 面试官或总监给最终判断，AI 解释与自身建议的差异。
- 将真实面试问答、题目反馈、最终判断沉淀为岗位评分标准和题库版本。

## Core Entities

- Job：在招岗位，包含部门、职级、薪资、岗位要求、T0/T1/T2 评分标准。
- Candidate：候选人，包含简历文本、来源文件、岗位匹配、进度、AI 评分、面试安排。
- Resume Asset：简历原文件和视觉快照，写入 R2 `RESUME_ASSETS`，D1 保存资产索引、active ref 和事件日志。
- Screening：AI 首轮筛选结果，包含总分、分项、风险、建议。
- Interview Question：按岗位和简历经历生成的问题，支持质量反馈。
- Interview Record：面试笔记、上传文件、结构化问答 `extractedQA`、轮次评估。
- Director Verdict：面试官或总监最终判断，是最终录用结果的来源。
- Learning Sample：由筛选、面试问答、反馈、最终判断组成的学习样本。
- Rubric / Question Bank：岗位评分标准版本和题库版本。

## Data Truth

- 主状态真源：D1 `hr_state.payload`。
- 简历资产真源：R2 `RESUME_ASSETS` 对象 + D1 `hr_resume_assets` / `hr_candidate_resume_refs` 版本索引。
- 旧简历快照：D1 `hr_resume_previews.preview_payload` 仅作 legacy 读取兜底和迁移来源。
- 本地缓存：浏览器 `localStorage`，用于离线或失败兜底，不应被当作云端真源。
- 模型配置真源：服务端 `functions/api/ai.js`，前端模型面板需与其保持一致。
- Cloudflare D1 绑定名必须是 `DB`。
- Cloudflare R2 绑定名必须是 `RESUME_ASSETS`。

## Success Criteria

Codex 在本项目中的好结果是：

- 能保护候选人隐私和简历数据。
- 能区分主状态、R2 简历资产、D1 资产索引、legacy 快照、本地缓存几条数据链。
- 能让面试题贴合岗位和简历经历，避免空泛或错岗问题。
- 能尊重面试官最终判断，并让 AI 学习差异原因。
- 能在修改后给出明确验证证据。
