// 可视化监控面板（服务端渲染，自包含 HTML，无外部依赖）
// 风格仿照 uptime-status 经典状态页：浅色背景 + 渐变横幅 + 时间线条

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
  return d.toISOString().replace("T", " ").slice(5, 16);
}

function fmtFull(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(5, 19);
}

// 由站点 URL 取源站，用于加载 favicon
function siteOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// 整体状态等级：0 全部正常 / 1 有未知 / 3 有异常
function overallLevel(sites) {
  if (!sites.length) return 1;
  if (sites.some((s) => s.state?.lastCheck?.ok === false)) return 3;
  if (sites.some((s) => s.state?.lastCheck?.ok === undefined)) return 1;
  return 0;
}

const LEVEL_TITLE = {
  0: "所有服务运行正常",
  1: "监控数据加载中",
  3: "部分服务出现异常",
};

function statusText(lastCheck) {
  if (!lastCheck || lastCheck.ok === undefined) {
    return `<span class="status unknow">未知</span>`;
  }
  return lastCheck.ok
    ? `<span class="status ok">正常</span>`
    : `<span class="status down">异常</span>`;
}

// 网站图标：优先源站 /favicon.ico，加载失败回退为首字母圆形图标
function renderFavicon(site) {
  const origin = siteOrigin(site.url);
  const letter = esc(String(site.name || "?").trim().charAt(0).toUpperCase() || "?");
  if (!origin) return `<span class="favicon noicon"><b>${letter}</b></span>`;
  return `<span class="favicon"><img src="${esc(origin)}/favicon.ico" alt="" loading="lazy" onerror="this.remove();this.parentElement.classList.add('noicon')"><b>${letter}</b></span>`;
}

// 时间线条：每根代表一次检测（左旧右新），tooltip 展示详情
function renderTimeline(history) {
  if (!history || !history.length) {
    return `<div class="timeline-empty">暂无检测数据，等待下一轮 Cron 触发</div>`;
  }
  const bars = history
    .slice(0, 30)
    .reverse()
    .map((h) => {
      const tip =
        `${fmtFull(h.ts)} | ` +
        (h.status ? `HTTP ${h.status}` : h.error || "错误") +
        ` | ${h.latencyMs != null ? h.latencyMs + "ms" : "-"}` +
        (h.event ? ` | ${h.event}` : "");
      return `<i class="${h.ok ? "up" : "down"}" title="${esc(tip)}"></i>`;
    })
    .join("");
  return `<div class="timeline">${bars}</div>`;
}

function renderSite(site) {
  const st = site.state || {};
  const lc = st.lastCheck || {};
  const proxiedText =
    st.proxied === true ? "橙云" : st.proxied === false ? "仅DNS" : "-";
  const sub = [
    `当前节点 ${st.currentTarget || "-"}`,
    `CF代理 ${proxiedText}`,
    lc.latencyMs != null ? `延迟 ${lc.latencyMs}ms` : null,
    lc.ts ? `检测于 ${fmtTime(lc.ts)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return `<div class="site">
    <div class="meta">
      ${renderFavicon(site)}
      <span class="name">${esc(site.name)}</span>
      <a class="link" href="${esc(site.url)}" target="_blank" rel="noopener" title="访问站点">↗</a>
      <span class="badge">${esc(site.recordName)}</span>
      ${statusText(lc)}
    </div>
    ${renderTimeline(site.history)}
    <div class="site-sub">${esc(sub)}</div>
  </div>`;
}

export function renderDashboard(data) {
  const total = data.sites.length;
  const up = data.sites.filter((s) => s.state?.lastCheck?.ok === true).length;
  const down = data.sites.filter((s) => s.state?.lastCheck?.ok === false).length;
  const level = overallLevel(data.sites);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>站点监控</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background-color: #f0f2f5; color: #131a26; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.5; }
  a { color: inherit; text-decoration: none; }
  .container { margin: 0 auto; max-width: 980px; padding: 0 20px; width: 100%; }

  /* ===== 渐变横幅 ===== */
  #header { color: #fff; overflow: hidden; padding: 30px 0 140px; position: relative; transition: background .8s ease; width: 100%; }
  #header.level-0 { background: linear-gradient(135deg, #10b981, #059669 50%, #047857); }
  #header.level-1 { background: linear-gradient(135deg, #f59e0b, #d97706 50%, #b45309); }
  #header.level-3 { background: linear-gradient(135deg, #ef4444, #dc2626 50%, #b91c1c); }
  .wave-container { bottom: 0; height: 120px; left: 0; pointer-events: none; position: absolute; right: 0; }
  .wave { bottom: 0; height: 100%; left: 0; position: absolute; width: 200%; }
  .wave path { fill: hsla(0,0%,100%,.15); }
  .wave1 { animation: waveMove 10s linear infinite; }
  .wave1 path { fill: hsla(0,0%,100%,.12); }
  .wave2 { animation: waveMove 14s linear infinite reverse; }
  .wave2 path { fill: hsla(0,0%,100%,.2); }
  .wave3 { animation: waveMove 18s linear infinite; }
  .wave3 path { fill: hsla(0,0%,100%,.3); }
  @keyframes waveMove { from { transform: translateX(0); } to { transform: translateX(-50%); } }

  .header-top { align-items: center; display: flex; justify-content: space-between; position: relative; z-index: 2; }
  .logo { color: #fff; font-size: 20px; font-weight: 700; text-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .banner-content { align-items: center; display: flex; flex-wrap: wrap; gap: 20px; justify-content: space-between; margin-top: 50px; position: relative; z-index: 2; }
  .banner-status { align-items: center; display: flex; gap: 20px; }
  .status-dot { align-items: center; background: hsla(0,0%,100%,.3); border-radius: 50%; display: flex; flex-shrink: 0; height: 50px; justify-content: center; position: relative; width: 50px; }
  .status-dot:before { background: #fff; border-radius: 50%; box-shadow: 0 0 20px hsla(0,0%,100%,.6); content: ""; height: 24px; width: 24px; }
  .status-ring { animation: pulseRing 2.5s ease-out infinite; border: 2px solid hsla(0,0%,100%,.4); border-radius: 50%; height: 50px; left: 50%; position: absolute; top: 50%; transform: translate(-50%,-50%); width: 50px; }
  .status-ring.delay { animation-delay: 1.2s; }
  @keyframes pulseRing { 0% { opacity: 1; transform: translate(-50%,-50%) scale(1); } 100% { opacity: 0; transform: translate(-50%,-50%) scale(1.8); } }
  .status-title { color: #fff; font-size: 32px; font-weight: 700; margin: 0 0 6px; text-shadow: 0 2px 10px rgba(0,0,0,.15); }
  .status-sub { color: hsla(0,0%,100%,.8); font-size: 14px; margin: 0; }
  .banner-info { align-items: center; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); background: hsla(0,0%,100%,.15); border: 1px solid hsla(0,0%,100%,.2); border-radius: 14px; display: flex; gap: 24px; padding: 14px 22px; }
  .info-item { align-items: baseline; display: flex; font-size: 13px; gap: 6px; }
  .info-label { color: hsla(0,0%,100%,.7); }
  .info-value { color: #fff; font-family: SFMono-Regular, Consolas, monospace; font-weight: 600; }
  .refresh-btn { align-items: center; background: hsla(0,0%,100%,.15); border: 1px solid hsla(0,0%,100%,.3); border-radius: 8px; color: #fff; cursor: pointer; display: flex; font-size: 15px; height: 34px; justify-content: center; transition: all .2s ease; width: 34px; }
  .refresh-btn:hover { background: hsla(0,0%,100%,.25); transform: rotate(180deg); }

  /* ===== 白色主卡片 ===== */
  #uptime { background-color: #fff; border-radius: 16px; box-shadow: 0 10px 40px rgba(0,0,0,.12); margin-bottom: 50px; margin-top: -60px; overflow: hidden; position: relative; z-index: 10; }
  .site { border-bottom: 1px solid #e6e7e8; margin: 0 35px; padding: 28px 0; }
  .site:last-child { border-bottom: none; }
  .site .meta { align-items: center; display: flex; }
  .favicon { align-items: center; border-radius: 6px; display: flex; flex-shrink: 0; height: 22px; justify-content: center; margin-right: 10px; overflow: hidden; width: 22px; }
  .favicon img { display: block; height: 100%; object-fit: contain; width: 100%; }
  .favicon b { display: none; }
  .favicon.noicon { background: linear-gradient(135deg, #6366f1, #4f46e5); }
  .favicon.noicon b { color: #fff; display: flex; font-size: 12px; font-weight: 700; }
  .site .name { font-size: 16px; font-weight: 500; }
  .site .link { color: #8492a6; font-size: 13px; margin-left: 8px; opacity: .6; transition: opacity .15s ease; }
  .site .link:hover { opacity: 1; }
  .site .badge { background: #f5f7fa; border-radius: 20px; color: #6b7280; font-family: SFMono-Regular, Consolas, monospace; font-size: 12px; font-weight: 500; margin-left: 10px; padding: 3px 10px; }
  .site .status { font-weight: 500; margin-left: auto; padding-left: 20px; }
  .site .status.ok { color: #3bd672; }
  .site .status.down { color: #de484a; }
  .site .status.unknow { color: #969ea8; }
  .site .status.ok:before { content: "✓ "; }
  .site .status.down:before { content: "✗ "; }
  .site .status.unknow:before { content: "? "; }

  /* ===== 时间线条 ===== */
  .timeline { display: flex; justify-content: space-between; margin: 20px 0 12px; }
  .timeline i { border-radius: 4px; cursor: pointer; flex-grow: 1; height: 30px; margin: 0 1px; transition: transform .15s ease, opacity .15s ease; }
  .timeline i:hover { opacity: .75; transform: scaleY(1.15); }
  .timeline i.up { background: #3bd672; }
  .timeline i.down { background: #de484a; }
  .timeline-empty { color: #969ea8; font-size: 13px; margin: 20px 0 12px; }
  .site-sub { color: #969ea8; font-size: 13px; }

  footer { color: #969ea8; font-size: 13px; padding-bottom: 40px; text-align: center; }
  footer a { color: #6b7280; }
  @media (max-width: 640px) {
    .status-title { font-size: 24px; }
    .site { margin: 0 20px; }
    .banner-info { gap: 14px; padding: 12px 16px; }
  }
</style>
</head>
<body>
<header id="header" class="level-${level}">
  <div class="container">
    <div class="header-top"><span class="logo">站点监控</span></div>
    <div class="banner-content">
      <div class="banner-status">
        <div class="status-dot"><span class="status-ring"></span><span class="status-ring delay"></span></div>
        <div class="status-text">
          <p class="status-title">${LEVEL_TITLE[level]}</p>
          <p class="status-sub">每分钟自动检测 · 故障时自动切换 CNAME 至备用节点</p>
        </div>
      </div>
      <div class="banner-info">
        <div class="info-item"><span class="info-label">监控站点</span><span class="info-value">${total}</span></div>
        <div class="info-item"><span class="info-label">正常</span><span class="info-value">${up}</span></div>
        <div class="info-item"><span class="info-label">异常</span><span class="info-value">${down}</span></div>
        <div class="info-item"><span class="info-label">更新于</span><span class="info-value">${fmtTime(data.generatedAt)}</span></div>
        <button class="refresh-btn" onclick="location.reload()" title="刷新">⟳</button>
      </div>
    </div>
  </div>
  <div class="wave-container">
    <div class="wave wave1"><svg viewBox="0 0 1440 120" preserveAspectRatio="none" style="width:100%;height:100%"><path d="M0,60 C240,100 480,20 720,60 C960,100 1200,20 1440,60 L1440,120 L0,120 Z"/></svg></div>
    <div class="wave wave2"><svg viewBox="0 0 1440 120" preserveAspectRatio="none" style="width:100%;height:100%"><path d="M0,80 C260,40 520,110 780,70 C1040,30 1240,90 1440,70 L1440,120 L0,120 Z"/></svg></div>
    <div class="wave wave3"><svg viewBox="0 0 1440 120" preserveAspectRatio="none" style="width:100%;height:100%"><path d="M0,90 C300,60 600,110 900,85 C1100,70 1300,100 1440,85 L1440,120 L0,120 Z"/></svg></div>
  </div>
</header>
<main class="container">
  <div id="uptime">
    ${data.sites.map(renderSite).join("") || '<div class="site"><div class="timeline-empty">尚未配置站点，请在环境变量 SITES_CONFIG 中添加。</div></div>'}
  </div>
</main>
<footer>Powered by <a href="https://github.com/flow2000/cloudflare-failover-monitor" target="_blank" rel="noopener">cloudflare-failover-monitor</a> · Cloudflare Workers</footer>
</body>
</html>`;
}
