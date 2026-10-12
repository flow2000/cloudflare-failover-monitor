# cloudflare-failover-monitor

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)

基于 **Cloudflare Workers** 的多站点、多节点可用性监控与自动故障切换系统。

当监控到网站无法访问（返回 **4XX** 等失败响应）时，自动调用 Cloudflare API（API Token 鉴权）将域名的 **CNAME 记录切换到备用节点**；主节点恢复后自动回切。内置可视化 Web 面板，随时查看监控详情。

## 功能特性

- **多站点**：一个 Worker 同时监控任意多个网站，互不影响
- **多节点**：每个站点支持 1 个主节点 + 任意多个备用节点，按优先级切换，切换前可先验证节点健康度
- **自动切换**：连续失败达到阈值后，通过 Cloudflare API 自动修改 CNAME 指向健康节点
- **自动回切**：主节点恢复健康后自动切回（可开关）
- **可视化面板**：内置 Web Dashboard，展示站点状态、当前节点、检测历史、切换事件，30 秒自动刷新
- **环境变量驱动**：所有配置（站点、节点、阈值、超时等）均通过环境变量注入，零改码部署
- **JSON API**：`/api/status` 输出全部监控数据，方便接入第三方告警（如 Uptime Kuma、企业微信、Telegram Bot）

## 工作原理

```
┌─────────────┐   Cron（每分钟）   ┌──────────────────────────┐
│  Cloudflare │ ───────────────▶ │  Worker: runChecks        │
│   Cron      │                   │  1. 探测所有站点 URL        │
└─────────────┘                   │  2. 4XX/5XX/超时 → 记失败   │
                                  │  3. 连续失败 ≥ 阈值          │
                                  └───────────┬──────────────┘
                                              │
                          ┌───────────────────▼───────────────┐
                          │  选择健康备用节点（验证 checkUrl）   │
                          │  Cloudflare API 更新 CNAME 记录     │
                          └───────────────────┬───────────────┘
                                              │
                                  ┌───────────▼──────────────┐
                                  │  状态与历史写入 Workers KV │
                                  │  Dashboard / API 读取展示  │
                                  └──────────────────────────┘
```

**恢复流程**：站点 CNAME 指向备用节点期间，Worker 会持续通过主节点的 `checkUrl`（直连探测地址）验证其健康度，主节点恢复后自动将 CNAME 回切。

## 快速开始

### 前置要求

- Node.js ≥ 18
- Cloudflare 账号，且被监控域名的 **DNS 托管在 Cloudflare**
- 一个具备 DNS 编辑权限的 **API Token**（见下文）

### 1. 克隆并安装

```bash
git clone https://github.com/flow2000/monitoring-web.git
cd monitoring-web
npm install
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv namespace create MONITOR_KV
```

将输出的 `id` 填入 [wrangler.toml](wrangler.toml) 的 `[[kv_namespaces]]` 中。

### 3. 创建 Cloudflare API Token

Cloudflare 控制台 → 右上角头像 → **My Profile → API Tokens → Create Token**：

| 权限 | 资源 |
|---|---|
| `Zone - DNS - Edit` | 包含被监控域名的 Zone（或 All zones）|
| `Zone - Zone - Read` | 同上 |
| `Account - Workers KV Storage - Edit` | 本账号（用于读写监控状态与历史）|

创建后注入为 secret（**不要写进 wrangler.toml**）：

```bash
npx wrangler secret put CF_API_TOKEN
```

**验证 Token 是否可用**：

```bash
# 用户级 Token（My Profile 里创建的常规 Token）
curl -H "Authorization: Bearer <Token>" https://api.cloudflare.com/client/v4/user/tokens/verify

# 账户级 Token（cfat_ 前缀，Account API Tokens 里创建），需改用账户接口
curl -H "Authorization: Bearer <Token>" https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/tokens/verify

# 验证 DNS 读取权限（应返回记录列表而非 403）
curl -H "Authorization: Bearer <Token>" "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records?type=CNAME"
```

返回 `"status":"active"` 即有效。注意：`cfat_` 前缀的账户级 Token 调用 `/user/tokens/verify` 会返回 401，属于接口路径不对，并非 Token 失效。

### 4. 配置站点

编辑 `wrangler.toml` 的 `[vars]`，把 `SITES_CONFIG` 改成你的站点（JSON 数组，**单行**）：

```toml
[vars]
SITES_CONFIG = '[{"name":"主站","url":"https://www.example.com/","zoneId":"你的ZoneID","recordName":"www.example.com","autoRecover":true,"nodes":[{"name":"节点A","cname":"origin-a.example.com","checkUrl":"https://origin-a.example.com/health"},{"name":"节点B","cname":"origin-b.example.com","checkUrl":"https://origin-b.example.com/health"}]}]'
```

### 5. 部署

```bash
npm run deploy
```

部署完成后访问 Worker 域名即可打开监控面板：

```
https://cf-failover-monitor.<你的子域>.workers.dev
```

> 建议在 Workers 设置中为 Worker 绑定自定义域名，并配置 `DASH_TOKEN` 防止面板公开。

## 配置说明

### 环境变量

| 变量 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `CF_API_TOKEN` | secret | **必填** | Cloudflare API Token（Zone.DNS Edit 权限） |
| `SITES_CONFIG` | var | `[]` | 站点配置，JSON 数组，见下表 |
| `FAIL_ON` | var | `4xx,5xx,error` | 失败判定规则，逗号分隔：`4xx` / `5xx` / `error`（网络错误与超时） |
| `FAILURE_THRESHOLD` | var | `2` | 连续失败多少次后触发切换（防抖动） |
| `CHECK_TIMEOUT_MS` | var | `8000` | 单次探测超时时间（毫秒） |
| `HISTORY_LIMIT` | var | `50` | 每个站点保留的历史记录条数 |
| `DASH_TOKEN` | secret/var | 空 | 面板访问口令，设置后需 `?token=xxx` 访问 |

### SITES_CONFIG 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 站点名称（面板展示、KV 键名使用，需唯一） |
| `url` | 是 | 监控探测地址，返回 4XX/5XX 即判定故障 |
| `zoneId` | 是 | 域名所在 Zone 的 ID（Cloudflare 控制台域名概览页右下角） |
| `recordName` | 是 | 要切换的 CNAME 记录完整名称，如 `www.example.com` |
| `nodes` | 是 | 节点数组，**第一个为主节点**，其余按顺序为备选 |
| `nodes[].name` | 否 | 节点显示名 |
| `nodes[].cname` | 是 | 该节点的 CNAME 目标，如 `origin-a.example.com` |
| `nodes[].checkUrl` | 否 | 节点直连探测地址。配置后：切换前先验证该节点健康；主节点配置后才有自动回切能力 |
| `autoRecover` | 否 | 主节点恢复后是否自动回切，默认 `true` |
| `proxied` | 否 | 切换/回切时是否开启 Cloudflare 代理（橙云）：`true` / `false`；不填则保持记录当前代理状态不变 |
| `failOn` | 否 | 站点级失败判定规则，覆盖全局 `FAIL_ON`，如 `["4xx","error"]` |

### 完整示例（2 个站点 × 多节点）

```json
[
  {
    "name": "官网",
    "url": "https://www.example.com/",
    "zoneId": "abc123",
    "recordName": "www.example.com",
    "autoRecover": true,
    "proxied": true,
    "nodes": [
      { "name": "香港主节点", "cname": "hk-origin.example.com", "checkUrl": "https://hk-origin.example.com/health" },
      { "name": "日本备用", "cname": "jp-origin.example.com", "checkUrl": "https://jp-origin.example.com/health" },
      { "name": "CF Pages 兜底", "cname": "backup.pages.dev" }
    ]
  },
  {
    "name": "博客",
    "url": "https://blog.example.com/",
    "zoneId": "abc123",
    "recordName": "blog.example.com",
    "failOn": ["4xx", "error"],
    "nodes": [
      { "name": "VPS", "cname": "vps.example.com", "checkUrl": "https://vps.example.com/" },
      { "name": "GH Pages", "cname": "you.github.io" }
    ]
  }
]
```

## 可视化面板与 API

| 路径 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 监控面板（30 秒自动刷新，含"立即检测"按钮） |
| `/api/status` | GET | 全部站点状态与历史记录的 JSON |
| `/api/run` | POST | 手动触发一次全量检测（异步执行） |

面板展示内容：站点健康状态、当前 CNAME 节点、连续失败次数、最近延迟、节点列表（高亮当前生效节点）、最近 15 条检测记录与切换事件。

## 本地开发

```bash
# 创建 .dev.vars 存放本地 secret（已被 .gitignore 忽略）
# 注意必须是 KEY=value 标准格式（冒号格式 wrangler 无法解析）
echo "CF_API_TOKEN=你的Token" > .dev.vars

npm run dev        # 本地运行（cron 可用 "curl http://localhost:8787/__scheduled?cron=*+*+*+*+*" 触发）
npm run tail       # 查看线上实时日志
```

## 常见问题

**Q：切换后多久生效？**
若记录开启 Cloudflare 代理（橙色云），CNAME 变更即刻生效；若为仅 DNS 模式，取决于 TTL，建议把 TTL 调低（如 60s）。

**Q：为什么一直不切换？**
按顺序排查：① `CF_API_TOKEN` 是否注入且权限正确；② 连续失败次数是否达到 `FAILURE_THRESHOLD`；③ `npm run tail` 查看日志中是否有 API 报错；④ 备用节点 `checkUrl` 是否全部不健康（面板事件中会显示"所有备选节点均不健康"）。

**Q：为什么不会自动回切？**
自动回切依赖主节点（`nodes[0]`）配置 `checkUrl` 直连探测地址——因为站点恢复指的是主节点恢复，而站点 URL 此时解析到备用节点，无法反映主节点状态。

**Q：某些站点对探测返回 403 怎么办？**
为目标站点配置一个专门的轻量健康检查路径（如 `/health`），或为该站点设置 `failOn` 覆盖全局规则。

**Q：免费套餐够用吗？**
Workers 免费版每天 10 万次请求、Cron 最小粒度 1 分钟，完全够用；瓶颈在 KV 写额度（免费版 1000 次/天）——每站点每分钟约 2 次写（状态 + 历史），3 个站点 ≈ 8600 次/天，会超出免费额度。建议把 Cron 间隔调大（如 `*/5 * * * *`，每 5 分钟），或升级 Workers Paid（$5/月起）。

## License

[MIT](LICENSE) © 2026 cloudflare-failover-monitor contributors
