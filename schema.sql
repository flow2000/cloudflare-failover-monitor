-- cloudflare-failover-monitor D1 建表脚本
-- 执行：npx wrangler d1 execute monitor-db --remote --file=schema.sql

-- 站点状态：每站点一行 JSON（连续失败计数、当前 CNAME、最近一次检测结果）
CREATE TABLE IF NOT EXISTS state (
  site TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

-- 检测明细：每次检测一行，保留 90 天（供 /api/status 最近历史）
CREATE TABLE IF NOT EXISTS checks (
  site TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  latency_ms INTEGER,
  event TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_checks_site_ts ON checks (site, ts DESC);

-- 按日聚合（UTC+8 日期桶）：供面板 90 天可用性视图
CREATE TABLE IF NOT EXISTS daily (
  site TEXT NOT NULL,
  day TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  fail INTEGER NOT NULL DEFAULT 0,
  events TEXT,
  PRIMARY KEY (site, day)
);
