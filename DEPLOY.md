# 词元.fast Chat 部署说明

## 1. 环境要求

- Node.js 24 或更高版本
- npm
- Docker 与 Docker Compose（推荐生产部署使用）
- 一个可访问的 Sub2API/OpenAI 兼容接口地址

## 2. 本地运行

安装依赖：

```bash
npm install
```

启动后端代理：

```bash
npm run dev:server
```

另开一个终端启动前端：

```bash
npm run dev
```

打开：

```text
http://localhost:5173/chat/
```

开发环境中，Vite 会把 `/chat-api` 代理到 `http://localhost:3000`。

## 3. 生产构建检查

部署前建议先执行：

```bash
npm run check
```

这个命令会依次执行：

- 前端 TypeScript 类型检查
- 前端生产构建
- 后端 Node 语法检查

## 4. Docker 部署

编辑 `docker-compose.yml` 中的环境变量：

```yaml
environment:
  SUB2API_BASE_URL: https://ciyuan.fast
  CHAT_COMPLETIONS_ENDPOINT: /v1/chat/completions
  IMAGE_ENDPOINT: /v1/images/generations
  IMAGE_MODEL: ""
  PORT: 3000
  UPSTREAM_TIMEOUT_MS: 600000
```

启动：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
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

访问页面：

```text
http://服务器IP:3000/chat/
```

## 5. Nginx 反向代理

如果对外域名是 `https://ciyuan.fast`，可以把 `deploy/nginx-ciyuan-chat.conf` 里的 `location` 片段放进现有 server 块。

当 Nginx 运行在 Docker 宿主机上，并且容器发布了 `3000:3000`：

```nginx
proxy_pass http://127.0.0.1:3000;
```

当 Nginx 和应用在同一个 Docker Compose 网络里：

```nginx
proxy_pass http://ciyuan-chat:3000;
```

应用需要代理这些路径：

- `/chat`
- `/chat/`
- `/chat-api/`

`/chat-api/` 已关闭 Nginx buffering，便于聊天接口保持流式输出。

## 6. 页面配置

Sub2API 后台自定义菜单 URL 填：

```text
https://ciyuan.fast/chat
```

主题支持 URL 参数：

```text
/chat/?theme=auto
/chat/?theme=light
/chat/?theme=dark
```

## 7. API Key 说明

用户 API Key 只保存在浏览器 `localStorage`，后端代理只做转发，不保存 Key，不记录请求体或响应体。

生产环境建议启用 HTTPS。当前服务端已启用基础 CSP，并允许图片返回 `https:`、`data:`、`blob:` 地址。

## 8. 常见维护命令

更新部署：

```bash
git pull
docker compose up -d --build
```

重启服务：

```bash
docker compose restart ciyuan-chat
```

停止服务：

```bash
docker compose down
```

清理旧镜像：

```bash
docker image prune
```

