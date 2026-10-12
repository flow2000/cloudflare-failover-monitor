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
