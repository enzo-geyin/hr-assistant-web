# AI Recruitment Assistant

一个面向个人或小团队的 AI 招聘助手。前端使用 Vite + React，线上部署使用 Cloudflare Pages + Pages Functions + D1 + R2。应用支持岗位管理、简历上传识别、候选人初筛、面试题生成、面试记录评估、总监最终判断、岗位题库学习和云端同步。

## 本地启动

1. 安装依赖：

```bash
npm install
```

2. 启动前端：

```bash
npm run dev
```

3. 可选：启动本地 Node 代理：

```bash
PORT=8787 ANTHROPIC_API_KEY=your_key npm run proxy
```

本地 Node 代理适合离线调试。Cloudflare Pages 部署后，默认使用同域 Pages Functions，不需要单独运行 Node 代理。

## 线上部署

推荐使用 Cloudflare Pages：

- 构建命令：`npm run build`
- 输出目录：`dist`
- D1 绑定名：`DB`
- D1 数据库名示例：`hr-assistant-db`
- R2 绑定名：`RESUME_ASSETS`
- R2 bucket 名建议：`hr-resume-assets`
- D1 schema 真源：[d1/schema.sql](d1/schema.sql)
- Cloudflare Pages 配置：[wrangler.jsonc](wrangler.jsonc)

Pages Functions：

- `/api/ai`：模型代理，读取服务端模型 API Key。
- `/api/state`：主状态同步，读写 `hr_state.payload`。
- `/api/resume-assets`：简历原文件和预览资产写入入口，写 R2，并把索引和版本写入 D1。
- `/api/preview`：简历图片快照兼容读取入口，优先读 R2 active asset，失败时兜底旧 `hr_resume_previews`。
- `/api/preview-audit`：简历资产只读诊断入口。
- `/api/knowledge`：学习样本、评分标准版本、题库版本。
- `/api/model-status`：模型环境变量与连通状态诊断。
- `/api/transcribe`：面试记录音频或文件识别入口。

## 环境变量

前端构建变量，类型建议选 Plaintext：

```text
VITE_HR_PROXY_URL=/api/ai
VITE_HR_PROXY_TOKEN=
VITE_HR_STATE_URL=/api/state
VITE_HR_PREVIEW_URL=/api/preview
VITE_HR_RESUME_ASSETS_URL=/api/resume-assets
VITE_HR_PREVIEW_AUDIT_URL=/api/preview-audit
VITE_HR_KNOWLEDGE_URL=/api/knowledge
VITE_HR_MODEL_STATUS_URL=/api/model-status
VITE_HR_TRANSCRIBE_URL=/api/transcribe
```

服务端变量，模型 Key 与代理令牌建议选 Secret：

```text
HR_PROXY_TOKEN=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
DEEPSEEK_API_KEY=
KIMI_API_KEY=
```

至少配置一个模型平台 API Key。线上 Pages Functions 还必须配置 `HR_PROXY_TOKEN`，并且 `HR_PROXY_TOKEN` 和 `VITE_HR_PROXY_TOKEN` 必须完全一致；否则前端请求会被 Functions 拒绝，界面会显示云端同步或模型连接异常。

## 数据模型

D1 / R2 中有三条主要数据轨：

- `hr_state`：保存整个应用主状态 JSON，包括岗位、候选人、面试记录、设置、调用统计、学习状态等。
- R2 `RESUME_ASSETS`：保存简历原文件和派生预览资产。
- `hr_resume_assets` / `hr_candidate_resume_refs` / `hr_resume_asset_events`：保存 R2 对象索引、候选人当前资产版本和追加式事件日志。
- `hr_resume_previews`：旧版 D1 blob 表，仅保留为 legacy 读取和迁移来源，不作为新写入口。

学习相关表：

- `learning_samples`：候选人筛选、面试问答、总监判断形成的学习样本。
- `rubric_versions`：岗位评分标准版本。
- `question_bank_versions`：岗位面试题库版本。

前端版本发布不会清空 D1。若部署后看不到数据，优先检查 `HR_PROXY_TOKEN` / `VITE_HR_PROXY_TOKEN`、D1 绑定名 `DB`、以及 Pages Functions 是否正常发布。

## 简历图片快照双轨制

简历识别文本和候选人主体信息随 `hr_state.payload` 同步。原始简历文件和图片快照不放进 `/api/state`，而是通过 `/api/resume-assets` 写入 R2，再由 `/api/preview?id=<candidateId>` 按需读取。

关键规则：

- `GET /api/state` 按设计不返回图片快照。
- `PUT /api/state` 会剥离图片字段，不写入或删除简历 blob。
- `/api/resume-assets` 写入必须带 `expectedVersion`，旧页面不能覆盖更高版本资产。
- `/api/preview` 优先读取 R2 active asset；没有 R2 记录时才读取旧 `hr_resume_previews`。
- 删除候选人默认不物理删除 R2 对象。
- 如果 R2 和 legacy 表都没有快照，并且浏览器本地也没有原始图片快照，只能重新上传原始 PDF / 图片生成视觉预览；识别后的纯文字不能还原原始版式。

## AI 学习循环

应用使用检索增强式学习，不修改模型权重：

1. 简历上传阶段：识别简历文本、推断岗位方向、按岗位标准初筛。
2. 面试题阶段：基于岗位、简历经历、历史题库和反馈生成问题。
3. 面试记录阶段：从人工笔记或上传文件中抽取结构化问答 `extractedQA`。
4. 总监判断阶段：以面试官或总监判断为最终结果，AI 负责给录用建议与差异解释。
5. 学习沉淀阶段：把筛选、问答、反馈、最终判断写入 `learning_samples`，再生成新版本评分标准与题库。

DeepSeek 模型注册以服务端 `functions/api/ai.js` 和前端 `src/App.jsx` 为准。本仓库使用的 DeepSeek V4 ID 是 `deepseek-v4-flash` 与 `deepseek-v4-pro`。

## 目录结构

```text
.
├── index.html
├── package.json
├── functions/
│   └── api/
│       ├── ai.js
│       ├── knowledge.js
│       ├── model-status.js
│       ├── preview.js
│       ├── preview-audit.js
│       ├── resume-assets.js
│       ├── state.js
│       └── transcribe.js
├── d1/
│   └── schema.sql
├── docs/
│   ├── architecture.md
│   └── runbook.md
├── server/
│   └── proxy.js
├── scripts/
│   └── preview-migration-dry-run.mjs
├── src/
│   ├── App.jsx
│   ├── components/
│   │   └── CandDetail.jsx
│   └── main.jsx
└── vite.config.mjs
```

## 运行限制

- 云端同步使用整库快照，适合个人或小团队轻协作。
- 多人同时编辑同一份数据时，后保存的快照可能覆盖先保存的内容。
- 公网使用建议给 Cloudflare Pages 加 Cloudflare Access；`HR_PROXY_TOKEN` 只是应用级请求令牌，不是完整登录体系。
- 简历和面试记录包含个人信息，导出、截图、调试日志都应避免泄露。
