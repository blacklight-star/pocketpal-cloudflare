/* eslint-disable prettier/prettier */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const source = await readFile(new URL('./pocketpal-api-v1.js', import.meta.url), 'utf8');

function loadHandler({auditFails = false, rateAllowed = true, financialResponse = {ok: true}} = {}) {
  const calls = {audit: 0, rate: 0, financial: []};
  const env = {
    POCKETPAL_APP_KEY: 'a'.repeat(48),
    DB: {
      prepare(sql) {
        const query = {
          async first() {
            if (sql.includes('INSERT INTO gs_pocketpal_rate_limits')) {
              calls.rate++;
              return rateAllowed ? {request_count: 1} : null;
            }
            if (sql.includes('MAX(version)')) return {version: 1};
            return null;
          },
          async all() {
            if (sql.includes('gs_org_units')) return {results: []};
            if (sql.includes('gs_org_agents')) return {results: []};
            if (sql.includes('gs_org_tasks')) return {results: []};
            if (sql.includes('gs_org_connections')) return {results: []};
            throw new Error('Unexpected D1 query: ' + sql);
          },
        };
        return {
          ...query,
          bind(...values) {
            return {
              ...query,
              async run() {
                if (sql.includes('INSERT INTO gs_l1_audit')) {
                  calls.audit++;
                  if (auditFails) throw new Error('simulated audit outage');
                  return {success: true};
                }
                throw new Error('Unexpected D1 run: ' + sql);
              },
            };
          },
        };
      },
    },
  };
  const context = {
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Response,
    URL,
    JSON,
    Math,
    Date,
    Number,
    Object,
    String,
    RegExp,
    Set,
    Error,
    sha256Hex: async value => 'sha256:' + String(value).length,
    callFinancial: async (path, _env, method) => {
      calls.financial.push({path, method});
      return financialResponse;
    },
  };
  vm.runInNewContext(source + '\nglobalThis.__handle = handlePocketPalGateway; globalThis.__redact = pocketpalRedact;', context);
  return {handle: context.__handle, env, calls};
}

function makeRequest(body, {key = 'a'.repeat(48), method = 'POST', contentType = 'application/json', url = 'https://personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute'} = {}) {
  return new Request(url, {
    method,
    headers: {
      Authorization: key === null ? '' : 'Bearer ' + key,
      'Content-Type': contentType,
    },
    body: body === null ? undefined : body,
  });
}

test('valid L1 read is returned and audited', async () => {
  const {handle, env, calls} = loadHandler();
  const response = await handle(makeRequest(JSON.stringify({manager: 'level1', operation: 'status', args: {}})), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.manager, 'level1');
  assert.equal(calls.rate, 1);
  assert.equal(calls.audit, 1);
});

test('missing and invalid credentials are rejected', async () => {
  const {handle, env} = loadHandler();
  const missing = await handle(makeRequest(JSON.stringify({manager: 'level1', operation: 'status'}), {key: null}), env);
  assert.equal(missing.status, 401);
  const invalid = await handle(makeRequest(JSON.stringify({manager: 'level1', operation: 'status'}), {key: 'b'.repeat(48)}), env);
  assert.equal(invalid.status, 401);
});

test('audit outage fails closed and never returns manager data', async () => {
  const {handle, env} = loadHandler({auditFails: true});
  const response = await handle(makeRequest(JSON.stringify({manager: 'level1', operation: 'status'})), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).ok, false);
});

test('atomic rate limit denial is audited and returns 429', async () => {
  const {handle, env, calls} = loadHandler({rateAllowed: false});
  const response = await handle(makeRequest(JSON.stringify({manager: 'level1', operation: 'status'})), env);
  assert.equal(response.status, 429);
  assert.equal(calls.audit, 1);
});

test('request body is bounded while streaming', async () => {
  const {handle, env} = loadHandler();
  const response = await handle(makeRequest('x'.repeat(8193)), env);
  assert.equal(response.status, 413);
});

test('manager/operation mismatch is denied', async () => {
  const {handle, env, calls} = loadHandler();
  const response = await handle(makeRequest(JSON.stringify({manager: 'level1', operation: 'financial.pending'})), env);
  assert.equal(response.status, 403);
  assert.equal(calls.financial.length, 0);
});

test('L2 route is fixed to an allowlisted read-only path', async () => {
  const {handle, env, calls} = loadHandler({financialResponse: {status: 'ok'}});
  const response = await handle(makeRequest(JSON.stringify({manager: 'level2', operation: 'financial.status'})), env);
  assert.equal(response.status, 200);
  assert.equal(calls.financial.length, 1);
  assert.equal(calls.financial[0].path, '/status');
  assert.equal(calls.financial[0].method, 'GET');
});

test('pinned versioned preview hostname is accepted', async () => {
  const {handle, env} = loadHandler();
  const response = await handle(makeRequest(
    JSON.stringify({manager: 'level1', operation: 'status', args: {}}),
    {url: 'https://d6cb5013-personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute'},
  ), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('unrecognized versioned worker host is rejected', async () => {
  const {handle, env} = loadHandler();
  const response = await handle(makeRequest(
    JSON.stringify({manager: 'level1', operation: 'status', args: {}}),
    {url: 'https://deadbeef-untrusted.goldstar-al-manager.workers.dev/pocketpal/v1/execute'},
  ), env);
  assert.equal(response.status, 404);
});

test('handler rejects a different path and non-JSON media type', async () => {
  const {handle, env} = loadHandler();
  const body = JSON.stringify({manager: 'level1', operation: 'status'});
  const wrongPath = await handle(makeRequest(body, {url: 'https://personal-ai-manager.goldstar-al-manager.workers.dev/not-the-gateway'}), env);
  assert.equal(wrongPath.status, 404);
  const wrongType = await handle(makeRequest(body, {contentType: 'application/jsonp'}), env);
  assert.equal(wrongType.status, 400);
});

test('redaction drops prototype-pollution keys from untrusted manager data', () => {
  const payload = JSON.parse('{"status":"ok","__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"polluted":true}}}}');
  const sandbox = {payload};
  vm.runInNewContext(source + '\nglobalThis.__redact = pocketpalRedact;', sandbox);
  const redacted = sandbox.__redact(payload);
  assert.equal(Object.getPrototypeOf(redacted).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(redacted.nested, 'constructor'), false);
});
