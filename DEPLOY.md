# 词元.fast Chat 部署说明

## 1. 推荐架构

生产环境建议这样走：

```text
浏览器 -> Cloudflare / 域名 -> Nginx -> ciyuan-chat
ciyuan-chat -> 同机 Sub2API -> 上游模型服务
```

也就是说，用户访问入口可以走 Cloudflare，但 `ciyuan-chat` 调用 Sub2API 时默认走服务器本机地址，避免在同一台服务器上绕公网域名和 Cloudflare。

## 2. 环境要求

- Docker 与 Docker Compose
- 已运行的 Sub2API 服务
- Sub2API 在宿主机上能通过 `http://127.0.0.1` 访问

当前 `docker-compose.yml` 已默认配置：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
environment:
  SUB2API_BASE_URL: http://host.docker.internal
```

如果你的 Sub2API 不在同一台服务器，请把 `SUB2API_BASE_URL` 改成实际可访问的内网或公网地址。

## 3. 服务器部署

拉取代码：

```bash
cd /opt
git clone https://github.com/jzg-lab/ai_chat_web.git
cd ai_chat_web
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

## 4. 验证 Sub2API 连通性

在宿主机上测试：

```bash
curl -i http://127.0.0.1/v1/models
```

在 chat 容器里测试：

```bash
docker compose exec ciyuan-chat wget -S -O- http://host.docker.internal/v1/models
```

如果宿主机能通、容器不通，检查 Docker 版本是否支持 `host-gateway`。如果 Sub2API 不在宿主机 80 端口，请修改 `SUB2API_BASE_URL`。

## 5. 临时直连访问

用于测试时，可以直接访问：

```text
http://服务器IP:3000/chat/
```

这只是临时测试入口。生产环境更推荐走域名和 Nginx 的 80/443。

## 6. Nginx 反向代理

把下面配置放进你的域名 server 块中：

```nginx
location /chat {
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

