/* eslint-disable prettier/prettier */
import {
  CLOUDFLARE_ADMIN_ENDPOINT as configuredEndpoint,
} from '@env';

// Candidate-only: pin PocketPal to isolated L1 preview version 106.
// This immutable URL does not follow production deployments or a moving preview alias.
const PREVIEW_GATEWAY_ENDPOINT =
  'https://3deac18c-personal-ai-manager.goldstar-al-manager.workers.dev/pocketpal/v1/execute';
const configuredGatewayEndpoint = (configuredEndpoint || '').trim();

// Production is intentionally excluded until a separate, approved rollout.
// Any non-preview override disables the client rather than redirecting traffic.
export const CLOUDFLARE_ADMIN_ENDPOINT = configuredGatewayEndpoint
  ? configuredGatewayEndpoint === PREVIEW_GATEWAY_ENDPOINT
    ? configuredGatewayEndpoint
    : ''
  : PREVIEW_GATEWAY_ENDPOINT;

export type CloudflareManagerLevel = 'level1' | 'level2';

export type CloudflareManagerOperation =
  | 'status'
  | 'agents.list'
  | 'tasks.list'
  | 'access.policy.get'
  | 'connections.list'
  | 'health'
  | 'financial.status'
  | 'financial.pending'
  | 'financial.strategy.get'
  | 'financial.progress'
  | 'financial.sources.list';

export interface CloudflareAdminCredentialStore {
  readonly isKeyLoaded: boolean;
  getGatewayKey(): string;
}

export interface CloudflareGatewayResponse {
  ok: boolean;
  manager?: CloudflareManagerLevel;
  operation?: CloudflareManagerOperation;
  data?: unknown;
  error?: string;
  requestId?: string;
}

const MAX_RESPONSE_CHARS = 30000;

export function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields);
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        continue;
      }
      if (
        /(token|secret|password|api[_-]?key|bridge[_-]?key|private[_-]?key|app[_-]?key|access[_-]?key|authorization|credential)/i.test(
          key,
        )
      ) {
        output[key] = '[REDACTED]';
      } else {
        output[key] = redactSensitiveFields(child);
      }
    }
    return output;
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(api[_-]?key|bridge[_-]?key|private[_-]?key|app[_-]?key|access[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
  }
  return value;
}

export class CloudflareAdminClient {
  constructor(private credentialStore: CloudflareAdminCredentialStore) {}

  async execute(
    manager: CloudflareManagerLevel,
    operation: CloudflareManagerOperation,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!CLOUDFLARE_ADMIN_ENDPOINT) {
      throw new Error(
        'Cloudflare gateway endpoint is invalid or not allowlisted.',
      );
    }

    if (!this.credentialStore.isKeyLoaded) {
      throw new Error('Cloudflare gateway credential is still loading.');
    }

    const key = this.credentialStore.getGatewayKey();
    if (!key) {
      throw new Error(
        'Cloudflare manager is not configured. Add the gateway credential in Settings.',
      );
    }

    if (signal?.aborted) {
      throw new Error('Cloudflare request was cancelled.');
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, {once: true});
    const timeout = setTimeout(() => controller.abort(), 20000);

    let response: Response;
    let raw: string;
    try {
      response = await fetch(CLOUDFLARE_ADMIN_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({manager, operation, args}),
        signal: controller.signal,
      });
      raw = await response.text();
    } catch (error) {
      if (signal?.aborted) {
        throw new Error('Cloudflare request was cancelled.');
      }
      if (controller.signal.aborted) {
        throw new Error('Cloudflare gateway request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }

    if (raw.length > MAX_RESPONSE_CHARS) {
      throw new Error('Cloudflare gateway response exceeded the allowed size.');
    }

    let payload: CloudflareGatewayResponse;
    try {
      payload = JSON.parse(raw) as CloudflareGatewayResponse;
    } catch {
      throw new Error(
        `Cloudflare gateway returned invalid JSON (HTTP ${response.status}).`,
      );
    }

    if (
      payload.ok === true &&
      (payload.manager !== manager || payload.operation !== operation)
    ) {
      throw new Error('Cloudflare gateway response context mismatch.');
    }

    if (!response.ok || payload.ok !== true) {
      const safeError = redactSensitiveFields(payload.error);
      const message =
        typeof safeError === 'string'
          ? safeError.slice(0, 500)
          : `Cloudflare gateway request failed (HTTP ${response.status}).`;
      throw new Error(message);
    }

    return redactSensitiveFields(payload.data);
  }
}
