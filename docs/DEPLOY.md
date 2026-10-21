# 部署指南

从"本地跑通"到"公网可用"，这份文档给出三条路径和完整的安全清单。

> **重要**：这个项目存储的是你的求职数据（公司、岗位、薪资期望、投递进度）。公网部署前，**务必设置访问口令**。

---

## 三种部署方式

| 方式 | 适用场景 | 复杂度 | 需要什么 |
|---|---|---|---|
| **A. 本机直接跑** | 自己一个人用 | 最低 | Node.js 18+ |
| **B. 云服务器 + Nginx** | 手机/多设备访问 | 中 | 一台 Linux 服务器 + 域名（可选） |
| **C. Docker** | 已有容器环境、要隔离 | 中 | Docker |

---

## 方式 A：本机直接跑

```bash
cd job-matcher
node src/server.js
```

访问 http://127.0.0.1:7788

**特点**：只监听 `127.0.0.1`，外部无法访问。不需要口令。这是最安全的用法，推荐大多数人用这个。

想换端口：

```bash
JOB_MATCHER_PORT=9000 node src/server.js
```

---

## 方式 B：云服务器 + Nginx（推荐公网部署）

### 前置条件

- Linux 服务器（Ubuntu 20.04+ / Debian 11+ / CentOS 8+ 均可）
- 已安装 Node.js 18+ 和 Nginx
- 一个指向该服务器的域名（用 HTTPS 强烈建议；仅 IP 访问也能跑但会明文传输）

### 步骤 1：安装 Node.js

如果服务器没有 Node.js：

```bash
# 用 NodeSource 官方源安装 Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证
node --version   # 应 >= v18
```

### 步骤 2：上传代码

```bash
# 在本机执行
rsync -avz --exclude 'data/jobs.json' --exclude 'data/ai-config.json' \
  ./job-matcher/ user@your-server:/opt/job-matcher/
```

或在服务器上直接 clone：

```bash
sudo mkdir -p /opt/job-matcher
sudo chown $USER:$USER /opt/job-matcher
git clone <your-repo-url> /opt/job-matcher
cd /opt/job-matcher
```

> 注意排除 `data/jobs.json`（你的私人数据），不要把本地数据带上服务器。

### 步骤 3：生成访问口令

```bash
openssl rand -hex 16
# 输出类似：a3f8c21e9b7d4f6a1c2e8d9b0f3a7c5e
```

**把这个口令存到密码管理器**。

### 步骤 4：配置 systemd 服务

创建 `/etc/systemd/system/job-matcher.service`：

```ini
[Unit]
Description=Job Matcher
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/job-matcher

# ── 核心配置 ──
Environment=NODE_ENV=production
Environment=JOB_MATCHER_PORT=7788
Environment=JOB_MATCHER_HOST=127.0.0.1

# ── 访问口令（必须）──
Environment=JOB_MATCHER_TOKEN=替换成你的随机口令

# ── AI 配置（可选，二选一）──
# 方案 1：OpenRouter 免费模型
# Environment=JOB_MATCHER_PROVIDER=openrouter
# Environment=OPENROUTER_API_KEY=sk-or-v1-xxx
# Environment=JOB_MATCHER_MODEL=meta-llama/llama-3.3-70b-instruct:free
#
# 方案 2：NVIDIA NIM
# Environment=JOB_MATCHER_PROVIDER=nvidia
# Environment=NVIDIA_API_KEY=nvapi-xxx

# ── 配额与限流 ──
Environment=JOB_MATCHER_AI_DAILY_LIMIT=200
Environment=JOB_MATCHER_RATE_LIMIT=120

ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5s

# ── 安全加固 ──
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/job-matcher/data

[Install]
WantedBy=multi-user.target
```

> **权限提示**：如果服务器上已有其它服务，`www-data` 用户可能没有 `/opt/job-matcher` 的写权限。执行：
> ```bash
> sudo mkdir -p /opt/job-matcher/data
> sudo chown -R www-data:www-data /opt/job-matcher/data
> ```

启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now job-matcher
sudo systemctl status job-matcher
```

看日志：

```bash
sudo journalctl -u job-matcher -f
```

### 步骤 5：配置 Nginx 反向代理

创建 `/etc/nginx/sites-available/job-matcher`：

```nginx
server {
    listen 80;
    server_name matcher.yourdomain.com;   # 换成你的域名；没有域名就用服务器 IP

    # 日志
    access_log /var/log/nginx/job-matcher.access.log;
    error_log  /var/log/nginx/job-matcher.error.log;

    # ── 请求体大小（要能装下一批 JD 文本）──
    client_max_body_size 8m;

    # ── 限流：每 IP 每分钟 120 次 ──
    # 先在 http{} 块里定义 zone，见下方说明
    limit_req zone=jobmatcher burst=30 nodelay;
    limit_req_status 429;

    location / {
        proxy_pass http://127.0.0.1:7788;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # AI 接口可能响应较慢（免费模型），超时放宽
        proxy_connect_timeout 10s;
        proxy_send_timeout    120s;
        proxy_read_timeout    120s;
    }

    # 健康检查不记日志、不限流
    location = /api/health {
        access_log off;
        proxy_pass http://127.0.0.1:7788;
    }
}
```

在 `/etc/nginx/nginx.conf` 的 `http { }` 块内添加限流 zone：

```nginx
http {
    # ... 已有的配置 ...

    limit_req_zone $binary_remote_addr zone=jobmatcher:10m rate=120r/m;
}
```

启用站点：

```bash
sudo ln -s /etc/nginx/sites-available/job-matcher /etc/nginx/sites-enabled/
sudo nginx -t          # 检查配置语法
sudo systemctl reload nginx
```

### 步骤 6：配置 HTTPS（强烈建议）

用 Let's Encrypt 免费证书：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d matcher.yourdomain.com
```

certbot 会自动改 Nginx 配置并设置自动续期。

**为什么必须上 HTTPS**：口令和你的 JD 内容都会经过网络传输，HTTP 下是明文。

### 步骤 7：防火墙

只开放必要端口：

```bash
# Ubuntu (ufw)
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP（用于跳转和证书验证）
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable

# 确认 7788 没有对外暴露
sudo ufw status
```

> **关键**：Node 服务监听 `127.0.0.1:7788`，只接受本机连接。外部只能通过 Nginx 访问。不要在 `JOB_MATCHER_HOST` 里写 `0.0.0.0`。

### 步骤 8：验证

```bash
# 1. 服务健康
curl -s https://matcher.yourdomain.com/api/health

# 2. 未登录访问应被拒
curl -s https://matcher.yourdomain.com/api/jobs
# 期望：{"error":"请先登录","needLogin":true}

# 3. 用口令访问
curl -s -H "Authorization: Bearer 你的口令" \
  https://matcher.yourdomain.com/api/jobs
# 期望：正常返回岗位列表
```

浏览器打开域名，输入口令即可使用。

---

## 方式 C：Docker

### Dockerfile

在项目根目录创建 `Dockerfile`：

```dockerfile
FROM node:20-alpine

WORKDIR /app

# 零依赖项目，只需要复制源码
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY data/presets/ ./data/presets/

# 数据目录用 volume 挂载，不在镜像里
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV JOB_MATCHER_PORT=7788
ENV JOB_MATCHER_HOST=0.0.0.0

EXPOSE 7788

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:7788/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
```

> 注意容器内必须监听 `0.0.0.0` 才能被宿主机访问；此时**不要直接映射到公网**，而是通过 Docker 网络由 Nginx 访问，或映射到 `127.0.0.1:7788:7788`。

### docker-compose.yml

```yaml
services:
  job-matcher:
    build: .
    container_name: job-matcher
    restart: unless-stopped
    ports:
      # 只绑定到本机回环，由宿主机 Nginx 反代
      - "127.0.0.1:7788:7788"
    environment:
      JOB_MATCHER_TOKEN: ${JOB_MATCHER_TOKEN}
      JOB_MATCHER_AI_DAILY_LIMIT: "200"
      # AI（可选）
      JOB_MATCHER_PROVIDER: ${JOB_MATCHER_PROVIDER:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      NVIDIA_API_KEY: ${NVIDIA_API_KEY:-}
      JOB_MATCHER_MODEL: ${JOB_MATCHER_MODEL:-}
    volumes:
      # 数据持久化
      - ./data:/app/data
    mem_limit: 256m
    security_opt:
      - no-new-privileges:true
```

`.env` 文件（不要提交到 git）：

```bash
JOB_MATCHER_TOKEN=你的随机口令
JOB_MATCHER_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-xxx
JOB_MATCHER_MODEL=meta-llama/llama-3.3-70b-instruct:free
```

启动：

```bash
docker compose up -d
docker compose logs -f
```

---

## 安全清单（公网部署必查）

部署完成后逐项确认：

- [ ] **设置了 `JOB_MATCHER_TOKEN`**（否则任何人都能用你的 AI Key）
- [ ] **`JOB_MATCHER_HOST` 保持 `127.0.0.1`**，Node 不直接对外
- [ ] **配了 HTTPS**，口令和 JD 内容不明文传输
- [ ] **防火墙只开 22/80/443**，7788 未对外开放
- [ ] **API Key 走环境变量**，没有落到文件里
- [ ] **Nginx 配了 `limit_req`**，防止接口被刷
- [ ] **设置了 `JOB_MATCHER_AI_DAILY_LIMIT`**，防止账单失控
- [ ] **`data/jobs.json` 没有被提交到公开仓库**
- [ ] **`.gitignore` 生效**，`data/*.json`、`.env*` 都被排除
- [ ] 服务器 `data/` 目录权限正确（只有服务用户可写）

自查命令：

```bash
# 确认数据和密钥没进 git
git status --ignored | grep -E "jobs.json|ai-config|\.env"

# 确认没有硬编码的 key
grep -rInE "sk-[a-zA-Z0-9]{20,}|nvapi-[a-zA-Z0-9]{20,}" \
  --exclude-dir=.git --exclude-dir=node_modules . || echo "✓ 未发现硬编码密钥"
```

---

## 运维

### 查看日志

```bash
sudo journalctl -u job-matcher -n 100 --no-pager
sudo journalctl -u job-matcher -f          # 实时
```

### 重启与更新

```bash
# 重启
sudo systemctl restart job-matcher

# 更新代码
cd /opt/job-matcher
git pull
sudo systemctl restart job-matcher
```

### 备份数据

```bash
# 数据全在 data/ 目录，直接打包
tar -czf ~/job-matcher-backup-$(date +%F).tar.gz \
  -C /opt/job-matcher data/

# 定时备份（每天 3 点）
crontab -e
# 添加：0 3 * * * tar -czf /home/user/backup/jm-$(date +\%F).tar.gz -C /opt/job-matcher data/
```

### 数据重置于

```bash
sudo systemctl stop job-matcher
sudo rm -f /opt/job-matcher/data/jobs.json
sudo systemctl start job-matcher
```

---

## 资源占用参考

实测数据（单用户，几十个岗位）：

| 指标 | 数值 |
|---|---|
| 内存 | 约 40-60 MB（Node 进程） |
| CPU | 空闲时接近 0 |
| 磁盘 | 代码约 250 KB，数据每 100 个岗位约 300 KB |
| 依赖 | **零第三方包**，不需要 `node_modules` |

这意味着它几乎可以跑在任何机器上，包括 1 核 512MB 的最低配服务器。

---

## 常见问题

**Q：为什么不用 PM2？**

systemd 是系统级方案，开机自启、日志、重启策略都原生支持，比 PM2 少一层依赖。如果你已经用 PM2 管别的服务，改用 PM2 也完全可以：

```bash
pm2 start src/server.js --name job-matcher
pm2 save
```

**Q：能不能多用户共用？**

当前是单用户设计，没有多租户隔离。所有人共享同一份 `data/jobs.json` 和同一个口令。如果要多用户，需要改造 `store.js` 加入用户维度。

**Q：服务器磁盘很小怎么办？**

本项目代码只有约 250 KB，数据每百个岗位约 300 KB，几乎不占空间。注意不要装 `node_modules`（不需要），也不要在这个目录放别的东西。

**Q：能不能用 SQLite？**

可以。数据层集中在 `src/store.js`，替换这一层即可。当前用 JSON 是为了零依赖和可读性。
