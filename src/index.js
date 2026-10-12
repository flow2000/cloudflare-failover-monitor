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
    if (url.pathname === "/api/run" && request.method === "POST") {
      ctx.waitUntil(runChecks(env, cfg));
      return Response.json({ ok: true, message: "已触发一次全量检测，请稍后刷新" });
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
async function collectStatus(env, cfg) {
  const kv = env.MONITOR_KV;
  const sites = [];
  for (const s of cfg.sites) {
    const state = (await kv.get(`state:${s.name}`, "json")) || {};
    const history = (await kv.get(`history:${s.name}`, "json")) || [];
    sites.push({
      name: s.name,
      url: s.url,
      recordName: s.recordName,
      nodes: s.nodes || [],
      autoRecover: s.autoRecover !== false,
      state,
      history,
    });
  }
  return { generatedAt: Date.now(), sites };
}

// 全量检测入口：Cron 与手动触发共用
async function runChecks(env, cfg) {
  if (!env.CF_API_TOKEN) {
    console.error("缺少 CF_API_TOKEN，将无法执行 DNS 切换");
  }
  await Promise.all(
    cfg.sites.map((site) =>
      processSite(env, cfg, site).catch((e) =>
        console.error(`站点 ${site.name} 检测异常:`, e)
      )
    )
  );
}

// 单站点：探测 -> 判定 -> 切换/回切 -> 写入 KV
async function processSite(env, cfg, site) {
  const kv = env.MONITOR_KV;
  const stateKey = `state:${site.name}`;
  const histKey = `history:${site.name}`;
  const state = (await kv.get(stateKey, "json")) || { consecutiveFailures: 0 };
  const history = (await kv.get(histKey, "json")) || [];
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

  // 4. 写入 KV（历史记录按上限截断）
  history.unshift(entry);
  if (history.length > cfg.historyLimit) history.length = cfg.historyLimit;
  state.lastCheck = {
    ts: entry.ts,
    ok: entry.ok,
    status: entry.status,
    latencyMs: entry.latencyMs,
  };
  await kv.put(stateKey, JSON.stringify(state));
  await kv.put(histKey, JSON.stringify(history));
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
