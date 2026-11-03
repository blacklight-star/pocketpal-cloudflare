jest.mock('../../../store/CloudflareAdminStore', () => ({
  CLOUDFLARE_ADMIN_ENDPOINT:
    'https://gateway.example.test/pocketpal/v1/execute',
  cloudflareAdminStore: {
    isKeyLoaded: true,
    getGatewayKey: jest.fn(() => 'test-gateway-key'),
  },
}));

import {CloudflareAdminClient, redactSensitiveFields} from '../CloudflareAdminClient';

describe('CloudflareAdminClient', () => {
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

    const client = new CloudflareAdminClient();
    const result = await client.execute('level1', 'status', {});

    expect(global.fetch).toHaveBeenCalledWith(
      'https://gateway.example.test/pocketpal/v1/execute',
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

    const client = new CloudflareAdminClient();
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

    const client = new CloudflareAdminClient();
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

  it('redacts credential-like strings', () => {
    expect(redactSensitiveFields('Authorization: Bearer abc.def')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });
});
