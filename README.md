# 词元.fast Chat

ChatGPT 风格 iframe 页面，部署路径为 `/chat`，代理路径为 `/chat-api/*`。用户 API Key 只保存在浏览器 `localStorage`，Node 代理仅转发请求，不落库、不记录 Key、请求体或响应体。

## 本地开发

```bash
npm install
npm run dev:server
npm run dev
```

打开 `http://localhost:5173/chat/`。Vite 会把 `/chat-api` 代理到 `http://localhost:3000`。

主题支持 URL 参数：

```text
/chat/?theme=auto
/chat/?theme=light
/chat/?theme=dark
```

## 生产运行

```bash
docker compose up -d --build
```

默认服务监听容器内 `3000`：

```env
API_BASE_URL=https://ciyuan.fast/v1
IMAGE_API_BASE_URL=https://imgapi.ciyuan.fast/v1
MODELS_ENDPOINT=/models
CHAT_COMPLETIONS_ENDPOINT=/chat/completions
RESPONSES_ENDPOINT=/responses
IMAGE_GENERATIONS_ENDPOINT=/images/generations
IMAGE_EDITS_ENDPOINT=/images/edits
IMAGE_VARIATIONS_ENDPOINT=/images/variations
IMAGE_MODEL=
PORT=3000
```

Nginx 反代参考：`deploy/nginx-ciyuan-chat.conf`。

Sub2API 后台自定义菜单 URL 填：

```text
https://ciyuan.fast/chat
```

## 接口

- `GET /chat-api/models` 转发到 `${API_BASE_URL}${MODELS_ENDPOINT}`
- `POST /chat-api/chat/completions` 转发到 `${API_BASE_URL}${CHAT_COMPLETIONS_ENDPOINT}`
- `POST /chat-api/responses` 转发到 `${API_BASE_URL}${RESPONSES_ENDPOINT}`
- `POST /chat-api/images/generations` 转发到 `${IMAGE_API_BASE_URL}${IMAGE_GENERATIONS_ENDPOINT}`
- `POST /chat-api/images/edits` 转发到 `${IMAGE_API_BASE_URL}${IMAGE_EDITS_ENDPOINT}`
- `POST /chat-api/images/variations` 转发到 `${IMAGE_API_BASE_URL}${IMAGE_VARIATIONS_ENDPOINT}`
- `GET /chat-api/health` 健康检查

前端请求代理时带：

```http
Authorization: Bearer <user-api-key>
```

## 已覆盖能力

- 左侧会话列表、删除单会话、清空历史
- 顶部模型选择：`gpt-5.5`、`gpt-5.4`、`gpt-5.3-codex`、`gpt-5.2`
- API Key 本地保存，一次填写后刷新仍可用
- 对话流式输出、Markdown 和代码块渲染
- 停止生成
- 对话 / 生图切换，生图模式支持模型、尺寸、数量、质量、返回格式
- 多张图片 URL 或 base64 结果进入当前会话，点击图片可在 iframe 内预览
- 浅色、深色、自动主题，默认跟随系统
