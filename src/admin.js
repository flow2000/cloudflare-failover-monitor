// 可视化管理页：站点配置的增删改查，保存后立即生效（无需重新部署）
// 访问控制：自定义路径（CONFIG_PATH）+ 强密码（CONFIG_TOKEN）双因子

import { isStrongPassword, validateSites } from "./config.js";

// 检查管理功能是否可用
function adminStatus(env) {
  if (!env.CONFIG_PATH) return { enabled: false, reason: "未设置 CONFIG_PATH（自定义路径）" };
  if (!env.CONFIG_TOKEN) return { enabled: false, reason: "未设置 CONFIG_TOKEN（访问密码）" };
  if (!isStrongPassword(env.CONFIG_TOKEN))
    return { enabled: false, reason: "CONFIG_TOKEN 不是强密码（需 ≥12 位，含大小写字母、数字、特殊符号）" };
  return { enabled: true };
}

// 从 query 或 header 取 token 鉴权
function checkAuth(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("x-config-token");
  return token === env.CONFIG_TOKEN;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// 功能禁用提示页
function renderDisabledPage(reason) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>配置管理</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #f0f2f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.08); max-width: 520px; padding: 40px; text-align: center; }
  .icon { color: #f59e0b; font-size: 48px; margin-bottom: 16px; }
  h1 { color: #131a26; font-size: 20px; margin-bottom: 12px; }
  p { color: #6b7280; font-size: 14px; line-height: 1.6; margin-bottom: 8px; }
  code { background: #f3f4f6; border-radius: 4px; color: #dc2626; font-size: 13px; padding: 2px 6px; }
  .step { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-top: 16px; padding: 16px; text-align: left; }
  .step code { background: #e2e8f0; color: #1e293b; display: block; font-size: 12px; margin-top: 6px; padding: 8px; word-break: break-all; }
</style></head><body>
<div class="card">
  <div class="icon">⚠</div>
  <h1>配置管理功能未启用</h1>
  <p>${esc(reason)}</p>
  <div class="step">
    <strong>启用步骤：</strong>
    <code>npx wrangler secret put CONFIG_PATH</code>
    <code>npx wrangler secret put CONFIG_TOKEN</code>
  </div>
  <p style="margin-top:16px;font-size:12px;color:#9ca3af">设置后无需重新部署，刷新本页即可</p>
</div>
</body></html>`;
}

// 密码输入页（未认证时）
function renderAuthPage(path) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>配置管理</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #f0f2f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.08); max-width: 400px; padding: 40px; text-align: center; }
  .icon { color: #6366f1; font-size: 48px; margin-bottom: 16px; }
  h1 { color: #131a26; font-size: 20px; margin-bottom: 24px; }
  input { border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; padding: 10px 14px; width: 100%; }
  input:focus { border-color: #6366f1; outline: none; }
  button { background: #6366f1; border: none; border-radius: 8px; color: #fff; cursor: pointer; font-size: 14px; margin-top: 12px; padding: 10px 24px; width: 100%; }
  button:hover { background: #4f46e5; }
  .err { color: #dc2626; font-size: 13px; margin-top: 8px; display: none; }
</style></head><body>
<div class="card">
  <div class="icon">🔐</div>
  <h1>配置管理</h1>
  <form id="f">
    <input type="password" id="t" placeholder="请输入 CONFIG_TOKEN" autofocus>
    <button type="submit">进入</button>
    <div class="err" id="e">密码错误</div>
  </form>
</div>
<script>
document.getElementById("f").addEventListener("submit", function(e) {
  e.preventDefault();
  var t = document.getElementById("t").value;
  if (!t) return;
  location.href = ${JSON.stringify(path)} + "?token=" + encodeURIComponent(t);
});
</script>
</body></html>`;
}

// 配置管理页（表单式编辑器）
function renderAdminPage(sites, source, path) {
  // 注入 <script> 的 JSON 不能做 HTML 转义（实体不会被解码），只需防 </script> 逃逸
  const sitesJson = JSON.stringify(sites).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>配置管理 - 站点监控</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #f0f2f5; color: #131a26; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.5; }
  .container { margin: 0 auto; max-width: 900px; padding: 20px; }

  /* ===== 顶部横幅 ===== */
  #header { background: linear-gradient(135deg, #6366f1, #4f46e5 50%, #4338ca); color: #fff; padding: 24px 0; margin-bottom: 20px; border-radius: 12px; }
  #header .container { display: flex; align-items: center; justify-content: space-between; }
  .logo { font-size: 20px; font-weight: 700; }
  .source-badge { background: rgba(255,255,255,.2); border-radius: 6px; font-size: 12px; padding: 4px 10px; }
  .source-badge.env { background: rgba(245,158,11,.3); }
  .source-badge.d1 { background: rgba(16,185,129,.3); }

  /* ===== 站点卡片 ===== */
  .site-card { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.06); margin-bottom: 16px; overflow: hidden; }
  .site-header { align-items: center; cursor: pointer; display: flex; justify-content: space-between; padding: 16px 20px; user-select: none; }
  .site-header:hover { background: #f8fafc; }
  .site-title { font-size: 16px; font-weight: 600; }
  .site-url { color: #6b7280; font-size: 13px; margin-left: 12px; }
  .site-actions { display: flex; gap: 8px; }
  .toggle-btn { background: none; border: none; color: #6366f1; cursor: pointer; font-size: 14px; }
  .delete-site-btn { background: #fee2e2; border: none; border-radius: 6px; color: #dc2626; cursor: pointer; font-size: 12px; padding: 4px 10px; }
  .delete-site-btn:hover { background: #fecaca; }
  .site-body { border-top: 1px solid #e5e7eb; display: none; padding: 20px; }
  .site-card.expanded .site-body { display: block; }

  /* ===== 表单字段 ===== */
  .form-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .form-item label { color: #374151; display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px; }
  .form-item input, .form-item select { border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; padding: 8px 10px; width: 100%; }
  .form-item input:focus, .form-item select:focus { border-color: #6366f1; outline: none; }
  .form-item input[type="checkbox"] { width: auto; }
  .form-check { align-items: center; display: flex; gap: 6px; }
  .form-check label { margin-bottom: 0; }

  /* ===== 节点表格 ===== */
  .nodes-section { margin-top: 16px; }
  .nodes-title { color: #374151; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  .nodes-table { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
  .nodes-header { background: #f9fafb; display: grid; font-size: 12px; font-weight: 600; gap: 8px; grid-template-columns: 1fr 2fr 2fr 60px 40px; padding: 8px 12px; }
  .node-row { border-top: 1px solid #e5e7eb; display: grid; gap: 8px; grid-template-columns: 1fr 2fr 2fr 60px 40px; padding: 8px 12px; }
  .node-row input { border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px; padding: 6px 8px; }
  .node-row input:focus { border-color: #6366f1; outline: none; }
  .node-ops { align-items: center; display: flex; gap: 4px; }
  .node-ops button { background: none; border: 1px solid #d1d5db; border-radius: 4px; color: #6b7280; cursor: pointer; font-size: 11px; padding: 2px 6px; }
  .node-ops button:hover { background: #f3f4f6; }
  .node-del { color: #dc2626 !important; }
  .add-node-btn { background: #ede9fe; border: 1px dashed #6366f1; border-radius: 6px; color: #6366f1; cursor: pointer; font-size: 12px; margin-top: 8px; padding: 6px 14px; }
  .add-node-btn:hover { background: #ddd6fe; }

  /* ===== 底部操作栏 ===== */
  .action-bar { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.06); display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 20px; padding: 20px; }
  .btn { border: none; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; padding: 10px 24px; transition: all .15s; }
  .btn-primary { background: #6366f1; color: #fff; }
  .btn-primary:hover { background: #4f46e5; }
  .btn-secondary { background: #f3f4f6; color: #374151; }
  .btn-secondary:hover { background: #e5e7eb; }
  .btn-danger { background: #fee2e2; color: #dc2626; }
  .btn-danger:hover { background: #fecaca; }
  .btn:disabled { cursor: not-allowed; opacity: .5; }

  /* ===== 消息提示 ===== */
  #toast { border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,.15); color: #fff; font-size: 14px; left: 50%; opacity: 0; padding: 12px 24px; position: fixed; top: 20px; transform: translateX(-50%); transition: opacity .3s; z-index: 1000; }
  #toast.show { opacity: 1; }
  #toast.success { background: #10b981; }
  #toast.error { background: #ef4444; }

  .add-site-btn { background: #ede9fe; border: 2px dashed #6366f1; border-radius: 12px; color: #6366f1; cursor: pointer; font-size: 15px; font-weight: 500; padding: 20px; text-align: center; width: 100%; }
  .add-site-btn:hover { background: #ddd6fe; }

  @media (max-width: 640px) {
    .form-grid { grid-template-columns: 1fr; }
    .node-row, .nodes-header { grid-template-columns: 1fr 1fr 1fr 50px 30px; font-size: 11px; }
    .node-row input { font-size: 11px; padding: 4px 6px; }
  }
</style>
</head>
<body>

<header id="header">
  <div class="container">
    <span class="logo">⚙ 配置管理</span>
    <span class="source-badge ${source}">生效来源: ${source === "d1" ? "页面配置" : "wrangler.toml"}</span>
  </div>
</header>

<div class="container">
  <div id="sites-container"></div>
  <button class="add-site-btn" onclick="addSite()">+ 新增站点</button>
  <div class="action-bar">
    <button class="btn btn-primary" onclick="saveConfig()" id="save-btn">💾 保存配置</button>
    <button class="btn btn-secondary" onclick="exportJson()">📋 导出单行 JSON</button>
    <button class="btn btn-danger" onclick="resetConfig()">↩ 恢复为 wrangler.toml</button>
  </div>
</div>

<div id="toast"></div>

<script>
// 初始配置数据（从服务端注入）
var SITES = ${sitesJson};
var API_PATH = ${JSON.stringify(path)};
var TOKEN = new URLSearchParams(location.search).get("token") || "";

// ===== 渲染 =====
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function render() {
  var container = document.getElementById("sites-container");
  container.innerHTML = SITES.map(function(site, i) {
    return renderSite(site, i);
  }).join("");
}

function renderSite(site, i) {
  var expanded = site._expanded !== false ? " expanded" : "";
  var nodes = (site.nodes || []).map(function(n, j) {
    return renderNode(n, i, j);
  }).join("");
  var failOnArr = Array.isArray(site.failOn) ? site.failOn : [];
  var failOnStr = failOnArr.join(",");
  var proxiedVal = site.proxied === true ? "true" : site.proxied === false ? "false" : "";
  var handleWww = site.handleWww ? " checked" : "";
  var wwwFirst = site.wwwFirst !== false ? " checked" : "";
  var autoRecover = site.autoRecover !== false ? " checked" : "";

  return '<div class="site-card' + expanded + '" data-index="' + i + '">' +
    '<div class="site-header" onclick="toggleSite(' + i + ')">' +
      '<div><span class="site-title">' + esc(site.name || "未命名站点") + '</span><span class="site-url">' + esc(site.url || "") + '</span></div>' +
      '<div class="site-actions">' +
        '<button class="delete-site-btn" onclick="event.stopPropagation();deleteSite(' + i + ')">删除</button>' +
        '<button class="toggle-btn">' + (expanded ? "▼ 收起" : "▶ 展开") + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="site-body">' +
      '<div class="form-grid">' +
        '<div class="form-item"><label>名称 *</label><input type="text" data-field="name" value="' + esc(site.name) + '"></div>' +
        '<div class="form-item"><label>监控地址 *</label><input type="url" data-field="url" value="' + esc(site.url) + '" placeholder="https://..."></div>' +
        '<div class="form-item"><label>图标 URL</label><input type="url" data-field="icon" value="' + esc(site.icon || "") + '"></div>' +
        '<div class="form-item"><label>Zone ID *</label><input type="text" data-field="zoneId" value="' + esc(site.zoneId || "") + '"></div>' +
        '<div class="form-item"><label>DNS 记录名 *</label><input type="text" data-field="recordName" value="' + esc(site.recordName || "") + '"></div>' +
        '<div class="form-item"><label>failOn（逗号分隔）</label><input type="text" data-field="failOn" value="' + esc(failOnStr) + '" placeholder="4xx,5xx,error"></div>' +
        '<div class="form-item form-check"><label><input type="checkbox" data-field="handleWww"' + handleWww + '> www 联动（handleWww）</label></div>' +
        '<div class="form-item form-check"><label><input type="checkbox" data-field="wwwFirst"' + wwwFirst + '> www 为主记录（wwwFirst）</label></div>' +
        '<div class="form-item"><label>CF 代理（proxied）</label><select data-field="proxied"><option value=""' + (proxiedVal === "" ? " selected" : "") + '>继承现有</option><option value="true"' + (proxiedVal === "true" ? " selected" : "") + '>橙云（开启）</option><option value="false"' + (proxiedVal === "false" ? " selected" : "") + '>灰云（仅 DNS）</option></select></div>' +
        '<div class="form-item form-check"><label><input type="checkbox" data-field="autoRecover"' + autoRecover + '> 自动回切（autoRecover）</label></div>' +
      '</div>' +
      '<div class="nodes-section">' +
        '<div class="nodes-title">节点列表（顺序即优先级，第 1 个为主节点）</div>' +
        '<div class="nodes-table">' +
          '<div class="nodes-header"><span>节点名</span><span>CNAME 目标</span><span>checkUrl（可选）</span><span>排序</span><span></span></div>' +
          '<div class="nodes-list" data-site="' + i + '">' + nodes + '</div>' +
        '</div>' +
        '<button class="add-node-btn" onclick="addNode(' + i + ')">+ 添加节点</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderNode(node, si, ni) {
  return '<div class="node-row" data-node="' + ni + '">' +
    '<input type="text" data-nfield="name" value="' + esc(node.name || "") + '" placeholder="节点名">' +
    '<input type="text" data-nfield="cname" value="' + esc(node.cname || "") + '" placeholder="xxx.vercel.app">' +
    '<input type="text" data-nfield="checkUrl" value="' + esc(node.checkUrl || "") + '" placeholder="https://...">' +
    '<div class="node-ops">' +
      '<button onclick="moveNode(' + si + ',' + ni + ',-1)" title="上移">↑</button>' +
      '<button onclick="moveNode(' + si + ',' + ni + ',1)" title="下移">↓</button>' +
    '</div>' +
    '<button class="node-del" onclick="deleteNode(' + si + ',' + ni + ')" title="删除">×</button>' +
  '</div>';
}

// ===== 交互操作 =====
function toggleSite(i) {
  SITES[i]._expanded = SITES[i]._expanded === false;
  render();
}

function addSite() {
  SITES.push({ name: "", url: "", zoneId: "", recordName: "", nodes: [{ name: "主节点", cname: "", checkUrl: "" }], _expanded: true });
  render();
}

function deleteSite(i) {
  if (!confirm("确定删除站点「" + (SITES[i].name || "未命名") + "」吗？")) return;
  SITES.splice(i, 1);
  render();
}

function addNode(si) {
  if (!SITES[si].nodes) SITES[si].nodes = [];
  SITES[si].nodes.push({ name: "", cname: "", checkUrl: "" });
  render();
}

function deleteNode(si, ni) {
  SITES[si].nodes.splice(ni, 1);
  render();
}

function moveNode(si, ni, dir) {
  var nodes = SITES[si].nodes;
  var to = ni + dir;
  if (to < 0 || to >= nodes.length) return;
  var tmp = nodes[ni]; nodes[ni] = nodes[to]; nodes[to] = tmp;
  render();
}

// ===== 收集表单数据 =====
function collectData() {
  var cards = document.querySelectorAll(".site-card");
  var result = [];
  cards.forEach(function(card, i) {
    var site = {};
    card.querySelectorAll("[data-field]").forEach(function(input) {
      var field = input.dataset.field;
      var val = input.type === "checkbox" ? input.checked : input.value.trim();
      if (field === "failOn") {
        if (val) site.failOn = val.split(",").map(function(s) { return s.trim().toLowerCase(); }).filter(Boolean);
        else delete site.failOn;
      } else if (field === "proxied") {
        if (val === "true") site.proxied = true;
        else if (val === "false") site.proxied = false;
      } else if (field === "handleWww" || field === "wwwFirst" || field === "autoRecover") {
        if (val) site[field] = true;
        else if (field === "wwwFirst" && site.handleWww) site.wwwFirst = false;
        else if (field === "autoRecover") site.autoRecover = false;
      } else {
        if (val) site[field] = val;
      }
    });
    // 收集节点
    var nodeRows = card.querySelectorAll(".node-row");
    if (nodeRows.length) {
      site.nodes = [];
      nodeRows.forEach(function(row) {
        var node = {};
        row.querySelectorAll("[data-nfield]").forEach(function(input) {
          var v = input.value.trim();
          if (v) node[input.dataset.nfield] = v;
        });
        if (node.cname) site.nodes.push(node);
      });
    }
    if (!site.autoRecover) delete site.autoRecover;
    result.push(site);
  });
  return result;
}

// ===== API 操作 =====
function showToast(msg, type) {
  var t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show " + (type || "success");
  setTimeout(function() { t.className = ""; }, 3000);
}

function saveConfig() {
  var data = collectData();
  var btn = document.getElementById("save-btn");
  btn.disabled = true;
  btn.textContent = "保存中...";
  fetch(API_PATH + "/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-config-token": TOKEN },
    body: JSON.stringify(data),
  })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.ok) {
        showToast("✅ " + res.message);
        setTimeout(function() { location.reload(); }, 1500);
      } else {
        showToast("❌ " + (res.errors || [res.message]).join("；"), "error");
      }
    })
    .catch(function(e) { showToast("❌ 请求失败: " + e.message, "error"); })
    .finally(function() { btn.disabled = false; btn.textContent = "💾 保存配置"; });
}

function resetConfig() {
  if (!confirm("确定要恢复为 wrangler.toml 中的配置吗？页面配置将被删除。")) return;
  fetch(API_PATH + "/api/config", {
    method: "DELETE",
    headers: { "x-config-token": TOKEN },
  })
    .then(function(r) { return r.json(); })
    .then(function(res) {
      if (res.ok) { showToast("✅ " + res.message); setTimeout(function() { location.reload(); }, 1500); }
      else showToast("❌ " + res.message, "error");
    })
    .catch(function(e) { showToast("❌ 请求失败: " + e.message, "error"); });
}

function exportJson() {
  var data = collectData();
  var json = JSON.stringify(data);
  var ta = document.createElement("textarea");
  ta.value = json;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  showToast("✅ 单行 JSON 已复制到剪贴板，可粘贴到 wrangler.toml 备份");
}

// 初始化
render();
</script>
</body>
</html>`;
}

// 统一处理 admin 路由（在 index.js 中被调用）
export async function handleAdmin(request, env, cfg) {
  const url = new URL(request.url);
  const path = cfg.configPath; // 已由 resolveConfig 归一化（确保以 / 开头）
  const sub = url.pathname.slice(path.length); // "" 或 "/api/config"

  // 1. 功能是否启用
  const status = adminStatus(env);
  if (!status.enabled) {
    return new Response(renderDisabledPage(status.reason), {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // 2. 鉴权
  if (!checkAuth(request, env)) {
    return new Response(renderAuthPage(path), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // 3. API 路由
  if (sub === "/api/config") {
    if (request.method === "GET") {
      const row = await env.DB.prepare("SELECT json FROM state WHERE site = '__config__'").first();
      const source = row ? "d1" : "env";
      return Response.json({ source, sites: cfg.sites });
    }
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, message: "请求体必须是 JSON" }, { status: 400 });
      }
      const errors = validateSites(body);
      if (errors.length) {
        return Response.json({ ok: false, errors }, { status: 400 });
      }
      await env.DB.prepare(
        "INSERT INTO state (site, json) VALUES ('__config__', ?) ON CONFLICT(site) DO UPDATE SET json = excluded.json"
      )
        .bind(JSON.stringify(body))
        .run();
      return Response.json({ ok: true, message: "配置已保存，下一轮检测（1 分钟内）起生效" });
    }
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM state WHERE site = '__config__'").run();
      return Response.json({ ok: true, message: "已回退到 wrangler.toml 配置" });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 4. 页面路由（GET /）
  if (request.method === "GET" && (sub === "" || sub === "/")) {
    const row = await env.DB.prepare("SELECT json FROM state WHERE site = '__config__'").first();
    const source = row ? "d1" : "env";
    return new Response(renderAdminPage(cfg.sites, source, path), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return new Response("Not Found", { status: 404 });
}
