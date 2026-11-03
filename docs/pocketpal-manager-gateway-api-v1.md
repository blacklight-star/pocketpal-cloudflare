# PocketPal manager gateway API contract (v1)

This is the contract expected by the app-side `cloudflare_admin` Talent. It is a proposed, read-only API; the live L1 Worker does not yet expose this route. Do not treat the endpoint as live until a separately tested Worker version implements it.

## Endpoint and authentication

- Method: `POST`
- Path: `/pocketpal/v1/execute`
- Current app endpoint: `https://personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute`
- Authentication: `Authorization: Bearer <POCKETPAL_APP_KEY>`
- `POCKETPAL_APP_KEY` is a dedicated app-to-gateway credential, separate from `GOLDSTAR_FINANCIAL_BRIDGE_KEY` and `GOLDSTAR_API_KEY`.
- The app stores only the app credential in iOS Keychain. The L1↔L2 bridge credential stays in Cloudflare Worker secrets.
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

| Manager | Operation | Arguments | Expected behavior |
|---|---|---|---|
| level1 | status | none | Read-only manager status/counts from the existing L1 database |
| level1 | agents.list | `limit` integer 1–10 (default 5) | List active agents; omit all stored API keys |
| level1 | tasks.list | `limit` integer 1–10 (default 5) | List non-completed tasks |
| level1 | knowledge.search | `query` string, 1–200 chars | Search L1 knowledge using bound SQL parameters |
| level2 | health | none | Call L2 `/health` through the verified server-side bridge |
| level2 | financial.status | none | Call L2 `/status` through the verified server-side bridge |
| level2 | financial.pending | `limit` integer 1–10 (default 5) | Read pending review items; no approval action |
| level2 | financial.strategy.get | none | Read current strategy/status |
| level2 | financial.knowledge.list | `style` enum `ICT`, `RTM`, `NDS` | Read the requested knowledge category |

The app validates this allowlist locally as defense in depth. The Worker must independently enforce the same allowlist; client validation is not authorization.

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
4. Require HTTPS, enforce a small JSON body limit (8 KiB), reject non-JSON requests, and rate-limit the app credential (initial target: 30 requests/minute).
5. Generate a request ID and record a bounded audit entry containing timestamp, manager, operation, result status, and request ID. Never log request authorization headers or secret values.
6. Return bounded payloads. The app rejects responses larger than 30,000 characters and limits model-visible summaries to 10,000 characters.
7. Add tests for manager isolation, operation allowlist, argument validation, SQL parameterization, authentication, rate limiting, redaction, and upstream errors.
8. Keep the route disabled until the exact production L1 source is backed up and a preview version passes its tests. Do not replace the active version merely because a newer source upload exists.
