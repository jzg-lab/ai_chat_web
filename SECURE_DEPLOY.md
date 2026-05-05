# 安全部署指南：Chat 服务器直连 Sub2API

这份文档用于“两台或三台服务器”部署，并以安全为第一目标：

```text
用户浏览器 -> Cloudflare / 域名 -> Chat 服务器 Nginx -> ciyuan-chat
ciyuan-chat -> Sub2API 服务器直连地址 -> 模型上游
ciyuan-chat -> 生图直连地址 -> 生图上游
```

核心原则：

- 只把 Chat 服务器的 `80/443` 暴露给用户。
- Sub2API 服务器不要对公网开放给所有人，只允许 Chat 服务器的固定 IP 访问。
- `IMAGE_API_BASE_URL` 不走 Cloudflare 代理域名，避免生图长请求被 Cloudflare 超时切断。
- 用户 API Key 只在浏览器 localStorage，Node 代理只转发，不落库、不打印请求体。
- 生图使用异步 job：浏览器轮询 Chat 服务器，长请求由 Chat 后端 worker 直连上游，生成图片经 `/chat-assets/images/` 临时暴露。
- 对外异步接口使用 `/v1/images/generations` 创建 job、`/v1/image-jobs/:jobId` 查询；查询时必须携带同一个用户 Key。

## 1. 规划 IP 和端口

先确认这些值：

```text
Chat 服务器公网 IP：203.0.113.10
Chat 站点域名：https://chat.example.com/chat/

Sub2API 服务器内网 IP：10.0.0.20
Sub2API 监听端口：3000

生图直连服务 IP：10.0.0.30
生图直连端口：3000
```

如果 Chat 和 Sub2API 在同一个内网，优先使用内网 IP。没有内网时才使用 Sub2API 公网 IP，并且必须用防火墙限制来源。

## 2. Sub2API 服务器安全规则

目标：Sub2API 端口只允许 Chat 服务器访问。

### 云厂商安全组

在 Sub2API 服务器的安全组里配置：

```text
入站允许：TCP 3000，来源 203.0.113.10/32
入站拒绝：其他所有 TCP 3000
```

如果 Chat 通过内网访问 Sub2API，把来源改成 Chat 服务器内网 IP。

### UFW 示例

在 Sub2API 服务器执行：

```bash
ufw allow OpenSSH
ufw allow from 203.0.113.10 to any port 3000 proto tcp
ufw deny 3000/tcp
ufw enable
ufw reload
ufw status numbered
```

规则顺序里，允许 Chat IP 的规则要在拒绝端口规则之前。

### firewalld 示例

```bash
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="203.0.113.10/32" port protocol="tcp" port="3000" accept'
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" port protocol="tcp" port="3000" drop'
firewall-cmd --reload
firewall-cmd --list-rich-rules
```

### iptables 示例

```bash
iptables -A INPUT -p tcp -s 203.0.113.10 --dport 3000 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

iptables 规则需要按你的系统方式持久化，例如 `iptables-save`、`netfilter-persistent` 或发行版自带防火墙服务。

## 3. Chat 服务器配置

在 Chat 服务器拉取项目：

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

推荐配置：

```env
API_BASE_URL=http://10.0.0.20:3000/v1
IMAGE_API_BASE_URL=http://10.0.0.30:3000/v1
UPSTREAM_TIMEOUT_MS=600000
IMAGE_JOB_DELIVERY_CLEANUP_MS=3600000
IMAGE_JOB_OWNER_SECRET=
FRAME_ANCESTORS="'self' https://ciyuan.fast https://*.ciyuan.fast"
```

说明：

- `API_BASE_URL` 指向 Sub2API 的直连地址。
- `IMAGE_API_BASE_URL` 指向生图直连地址，不要填 Cloudflare 代理后的域名。
- `UPSTREAM_TIMEOUT_MS=600000` 是 10 分钟，用于放宽长请求。
- `IMAGE_JOB_DELIVERY_CLEANUP_MS=3600000` 表示异步生图成功状态首次回传后，临时图片和 job 默认 1 小时后清理。
- `IMAGE_JOB_OWNER_SECRET` 用于对外 job 查询的 Key 归属 HMAC 校验；留空时进程启动会生成临时 secret。
- `FRAME_ANCESTORS` 控制允许哪些站点把 `/chat/` 嵌入 iframe；不需要 iframe 时可以只保留 `"'self'"`。

启动：

```bash
docker compose up -d --build
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

## 4. Chat 服务器 Nginx

只让公网访问 Nginx 的 `80/443`，不要把 Sub2API 端口暴露到 Chat 域名下。

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

检查并重载：

```bash
nginx -t && systemctl reload nginx
```

## 5. 验证安全边界

### 从 Chat 服务器验证应当能通

```bash
curl -i http://10.0.0.20:3000/v1/models
```

如果 Sub2API 需要鉴权：

```bash
curl -i -H "Authorization: Bearer <你的测试Key>" http://10.0.0.20:3000/v1/models
```

预期：能返回模型列表，或返回 Sub2API 的鉴权错误。关键是网络层能连通。

### 从非 Chat 服务器验证应当不通

在你的本地电脑或另一台服务器测试：

```bash
curl -i --connect-timeout 5 http://<Sub2API公网IP>:3000/v1/models
```

预期：连接超时、被拒绝，或无法访问。不能返回模型列表。

### 从浏览器验证 Chat 页面

访问：

```text
https://你的域名/chat/
```

页面里填写 Key 后，模型列表应能正常读取。若提示模型列表读取失败：

- 浏览器访问的是不是 `/chat/`，不是旧的开发端口。
- Nginx 是否反代了 `/chat-api/`。
- Chat 容器里是否能访问 `API_BASE_URL`。
- Sub2API 防火墙是否允许了 Chat 服务器实际出口 IP。

容器内验证：

```bash
docker compose exec ciyuan-chat wget -S -O- http://10.0.0.20:3000/v1/models
```

## 6. 需要避免的配置

不要这样做：

```text
API_BASE_URL=https://你的Cloudflare域名/v1
IMAGE_API_BASE_URL=https://你的Cloudflare域名/v1
```

原因：

- Chat 服务器调用上游会绕一圈公网和 Cloudflare。
- 生图长请求可能被 Cloudflare 超时。
- Sub2API 更容易被外部扫描和攻击。

也不要把 Sub2API Nginx 直接配成：

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:3000;
}
```

并同时对公网开放。除非你已经在云安全组或防火墙里限制了来源 IP。

## 7. 更新部署

```bash
cd /opt/ai_chat_web
git pull
docker compose up -d --build
docker compose logs -f ciyuan-chat
```

更新后确认：

```bash
curl http://127.0.0.1:3000/chat-api/health
docker compose exec ciyuan-chat wget -S -O- http://10.0.0.20:3000/v1/models
```

## 8. 最小安全检查清单

- Chat 域名只暴露 `80/443`。
- Chat 服务器本机 `3000` 只给 Nginx 反代使用；如非必要，不向公网开放。
- Sub2API 端口只允许 Chat 服务器 IP 访问。
- `API_BASE_URL` 使用 Sub2API 直连地址。
- `IMAGE_API_BASE_URL` 使用生图直连地址，不经过 Cloudflare。
- Nginx `/chat-api/` 已关闭 buffering，并设置较长 timeout。
- Nginx 已代理 `/v1/`，否则对外 OpenAI 风格异步接口不可访问。
- Nginx 已代理 `/chat-assets/`，否则异步生图成功后图片 URL 会 404。
- `.env` 不提交到 Git。
- 部署后从非 Chat 服务器确认 Sub2API 端口无法访问。
