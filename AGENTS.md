# HR Assistant Project Rules

本仓库是运行在 Cloudflare Pages + Pages Functions + D1 上的 AI 招聘助手。具体开发、产品、测试和风险规则放在 `.codex/rules/`，运维与架构说明放在 `docs/`。

## 范围

- 主应用目录：`src/`、`functions/`、`d1/`、`server/`、`docs/`、`.codex/rules/` 和根配置文件。
- `wechat-*`、`wx-*`、`kuaishou-*` 等旁支目录不属于 HR Assistant；除非用户明确点名，不纳入构建、提交或重构范围。
- 保留当前工作区已有修改和未跟踪文件；开始前读取 `git status --short --untracked-files=all`。

## 规则索引

- `.codex/rules/00-project-context.md`：产品对象、数据边界和真源。
- `.codex/rules/10-development-rules.md`：Cloudflare、D1、API 和模型配置边界。
- `.codex/rules/20-product-rules.md`：招聘流程、评分、面试题和学习反馈。
- `.codex/rules/30-test-rules.md`：验证策略和手工检查。
- `.codex/rules/40-risk-rules.md`：隐私、密钥、生产数据和高风险操作。
- `docs/architecture.md`、`docs/runbook.md`：架构与运维。

按任务只读取相关规则；模型 ID、评分阈值和 API 清单以代码及上述规则为准，不在本文件复制一份。

## 项目不变量

- 主状态保存在 D1 `hr_state.payload` JSON。
- 简历资产长期保存在 R2 `RESUME_ASSETS`，D1 `hr_resume_assets` / `hr_candidate_resume_refs` 只保存索引和版本；旧 `hr_resume_previews` 仅作 legacy 读取兜底。
- `GET /api/state` 不返回图片快照是设计选择，不代表数据丢失。
- `HR_PROXY_TOKEN` 与 `VITE_HR_PROXY_TOKEN` 必须一致。
- 总监/面试官最终判断是录用结果，AI 输出是建议与差异解释。
- 涉及模型时，按 `.codex/rules/10-development-rules.md` 重新核对服务端注册、前端模型面板和状态提示。

## 硬边界

- 不读取或改写密钥、Cookie、真实账号凭据和生产配置值。
- 不删除 D1 表，不清空 `hr_state` / `hr_resume_previews` / R2 `RESUME_ASSETS`，不做未经确认的 schema 迁移。
- 不使用 `git reset --hard`、`git clean -fd` 或 `git checkout -- <path>` 丢弃现有改动。
- 不自动 commit、push、部署或修改 Cloudflare 后台。
- 不删除未跟踪文件、不新增依赖、不为规则整理重构业务代码，除非用户明确要求。
- 不创建新的 `CLAUDE.md`；当前 Codex 规则只维护在本文件和 `.codex/rules/`。

代码改动按相关规则执行 targeted tests、必要的 build/smoke 和对抗性审查；文档改动至少验证路径、链接和事实真源。
