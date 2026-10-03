# Risk Rules

## Never Touch Without Explicit Authorization

- API Key、Cookie、登录态、账号密码、验证码、Session、Token。
- Cloudflare 后台生产配置值。
- D1 表删除、清空、破坏性迁移。
- 候选人隐私数据批量导出或公开展示。
- 大规模重命名、业务重构、跨模块迁移。
- `git reset --hard`、`git clean -fd`、`git checkout -- <path>` 丢弃改动。

## High-Risk Product Areas

- 候选人简历包含个人信息，截图、日志、导出文件都要避免泄露。
- 云端同步错误可能覆盖候选人、岗位和面试记录。
- 简历图片快照体积过大可能触发 Cloudflare 4MB 请求限制。
- `HR_PROXY_TOKEN` 配置错误会让同步和模型调用看起来像“数据丢失”。
- 面试题错岗会浪费面试时间，并污染学习题库。
- AI 建议不能替代人工最终判断。

## Required Safeguards

- 所有 D1 schema 改动必须 additive。
- 图片快照必须走 `/api/preview`，不要塞回 `/api/state`。
- 合并云端和本地候选人时，图片字段应只增不减，不能被空值覆盖。
- 上传、生成、识别、评估类长任务应后台运行并保留状态。
- 面试题反馈必须支持标记高价值、一般、重复、无效。
- 删除候选人前要明确影响范围；默认不批量删除。

## Dangerous Commands

不要运行会破坏仓库、数据或环境的命令，例如：

- `rm -rf`
- `git reset --hard`
- `git clean -fd`
- `git checkout -- <path>` 用于丢弃改动
- 数据库 `DROP` / destructive migration
- 未经授权的部署、发布、上传脚本

如必须执行风险操作，先说明影响范围、恢复方式和替代方案，并等待用户明确授权。
