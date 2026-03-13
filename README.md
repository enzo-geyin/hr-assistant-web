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
- 可选前端环境变量：`VITE_HR_PROXY_URL`、`VITE_HR_PROXY_TOKEN`
- 必填服务端环境变量：至少一个模型平台的 API Key
- 可选服务端环境变量：`HR_PROXY_TOKEN`
- D1 绑定名：`DB`

Cloudflare Pages 部署时，前端和代理函数会走同一个域名，默认直接请求 `/api/ai`，不需要额外填代理地址。

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
