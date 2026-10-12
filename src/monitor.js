// 对目标 URL 发起一次可用性探测
export async function checkTarget(url, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "cf-failover-monitor/1.0" },
    });
    return { status: resp.status, latencyMs: Date.now() - started };
  } catch (e) {
    const reason = controller.signal.aborted
      ? "timeout"
      : (e && e.message) || "network error";
    return { status: 0, latencyMs: Date.now() - started, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

// 根据 failOn 规则判定一次探测是否失败（默认 4xx/5xx/网络错误 视为失败）
export function isFailure(result, failOn) {
  if (result.error || !result.status) return failOn.includes("error");
  const cls = Math.floor(result.status / 100);
  if (cls === 4) return failOn.includes("4xx");
  if (cls === 5) return failOn.includes("5xx");
  return false;
}
