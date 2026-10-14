import { getConfig, siteFailOn } from "./config.js";
import { checkTarget, isFailure } from "./monitor.js";
import { getCnameRecord, updateCname, normalizeTarget } from "./dns.js";
import { renderDashboard } from "./dashboard.js";

export default {
  // HTTP 入口：可视化面板 + JSON API + 手动触发检测
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = getConfig(env);

    // 可选的面板访问口令
    if (cfg.dashToken) {
      const token =
        url.searchParams.get("token") || request.headers.get("x-dash-token");
      if (token !== cfg.dashToken) {
        return new Response("401 Unauthorized: 缺少或错误的 DASH_TOKEN", {
          status: 401,
        });
      }
    }

    if (url.pathname === "/api/status") {
      return Response.json(await collectStatus(env, cfg));
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const data = await collectStatus(env, cfg);
      return new Response(renderDashboard(data), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },

  // Cron 入口：周期性检测
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env, getConfig(env)));
  },
};

// ===== D1 存储层 =====
// state 表：每站点一行 JSON（连续失败计数、当前 CNAME、最近一次检测结果）
// checks 表：每次检测一行明细（供 API 查询最近历史），保留 90 天
// daily 表：按 UTC+8 日期桶聚合（供 90 天可用性视图），保留 90 天
// D1 免费额度 10 万行写/天，每分钟 4 站点×3 张表≈1.7 万行/天，无需写入节流

const CACHE_TTL_MS = 25000;
// Worker 实例级内存缓存，面板访问基本不再消耗 D1 读
let memCache = { ts: 0, data: null };

// UTC+8 日期桶键
function dayStr(ts) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
}

// 一次性读出面板所需的全部数据（单批次往返）
async function loadData(db, cfg) {
  const cutoffDay = dayStr(Date.now() - 90 * 86400e3);
  const stmts = [
    db.prepare("SELECT site, json FROM state"),
    db.prepare("SELECT site, day, ok, fail, events FROM daily WHERE day >= ?").bind(cutoffDay),
    ...cfg.sites.map((s) =>
      db
        .prepare("SELECT ts, ok, status, latency_ms, event, error FROM checks WHERE site = ? ORDER BY ts DESC LIMIT ?")
        .bind(s.name, cfg.historyLimit)
    ),
  ];
  const [stateRes, dailyRes, ...histRes] = await db.batch(stmts);

  const states = {};
  for (const r of stateRes.results) {
    if (r.site !== "__meta__") states[r.site] = JSON.parse(r.json);
  }
  const daily = {};
  for (const r of dailyRes.results) {
    const bucket = { ok: r.ok, fail: r.fail };
    if (r.events) bucket.events = JSON.parse(r.events);
    (daily[r.site] ||= {})[r.day] = bucket;
  }
  const histories = {};
  cfg.sites.forEach((s, i) => {
    histories[s.name] = histRes[i].results.map((r) => {
      const e = { ts: r.ts, ok: !!r.ok, status: r.status ?? undefined, latencyMs: r.latency_ms ?? undefined };
      if (r.event) e.event = r.event;
      if (r.error) e.error = r.error;
      return e;
    });
  });
  return { states, histories, daily };
}

// 聚合所有站点状态，供面板与 /api/status 使用
async function collectStatus(env, cfg) {
  const now = Date.now();
  if (!memCache.data || now - memCache.ts > CACHE_TTL_MS) {
    memCache = { ts: now, data: await loadData(env.DB, cfg) };
  }
  const sites = cfg.sites.map((s) => ({
    name: s.name,
    url: s.url,
    icon: s.icon || "",
    recordName: s.recordName,
    nodes: s.nodes || [],
    autoRecover: s.autoRecover !== false,
    state: memCache.data.states[s.name] || {},
    history: memCache.data.histories[s.name] || [],
    daily: memCache.data.daily[s.name] || {},
  }));
  return { generatedAt: memCache.ts, sites };
}

// 全量检测入口：Cron 与手动触发共用
async function runChecks(env, cfg) {
  if (!env.CF_API_TOKEN) {
    console.error("缺少 CF_API_TOKEN，将无法执行 DNS 切换");
  }
  const db = env.DB;
  // 读出全部站点状态（含连续失败计数）
  const stateRes = await db.prepare("SELECT site, json FROM state").all();
  const states = {};
  for (const r of stateRes.results) {
    if (r.site !== "__meta__") states[r.site] = JSON.parse(r.json);
  }
  await Promise.all(
    cfg.sites.map((site) =>
      processSite(env, cfg, site, db, states[site.name] || { consecutiveFailures: 0 }).catch((e) =>
        console.error(`站点 ${site.name} 检测异常:`, e)
      )
    )
  );
  memCache = { ts: 0, data: null }; // 检测后数据已变，使面板缓存失效
  await cleanupOldData(db);
}

// 每天（UTC+8）清理一次 90 天前的明细与聚合数据
async function cleanupOldData(db) {
  const today = dayStr(Date.now());
  const meta = await db.prepare("SELECT json FROM state WHERE site = '__meta__'").first();
  const m = meta ? JSON.parse(meta.json) : {};
  if (m.lastCleanupDay === today) return;
  m.lastCleanupDay = today;
  await db.batch([
    db.prepare("DELETE FROM checks WHERE ts < ?").bind(Date.now() - 90 * 86400e3),
    db.prepare("DELETE FROM daily WHERE day < ?").bind(dayStr(Date.now() - 90 * 86400e3)),
    db
      .prepare("INSERT INTO state (site, json) VALUES ('__meta__', ?) ON CONFLICT(site) DO UPDATE SET json = excluded.json")
      .bind(JSON.stringify(m)),
  ]);
}

// 查询主记录与别名记录（handleWww 时两条并行）；失败不中断流程，错误通过 error 传递
async function lookupCnameRecords(env, site, switchName, aliasName) {
  if (!env.CF_API_TOKEN) return { record: null, aliasRecord: null };
  try {
    const [record, aliasRecord] = await Promise.all([
      getCnameRecord(site.zoneId, switchName, env.CF_API_TOKEN),
      aliasName ? getCnameRecord(site.zoneId, aliasName, env.CF_API_TOKEN) : null,
    ]);
    return { record, aliasRecord };
  } catch (e) {
    return { record: null, aliasRecord: null, error: e };
  }
}

// 单站点：探测 -> 判定 -> 切换/回切 -> 写入 D1
async function processSite(env, cfg, site, db, state) {
  const failOn = siteFailOn(site, cfg);
  const { switchName, aliasName } = wwwPlan(site);

  // 1+2. 并行执行：站点探测与 DNS 记录查询互不依赖
  const [result, dns] = await Promise.all([
    checkTarget(site.url, cfg.timeoutMs),
    lookupCnameRecords(env, site, switchName, aliasName),
  ]);
  const failed = isFailure(result, failOn);
  const entry = {
    ts: Date.now(),
    ok: !failed,
    status: result.status,
    latencyMs: result.latencyMs,
  };
  if (result.error) entry.error = result.error;
  if (dns.error) entry.event = `DNS 查询失败: ${dns.error.message}`;
  const { record, aliasRecord } = dns;
  const currentTarget = record
    ? normalizeTarget(record.content)
    : state.currentTarget || null;
  state.currentTarget = currentTarget;
  if (record) state.proxied = record.proxied;

  // 3. 故障切换 / 恢复回切
  if (failed) {
    state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
    if (record && state.consecutiveFailures >= cfg.failureThreshold) {
      const r = await doFailover(env, cfg, site, record, currentTarget, failOn);
      entry.event = r.message;
      if (r.newTarget) state.currentTarget = normalizeTarget(r.newTarget);
      // 每次切换尝试后重置计数，避免每个周期都调用 API
      state.consecutiveFailures = 0;
    }
  } else {
    state.consecutiveFailures = 0;
    if (record && site.autoRecover !== false && Array.isArray(site.nodes) && site.nodes.length) {
      const primary = site.nodes[0];
      if (normalizeTarget(primary.cname) !== currentTarget) {
        const r = await doRecover(env, cfg, site, record, currentTarget, primary, failOn);
        if (r) {
          entry.event = r.message;
          if (r.newTarget) state.currentTarget = normalizeTarget(r.newTarget);
        }
      }
    }
  }

  // 3.5 www 联动：别名记录（@ 或 www）始终 CNAME 指向主记录
  if (record && aliasRecord) {
    const m = await alignAlias(env, site, aliasRecord, switchName);
    if (m) entry.event = entry.event ? `${entry.event}；${m}` : m;
  }

  // 4. 持久化：检测明细 + 站点状态 + 按日聚合
  state.lastCheck = {
    ts: entry.ts,
    ok: entry.ok,
    status: entry.status,
    latencyMs: entry.latencyMs,
  };
  const day = dayStr(entry.ts);

  // 有事件时先读出当天已有事件，合并后保留最近 3 条
  let eventsJson = null;
  if (entry.event) {
    const row = await db.prepare("SELECT events FROM daily WHERE site = ? AND day = ?").bind(site.name, day).first();
    const events = row && row.events ? JSON.parse(row.events) : [];
    events.push(entry.event);
    eventsJson = JSON.stringify(events.slice(-3));
  }

  await db.batch([
    db
      .prepare("INSERT INTO checks (site, ts, ok, status, latency_ms, event, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(site.name, entry.ts, entry.ok ? 1 : 0, entry.status ?? null, entry.latencyMs ?? null, entry.event || null, entry.error || null),
    db
      .prepare("INSERT INTO state (site, json) VALUES (?, ?) ON CONFLICT(site) DO UPDATE SET json = excluded.json")
      .bind(site.name, JSON.stringify(state)),
    db
      .prepare(
        `INSERT INTO daily (site, day, ok, fail, events) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(site, day) DO UPDATE SET
           ok = daily.ok + excluded.ok,
           fail = daily.fail + excluded.fail,
           events = COALESCE(excluded.events, daily.events)`
      )
      .bind(site.name, day, entry.ok ? 1 : 0, entry.ok ? 0 : 1, eventsJson),
  ]);
}

// 选择下一个健康节点并切换 CNAME
async function doFailover(env, cfg, site, record, currentTarget, failOn) {
  const candidates = (site.nodes || []).filter(
    (n) => normalizeTarget(n.cname) !== currentTarget
  );
  if (!candidates.length) {
    return { message: "探测失败，但没有可切换的备选节点" };
  }

  // 并行探测所有配置了 checkUrl 的候选节点（直到第一个未配置 checkUrl 的节点为止），再按优先级选第一个健康者
  const firstDirect = candidates.findIndex((n) => !n.checkUrl);
  const toCheck = firstDirect === -1 ? candidates : candidates.slice(0, firstDirect);
  const results = await Promise.all(
    toCheck.map((n) => checkTarget(n.checkUrl, cfg.timeoutMs))
  );
  let chosen = null;
  for (let i = 0; i < results.length; i++) {
    if (!isFailure(results[i], failOn)) {
      chosen = toCheck[i];
      break;
    }
  }
  // 未配置 checkUrl 的节点不做健康验证，前面节点全不健康时按优先级直接选用
  if (!chosen && firstDirect !== -1) chosen = candidates[firstDirect];
  if (!chosen) return { message: "所有备选节点均不健康，未执行切换" };

  try {
    await updateCname(site.zoneId, record, chosen.cname, env.CF_API_TOKEN, site.proxied);
    return {
      message: `故障切换: ${currentTarget || record.content} → ${normalizeTarget(chosen.cname)}（${chosen.name || chosen.cname}）${proxiedLabel(site)}`,
      newTarget: chosen.cname,
    };
  } catch (e) {
    return { message: `CNAME 切换失败: ${e.message}` };
  }
}

// 主节点（nodes[0]）恢复健康后自动回切；未配置主节点 checkUrl 时不自动回切
async function doRecover(env, cfg, site, record, currentTarget, primary, failOn) {
  if (!primary.checkUrl) return null;
  const r = await checkTarget(primary.checkUrl, cfg.timeoutMs);
  if (isFailure(r, failOn)) return null;
  try {
    await updateCname(site.zoneId, record, primary.cname, env.CF_API_TOKEN, site.proxied);
    return {
      message: `回切主节点: ${currentTarget} → ${normalizeTarget(primary.cname)}${proxiedLabel(site)}`,
      newTarget: primary.cname,
    };
  } catch (e) {
    return { message: `回切失败: ${e.message}` };
  }
}

// www 联动：别名记录偏离主记录时纠正（如 @ → www.bimg.cc）
async function alignAlias(env, site, aliasRecord, switchName) {
  if (normalizeTarget(aliasRecord.content) === normalizeTarget(switchName)) return null;
  try {
    await updateCname(site.zoneId, aliasRecord, switchName, env.CF_API_TOKEN, site.proxied);
    return `www 联动: ${aliasRecord.name} → ${switchName}`;
  } catch (e) {
    return `www 联动失败: ${e.message}`;
  }
}

// 站点配置了 proxied 时在事件消息中标注代理状态
function proxiedLabel(site) {
  return typeof site.proxied === "boolean"
    ? `，CF代理${site.proxied ? "开启(橙云)" : "关闭(仅DNS)"}`
    : "";
}

// 是否根域记录（如 bimg.cc），仅根域支持 www 子域联动
function isApexName(name) {
  return String(name || "").trim().split(".").length === 2;
}

// 解析 www 联动配置：handleWww 开启后，切换目标写在「主记录」上，另一条记录 CNAME 指向主记录
// wwwFirst（默认 true）：主记录为 www，@ 指向 www；false：主记录为 @，www 指向 @
function wwwPlan(site) {
  if (!site.handleWww || !isApexName(site.recordName)) {
    return { switchName: site.recordName, aliasName: null };
  }
  return site.wwwFirst === false
    ? { switchName: site.recordName, aliasName: "www." + site.recordName }
    : { switchName: "www." + site.recordName, aliasName: site.recordName };
}
