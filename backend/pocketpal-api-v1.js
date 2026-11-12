/* global TextEncoder, TextDecoder, Response, crypto, sha256Hex, callFinancial, callFinancialPreview */
/* eslint-disable prettier/prettier */
/*
 * GOLDSTAR L1 PocketPal Gateway API v1
 * Insert this module into personal-ai-manager after callFinancial().
 * Dependencies provided by the L1 Worker: env.DB, callFinancial(), callFinancialPreview(), sha256Hex().
 * Read-only manager operations only. This module never exposes Cloudflare secrets.
 */

function pocketpalIsRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pocketpalConstantTimeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a || ""));
  const bb = new TextEncoder().encode(String(b || ""));
  const length = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < length; i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

function pocketpalRedact(value) {
  if (Array.isArray(value)) return value.map(pocketpalRedact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      if (/(token|secret|password|api[_-]?key|bridge[_-]?key|private[_-]?key|app[_-]?key|access[_-]?key|authorization|credential)/i.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = pocketpalRedact(child);
      }
    }
    return out;
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/(api[_-]?key|bridge[_-]?key|private[_-]?key|app[_-]?key|access[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  }
  return value;
}

function pocketpalResponse(status, body, requestId) {
  return new Response(JSON.stringify(Object.assign({ requestId: requestId }, body)), {
    status: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestId
    }
  });
}

async function pocketpalAudit(env, requestId, manager, operation, status, payloadHash) {
  if (!env.DB) throw new Error("Audit database is unavailable.");
  const result = await env.DB.prepare(
    "INSERT INTO gs_l1_audit (event_id, actor_identity, event_type, resource_id, payload_hash, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
  ).bind(
    requestId,
    "POCKETPAL_APP",
    "pocketpal_read",
    manager + "." + operation,
    payloadHash,
    JSON.stringify({ httpStatus: status, requestId: requestId })
  ).run();
  if (!result || result.success === false) throw new Error("Audit write failed.");
}

async function pocketpalAuditedResponse(env, requestId, manager, operation, status, body, payloadHash) {
  try {
    await pocketpalAudit(env, requestId, manager, operation, status, payloadHash);
    return pocketpalResponse(status, body, requestId);
  } catch (error) {
    return pocketpalResponse(503, { ok: false, error: "Audit service is unavailable." }, requestId);
  }
}

async function pocketpalReadBodyLimited(request, maxBytes) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let raw = "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
    return raw;
  } finally {
    reader.releaseLock();
  }
}

async function pocketpalConsumeRateLimit(env, credentialHash) {
  if (!env.DB) throw new Error("Rate-limit database is unavailable.");
  const windowStart = Math.floor(Date.now() / 60000);
  const result = await env.DB.prepare(
    "INSERT INTO gs_pocketpal_rate_limits (credential_hash, window_start, request_count) VALUES (?, ?, 1) ON CONFLICT(credential_hash) DO UPDATE SET window_start = excluded.window_start, request_count = CASE WHEN gs_pocketpal_rate_limits.window_start = excluded.window_start THEN gs_pocketpal_rate_limits.request_count + 1 ELSE 1 END WHERE gs_pocketpal_rate_limits.window_start <> excluded.window_start OR gs_pocketpal_rate_limits.request_count < 30 RETURNING request_count"
  ).bind(credentialHash, windowStart).first();
  return !!result;
}

async function handlePocketPalGateway(request, env) {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  if (url.pathname !== "/pocketpal/v1/execute") {
    return pocketpalResponse(404, { ok: false, error: "Not found." }, requestId);
  }
  if (url.protocol !== "https:") {
    return pocketpalResponse(400, { ok: false, error: "HTTPS is required." }, requestId);
  }
  const allowedHosts = [
    "personal-ai-manager.goldstar-al-manager.workers.dev",
    "pocketpal-test-personal-ai-manager.goldstar-al-manager.workers.dev"
  ];
  const isVersionedPreviewHost = /^[a-f0-9]{8}-personal-ai-manager\.goldstar-al-manager\.workers\.dev$/.test(url.hostname);
  if (!allowedHosts.includes(url.hostname) && !isVersionedPreviewHost) {
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "POST") {
    return pocketpalResponse(405, { ok: false, error: "Method not allowed." }, requestId);
  }

  const expected = env.POCKETPAL_APP_KEY;
  if (typeof expected !== "string" || !/^[A-Za-z0-9._~-]{32,256}$/.test(expected)) {
    return pocketpalResponse(503, { ok: false, error: "PocketPal gateway credential is not configured." }, requestId);
  }
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]{32,256})$/);
  if (!match || !pocketpalConstantTimeEqual(match[1], expected)) {
    return pocketpalResponse(401, { ok: false, error: "Unauthorized." }, requestId);
  }

  const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return pocketpalResponse(400, { ok: false, error: "Content-Type must be application/json." }, requestId);
  }
  const declaredLengthHeader = request.headers.get("Content-Length");
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > 8192)) {
    return pocketpalResponse(413, { ok: false, error: "Request body is too large." }, requestId);
  }

  let raw;
  let input;
  try {
    raw = await pocketpalReadBodyLimited(request, 8192);
    input = JSON.parse(raw);
  } catch (error) {
    if (error && error.message === "BODY_TOO_LARGE") {
      return pocketpalResponse(413, { ok: false, error: "Request body is too large." }, requestId);
    }
    return pocketpalResponse(400, { ok: false, error: "Invalid JSON request body." }, requestId);
  }

  if (!pocketpalIsRecord(input) ||
      Object.keys(input).some(key => !["manager", "operation", "args"].includes(key))) {
    return pocketpalResponse(400, { ok: false, error: "Request schema is invalid." }, requestId);
  }
  const manager = input.manager;
  const operation = input.operation;
  if (manager !== "level1" && manager !== "level2") {
    return pocketpalResponse(400, { ok: false, error: "manager must be level1 or level2." }, requestId);
  }
  if (typeof operation !== "string") {
    return pocketpalResponse(400, { ok: false, error: "operation is required." }, requestId);
  }

  const level1Ops = new Set([
    "status", "agents.list", "tasks.list", "access.policy.get", "connections.list"
  ]);
  const level2Ops = new Set([
    "health", "financial.status", "financial.pending", "financial.progress",
    "financial.strategy.get", "financial.sources.list",
    "financial.mt5.status", "financial.mt5.latest", "financial.mql5.tools", "financial.mql5.call"
  ]);
  if (!(manager === "level1" ? level1Ops : level2Ops).has(operation)) {
    return pocketpalResponse(403, { ok: false, error: "Operation is not available for this manager." }, requestId);
  }

  const args = input.args === undefined ? {} : input.args;
  if (!pocketpalIsRecord(args)) {
    return pocketpalResponse(400, { ok: false, error: "args must be an object." }, requestId);
  }
  const limitOps = ["agents.list", "tasks.list", "financial.pending"];
  const isMql5Call = operation === "financial.mql5.call";
  const allowedArgs = isMql5Call ? ["name", "arguments"] : (limitOps.includes(operation) ? ["limit"] : []);
  if (Object.keys(args).some(key => !allowedArgs.includes(key))) {
    return pocketpalResponse(400, { ok: false, error: "Unsupported operation arguments." }, requestId);
  }
  if (isMql5Call && (typeof args.name !== "string" || !/^marketdata_[a-zA-Z0-9_]+$/.test(args.name) ||
      (args.arguments !== undefined && !pocketpalIsRecord(args.arguments)))) {
    return pocketpalResponse(400, { ok: false, error: "Only marketdata_* tool calls with object arguments are permitted." }, requestId);
  }
  let limit = 5;
  if (limitOps.includes(operation)) {
    limit = args.limit === undefined ? 5 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      return pocketpalResponse(400, { ok: false, error: "limit must be an integer from 1 to 10." }, requestId);
    }
  }

  const payloadHash = await sha256Hex(raw);
  try {
    const credentialHash = await sha256Hex(expected);
    const withinLimit = await pocketpalConsumeRateLimit(env, credentialHash);
    if (!withinLimit) {
      return await pocketpalAuditedResponse(
        env, requestId, manager, operation, 429,
        { ok: false, error: "Rate limit exceeded." }, payloadHash
      );
    }
  } catch (error) {
    return pocketpalResponse(503, { ok: false, error: "Rate limiter is unavailable." }, requestId);
  }

  try {
    let data;
    if (manager === "level1") {
      if (!env.ORG_DB || typeof env.ORG_DB.prepare !== "function") {
        return await pocketpalAuditedResponse(env, requestId, manager, operation, 503, { ok: false, error: "L1 organization data source is unavailable." }, payloadHash);
      }
      if (operation === "status") {
        const results = await Promise.all([
          env.ORG_DB.prepare("SELECT manager_level, status, COUNT(*) AS count FROM gs_org_units GROUP BY manager_level, status ORDER BY manager_level, status").all(),
          env.ORG_DB.prepare("SELECT level, status, COUNT(*) AS count FROM gs_org_agents GROUP BY level, status ORDER BY level, status").all(),
          env.ORG_DB.prepare("SELECT status, COUNT(*) AS count FROM gs_org_tasks GROUP BY status ORDER BY status").all(),
          env.ORG_DB.prepare("SELECT connection_id, status, last_verified_at FROM gs_org_connections ORDER BY connection_id").all(),
          env.ORG_DB.prepare("SELECT MAX(version) AS version FROM gs_l1_policy").first()
        ]);
        data = {
          status: "ok",
          units: results[0].results || [],
          agents: results[1].results || [],
          tasks: results[2].results || [],
          connections: results[3].results || [],
          policyVersion: results[4] ? results[4].version : null
        };
      } else if (operation === "agents.list") {
        const result = await env.ORG_DB.prepare(
          "SELECT a.agent_id, a.unit_id, a.level, a.agent_name, a.role, a.reports_to, a.status, u.unit_name FROM gs_org_agents a LEFT JOIN gs_org_units u ON u.unit_id = a.unit_id ORDER BY a.level, a.unit_id, a.agent_id LIMIT ?"
        ).bind(limit).all();
        data = { items: result.results || [], returned: (result.results || []).length };
      } else if (operation === "tasks.list") {
        const result = await env.ORG_DB.prepare(
          "SELECT task_id, parent_task_id, unit_id, assigned_agent_id, created_by, title, objective, status, priority, risk_level, approval_status, created_at, updated_at FROM gs_org_tasks ORDER BY updated_at DESC LIMIT ?"
        ).bind(limit).all();
        data = { items: result.results || [], returned: (result.results || []).length };
      } else if (operation === "access.policy.get") {
        const results = await Promise.all([
          env.ORG_DB.prepare("SELECT policy_id, subject_level, scope, allowed_actions_json, denied_actions_json, approval_required_json, version, status FROM gs_org_access_policies WHERE status='active' ORDER BY subject_level").all(),
          env.ORG_DB.prepare("SELECT MAX(version) AS version FROM gs_l1_policy").first()
        ]);
        data = {
          policies: results[0].results || [],
          l1PolicyVersion: results[1] ? results[1].version : null
        };
      } else if (operation === "connections.list") {
        const result = await env.ORG_DB.prepare(
          "SELECT connection_id, source_unit_id, target_unit_id, protocol, authentication_mode, status, last_verified_at FROM gs_org_connections ORDER BY connection_id"
        ).all();
        data = { items: result.results || [], returned: (result.results || []).length };
      }
    } else {
      const previewPaths = {
        "financial.mt5.status": "/mt5/status",
        "financial.mt5.latest": "/mt5/latest",
        "financial.mql5.tools": "/mql5/tools",
        "financial.mql5.call": "/mql5/call"
      };
      let upstream;
      if (previewPaths[operation]) {
        if (typeof callFinancialPreview !== "function") throw new Error("MQL5 preview bridge is unavailable.");
        const previewMethod = operation.startsWith("financial.mql5.") ? "POST" : "GET";
        const previewBody = isMql5Call ? {name: args.name, arguments: args.arguments || {}} : {};
        upstream = await callFinancialPreview(previewPaths[operation], env, previewMethod, previewBody);
      } else {
        const paths = {
          health: "/health",
          "financial.status": "/status",
          "financial.pending": "/training/pending?limit=" + limit,
          "financial.progress": "/training/progress",
          "financial.strategy.get": "/strategy",
          "financial.sources.list": "/training/sources"
        };
        upstream = await callFinancial(paths[operation], env, "GET");
      }
      if (upstream && upstream.error) {
        return await pocketpalAuditedResponse(
          env, requestId, manager, operation, 502,
          { ok: false, error: "Financial manager request failed." }, payloadHash
        );
      }
      data = upstream;
    }

    data = pocketpalRedact(data);
    const serialized = JSON.stringify(data);
    if (typeof serialized !== "string" || serialized.length > 24000) {
      return await pocketpalAuditedResponse(
        env, requestId, manager, operation, 502,
        { ok: false, error: "Manager response exceeded the allowed size." }, payloadHash
      );
    }
    return await pocketpalAuditedResponse(
      env, requestId, manager, operation, 200,
      { ok: true, manager: manager, operation: operation, data: data }, payloadHash
    );
  } catch (error) {
    return await pocketpalAuditedResponse(
      env, requestId, manager, operation, 500,
      { ok: false, error: "Manager request failed." }, payloadHash
    );
  }
}
