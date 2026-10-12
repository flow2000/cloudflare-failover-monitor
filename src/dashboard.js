// 可视化监控面板（服务端渲染，自包含 HTML，无外部依赖）

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// 统一按 UTC+8 展示时间
function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(5, 19);
}

function statusBadge(lastCheck) {
  if (!lastCheck || lastCheck.ok === undefined) {
    return `<span class="badge gray">等待检测</span>`;
  }
  return lastCheck.ok
    ? `<span class="badge green">● 正常</span>`
    : `<span class="badge red">● 异常</span>`;
}

function renderNodes(nodes, currentTarget) {
  if (!nodes || !nodes.length) return `<span class="muted">未配置节点</span>`;
  return nodes
    .map((n, i) => {
      const cname = String(n.cname || "").toLowerCase().replace(/\.$/, "");
      const active = cname && cname === String(currentTarget || "").toLowerCase();
      const cls = active ? "node active" : "node";
      const tag = i === 0 ? "主" : `备${i}`;
      return `<span class="${cls}" title="${esc(n.checkUrl || "未配置直连探测")}">${esc(n.name || n.cname)} <em>${tag}</em>${active ? " <b>← 当前</b>" : ""}</span>`;
    })
    .join("");
}

function renderHistory(history) {
  if (!history || !history.length) {
    return `<div class="muted empty">暂无检测记录</div>`;
  }
  const rows = history
    .slice(0, 15)
    .map((h) => {
      const result = h.ok
        ? `<span class="ok">✓ 正常</span>`
        : `<span class="bad">✗ 失败</span>`;
      const status = h.status ? h.status : h.error || "-";
      const event = h.event ? `<span class="event">${esc(h.event)}</span>` : "";
      return `<tr>
        <td>${fmtTime(h.ts)}</td>
        <td>${result}</td>
        <td>${esc(status)}</td>
        <td>${h.latencyMs != null ? h.latencyMs + " ms" : "-"}</td>
        <td>${event}</td>
      </tr>`;
    })
    .join("");
  return `<table>
    <thead><tr><th>时间 (UTC+8)</th><th>结果</th><th>HTTP</th><th>延迟</th><th>事件</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderSite(site) {
  const st = site.state || {};
  const lc = st.lastCheck || {};
  const meta = [
    ["监控地址", site.url],
    ["域名记录", site.recordName],
    ["当前 CNAME", st.currentTarget || "-"],
    ["CF 代理", st.proxied === true ? "已开启（橙云）" : st.proxied === false ? "仅 DNS" : "-"],
    ["连续失败", String(st.consecutiveFailures || 0)],
    ["最近检测", fmtTime(lc.ts)],
    ["最近延迟", lc.latencyMs != null ? lc.latencyMs + " ms" : "-"],
    ["自动回切", site.autoRecover ? "开启" : "关闭"],
  ]
    .map(
      ([k, v]) =>
        `<div class="meta-item"><label>${k}</label><span>${esc(v)}</span></div>`
    )
    .join("");

  return `<section class="card">
    <div class="card-head">
      <h2>${esc(site.name)}</h2>
      ${statusBadge(lc)}
    </div>
    <div class="meta">${meta}</div>
    <div class="nodes">${renderNodes(site.nodes, st.currentTarget)}</div>
    <h3>最近检测记录</h3>
    ${renderHistory(site.history)}
  </section>`;
}

export function renderDashboard(data) {
  const total = data.sites.length;
  const up = data.sites.filter((s) => s.state?.lastCheck?.ok === true).length;
  const down = data.sites.filter((s) => s.state?.lastCheck?.ok === false).length;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Cloudflare 故障切换监控</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; padding: 24px; }
  .container { max-width: 1100px; margin: 0 auto; }
  header.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
  h1 { font-size: 22px; }
  .summary { color: #94a3b8; font-size: 14px; margin-top: 6px; }
  .summary b { color: #e2e8f0; }
  .actions { display: flex; gap: 8px; }
  button { background: #2563eb; color: #fff; border: none; border-radius: 8px; padding: 8px 14px; font-size: 14px; cursor: pointer; }
  button.ghost { background: #1e293b; color: #cbd5f5; border: 1px solid #334155; }
  button:hover { filter: brightness(1.15); }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
  .card-head h2 { font-size: 17px; }
  .badge { font-size: 13px; padding: 4px 10px; border-radius: 999px; }
  .badge.green { background: rgba(34,197,94,.15); color: #4ade80; }
  .badge.red { background: rgba(239,68,68,.15); color: #f87171; }
  .badge.gray { background: rgba(148,163,184,.15); color: #94a3b8; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .meta-item label { display: block; font-size: 12px; color: #64748b; margin-bottom: 2px; }
  .meta-item span { font-size: 13px; word-break: break-all; }
  .nodes { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .node { font-size: 12px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 5px 10px; color: #94a3b8; }
  .node em { font-style: normal; color: #64748b; }
  .node.active { border-color: #2563eb; color: #93c5fd; }
  .node.active b { color: #4ade80; }
  h3 { font-size: 14px; color: #94a3b8; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #334155; }
  th { color: #64748b; font-weight: 500; font-size: 12px; }
  .ok { color: #4ade80; }
  .bad { color: #f87171; }
  .event { color: #fbbf24; }
  .muted { color: #64748b; font-size: 13px; }
  .empty { padding: 12px 0; }
  footer { text-align: center; color: #475569; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<div class="container">
  <header class="top">
    <div>
      <h1>Cloudflare 故障切换监控</h1>
      <div class="summary">
        共 <b>${total}</b> 个站点 · <b style="color:#4ade80">${up}</b> 正常 · <b style="color:#f87171">${down}</b> 异常 ·
        更新时间 ${fmtTime(data.generatedAt)}（30 秒自动刷新）
      </div>
    </div>
    <div class="actions">
      <button class="ghost" onclick="location.reload()">刷新</button>
      <button onclick="runNow(this)">立即检测</button>
    </div>
  </header>
  ${data.sites.map(renderSite).join("") || '<div class="muted">尚未配置站点，请在环境变量 SITES_CONFIG 中添加。</div>'}
  <footer>cloudflare-failover-monitor · Powered by Cloudflare Workers · MIT License</footer>
</div>
<script>
async function runNow(btn) {
  btn.disabled = true;
  btn.textContent = "检测中...";
  const token = new URLSearchParams(location.search).get("token");
  const url = "/api/run" + (token ? "?token=" + encodeURIComponent(token) : "");
  try { await fetch(url, { method: "POST" }); } catch (e) {}
  setTimeout(() => location.reload(), 4000);
}
</script>
</body>
</html>`;
}
