/*
 * GOLDSTAR L1 PocketPal Gateway API v1
 * Insert this module into personal-ai-manager after callFinancial().
 * Dependencies provided by the L1 Worker: env.DB, env.CACHE, callFinancial(), sha256Hex().
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
  try {
    await env.DB.prepare(
      "INSERT INTO gs_l1_audit (event_id, actor_identity, event_type, resource_id, payload_hash, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))"
    ).bind(
      requestId,
      "POCKETPAL_APP",
      "pocketpal_read",
      manager + "." + operation,
      payloadHash,
      JSON.stringify({ httpStatus: status, requestId: requestId })
    ).run();
  } catch (error) {
    // Audit failure must not disclose details or secrets to the client.
  }
}

async function handlePocketPalGateway(request, env) {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  const allowedHosts = [
    "personal-ai-manager.goldstar-al-manager.workers.dev",
    "pocketpal-test-personal-ai-manager.goldstar-al-manager.workers.dev"
  ];
  if (!allowedHosts.includes(url.hostname)) {
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

  const contentType = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return pocketpalResponse(400, { ok: false, error: "Content-Type must be application/json." }, requestId);
  }
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > 8192) {
    return pocketpalResponse(413, { ok: false, error: "Request body is too large." }, requestId);
  }

  let raw;
  let input;
  try {
    raw = await request.text();
    if (new TextEncoder().encode(raw).length > 8192) {
      return pocketpalResponse(413, { ok: false, error: "Request body is too large." }, requestId);
    }
    input = JSON.parse(raw);
  } catch (error) {
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
    "financial.strategy.get", "financial.sources.list"
  ]);
  if (!(manager === "level1" ? level1Ops : level2Ops).has(operation)) {
    return pocketpalResponse(403, { ok: false, error: "Operation is not available for this manager." }, requestId);
  }

  const args = input.args === undefined ? {} : input.args;
  if (!pocketpalIsRecord(args)) {
    return pocketpalResponse(400, { ok: false, error: "args must be an object." }, requestId);
  }
  const limitOps = ["agents.list", "tasks.list", "financial.pending"];
  const allowedArgs = limitOps.includes(operation) ? ["limit"] : [];
  if (Object.keys(args).some(key => !allowedArgs.includes(key))) {
    return pocketpalResponse(400, { ok: false, error: "Unsupported operation arguments." }, requestId);
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
    const rateWindow = Math.floor(Date.now() / 60000);
    const rateKey = "pocketpal:rate:" + await sha256Hex(expected) + ":" + rateWindow;
    const currentCount = Number(await env.CACHE.get(rateKey) || "0");
    if (!Number.isFinite(currentCount) || currentCount >= 30) {
      await pocketpalAudit(env, requestId, manager, operation, 429, payloadHash);
      return pocketpalResponse(429, { ok: false, error: "Rate limit exceeded." }, requestId);
    }
    await env.CACHE.put(rateKey, String(currentCount + 1), { expirationTtl: 120 });
  } catch (error) {
    return pocketpalResponse(503, { ok: false, error: "Rate limiter is unavailable." }, requestId);
  }

  try {
    let data;
    if (manager === "level1") {
      if (operation === "status") {
        const results = await Promise.all([
          env.DB.prepare("SELECT manager_level, status, COUNT(*) AS count FROM gs_org_units GROUP BY manager_level, status ORDER BY manager_level, status").all(),
          env.DB.prepare("SELECT level, status, COUNT(*) AS count FROM gs_org_agents GROUP BY level, status ORDER BY level, status").all(),
          env.DB.prepare("SELECT status, COUNT(*) AS count FROM gs_org_tasks GROUP BY status ORDER BY status").all(),
          env.DB.prepare("SELECT connection_id, status, last_verified_at FROM gs_org_connections ORDER BY connection_id").all(),
          env.DB.prepare("SELECT MAX(version) AS version FROM gs_l1_policy").first()
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
        const result = await env.DB.prepare(
          "SELECT a.agent_id, a.unit_id, a.level, a.agent_name, a.role, a.reports_to, a.status, u.unit_name FROM gs_org_agents a LEFT JOIN gs_org_units u ON u.unit_id = a.unit_id ORDER BY a.level, a.unit_id, a.agent_id LIMIT ?"
        ).bind(limit).all();
        data = { items: result.results || [], returned: (result.results || []).length };
      } else if (operation === "tasks.list") {
        const result = await env.DB.prepare(
          "SELECT task_id, parent_task_id, unit_id, assigned_agent_id, created_by, title, objective, status, priority, risk_level, approval_status, created_at, updated_at FROM gs_org_tasks ORDER BY updated_at DESC LIMIT ?"
        ).bind(limit).all();
        data = { items: result.results || [], returned: (result.results || []).length };
      } else if (operation === "access.policy.get") {
        const results = await Promise.all([
          env.DB.prepare("SELECT policy_id, subject_level, scope, allowed_actions_json, denied_actions_json, approval_required_json, version, status FROM gs_org_access_policies WHERE status='active' ORDER BY subject_level").all(),
          env.DB.prepare("SELECT MAX(version) AS version FROM gs_l1_policy").first()
        ]);
        data = {
          policies: results[0].results || [],
          l1PolicyVersion: results[1] ? results[1].version : null
        };
      } else if (operation === "connections.list") {
        const result = await env.DB.prepare(
          "SELECT connection_id, source_unit_id, target_unit_id, protocol, authentication_mode, status, last_verified_at FROM gs_org_connections ORDER BY connection_id"
        ).all();
        data = { items: result.results || [], returned: (result.results || []).length };
      }
    } else {
      const paths = {
        health: "/health",
        "financial.status": "/status",
        "financial.pending": "/training/pending?limit=" + limit,
        "financial.progress": "/training/progress",
        "financial.strategy.get": "/strategy",
        "financial.sources.list": "/training/sources"
      };
      const upstream = await callFinancial(paths[operation], env, "GET");
      if (upstream && upstream.error) {
        await pocketpalAudit(env, requestId, manager, operation, 502, payloadHash);
        return pocketpalResponse(502, { ok: false, error: "Financial manager request failed." }, requestId);
      }
      data = upstream;
    }

    data = pocketpalRedact(data);
    const serialized = JSON.stringify(data);
    if (typeof serialized !== "string" || serialized.length > 24000) {
      await pocketpalAudit(env, requestId, manager, operation, 502, payloadHash);
      return pocketpalResponse(502, { ok: false, error: "Manager response exceeded the allowed size." }, requestId);
    }
    await pocketpalAudit(env, requestId, manager, operation, 200, payloadHash);
    return pocketpalResponse(200, { ok: true, manager: manager, operation: operation, data: data }, requestId);
  } catch (error) {
    await pocketpalAudit(env, requestId, manager, operation, 500, payloadHash);
    return pocketpalResponse(500, { ok: false, error: "Manager request failed." }, requestId);
  }
}
