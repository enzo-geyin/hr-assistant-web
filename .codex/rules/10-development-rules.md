# Development Rules

## Change Discipline

- 先读真实代码和配置，再修改。
- 只改完成当前任务必须改的文件。
- 优先复用现有组件、工具函数、状态结构和 API。
- 不新增依赖，除非用户明确要求。
- 不为了整理文档改动 `src/`、`functions/`、`server/`、`d1/` 的业务逻辑。
- 不回退用户已有改动。

## Cloudflare And D1 Guardrails

- `functions/api/state.js` 负责主状态同步；`functions/api/resume-assets.js` 负责简历资产写入；`functions/api/preview.js` 负责兼容读取。
- `GET /api/state` 不返回图片快照，避免响应体和 Worker CPU 超限。
- `PUT /api/state` 不应把大体积图片写进 `hr_state.payload`。
- 简历原文件和图片快照必须通过 `/api/resume-assets` 写入 R2 `RESUME_ASSETS`；D1 只保存资产索引、版本和事件。旧 `hr_resume_previews` 只读兜底，不再作为新写入口。
- D1 schema 只允许 additive 改动，优先 `CREATE TABLE IF NOT EXISTS` 或 `ALTER TABLE ADD COLUMN`。
- 不删除表、不清空表、不做破坏性 migration。

## Model And API Guardrails

- 模型提供商配置至少检查三处：`functions/api/ai.js`、`src/App.jsx`、`functions/api/model-status.js`。
- DeepSeek V4 模型 ID 使用 `deepseek-v4-flash` 和 `deepseek-v4-pro`。
- 代理模式下，`HR_PROXY_TOKEN` 为空时服务端应拒绝请求；前端应提示配置问题。
- direct 模式只适合本地调试，界面必须提示 API Key 仅保存在本地浏览器。

## Candidate Data Guardrails

- 修改候选人合并逻辑时，必须保护简历图片字段不被空值覆盖。
- 重新上传简历应保持候选人 ID 不变，并创建新的简历资产版本。
- 删除候选人必须同时考虑主状态、R2 简历资产引用、面试记录、学习样本的引用风险；默认软删除引用，不物理删除 R2 对象。
- 面试记录上传和生成任务应允许后台运行，不应因切换页面丢失状态。

## Validation Before Reporting

根据改动大小选择验证：

- 文档或规则改动：检查 Markdown 结构、路径和事实是否与代码一致。
- 前端改动：运行 `npm run build`。
- Functions 改动：运行 `npm run build`，并给出 Cloudflare Pages 验证路径。
- D1 改动：说明是否需要在 Cloudflare D1 Console 执行 SQL。
- 同步或预览改动：给出 `/api/state`、`/api/preview`、`/api/resume-assets`、`/api/preview-audit`、D1/R2 查询的验证方法。

## Git Hygiene

- 不提交、不推送、不部署，除非用户明确要求。
- 不使用破坏性 git 命令。
- 看到未跟踪文件时，先判断是否与当前任务相关；无关则避开。
