// 解析环境变量中的应用配置
export function getConfig(env) {
  let sites = [];
  try {
    const parsed = JSON.parse(env.SITES_CONFIG || "[]");
    if (Array.isArray(parsed)) sites = parsed;
  } catch (e) {
    console.error("SITES_CONFIG 解析失败:", e.message);
  }
  return {
    sites,
    failOn: (env.FAIL_ON || "4xx,5xx,error")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    timeoutMs: parseInt(env.CHECK_TIMEOUT_MS || "8000", 10),
    failureThreshold: Math.max(1, parseInt(env.FAILURE_THRESHOLD || "2", 10)),
    historyLimit: Math.max(10, parseInt(env.HISTORY_LIMIT || "50", 10)),
    dashToken: env.DASH_TOKEN || "",
  };
}

// 允许单个站点覆盖全局 failOn 规则
export function siteFailOn(site, cfg) {
  if (Array.isArray(site.failOn) && site.failOn.length) {
    return site.failOn.map((s) => String(s).toLowerCase());
  }
  return cfg.failOn;
}

// 强密码校验：长度 ≥ 12，且同时包含小写字母、大写字母、数字、特殊符号
export function isStrongPassword(s) {
  if (!s || s.length < 12) return false;
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && /[^A-Za-z0-9]/.test(s);
}

// 校验站点配置数组，返回错误列表（空数组 = 通过）
export function validateSites(sites) {
  const errors = [];
  if (!Array.isArray(sites)) {
    errors.push("配置必须是 JSON 数组");
    return errors;
  }
  sites.forEach((s, i) => {
    const label = s?.name ? `站点「${s.name}」` : `第 ${i + 1} 个站点`;
    if (!s || typeof s !== "object") {
      errors.push(`${label}：必须是对象`);
      return;
    }
    if (!s.name || typeof s.name !== "string") errors.push(`${label}：缺少 name`);
    if (!s.url || !/^https?:\/\//i.test(s.url)) errors.push(`${label}：url 必须是 http/https 地址`);
    if (s.nodes !== undefined && !Array.isArray(s.nodes)) errors.push(`${label}：nodes 必须是数组`);
    if (Array.isArray(s.nodes)) {
      s.nodes.forEach((n, j) => {
        if (!n || !n.cname || typeof n.cname !== "string") errors.push(`${label} 第 ${j + 1} 个节点：缺少 cname`);
      });
    }
    if (s.failOn !== undefined) {
      if (!Array.isArray(s.failOn)) errors.push(`${label}：failOn 必须是数组`);
      else {
        const bad = s.failOn.filter((x) => !["4xx", "5xx", "error"].includes(String(x).toLowerCase()));
        if (bad.length) errors.push(`${label}：failOn 含非法值 ${bad.join(", ")}（只允许 4xx/5xx/error）`);
      }
    }
  });
  return errors;
}

// 异步解析生效配置：D1 中保存的 __config__ 优先于 wrangler.toml 的 SITES_CONFIG
// 返回值附带 configSource（"d1" | "env"），调用方无需再次查询 D1 判断来源
export async function resolveConfig(env) {
  const cfg = getConfig(env);
  // 附加管理功能配置（不参与 D1 覆盖）；CONFIG_PATH 容错：缺少前导斜杠时自动补上
  const rawPath = env.CONFIG_PATH || "";
  cfg.configPath = rawPath ? (rawPath.startsWith("/") ? rawPath : "/" + rawPath) : "";
  cfg.configToken = env.CONFIG_TOKEN || "";
  cfg.configSource = "env";
  // D1 中保存的配置优先于 wrangler.toml
  try {
    const row = await env.DB.prepare("SELECT json FROM state WHERE site = '__config__'").first();
    if (row && row.json) {
      const parsed = JSON.parse(row.json);
      if (Array.isArray(parsed)) {
        cfg.sites = parsed;
        cfg.configSource = "d1";
      }
    }
  } catch (e) {
    console.error("读取 D1 配置失败，使用 wrangler.toml 配置:", e.message);
  }
  return cfg;
}
