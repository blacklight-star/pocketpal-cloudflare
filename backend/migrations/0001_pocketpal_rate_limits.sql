-- PocketPal gateway atomic fixed-window rate limiter.
-- Apply to the L1 D1 database before uploading/enabling the gateway route.
CREATE TABLE IF NOT EXISTS gs_pocketpal_rate_limits (
  rate_key TEXT PRIMARY KEY NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 30),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gs_pocketpal_rate_limits_expires_at
  ON gs_pocketpal_rate_limits(expires_at);
