# 词元.fast Chat 部署说明

安全部署优先看 [SECURE_DEPLOY.md](SECURE_DEPLOY.md)。这份文件保留常规部署流程，`SECURE_DEPLOY.md` 额外说明如何让 Sub2API 只允许 Chat 服务器访问。

## 1. 推荐架构

生产环境建议把用户入口和上游 API 分开：

```text
浏览器 -> Cloudflare / 域名 -> Nginx -> ciyuan-chat
ciyuan-chat -> Sub2API 服务器直连地址 -> 上游模型服务
ciyuan-chat -> 生图直连服务器地址 -> 生图上游服务
```

用户访问 `ciyuan-chat` 可以走 Cloudflare；`ciyuan-chat` 访问 Sub2API 和生图接口不要走 Cloudflare 代理域名。这样可以避免长耗时生图请求被 Cloudflare 超时中断，也能把 Sub2API 暴露面收窄到只允许 Chat 服务器访问。

生图在本项目内使用异步 job：浏览器只创建任务并轮询状态，真正的生图长请求由 `ciyuan-chat` 后端 worker 直连上游完成。生成图片会临时保存到 Chat 服务器，并通过 `/chat-assets/images/...` 返回给前端。

项目也提供 OpenAI 风格的对外异步接口：外部调用 `POST /v1/images/generations` 创建生图 job，再用 `GET /v1/image-jobs/:jobId` 轮询结果。外部请求继续使用用户自己的 `Authorization: Bearer <user-api-key>`。

## 2. 环境要求

- Chat 服务器：部署本项目、Nginx、Docker 与 Docker Compose。
- Sub2API 服务器：已运行 Sub2API，并开放给 Chat 服务器的直连端口。
- 生图直连服务器：可以是 Sub2API 同机，也可以是单独服务；关键是 `IMAGE_API_BASE_URL` 不经过 Cloudflare。

仓库根目录可以创建 `.env` 覆盖 `docker-compose.yml` 默认值：

```env
API_BASE_URL=http://<sub2api服务器内网IP或公网IP>:<端口>/v1
IMAGE_API_BASE_URL=http://<生图直连服务器IP或域名>:<端口>/v1
UPSTREAM_TIMEOUT_MS=600000
IMAGE_JOB_DELIVERY_CLEANUP_MS=3600000
IMAGE_JOB_OWNER_SECRET=
FRAME_ANCESTORS="'self' https://ciyuan.fast https://*.ciyuan.fast"
```

如果 Sub2API 和 Chat 在同一台机器，仍可使用默认值：

```env
API_BASE_URL=http://host.docker.internal/v1
```

## 3. 两台服务器直连配置

假设：

```text
Chat 服务器公网/出口 IP：203.0.113.10
Sub2API 服务器内网 IP：10.0.0.20
Sub2API 端口：3000
生图直连服务 IP：10.0.0.30
生图直连端口：3000
```

Chat 服务器的 `.env`：

```env
API_BASE_URL=http://10.0.0.20:3000/v1
IMAGE_API_BASE_URL=http://10.0.0.30:3000/v1
UPSTREAM_TIMEOUT_MS=600000
IMAGE_JOB_DELIVERY_CLEANUP_MS=3600000
IMAGE_JOB_OWNER_SECRET=
```

在 Chat 服务器验证连通性：

```bash
curl -i http://10.0.0.20:3000/v1/models
curl -i http://10.0.0.30:3000/v1/models
```

如果生图接口不是 `/v1/models` 风格，就用你的生图服务健康检查地址替换第二条命令。

## 当前功能同步

- 网页对话模型下拉只展示 Codex 支持模型：`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex`、`gpt-5.2`，避免把 `gpt-4o-mini` 等非 Codex 账号支持模型发到上游。
- 网页生图支持 `n=1..10` 数量批量；`dall-e-3` 自动限制为 `n=1`。
- 网页对话可上传图片；网页生图上传参考图时走异步图片编辑 job。
- 对外异步接口包含 `POST /v1/images/generations` 与 `POST /v1/images/edits`，统一使用 `GET /v1/image-jobs/:jobId` 轮询。
- 上传相关配置：`IMAGE_UPLOAD_TTL_MS`、`IMAGE_UPLOAD_MAX_BYTES`、`IMAGE_UPLOAD_MAX_FILES`、`JSON_BODY_LIMIT`。

## 4. Sub2API 服务器只允许 Chat 服务器访问

用 UFW 的示例：

```bash
ufw allow from 203.0.113.10 to any port 3000 proto tcp
ufw deny 3000/tcp
ufw reload
ufw status numbered
```

用 iptables 的示例：

```bash
iptables -A INPUT -p tcp -s 203.0.113.10 --dport 3000 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

如果 Chat 和 Sub2API 走内网 IP，把 `203.0.113.10` 换成 Chat 服务器访问 Sub2API 时实际使用的内网源 IP。配置后从非 Chat 服务器测试 Sub2API 端口应连接失败。

## 5. Chat 服务器部署

拉取代码：

```bash
cd /opt
git clone https://github.com/jzg-lab/ai_chat_web.git
cd ai_chat_web
```

创建 `.env`：

```bash
cp chat-server/.env.example .env
vi .env
```

启动：

```bash
docker compose up -d --build
```

更新部署：

```bash
cd /opt/ai_chat_web
git pull
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f ciyuan-chat
```

健康检查：

```bash
curl http://127.0.0.1:3000/chat-api/health
```

正常返回：

```json
{"ok":true}
```

## 6. Nginx 反向代理

把下面配置放进你的域名 `server` 块中：

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

检查并重载 Nginx：

```bash
nginx -t && systemctl reload nginx
```

访问：

```text
https://你的域名/chat/
```

## 7. 页面配置

Sub2API 后台自定义菜单 URL 填：

```text
https://你的域名/chat/
```

如果使用 `chat.ciyuan.fast` 子域名，并把它嵌入 `ciyuan.fast` 后台 iframe，`FRAME_ANCESTORS` 需要允许主域页面作为 iframe 父页面。默认配置已经允许：

```text
'self' https://ciyuan.fast https://*.ciyuan.fast
```

主题支持 URL 参数：

```text
/chat/?theme=auto
/chat/?theme=light
/chat/?theme=dark
```

## 8. 本地开发

安装依赖：

```bash
npm install
```

启动后端代理：

```bash
npm run dev:server
```

另开终端启动前端：

```bash
npm run dev
```

打开：

```text
http://localhost:5173/chat/
```

开发环境中，Vite 会把 `/chat-api` 代理到 `http://localhost:3000`。

## 9. 部署前检查

```bash
npm run check
```

这个命令会执行：

- 前端 TypeScript 类型检查
- 前端生产构建
- 后端 Node 语法检查

## 10. 常见维护命令

重启：

```bash
docker compose restart ciyuan-chat
```

停止：

```bash
docker compose down
```

清理旧镜像：

```bash
docker image prune
```
