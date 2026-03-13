# AI Recruitment Assistant

一个适合个人或小团队试用的 AI 招聘助手前端项目，前端使用 Vite + React，模型调用通过独立的 Node 代理服务完成。

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
- 可选前端环境变量：`VITE_HR_PROXY_URL`、`VITE_HR_PROXY_TOKEN`
- 必填服务端环境变量：至少一个模型平台的 API Key
- 可选服务端环境变量：`HR_PROXY_TOKEN`

Cloudflare Pages 部署时，前端和代理函数会走同一个域名，默认直接请求 `/api/ai`，不需要额外填代理地址。

### 本地 Node 代理

- 启动命令：`node server/proxy.js`
- 适合本地联调或不使用 Cloudflare Functions 时备用

## 当前限制

- 岗位、候选人、面试记录仍保存在浏览器 `localStorage`
- 不同成员之间不会自动共享同一份数据
- 适合个人使用或小团队各自独立试用，不适合正式协同招聘

## 目录结构

```text
.
├── index.html
├── package.json
├── functions/
│   └── api/
│       └── ai.js
├── server/
│   └── proxy.js
├── src/
│   ├── App.jsx
│   └── main.jsx
└── vite.config.mjs
```
