const CF_API = "https://api.cloudflare.com/client/v4";

async function cfApi(path, token, options = {}) {
  const resp = await fetch(CF_API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  const data = await resp.json();
  if (!data.success) {
    throw new Error(`Cloudflare API 错误: ${JSON.stringify(data.errors || data)}`);
  }
  return data.result;
}

// 按名称查询 CNAME 记录（免配置 recordId）
export async function getCnameRecord(zoneId, recordName, token) {
  const result = await cfApi(
    `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(recordName)}`,
    token
  );
  return Array.isArray(result) && result.length ? result[0] : null;
}

// 更新 CNAME 指向，保留原有 TTL 与代理（橙色云）状态
export async function updateCname(zoneId, record, newTarget, token) {
  return cfApi(`/zones/${zoneId}/dns_records/${record.id}`, token, {
    method: "PUT",
    body: JSON.stringify({
      type: "CNAME",
      name: record.name,
      content: newTarget,
      ttl: record.ttl,
      proxied: record.proxied,
    }),
  });
}

// 归一化 CNAME 目标，便于比较（去尾部点、统一小写）
export function normalizeTarget(t) {
  return String(t || "").trim().toLowerCase().replace(/\.$/, "");
}
