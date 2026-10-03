# Test Rules

## Test Strategy

验证要覆盖招聘助手真实工作流：

- 简历上传：PDF、图片、Word、txt、md 的识别和候选人创建。
- 简历预览：本地预览、云端 `/api/preview`、R2 `RESUME_ASSETS`、D1 资产索引和 legacy `hr_resume_previews`。
- 岗位匹配：自动识别、人工修正、重新筛选。
- 候选人进度：观察中、进入面试、简历通过、未通过等状态保存。
- 面试安排：日期、时间、地点、链接、备注、冲突提示。
- 面试题：按岗位生成、避免重复、反馈后重新生成。
- 面试记录：文本和文件二选一即可评估，后台任务不因切页中断。
- 总监判断：最终判断保存，并触发学习样本记录。
- 云端同步：刷新页面或部署新版本后，D1 数据仍能恢复。

## Minimum Checks

文档或规则改动后至少检查：

```bash
find .codex/rules docs -type f | sort
```

前端或 Functions 改动后至少运行：

```bash
npm run build
```

如项目新增或改动 shell hook，对本次实际变更的脚本逐一运行 `sh -n <script>`；不要引用仓库里不存在的固定路径。

## Regression Cases

涉及简历上传或预览时，至少覆盖：

- 新上传候选人后，候选人列表出现。
- 候选人详情能显示简历视觉预览。
- `/api/resume-assets` 成功返回 `resumeAssetVersion`，`/api/preview` 能按 candidate id 读回 R2 active asset。
- 旧 `hr_resume_previews` 只作为 legacy fallback，不应被新写入覆盖。
- 页面刷新后仍能按需加载图片快照。
- 图片快照失败时界面显示明确错误。

涉及面试题时，至少覆盖：

- 同一轮没有重复题。
- 内容岗不问投放计划数据，投放岗不问纯内容审美问题。
- 店铺运营问题围绕商品、活动、达人、客服、转化、GMV。
- 用户标记无效的问题不会原样重复出现。

涉及云端同步时，至少覆盖：

- `HR_PROXY_TOKEN` 与 `VITE_HR_PROXY_TOKEN` 一致时可同步。
- 令牌缺失或不一致时显示配置错误。
- D1 绑定名错误时显示云端异常。
- 刷新页面后候选人、岗位、面试记录仍存在。

## Reporting Evidence

最终汇报必须说明：

- 运行了哪些检查。
- 检查结果是什么。
- 哪些检查没跑，以及为什么。
- 如果只做文档同步，说明未触碰业务代码。
