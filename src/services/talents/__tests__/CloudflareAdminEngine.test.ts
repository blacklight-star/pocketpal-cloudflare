import {CloudflareAdminEngine} from '../CloudflareAdminEngine';

describe('CloudflareAdminEngine', () => {
  const execute = jest.fn();
  let engine: CloudflareAdminEngine;

  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({status: 'ok', count: 3});
    engine = new CloudflareAdminEngine({execute} as any);
  });

  it('exposes the cloudflare_admin tool name', () => {
    expect(engine.name).toBe('cloudflare_admin');
    expect(engine.toToolDefinition().function.name).toBe('cloudflare_admin');
  });

  it('routes central-manager status to level1', async () => {
    const result = await engine.execute({
      manager: 'level1',
      operation: 'status',
    });

    expect(execute).toHaveBeenCalledWith('level1', 'status', {}, undefined);
    expect(result.type).toBe('text');
    expect(result.summary).toContain('Cloudflare level1 — status');
  });

  it('routes financial progress to level2', async () => {
    await engine.execute({
      manager: 'level2',
      operation: 'financial.progress',
    });

    expect(execute).toHaveBeenCalledWith(
      'level2',
      'financial.progress',
      {},
      undefined,
    );
  });

  it('routes financial status to level2', async () => {
    await engine.execute({
      manager: 'level2',
      operation: 'financial.status',
    });

    expect(execute).toHaveBeenCalledWith(
      'level2',
      'financial.status',
      {},
      undefined,
    );
  });

  it('routes MQL5 tool discovery to level2', async () => {
    await engine.execute({
      manager: 'level2',
      operation: 'financial.mql5.tools',
    });
    expect(execute).toHaveBeenCalledWith(
      'level2',
      'financial.mql5.tools',
      {},
      undefined,
    );
  });

  it('routes only marketdata_* MQL5 calls with object arguments', async () => {
    await engine.execute({
      manager: 'level2',
      operation: 'financial.mql5.call',
      args: {name: 'marketdata_get_symbol_info', arguments: {symbol: 'EURUSD'}},
    });
    expect(execute).toHaveBeenCalledWith(
      'level2',
      'financial.mql5.call',
      {name: 'marketdata_get_symbol_info', arguments: {symbol: 'EURUSD'}},
      undefined,
    );
  });

  it('rejects order-like or arbitrary MQL5 tool names', async () => {
    const result = await engine.execute({
      manager: 'level2',
      operation: 'financial.mql5.call',
      args: {name: 'trade_place_order', arguments: {symbol: 'EURUSD'}},
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
  });

  it('rejects non-object MQL5 tool arguments', async () => {
    const result = await engine.execute({
      manager: 'level2',
      operation: 'financial.mql5.call',
      args: {name: 'marketdata_get_symbol_info', arguments: ['EURUSD']},
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
  });

  it('rejects a level2-only operation on level1', async () => {
    const result = await engine.execute({
      manager: 'level1',
      operation: 'financial.pending',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
  });

  it('rejects a level1-only operation on level2', async () => {
    const result = await engine.execute({
      manager: 'level2',
      operation: 'agents.list',
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
  });

  it('rejects unsupported arguments for read-only status operations', async () => {
    const result = await engine.execute({
      manager: 'level1',
      operation: 'status',
      args: {accountId: 'attacker-selected-account'},
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
  });

  it('validates and clamps no limits implicitly', async () => {
    const result = await engine.execute({
      manager: 'level2',
      operation: 'financial.pending',
      args: {limit: 11},
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.type).toBe('error');
  });

  it('forwards cancellation signal to the gateway client', async () => {
    const controller = new AbortController();
    await engine.execute(
      {manager: 'level1', operation: 'status'},
      {signal: controller.signal},
    );

    expect(execute).toHaveBeenCalledWith(
      'level1',
      'status',
      {},
      controller.signal,
    );
  });

  it('returns a safe error when the gateway rejects the request', async () => {
    execute.mockRejectedValueOnce(new Error('gateway unavailable'));
    const result = await engine.execute({
      manager: 'level1',
      operation: 'status',
    });

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.errorMessage).toBe('gateway unavailable');
    }
  });

  it('does not advertise mutation or deployment operations', () => {
    const schema = engine.toToolDefinition().function.parameters;
    const operations = schema.properties.operation.enum;
    expect(operations).not.toContain('deploy');
    expect(operations).not.toContain('delete');
    expect(operations).not.toContain('approve');
    expect(operations).not.toContain('knowledge.search');
    expect(operations).not.toContain('financial.knowledge.list');
  });
});
