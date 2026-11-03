import {
  cloudflareAdminClient,
  type CloudflareManagerLevel,
  type CloudflareManagerOperation,
} from './CloudflareAdminClient';
import {
  TalentEngine,
  TalentExecuteContext,
  TalentResult,
  ToolDefinition,
  SystemPromptContext,
} from './types';

type GatewayClient = {
  execute: (
    manager: CloudflareManagerLevel,
    operation: CloudflareManagerOperation,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

const LEVEL1_OPERATIONS = new Set([
  'status',
  'agents.list',
  'tasks.list',
  'knowledge.search',
]);

const LEVEL2_OPERATIONS = new Set([
  'health',
  'financial.status',
  'financial.pending',
  'financial.strategy.get',
  'financial.knowledge.list',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validateArguments(
  operation: CloudflareManagerOperation,
  raw: unknown,
): Record<string, unknown> | string {
  const args = raw === undefined ? {} : raw;
  if (!isRecord(args)) {
    return 'The args argument must be an object.';
  }

  switch (operation) {
    case 'agents.list':
    case 'tasks.list':
    case 'financial.pending': {
      const limit = args.limit === undefined ? 5 : args.limit;
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 10
      ) {
        return 'limit must be an integer from 1 to 10.';
      }
      return {limit};
    }
    case 'knowledge.search': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 200) {
        return 'query is required and must be at most 200 characters.';
      }
      return {query};
    }
    case 'financial.knowledge.list': {
      const style = args.style;
      if (style !== 'ICT' && style !== 'RTM' && style !== 'NDS') {
        return 'style must be ICT, RTM, or NDS.';
      }
      return {style};
    }
    case 'status':
    case 'health':
    case 'financial.status':
    case 'financial.strategy.get':
      return {};
    default:
      return 'Unsupported Cloudflare manager operation.';
  }
}

export class CloudflareAdminEngine implements TalentEngine {
  readonly name = 'cloudflare_admin';
  readonly recommendedContextTokens = 1400;

  constructor(private client: GatewayClient = cloudflareAdminClient) {}

  async execute(
    raw: Record<string, any>,
    ctx?: TalentExecuteContext,
  ): Promise<TalentResult> {
    const manager = raw.manager;
    const operation = raw.operation;

    if (manager !== 'level1' && manager !== 'level2') {
      return this.error('manager must be level1 or level2.');
    }

    if (typeof operation !== 'string') {
      return this.error('operation is required.');
    }

    const allowed =
      manager === 'level1' ? LEVEL1_OPERATIONS : LEVEL2_OPERATIONS;
    if (!allowed.has(operation)) {
      return this.error(
        `Operation "${operation}" is not available on manager ${manager}.`,
      );
    }

    const args = validateArguments(
      operation as CloudflareManagerOperation,
      raw.args,
    );
    if (typeof args === 'string') {
      return this.error(args);
    }

    if (ctx?.signal.aborted) {
      return this.error('Request cancelled.');
    }

    try {
      const data = await this.client.execute(
        manager as CloudflareManagerLevel,
        operation as CloudflareManagerOperation,
        args,
        ctx?.signal,
      );
      const serialized = JSON.stringify(data, null, 2) ?? 'null';
      const summary =
        serialized.length > 10000
          ? serialized.slice(0, 10000) + '\n[response truncated]'
          : serialized;
      return {
        type: 'text',
        summary: `Cloudflare ${manager} — ${operation}\n${summary}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.error(message);
    }
  }

  private error(message: string): TalentResult {
    return {
      type: 'error',
      summary: `cloudflare_admin: ${message}`,
      errorMessage: message,
    };
  }

  systemPromptFragment(_ctx: SystemPromptContext): string {
    return (
      'cloudflare_admin provides read-only access to the configured Goldstar ' +
      'Cloudflare managers. Use level1 for central-manager status, agents, tasks, ' +
      'and its knowledge search. Use level2 for financial-manager health, status, ' +
      'pending rules, strategy, and ICT/RTM/NDS knowledge. This tool cannot deploy, ' +
      'edit, delete, approve, or change Cloudflare resources. Never claim that a ' +
      'change was made through this tool.'
    );
  }

  toToolDefinition(): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description:
          'Read information from the Goldstar Cloudflare manager hierarchy. Choose level1 for the central manager and level2 for the financial manager. Read-only; no changes or deployments are possible.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            manager: {
              type: 'string',
              enum: ['level1', 'level2'],
              description: 'level1 = personal-ai-manager; level2 = financial manager.',
            },
            operation: {
              type: 'string',
              enum: [
                'status',
                'agents.list',
                'tasks.list',
                'knowledge.search',
                'health',
                'financial.status',
                'financial.pending',
                'financial.strategy.get',
                'financial.knowledge.list',
              ],
              description:
                'Allowed read-only operation. Availability depends on the selected manager level.',
            },
            args: {
              type: 'object',
              additionalProperties: false,
              properties: {
                query: {type: 'string', maxLength: 200},
                limit: {type: 'integer', minimum: 1, maximum: 10},
                style: {type: 'string', enum: ['ICT', 'RTM', 'NDS']},
              },
            },
          },
          required: ['manager', 'operation'],
        },
      },
    };
  }
}
