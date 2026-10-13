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

// 聚合所有站点状态，供面板与 /api/status 使用
// 单键存储：所有站点状态与历史合并在一个键，1 次读取代 站点数×2 次读
const DATA_KEY = "mon:data";
const CACHE_TTL_MS = 25000;
// Worker 实例级内存缓存，面板访问基本不再消耗 KV 读
let memCache = { ts: 0, data: null };

async function loadData(kv) {
  const data = (await kv.get(DATA_KEY, "json")) || {};
  data.states ||= {};
  data.histories ||= {};
  data.daily ||= {};
  return data;
}

async function collectStatus(env, cfg) {
  const now = Date.now();
  if (!memCache.data || now - memCache.ts > CACHE_TTL_MS) {
    memCache = { ts: now, data: await loadData(env.MONITOR_KV) };
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
  const kv = env.MONITOR_KV;
  const data = await loadData(kv);
  const results = await Promise.all(
    cfg.sites.map((site) =>
      processSite(env, cfg, site, data).catch((e) => {
        console.error(`站点 ${site.name} 检测异常:`, e);
        return false;
      })
    )
  );
  // 写入策略：有状态变化/事件立即写；否则每 5 分钟心跳写一次
  // 免费套餐每天仅 1000 次写，逐分钟写入会超限
  const changed = results.some(Boolean);
  const now = Date.now();
  if (changed || now - (data.lastWriteAt || 0) >= 300000) {
    data.lastWriteAt = now;
    await kv.put(DATA_KEY, JSON.stringify(data));
  }
  memCache = { ts: now, data };
}

// 单站点：探测 -> 判定 -> 切换/回切 -> 更新内存数据；返回是否有状态变化
async function processSite(env, cfg, site, data) {
  const state = data.states[site.name] || { consecutiveFailures: 0 };
  const history = data.histories[site.name] || [];
  const failOn = siteFailOn(site, cfg);

  // 1. 探测站点
  const result = await checkTarget(site.url, cfg.timeoutMs);
  const failed = isFailure(result, failOn);
  const entry = {
    ts: Date.now(),
    ok: !failed,
    status: result.status,
    latencyMs: result.latencyMs,
  };
  if (result.error) entry.error = result.error;

  // 2. 查询当前 CNAME 记录
  let record = null;
  if (env.CF_API_TOKEN) {
    try {
      record = await getCnameRecord(site.zoneId, site.recordName, env.CF_API_TOKEN);
    } catch (e) {
      entry.event = `DNS 查询失败: ${e.message}`;
    }
  }
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

  // 4. 更新内存数据（历史记录按上限截断），由 runChecks 统一持久化
  const statusChanged = state.lastCheck && state.lastCheck.ok !== entry.ok;
  history.unshift(entry);
  if (history.length > cfg.historyLimit) history.length = cfg.historyLimit;
  state.lastCheck = {
    ts: entry.ts,
    ok: entry.ok,
    status: entry.status,
    latencyMs: entry.latencyMs,
  };
  data.states[site.name] = state;
  data.histories[site.name] = history;

  // 5. 按日聚合（UTC+8 日期桶），保留最近 90 天，供 90 天可用性视图
  const day = new Date(entry.ts + 8 * 3600e3).toISOString().slice(0, 10);
  const daily = (data.daily[site.name] ||= {});
  const bucket = (daily[day] ||= { ok: 0, fail: 0 });
  if (entry.ok) bucket.ok++;
  else bucket.fail++;
  if (entry.event) {
    bucket.events ||= [];
    if (bucket.events.length < 3) bucket.events.push(entry.event);
  }
  const dayKeys = Object.keys(daily).sort();
  while (dayKeys.length > 90) delete daily[dayKeys.shift()];

  return Boolean(statusChanged || entry.event);
}

// 选择下一个健康节点并切换 CNAME
async function doFailover(env, cfg, site, record, currentTarget, failOn) {
  const candidates = (site.nodes || []).filter(
    (n) => normalizeTarget(n.cname) !== currentTarget
  );
  if (!candidates.length) {
    return { message: "探测失败，但没有可切换的备选节点" };
  }

  let chosen = null;
  for (const node of candidates) {
    if (node.checkUrl) {
      // 配置了直连探测地址的节点：先验证健康再切换
      const r = await checkTarget(node.checkUrl, cfg.timeoutMs);
      if (!isFailure(r, failOn)) {
        chosen = node;
        break;
      }
    } else {
      // 未配置 checkUrl 的节点按优先级顺序直接选用
      chosen = node;
      break;
    }
  }
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

// 站点配置了 proxied 时在事件消息中标注代理状态
function proxiedLabel(site) {
  return typeof site.proxied === "boolean"
    ? `，CF代理${site.proxied ? "开启(橙云)" : "关闭(仅DNS)"}`
    : "";
}
