-- PocketPal gateway atomic fixed-window rate limiter.
-- One row per credential; the minute window rolls the counter forward atomically.
-- Apply only to the D1 database bound to the Worker environment being deployed.
-- During preview, use the isolated preview D1 database; do not apply to production.
CREATE TABLE IF NOT EXISTS gs_pocketpal_rate_limits (
  credential_hash TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 30)
);
