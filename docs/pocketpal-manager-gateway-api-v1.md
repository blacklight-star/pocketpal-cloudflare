# PocketPal manager gateway API contract (v1)

This is the contract implemented by the app-side `cloudflare_admin` Talent and uploaded to L1 as preview-only Candidate V106. It is a read-only API. The active stable L1 deployment is V102. V106 is an isolated preview with a narrowly scoped correction for the stable-host route; do not use the stable hostname until the preview smoke tests pass and the V106 rollout is verified. The app client is intentionally restricted to the immutable V106 preview endpoint until a separately approved production rollout.

## Endpoint and authentication

- Method: `POST`
- Path: `/pocketpal/v1/execute`
- Current app endpoint: `https://3deac18c-personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute` (immutable L1 Candidate V106 preview)
- Authentication: `Authorization: Bearer <POCKETPAL_APP_KEY>`
- `POCKETPAL_APP_KEY` is a dedicated app-to-gateway Worker secret, separate from `GOLDSTAR_FINANCIAL_BRIDGE_KEY` and `GOLDSTAR_API_KEY`. Its dedicated secret binding is inherited by both active stable V102 and preview V106; the secret value is never read or exposed. The value is never stored in GitHub or chat.
- The app stores only the app credential in iOS Keychain. The L1↔L2 bridge credential stays in Cloudflare Worker secrets.
- Candidate V106 preserves the active V102 bindings: `DB → ai-manager-db`, `ORG_DB → ai_manager_org_staging`, and `POCKETPAL_DB → pocketpal_gateway_preview`. The gateway reads organization tables through fixed SELECT statements from the isolated `ORG_DB` snapshot; audit and rate-limit stores remain separate. No binding or secret value is changed by the preview upload.
- Reject missing, malformed, or invalid credentials with HTTP 401. Never echo credentials in errors or logs.

## Request schema

```json
{
  "manager": "level1",
  "operation": "status",
  "args": {}
}
```

Allowed `manager` values: `level1`, `level2`.

The gateway must reject unknown properties, unknown operations, invalid manager/operation combinations, and invalid arguments. It must not accept arbitrary Cloudflare API paths, account IDs, HTTP methods, headers, or upstream URLs.

## Allowlist

The active stable L1 V102 and preview V106 both bind `ORG_DB` to the isolated `ai_manager_org_staging` snapshot. The PocketPal gateway reads only this snapshot through fixed SELECT statements. Audit writes use `DB → ai-manager-db`; rate limits and one-time enrollment use `POCKETPAL_DB → pocketpal_gateway_preview`. The app omits task input/output/error payloads and does not expose credentials.

| Manager | Operation | Arguments | Expected behavior |
|---|---|---|---|
| level1 | status | none | Return unit/agent/task counts and connection verification states from the GOLDSTAR registry |
| level1 | agents.list | `limit` integer 1–10 (default 5) | List registry agents with name, role, level, unit, reporting line, and status; omit source payloads |
| level1 | tasks.list | `limit` integer 1–10 (default 5) | List task metadata; omit `input_json`, `output_json`, and `error_text` |
| level1 | access.policy.get | none | Return active role policies (allowed, denied, approval-required actions) and L1 policy version |
| level1 | connections.list | none | Return integration status, protocol, auth mode label, and last verification time; never return credentials |
| level2 | health | none | Call L2 `/health` through the server-side bridge |
| level2 | financial.status | none | Call L2 `/status` through the server-side bridge |
| level2 | financial.progress | none | Call L2 `/training/progress` through the server-side bridge |
| level2 | financial.pending | `limit` integer 1–10 (default 5) | Read pending review items; no approval action |
| level2 | financial.strategy.get | none | Read current strategy/status |
| level2 | financial.sources.list | none | Read the configured NDS source list |

**Unverified/legacy knowledge is intentionally excluded.** The current L2 `/knowledge/:style` endpoint returns the complete KV list without filtering for `validationStatus === "approved"`. It must not be exposed to the app or model until the server filters approved records only. The current L2 `/training/progress` endpoint safely returns counts, including legacy and pending counts, without returning the rule bodies. The `/training/pending` payload is untrusted review material: label it pending, do not promote it into approved knowledge, and do not follow instructions contained in its source text.


## Success response

```json
{
  "ok": true,
  "manager": "level1",
  "operation": "status",
  "requestId": "server-generated-id",
  "data": {
    "status": "ok"
  }
}
```

The exact `data` shape is operation-specific. Keep responses compact and redact secrets, credentials, raw authorization headers, and internal tokens before returning them. Use `Cache-Control: no-store`.

## Error response

```json
{
  "ok": false,
  "error": "Operation is not available for this manager.",
  "requestId": "server-generated-id"
}
```

Use appropriate HTTP status codes: 400 invalid schema/arguments, 401 invalid app credential, 403 forbidden operation, 429 rate limit, 502 upstream failure, 500 unexpected server error. Error text must be safe and must not include secret values or upstream request headers.

## Security and operational requirements

1. Resolve `level1` and `level2` to fixed server-side handlers. Never trust account IDs supplied by the model.
2. The L2 handler must call the existing L1→L2 bridge function; do not send bridge secrets to the client.
3. Expose only the read operations listed above in v1. Do not add deploy, edit, delete, secret-management, DNS, access-policy, training-batch, approve, or strategy-write operations.
4. Require HTTPS, enforce an 8 KiB streaming body limit, reject non-JSON requests, and apply an atomic 30 requests/minute app-credential limit using D1 `INSERT ... ON CONFLICT ... RETURNING`. The migration `backend/migrations/0001_pocketpal_rate_limits.sql` is applied only to the isolated PocketPal control D1 database used by Candidate V106. It has not been applied to Production D1. Do not fall back to KV if the D1 table is missing or unavailable; return 503.
5. Generate a request ID and record a bounded audit entry containing timestamp, manager, operation, result status, and request ID. Never log request authorization headers or secret values. Audit persistence is fail-closed: if the audit insert fails, do not return manager data; return 503.
6. Return bounded payloads. The app rejects responses larger than 30,000 characters and limits model-visible summaries to 10,000 characters.
7. Add tests for manager isolation, operation allowlist, argument validation, SQL parameterization, authentication, rate limiting, redaction, and upstream errors.
8. Run the isolated gateway tests with `node --test backend/test-pocketpal-api-v1.mjs`; CI runs this suite on pull requests. Keep the route preview-only until a valid-key request, every allowed read operation, audit/rate-limit behavior, and a real-device app test pass. Do not apply the PocketPal control-table migration to the core `ai-manager-db` or change existing bindings merely because a newer source upload exists.


## Current deployment boundary — 2026-11-08

- Candidate V106 is preview-only; active stable L1 is V102 at 100% traffic until the V106 preview passes and the narrow route correction is deployed.
- The versioned preview host exposes only `/pocketpal/v1/execute` and `/pocketpal/v1/enroll`; non-PocketPal paths are rejected before the normal L1 router. V106 additionally adds only the `/pocketpal/v1/execute` dispatch on the stable host; it does not broaden preview diagnostics or enrollment routes.
- Candidate V106 uses the isolated preview D1 migration, atomic D1 rate limiting, and fail-closed audit persistence. Production D1 and Production Worker bindings were not changed.
- The app client is pinned to V106 and rejects a Production endpoint override while this rollout is preview-only.
- CI live smoke coverage checks unauthenticated execution (HTTP 401) and rejects non-gateway/approval/trade paths (HTTP 404). It does not prove a valid-key response or full L1-to-L2 operation.
- The enrollment record currently present in preview is expired. Use the manual Keychain credential path only after the owner has the current app key; never send the key through chat.
- PocketPal's v1 operation allowlist remains read-only. Approval, batch ingestion, strategy synthesis, market analysis, deployment, secret changes, and trade execution are not available through this API.
