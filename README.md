# AI Recruitment Assistant

一个适合个人或小团队试用的 AI 招聘助手前端项目，前端使用 Vite + React，模型调用通过独立的 Node 代理服务或 Cloudflare Pages Functions 完成。当前版本支持把岗位、候选人、面试记录和调用统计同步到 Cloudflare D1。

## 本地启动

1. 安装依赖：

```bash
npm install
```

2. 启动前端：

```bash
npm run dev
```

3. 启动代理服务：

```bash
PORT=8787 ANTHROPIC_API_KEY=your_key npm run proxy
```

如果你使用 OpenAI、DeepSeek 或 Kimi，把对应环境变量一起传给代理服务即可。

## 免费部署建议

### 推荐：Cloudflare Pages + Pages Functions

- 构建命令：`npm run build`
- 输出目录：`dist`
- Pages Functions 文件位置：`functions/api/ai.js`
- 云端状态 API：`functions/api/state.js`
- 学习系统 API：`functions/api/knowledge.js`
- 可选前端环境变量：`VITE_HR_PROXY_URL`、`VITE_HR_PROXY_TOKEN`、`VITE_HR_STATE_URL`（类型必须选 **Plaintext**，构建时编入前端 bundle）
- 必填服务端环境变量：至少一个模型平台的 API Key
- 可选服务端环境变量：`HR_PROXY_TOKEN`（类型选 **Secret**）
- D1 绑定名：`DB`

Cloudflare Pages 部署时，前端和代理函数会走同一个域名，默认直接请求 `/api/ai`，不需要额外填代理地址。

> **重要：开启了 `HR_PROXY_TOKEN` 就必须同时配 `VITE_HR_PROXY_TOKEN`，两者值完全一致。** 前者给服务端 Functions 校验请求，后者在构建时编进前端 JS。漏配 `VITE_HR_PROXY_TOKEN` 时，新设备或隐私窗打开网站会显示"代理访问令牌无效"，看起来像数据丢了，其实只是前端没拿到 token。`HR_PROXY_TOKEN` 出现在前端 bundle 里相当于半公开，建议给整个 Pages 项目额外加 Cloudflare Access 做身份验证。

### Cloudflare D1 配置

1. 在 Cloudflare 创建一个 D1 数据库，例如 `hr-assistant-db`
2. 在 Pages / Workers 项目中添加 D1 绑定，绑定名必须是 `DB`
3. 可选：执行 [d1/schema.sql](/Users/fangweili/Documents/Playground/d1/schema.sql) 里的建表语句
4. 如果你启用了 `HR_PROXY_TOKEN`，前端设置页里填写同一个“代理访问令牌”，数据同步和 AI 代理都会复用这条 Bearer token

配置完成后，应用会：

- 启动时优先从 D1 拉取最新数据
- 继续保留浏览器 `localStorage` 作为本地缓存
- 在岗位、候选人、面试记录或设置变更后自动同步回 D1
- 如果表还不存在，`/api/state` 会在首次请求时自动创建 `hr_state`
- `/api/knowledge` 会自动创建 `learning_samples`、`rubric_versions`、`question_bank_versions`

### AI 学习循环实现

当前已接入完整的”招聘学习循环”：

1. **面试记录阶段**：使用 LLM 从面试笔记中自动抽取结构化问答对（extractedQA 字段）
2. **总监判断阶段**：将候选人 screening + extractedQA + 总监决策自动写入 `learning_samples`
3. **学习反馈阶段**：同岗位样本累计后，自动生成新的 `rubric_versions` 和 `question_bank_versions`
4. **出题优化阶段**：后续面试题生成会优先读取最新规则题库，并基于 extractedQA 避免重复出题

**技术实现**：
- **标签识别**：AI 筛选时直接输出 skillTags 字段（5-15 个跨领域标签），替代硬编码词典
- **问答抽取**：面试评估时调用 DeepSeek V4 Flash 从 Markdown 格式笔记中抽取问答对
- **学习样本**：使用 DeepSeek V4 Pro 处理复杂的学习合成任务

这是基于检索增强的学习循环，不涉及模型权重微调。

注意：

- 当前同步是整库快照，适合个人使用或小团队轻协作
- 多人同时修改时，后保存的数据会覆盖先保存的数据
- 正常前端版本发布不会清空 D1 数据

### 本地 Node 代理

- 启动命令：`node server/proxy.js`
- 适合本地联调或不使用 Cloudflare Functions 时备用

## 当前限制

- 云端同步目前采用整库快照，不是细粒度实时协同
- 尚未接入登录鉴权；如果部署在公网，建议至少启用 `HR_PROXY_TOKEN`
- 更适合个人使用或小团队试用，正式协同招聘仍建议继续补用户体系和权限控制

## 目录结构

```text
.
├── index.html
├── package.json
├── functions/
│   └── api/
│       ├── ai.js
│       ├── knowledge.js
│       └── state.js
├── d1/
│   └── schema.sql
├── server/
│   └── proxy.js
├── src/
│   ├── App.jsx
│   └── main.jsx
└── vite.config.mjs
```
