-- PocketPal gateway atomic fixed-window rate limiter.
-- One row per credential; the minute window rolls the counter forward atomically.
-- Apply to the L1 D1 database before uploading/enabling the gateway route.
CREATE TABLE IF NOT EXISTS gs_pocketpal_rate_limits (
  credential_hash TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 30)
);
