# Codex Project Rules

本文件是 Codex 在本仓库工作的总入口。保持简洁；具体规则放在 `.codex/rules/`，任务型流程放在 `skills/`，专项审阅角色放在 `subagents/`。

## Project Direction

当前规则面向电商运营工具与快手上传自动化：多账号管理、批量标题/简介生成、商品匹配、素材整理、定时发布、发布结果追踪。

如果代码中仍存在旧招聘助手命名或历史实现，先视为遗留上下文。除非用户明确要求迁移业务功能，不要为了规则整理去重构业务代码。

## Rule Index

- `.codex/rules/00-project-context.md`：项目背景、核心对象、业务边界。
- `.codex/rules/10-development-rules.md`：开发方式、代码改动边界、提交前检查。
- `.codex/rules/20-product-rules.md`：电商运营、快手上传、多账号与批量内容的产品规则。
- `.codex/rules/30-test-rules.md`：验证策略、回归范围、手工检查清单。
- `.codex/rules/40-risk-rules.md`：高风险操作、数据安全、账号与发布风险。

## Default Workflow

1. 先读相关规则和现有实现，再动手。
2. 明确任务类型：需求分析、功能开发、Bug 修复、代码审阅、运营自动化、上传排障。
3. 选择最贴近的 `skills/*/SKILL.md` 作为执行流程。
4. 保持最小改动；不改业务代码，除非用户明确要求。
5. 验证后再汇报，说明改了什么、如何验证、还有什么风险。

## Hard Rules

- 不创建 `CLAUDE.md`。
- 暂时不创建 `plugins/`。
- 不触碰密钥、Cookie、登录态、真实账号凭据或生产配置。
- 不执行真实发布、批量删除、批量改价、订单/库存/支付相关写操作，除非用户明确授权。
- 不重构业务代码来完成规则整理任务。

## Output Style

最终回复默认包含：理解、变更文件、验证结果、风险/未做事项。内容要短而具体。
