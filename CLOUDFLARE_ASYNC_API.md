# Cloudflare 与对外异步接口说明

本项目除了 `/chat/` 网页入口，还提供了后端代理接口和对外异步生图接口。配 Cloudflare 时要把“用户访问入口”和“后端访问上游模型服务”分开看。

## 1. 推荐访问结构

```text
浏览器 / 外部调用方
  -> Cloudflare
  -> Nginx
  -> ciyuan-chat 容器

ciyuan-chat 容器
  -> API_BASE_URL 直连聊天上游
  -> IMAGE_API_BASE_URL 直连生图上游
```

关键原则：

- 用户访问本项目域名可以走 Cloudflare。
- `API_BASE_URL` 和 `IMAGE_API_BASE_URL` 不建议填 Cloudflare 代理后的域名，应填内网 IP、公网直连 IP，或不经过 Cloudflare 的源站地址。
- 生图已做异步 job，外部调用方不会一直等上游生成完成；真正的长耗时请求由 `ciyuan-chat` 后端 worker 发给 `IMAGE_API_BASE_URL`。

## 2. 对外路径

### 网页入口

```text
GET /chat/
```

浏览器 UI 使用这个入口。根路径 `/` 会 302 跳到 `/chat`。

### 网页内部接口

```text
GET  /chat-api/health
GET  /chat-api/models
POST /chat-api/chat/completions
POST /chat-api/responses
POST /chat-api/image-jobs
GET  /chat-api/image-jobs/:jobId
```

这些主要给 `/chat/` 网页使用。生图时网页调用 `/chat-api/image-jobs` 创建任务，然后每 2 秒轮询 `/chat-api/image-jobs/:jobId`。

### 对外异步生图接口

```text
POST /v1/images/generations
POST /v1/images/edits
GET  /v1/image-jobs/:jobId
```

这组接口是给外部系统调用的 OpenAI 风格异步接口。它不直接返回最终图片，而是先返回 job，再轮询 job 状态。

### 生成图片访问

```text
GET /chat-assets/images/:filename
```

后端会把上游返回的 `b64_json` 或图片 URL 保存到：

```text
chat-server/storage/generated-images
```

Docker 中已挂载为持久化目录：

```yaml
./chat-server/storage/generated-images:/app/chat-server/storage/generated-images
```

## 3. 异步生图调用流程

### 创建文生图任务

```bash
curl -sS https://你的域名/v1/images/generations \
  -H "Authorization: Bearer <用户自己的API Key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-1",
    "prompt": "a clean product photo of a white ceramic mug",
    "size": "1024x1024",
    "n": 1
  }'
```

返回示例：

```json
{
  "id": "imgjob_xxx",
  "object": "image_generation.job",
  "status": "queued",
  "created": 1770000000,
  "poll_url": "/v1/image-jobs/imgjob_xxx"
}
```

### 轮询任务状态

轮询时必须继续携带同一个用户 Key：

```bash
curl -sS https://你的域名/v1/image-jobs/imgjob_xxx \
  -H "Authorization: Bearer <同一个用户自己的API Key>"
```

进行中：

```json
{
  "id": "imgjob_xxx",
  "object": "image_generation.job",
  "status": "running",
  "created": 1770000000,
  "poll_url": "/v1/image-jobs/imgjob_xxx"
}
```

成功：

```json
{
  "id": "imgjob_xxx",
  "object": "image_generation.job",
  "status": "succeeded",
  "created": 1770000000,
  "completed_at": 1770000020,
  "poll_url": "/v1/image-jobs/imgjob_xxx",
  "result": {
    "created": 1770000020,
    "data": [
      {
        "url": "https://你的域名/chat-assets/images/1770000020000-uuid.png"
      }
    ]
  }
}
```

失败：

```json
{
  "id": "imgjob_xxx",
  "object": "image_generation.job",
  "status": "failed",
  "created": 1770000000,
  "poll_url": "/v1/image-jobs/imgjob_xxx",
  "error": {
    "message": "Upstream 500: ..."
  }
}
```

建议外部调用方每 2 到 5 秒轮询一次，不要高频打接口。

## 4. 图生图 / 编辑接口

`POST /v1/images/edits` 支持两种方式。

### multipart 上传图片

```bash
curl -sS https://你的域名/v1/images/edits \
  -H "Authorization: Bearer <用户自己的API Key>" \
  -F "model=gpt-image-1" \
  -F "prompt=turn this into a studio product render" \
  -F "size=1024x1024" \
  -F "image[]=@./input.png"
```

也支持 `mask=@./mask.png`。

### JSON 引用图片

```bash
curl -sS https://你的域名/v1/images/edits \
  -H "Authorization: Bearer <用户自己的API Key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-1",
    "prompt": "make the background white",
    "size": "1024x1024",
    "images": [
      { "image_url": "https://example.com/input.png" }
    ]
  }'
```

`images` 中支持：

- `image_url` 或 `url`：HTTP/HTTPS 图片地址。
- `data:image/...;base64,...`：base64 图片。
- `file_id`：转发给上游的文件 ID。

上传限制由环境变量控制：

```env
IMAGE_UPLOAD_MAX_BYTES=20971520
IMAGE_UPLOAD_MAX_FILES=16
IMAGE_UPLOAD_TTL_MS=1800000
JSON_BODY_LIMIT=32mb
```

支持 PNG、JPEG、WEBP、非动画 GIF。动画 GIF 会被拒绝。

## 5. Job 生命周期与安全

- job 存在内存里，默认 30 分钟 TTL。
- 成功 job 第一次被查询到后，会按 `IMAGE_JOB_DELIVERY_CLEANUP_MS` 延迟清理，默认 1 小时。
- 生成图片也会在 job 清理时删除，所以返回图片后要及时下载或转存。
- `/v1/image-jobs/:jobId` 查询会校验 `Authorization`，必须和创建 job 时的 Bearer Key 匹配。
- 这个匹配使用 `IMAGE_JOB_OWNER_SECRET` 做 HMAC。生产环境建议固定配置，不要留空。
- 如果容器重启，内存 job 会丢失；已经保存到持久化目录里的图片文件仍在，但原 job 状态无法继续查询。

生产建议：

```env
IMAGE_JOB_OWNER_SECRET=一段足够长的随机字符串
IMAGE_JOB_DELIVERY_CLEANUP_MS=3600000
UPSTREAM_TIMEOUT_MS=600000
```

## 6. Cloudflare 配置要点

### DNS

把对外域名指向 Chat 服务器：

```text
chat.example.com -> Chat 服务器公网 IP
```

可以开启橙云代理。上游模型服务域名或 IP 不要套在这个用户入口域名下。

### SSL/TLS

Cloudflare 建议使用：

```text
SSL/TLS mode: Full (strict)
```

源站 Nginx 配真实证书，或使用 Cloudflare Origin Certificate。

### Cache Rules

建议：

- `/chat-api/*`：Bypass cache。
- `/v1/*`：Bypass cache。
- `/chat-assets/images/*`：可缓存 30 分钟；如果图片隐私要求高，也设为 Bypass cache。
- `/chat/*`：普通静态资源可走默认缓存策略。

不要给 `/v1/image-jobs/*` 开缓存，否则轮询会拿到旧状态。

### WAF / Rate Limit

建议至少限制：

- `/v1/images/generations`
- `/v1/images/edits`
- `/v1/image-jobs/*`
- `/chat-api/image-jobs`

参考策略：

```text
POST /v1/images/*：按 IP 每分钟 30 次以内
GET  /v1/image-jobs/*：按 IP 每分钟 120 次以内
POST /chat-api/image-jobs：按 IP 每分钟 30 次以内
```

实际阈值按你的用户量调整。

### 注意 Cloudflare 超时

同步接口仍然存在：

```text
POST /chat-api/images/generations
POST /chat-api/images/edits
POST /chat-api/images/variations
```

这些是直接转发接口，长耗时请求可能受 Cloudflare 超时影响。网页当前主要使用异步 `/chat-api/image-jobs`，对外系统也应优先使用 `/v1/images/generations` 和 `/v1/images/edits`。

## 7. Nginx 反代建议

```nginx
location = /chat {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /chat/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /chat-api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /v1/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /chat-assets/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`Host`、`X-Forwarded-Proto` 必须保留，否则 `/v1/image-jobs/:jobId` 成功结果里的图片绝对 URL 可能拼错。

## 8. 环境变量重点

```env
API_BASE_URL=http://<聊天上游直连地址>/v1
IMAGE_API_BASE_URL=http://<生图上游直连地址>/v1
UPSTREAM_TIMEOUT_MS=600000
IMAGE_JOB_DELIVERY_CLEANUP_MS=3600000
IMAGE_JOB_OWNER_SECRET=<生产固定随机密钥>
FRAME_ANCESTORS="'self' https://ciyuan.fast https://*.ciyuan.fast"
```

`FRAME_ANCESTORS` 控制谁能 iframe 嵌入 `/chat/`。如果你要把这个页面嵌到某个 Cloudflare 域名后台里，要把那个父页面域名加进去。

示例：

```env
FRAME_ANCESTORS="'self' https://example.com https://*.example.com"
```

## 9. 部署后验证

健康检查：

```bash
curl -i https://你的域名/chat-api/health
```

预期：

```json
{"ok":true}
```

创建异步 job：

```bash
curl -i https://你的域名/v1/images/generations \
  -H "Authorization: Bearer <测试Key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"test image","size":"1024x1024","n":1}'
```

预期 HTTP 状态：

```text
202 Accepted
```

轮询 job：

```bash
curl -i https://你的域名/v1/image-jobs/<job_id> \
  -H "Authorization: Bearer <同一个测试Key>"
```

图片访问：

```bash
curl -I https://你的域名/chat-assets/images/<filename>
```

预期：

```text
HTTP/2 200
```

## 10. 最容易踩的坑

- Cloudflare 缓存了 `/v1/image-jobs/*`，导致 job 状态一直不变。
- Nginx 没有代理 `/v1/`，外部异步接口 404。
- Nginx 没有代理 `/chat-assets/`，生图成功但图片 URL 404。
- `IMAGE_API_BASE_URL` 填了 Cloudflare 域名，后端 worker 的长请求仍可能被 Cloudflare 切断。
- 没有固定 `IMAGE_JOB_OWNER_SECRET`，容器重启后新旧进程的 job 查询校验不一致。
- 容器重启会丢内存 job；如果业务要可靠队列，需要后续把 job 状态迁到 Redis 或数据库。
- 图片是临时资源，默认成功查询后 1 小时清理；外部业务拿到 URL 后应尽快下载转存。
