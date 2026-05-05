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
UPSTREAM_TIMEOUT_MS=600000
IMAGE_JOB_DELIVERY_CLEANUP_MS=120000
IMAGE_JOB_OWNER_SECRET=
```

Nginx 反代参考：`deploy/nginx-ciyuan-chat.conf`。如果是两台服务器并且重视安全边界，先看 `SECURE_DEPLOY.md`。

Sub2API 后台自定义菜单 URL 填：

```text
https://ciyuan.fast/chat
```

## 接口

- `GET /chat-api/models` 转发到 `${API_BASE_URL}${MODELS_ENDPOINT}`
- `POST /chat-api/chat/completions` 转发到 `${API_BASE_URL}${CHAT_COMPLETIONS_ENDPOINT}`
- `POST /chat-api/responses` 转发到 `${API_BASE_URL}${RESPONSES_ENDPOINT}`
- `POST /chat-api/image-jobs` 创建异步生图任务，立即返回 `job_id`
- `GET /chat-api/image-jobs/:jobId` 查询异步生图任务状态
- `GET /chat-assets/images/:filename` 访问后端临时保存的生成图片
- `POST /chat-api/images/generations` 转发到 `${IMAGE_API_BASE_URL}${IMAGE_GENERATIONS_ENDPOINT}`
- `POST /chat-api/images/edits` 转发到 `${IMAGE_API_BASE_URL}${IMAGE_EDITS_ENDPOINT}`
- `POST /chat-api/images/variations` 转发到 `${IMAGE_API_BASE_URL}${IMAGE_VARIATIONS_ENDPOINT}`
- `POST /v1/images/generations` OpenAI 风格对外异步生图接口，返回 `202` job
- `GET /v1/image-jobs/:jobId` OpenAI 风格对外 job 查询接口
- `GET /chat-api/health` 健康检查

前端请求代理时带：

```http
Authorization: Bearer <user-api-key>
```

## 异步生图

网页端生图不再直接等待 `/images/generations` 长请求，而是：

1. 前端 `POST /chat-api/image-jobs` 创建任务。
2. 后端 worker 使用 `IMAGE_API_BASE_URL + IMAGE_GENERATIONS_ENDPOINT` 直连上游。
3. 上游返回 `b64_json` 时保存为本地图片；返回 `url` 时先尝试下载保存。
4. 前端每 2 秒轮询 `GET /chat-api/image-jobs/:jobId`。
5. 成功后返回 `/chat-assets/images/...` 图片 URL。

`gpt-image-*` 系列只使用 `b64_json` 返回格式；DALL-E 系列仍可使用 `url` 或 `b64_json`。生成图片保存在 `chat-server/storage/generated-images`，任务成功状态首次回传后默认 120 秒清理本地图片和 job，可用 `IMAGE_JOB_DELIVERY_CLEANUP_MS` 调整。

## 对外异步接口

对外接口保持 OpenAI images 请求风格，但生图全部异步：

```http
POST /v1/images/generations
Authorization: Bearer <user-api-key>
Content-Type: application/json
```

请求体继续使用 OpenAI images 字段，例如 `model`、`prompt`、`size`、`quality`、`background`、`output_format`、`response_format`、`n`。接口立即返回：

```json
{
  "id": "imgjob_xxx",
  "object": "image_generation.job",
  "status": "queued",
  "created": 1777911944,
  "poll_url": "/v1/image-jobs/imgjob_xxx"
}
```

查询时必须继续携带同一个 Bearer Key：

```http
GET /v1/image-jobs/imgjob_xxx
Authorization: Bearer <user-api-key>
```

成功后返回外层 job 状态，内层 `result` 尽量保持 OpenAI images response：

```json
{
  "id": "imgjob_xxx",
  "object": "image_generation.job",
  "status": "succeeded",
  "created": 1777911944,
  "completed_at": 1777911978,
  "result": {
    "created": 1777911978,
    "data": [
      {
        "url": "https://your-domain/chat-assets/images/xxx.png"
      }
    ]
  }
}
```

服务端只在 job 运行期间短暂保留明文 Authorization，完成或失败后立即删除。查询归属使用 HMAC 哈希校验；`IMAGE_JOB_OWNER_SECRET` 可选配置，不填时进程启动会自动生成临时 secret。

## 已覆盖能力

- 左侧会话列表、删除单会话、清空历史
- 顶部模型选择：`gpt-5.5`、`gpt-5.4`、`gpt-5.3-codex`、`gpt-5.2`
- API Key 本地保存，一次填写后刷新仍可用
- 对话流式输出、Markdown 和代码块渲染
- 停止生成
- 对话 / 生图切换，生图模式支持模型、尺寸、数量、质量、返回格式
- 异步生图任务，避免浏览器和 Cloudflare 长请求超时
- 多张图片 URL 或 base64 结果进入当前会话，点击图片可在 iframe 内预览
- 浅色、深色、自动主题，默认跟随系统
