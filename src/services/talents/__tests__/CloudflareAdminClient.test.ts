/* eslint-disable prettier/prettier */
import {
  CLOUDFLARE_ADMIN_ENDPOINT,
  CloudflareAdminClient,
  redactSensitiveFields,
} from '../CloudflareAdminClient';

const credentialStore = {
  isKeyLoaded: true,
  getGatewayKey: jest.fn(() => 'test-gateway-key'),
};

describe('CloudflareAdminClient', () => {
  it('defaults to the pinned isolated L1 preview v78', () => {
    expect(CLOUDFLARE_ADMIN_ENDPOINT).toBe(
      'https://a0a94890-personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute',
    );
  });


  it('does not select the production L1 endpoint during the preview-only rollout', () => {
    expect(CLOUDFLARE_ADMIN_ENDPOINT).not.toBe(
      'https://personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute',
    );
  });

  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn() as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('sends the selected manager and operation using the gateway credential', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ok: true, manager: 'level1', operation: 'status', data: {status: 'ok'}}),
    });

    const client = new CloudflareAdminClient(credentialStore);
    const result = await client.execute('level1', 'status', {});

    expect(global.fetch).toHaveBeenCalledWith(
      CLOUDFLARE_ADMIN_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-gateway-key',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({manager: 'level1', operation: 'status', args: {}}),
      }),
    );
    expect(result).toEqual({status: 'ok'});
  });

  it('rejects malformed JSON responses', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'not-json',
    });

    const client = new CloudflareAdminClient(credentialStore);
    await expect(client.execute('level1', 'status', {})).rejects.toThrow(
      'invalid JSON',
    );
  });

  it('rejects oversized gateway responses', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'x'.repeat(30001),
    });

    const client = new CloudflareAdminClient(credentialStore);
    await expect(client.execute('level1', 'status', {})).rejects.toThrow(
      'exceeded the allowed size',
    );
  });

  it('redacts sensitive response fields recursively', () => {
    expect(
      redactSensitiveFields({
        status: 'ok',
        api_key: 'private-value',
        nested: [{authorization: 'Bearer private-value', count: 2}],
      }),
    ).toEqual({
      status: 'ok',
      api_key: '[REDACTED]',
      nested: [{authorization: '[REDACTED]', count: 2}],
    });
  });

  it('redacts L1-to-L2 bridge key fields', () => {
    expect(
      redactSensitiveFields({
        GOLDSTAR_FINANCIAL_BRIDGE_KEY: 'private-value',
        safeStatus: 'ok',
      }),
    ).toEqual({
      GOLDSTAR_FINANCIAL_BRIDGE_KEY: '[REDACTED]',
      safeStatus: 'ok',
    });
  });

  it('redacts credential-like strings', () => {
    expect(redactSensitiveFields('Authorization: Bearer abc.def')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('drops prototype-pollution keys from manager responses', () => {
    const payload = JSON.parse(
      '{"status":"ok","__proto__":{"polluted":true},"nested":{"constructor":{"prototype":{"polluted":true}}}}',
    );
    const redacted = redactSensitiveFields(payload) as Record<string, any>;
    expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined();
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(redacted.nested)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(redacted, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(redacted.nested, 'constructor')).toBe(false);
  });
});
