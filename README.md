# cloudflare-failover-monitor

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)

一个跑在 **Cloudflare Workers** 上的网站监控 + 自动故障切换工具。**不要钱、不要服务器**，部署一次，以后它 7×24 帮你盯着网站。

## 它是干嘛的？（人话版）

假设你的网站部署在 Vercel，同时备了一份在 Netlify。某天 Vercel 额度用完/宕机，网站打不开了——

**没有这个工具时**：用户发现打不开 → 找你 → 你睡眼惺忪爬起来登录 Cloudflare 改 DNS → 等生效 → 网站恢复。全程可能几小时。

**有了它之后**：

1. 它**每分钟**访问一次你的网站；
2. 发现**连续 2 次打不开**（约 2 分钟），自动把域名的 CNAME 记录从 Vercel 改到 Netlify；
3. 网站自动恢复，你在面板上能看到一条「故障切换」记录；
4. 等 Vercel 恢复正常后，它再**自动切回去**。

你什么都不用做。面板长这样：

```
┌──────────────────────────────────────────────┐
│  ✓ 所有服务运行正常    站点 4 · 正常 4 · 异常 0 │
├──────────────────────────────────────────────┤
│  🟢 必应壁纸  [bimg.cc] [GET / 1m]        ✓ 正常 │
│  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ │
│  最近 90 天 · 可用率 99.86%      检测于 12:34   │
├──────────────────────────────────────────────┤
│  🔴 个人博客  [blog.example.com] [GET / 1m] ✗ 异常 │
│  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ │
│  最近 90 天 · 可用率 99.92%      检测于 12:34   │
└──────────────────────────────────────────────┘
```

## 使用前，确认 3 个前提

| 前提 | 说明 |
|---|---|
| ✅ 有 Cloudflare 账号 | 免费版即可 |
| ✅ 域名 DNS 托管在 Cloudflare | 即域名的 NS 记录指向 Cloudflare（买域名后改过 DNS 服务器的那种） |
| ✅ 电脑装了 Node.js ≥ 18 | [nodejs.org](https://nodejs.org) 下载 LTS 版即可 |

> ⚠️ 如果域名 DNS 不在 Cloudflare（比如在阿里云/腾讯云解析），这个工具**用不了**——它改 DNS 走的是 Cloudflare API。

## 部署（跟着点，约 10 分钟）

### 第 1 步：把代码弄下来，装好依赖

```bash
git clone https://github.com/flow2000/cloudflare-failover-monitor.git
cd cloudflare-failover-monitor
npm install
```

然后登录 Cloudflare（会弹浏览器，登录授权即可，只需一次）：

```bash
npx wrangler login
```

### 第 2 步：创建一个数据库（存监控记录用）

```bash
npx wrangler d1 create monitor-db
```

命令输出里有一行 `database_id = "xxxxxxxx-xxxx-..."`，**复制这串 ID**，打开项目里的 `wrangler.toml`，粘贴到这里：

```toml
[[d1_databases]]
binding = "DB"
database_name = "monitor-db"
database_id = "粘贴到这里"
```

然后建表（项目自带建表脚本，直接执行）：

```bash
npx wrangler d1 execute monitor-db --remote --file=schema.sql
```

看到 `🌀 Executing ...` 没报错就是成功了。

### 第 3 步：申请一个「改 DNS 用的钥匙」（API Token）

Worker 要靠这把钥匙帮你改 DNS 记录。

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com)，点右上角头像 → **My Profile（我的资料）**
2. 左侧选 **API Tokens（API 令牌）** → 点 **Create Token（创建令牌）**
3. 拉到最下面选 **Custom token（自定义令牌）** → **Get started**
4. 按下面填：

| 项目 | 填什么 |
|---|---|
| Token name | 随便起，如 `failover-monitor` |
| Permissions 第 1 行 | `Zone` — `DNS` — `Edit` |
| Permissions 第 2 行 | `Zone` — `Zone` — `Read` |
| Zone Resources | `Include` — `Specific zone` — 选你要监控的域名（多个域名就 Add more 都选上） |

5. 一路 Continue → **Create Token**，页面会显示一串 Token（只显示这一次，复制好）

把这串 Token 交给 Worker（**永远不要写进 wrangler.toml，也不要提交到 Git**）：

```bash
npx wrangler secret put CF_API_TOKEN
# 提示输入时，粘贴 Token，回车
```

### 第 4 步：告诉它监控哪些网站

配置有两种方式：**网页可视化配置（推荐）** 和手写 wrangler.toml。

#### 方式一：网页可视化配置（推荐）

先设置访问路径和密码（两个 secret，一次就好）：

```bash
npx wrangler secret put CONFIG_PATH     # 自定义路径，如 /cfg-x7k2p9（不要用常见路径）
npx wrangler secret put CONFIG_TOKEN    # 强密码（≥12 位，含大小写字母+数字+特殊符号）
```

**这两个 secret 是什么？**

| Secret | 作用 | 怎么填 |
|---|---|---|
| `CONFIG_PATH` | 配置页的**访问路径**（第一道防线）。别人不知道这个路径，连配置页的登录框都看不到 | 以 `/` 开头的一串随机字符，如 `/cfg-x7k2p9`。不要用 `/admin`、`/config` 这类常见路径；不要告诉别人 |
| `CONFIG_TOKEN` | 配置页的**访问密码**（第二道防线）。即使路径泄露，没有密码也进不去 | 强密码：长度 ≥ 12，**同时**包含小写字母、大写字母、数字、特殊符号 |

> ⚠️ `CONFIG_TOKEN` 不满足强密码规则时，配置功能**整体拒绝启用**（页面会显示"功能未启用"提示），这是故意的安全设计。

**强密码示例**（合格的 ✅ vs 不合格的 ❌）：

```
✅ Kx9#mQ2$vL8pRw3n
✅ Config@2026!Bimg
❌ abc123            （太短、无大写、无符号）
❌ qwertyuiop123     （无大写、无符号）
❌ Aa1234567890      （无特殊符号）
```

懒人可以用命令生成一个随机强密码：

```bash
# PowerShell
-join ((48..57)+(65..90)+(97..122)+(33,35,36,37,38,42,64) | Get-Random -Count 16 | %{[char]$_})
```

设置后**无需重新部署**，直接访问：

```
https://你的workers地址/你的CONFIG_PATH
```

例如路径设的是 `/cfg-x7k2p9`，就访问 `https://cloudflare-failover-monitor.你的子域.workers.dev/cfg-x7k2p9`（收藏这个链接）。

登录流程：输入 `CONFIG_TOKEN` 密码 → 首次登录**绑定验证器 App**（见下方二次验证）→ 进入配置页。

页面提供表单式编辑器：增删站点、编辑字段、调整节点顺序、保存立即生效。页面顶部会显示当前生效来源（`页面配置` = 来自 D1，`wrangler.toml` = 来自环境变量）。

> 💡 保存的配置**优先于** wrangler.toml 中的 `SITES_CONFIG`。想回退？点「恢复为 wrangler.toml」即可。

**二次验证（验证器 App，强制启用）**

配置页在密码之外强制启用 TOTP 二次验证。首次登录时页面会显示二维码，用验证器 App 扫码绑定，输入 App 上的 6 位验证码即完成绑定。之后每次登录需要 **CONFIG_TOKEN + 当前 6 位验证码**。登录状态保留 12 小时，过期后需重新输入。

- **支持的 App**：Google Authenticator、Microsoft Authenticator、1Password、Aegis 等任何支持 TOTP 的验证器；验证码每 30 秒自动轮换
- **换手机**：登录后点右上角「🔑 重置二次验证」，重新扫码即可
- **手机丢了**（无法登录）：在电脑上删除绑定记录，下次登录会重新引导绑定：

```bash
npx wrangler d1 execute monitor-db --remote --command "DELETE FROM state WHERE site='__totp__'"
```

- **验证码总是不对**：多半是手机时间不准，开启系统「自动设置日期与时间」即可

> 🔒 **安全提示**：`CONFIG_PATH` 和 `CONFIG_TOKEN` 都只通过 `wrangler secret` 注入，永远不要写进 `wrangler.toml` 或提交到 Git。二次验证密钥由 Worker 在首次登录时自动随机生成并存入 D1，二维码在浏览器与 Worker 之间直接传输，不经过任何第三方服务。面板首页**不会**显示配置页入口链接。

#### 方式二：手写 wrangler.toml（传统方式）

配置写在 `wrangler.toml` 的 `[vars]` 下的 `SITES_CONFIG`。内容是一个 JSON 数组，每个网站一个对象。先看**格式化版本**，结构一目了然：

```json
[
  {
    "name": "我的博客",
    "url": "https://blog.example.com/",
    "zoneId": "你的ZoneID",
    "recordName": "blog.example.com",
    "nodes": [
      {
        "name": "主节点-Vercel",
        "cname": "my-blog.vercel.app",
        "checkUrl": "https://my-blog.vercel.app/"
      },
      {
        "name": "备用-Netlify",
        "cname": "my-blog.netlify.app",
        "checkUrl": "https://my-blog.netlify.app/"
      }
    ]
  }
]
```

> ⚠️ **注意**：TOML 语法限制，粘贴进 `wrangler.toml` 时整个 JSON **必须压缩成一行**、并用单引号包裹。改完上面内容后，用编辑器（如 VS Code 安装 "JSON minify" 类插件）或 [json.cn](https://www.json.cn) 等在线工具压缩成一行再粘贴：

```toml
[vars]
SITES_CONFIG = '[{"name":"我的博客","url":"https://blog.example.com/","zoneId":"你的ZoneID","recordName":"blog.example.com","nodes":[{"name":"主节点-Vercel","cname":"my-blog.vercel.app","checkUrl":"https://my-blog.vercel.app/"},{"name":"备用-Netlify","cname":"my-blog.netlify.app","checkUrl":"https://my-blog.netlify.app/"}]}]'
```

**每个字段是什么意思**（以上面为例）：

| 字段 | 人话解释 |
|---|---|
| `name` | 面板上显示的名字，随便起 |
| `url` | 它每分钟访问这个地址，能打开（返回 2xx/3xx）就算正常 |
| `zoneId` | 域名在 Cloudflare 的 Zone ID。**在哪找**：Cloudflare 控制台 → 点进你的域名 → 右侧栏下方「API」区域里的 **Zone ID** |
| `recordName` | 要自动切换的那条 CNAME 记录的名字。⚠️ 这条记录必须**已经存在**于 Cloudflare DNS 里，且类型是 CNAME |
| `nodes` | 节点列表，**第 1 个是主节点**，后面的是备胎，按顺序切换 |
| `cname` | 这个节点的 CNAME 目标（Vercel/Netlify 分配给你的那个域名） |
| `checkUrl` | 直连探测地址。**切换前先访问它确认备胎是活的**；主节点填了它，才有「自动切回去」的能力 |

> 💡 **只想监控、不想让它动 DNS** 的站点：`nodes` 里只写当前节点一项即可（没有备胎可切，它就只记录不动作）。

写多个站点就是在数组里加多个对象，用逗号隔开，最后同样压缩成一行再粘贴。

### 第 5 步：部署上线

```bash
npm run deploy
```

成功后终端会显示一个地址，打开它就是监控面板：

```
https://cloudflare-failover-monitor.<你的子域>.workers.dev
```

**到此部署完成。** 它已经开始每分钟帮你盯网站了。

### 第 6 步（强烈建议）：给面板加个密码

面板默认谁都能打开。设个口令：

```bash
npx wrangler secret put DASH_TOKEN
# 输入你想用的密码，回车
```

以后访问面板要带上密码：`https://你的地址/?token=你的密码`（浏览器收藏夹存这个完整链接即可）。

## 面板怎么看

| 界面元素 | 含义 |
|---|---|
| 顶部横幅颜色 | 🟢绿=全部正常 / 🟠橙=数据加载中 / 🔴红=有站点异常 |
| 站点名右侧灰徽标（如 `bimg.cc`） | 当前监控的 DNS 记录名，**点击可直接访问该网站** |
| `GET / 1m` 徽标 | 表示每分钟 GET 探测一次。**鼠标悬停**可看详情：监控地址、记录名、当前 CNAME 指向哪个节点、节点列表 |
| 时间条（90 根小柱子） | 左旧右新，一根 = 一天。绿=当天全部正常；红=当天有故障；灰=当天无数据。**悬停**看当天可用率和切换事件 |
| `✓ 正常` / `✗ 异常` | 最近一次探测结果 |
| 底部「可用率 xx%」 | 最近 90 天的综合可用率 |

页面每 30 秒自动刷新一次。

另有 JSON 接口 `https://你的地址/api/status`（同样要带 token），可以接入 Uptime Kuma、企业微信机器人等第三方告警。

## 日常怎么用

**加一个新站点**：推荐用可视化配置页（设了 `CONFIG_PATH`/`CONFIG_TOKEN` 后直接访问）→ 表单里点「新增站点」→ 填完保存即可，无需重新部署。如果仍用 wrangler.toml：改 `SITES_CONFIG` → `npm run deploy` → 记得新域名要在第 3 步 Token 的授权范围内。

**改阈值/超时**：改 `wrangler.toml` 的 `[vars]` → `npm run deploy`。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FAILURE_THRESHOLD` | `2` | 连续失败几次才切换。调 `1` 切得快（约 1 分钟）但可能误切；调 `3` 更稳但慢 |
| `CHECK_TIMEOUT_MS` | `8000` | 超过 8 秒没响应算失败 |
| `FAIL_ON` | `4xx,5xx,error` | 什么情况算失败 |

**看它在干嘛（实时日志）**：

```bash
npm run tail
```

切换动作、API 报错都会打在这里。

**手动验证切换功能是否正常**（建议部署后做一次）：把主节点的网站临时搞挂（比如在 Vercel 暂停该部署）→ 等 2~3 分钟 → 看面板时间条变红、`GET / 1m` 气泡里 CNAME 目标变成备用节点 → 恢复主节点 → 看它自动切回来。

## 故障切换的完整逻辑（想了解细节再看）

```
每分钟一次 cron：
  访问站点 url
    ├─ 正常 → 连续失败清零
    │         └─ 如果当前指向备胎 且 主节点 checkUrl 能访问 → 切回主节点
    └─ 失败（4xx/5xx/超时/网络错误）→ 连续失败 +1
              └─ 达到 FAILURE_THRESHOLD（默认 2 次）：
                    按 nodes 顺序找备胎：
                      有 checkUrl 的先探测，活的才切
                    调 Cloudflare API 改 recordName 的 CNAME
                    计数清零（下一轮重新计数，避免每分钟狂调 API）
```

几点细节：

- **Vercel 额度耗尽返回 402/429，属于 4xx，会被正确识别为故障**并触发切换。
- 每次切换事件会写进数据库，在时间条和 API 里都能看到（每天最多保留 3 条事件）。
- 检测数据保留最近 90 天，每天自动清理，不用管。
- 切换后若开了 Cloudflare 代理（橙云）即刻生效；仅 DNS（灰云）要等 TTL，建议 TTL 设 60 秒。

## 高级配置（可选）

`SITES_CONFIG` 里每个站点还支持这些字段：

| 字段 | 说明 |
|---|---|
| `icon` | 面板上的网站图标 URL；不填自动用源站 `/favicon.ico`，加载失败显示首字母 |
| `autoRecover` | 主节点恢复后是否自动回切，默认 `true`。设 `false` 则切走后不自动回来 |
| `failOn` | 站点级失败规则，覆盖全局。如 `["4xx","error"]` 表示 5xx 不算故障 |
| `proxied` | 切换时强制设置代理开关：`true` 橙云 / `false` 灰云；不填保持原状 |
| `handleWww` | 仅 `recordName` 是根域（如 `example.com`）时可用。开启后自动管理 `example.com` 和 `www.example.com` 两条记录：切换只改主记录，另一条自动指过去 |
| `wwwFirst` | 配合 `handleWww`：默认 `true`（主记录是 www，@ 指向 www）；`false` 反过来 |

## 常见问题

**Q：为什么一直不切换？**
按顺序查：
1. `npm run tail` 看日志有没有 Cloudflare API 报错（Token 没权限/没注入最常见）；
2. 连续失败要达到 `FAILURE_THRESHOLD` 次才切（默认 2，即故障至少持续约 2 分钟）；
3. 所有备胎的 `checkUrl` 都不健康时不会切（面板事件里会写「所有备选节点均不健康」）；
4. `recordName` 对应的 CNAME 记录必须已存在于 Cloudflare DNS。

**Q：为什么不自动回切？**
自动回切要求主节点（`nodes[0]`）填了 `checkUrl`。原因：站点 url 此时解析到备胎，访问它无法得知主节点是否恢复，必须直连探测主节点。

**Q：免费额度够吗？**
够。Cloudflare Workers 免费版 10 万次请求/天、D1 免费版 10 万行写/天。4 个站点每分钟检测 ≈ 1.7 万行写/天（17%），面板访问有 25 秒内存缓存几乎不耗读。监控 10 个以内站点随便用。

**Q：面板访问很慢/数据有延迟？**
面板数据有 25 秒缓存 + 每分钟才有一次新检测，「更新于」时间落后 1 分钟以内都正常。

**Q：改完 wrangler.toml 没生效？**
`[vars]` 的修改必须 `npm run deploy` 重新部署才生效；secret（CF_API_TOKEN、DASH_TOKEN、CONFIG_PATH、CONFIG_TOKEN）改完立即生效，不用重新部署。

**Q：可视化配置页打不开？**
按顺序查：
1. 确认两个 secret 都设了：`npx wrangler secret put CONFIG_PATH` 和 `CONFIG_TOKEN`；
2. `CONFIG_TOKEN` 必须是强密码（≥12 位，含大小写+数字+符号），否则页面会显示"功能未启用"；
3. 确认访问路径完全正确；
4. 浏览器控制台看有无 JS 报错。

**Q：登录配置页提示「验证码错误或已过期」？**
按顺序查：1）手机时间是否准确（开启「自动设置日期与时间」）；2）是否绑定的是**当前显示**的二维码——中途刷新过登录页的话二维码会重新生成，需用最新的；3）验证码 30 秒一换，输入临期的码可能来不及，等下一轮刷新后再输。实在不行登录后（或用上面丢手机的命令）重置二次验证重新绑定。

**Q：手机丢了进不去配置页怎么办？**
在电脑上执行删除绑定命令（见上方「二次验证」一节），然后重新访问配置页，会重新走扫码绑定流程。

**Q：保存配置后 wrangler.toml 会同步吗？**
不会。可视化配置保存在 D1 数据库里，**优先于** wrangler.toml 生效。点「导出单行 JSON」可复制当前配置，粘贴回 wrangler.toml 做备份。

## License

[MIT](LICENSE) © 2026 cloudflare-failover-monitor contributors
