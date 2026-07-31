import { Injectable } from '@nestjs/common';
import { ActionBroker } from '../agent-control/action-broker';
import { CapabilityRegistry } from '../agent-control/capability-registry';
import { localId } from '../agent-control/ids';
import { redactSecrets } from '../agent-control/redaction';
import {
  RemoteAgentTurn,
  RemoteIntentAgentProposal,
} from './remote-agent.types';

const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

export const REMOTE_CHAT_CAPABILITIES = new Set([
  'catalog.list',
  'catalog.describe',
  'provider.list',
  'provider.prices.compare',
  'target.list',
  'target.inspect',
  'server.list',
  'server.inspect',
  'application.status',
  'healthcheck.run',
  'firewall.inspect',
]);

export interface RemoteAgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RemoteAgentToolResult {
  content: string;
  success: boolean;
}

type ToolContext = Pick<
  RemoteAgentTurn,
  'sessionToken' | 'onStatus' | 'onApproval' | 'onIntentProposal'
>;

@Injectable()
export class RemoteAgentToolsService {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly broker: ActionBroker,
  ) {}

  definitions(): RemoteAgentToolDefinition[] {
    const readTools = this.registry
      .list()
      .filter((entry) => REMOTE_CHAT_CAPABILITIES.has(entry.id) && entry.access === 'read')
      .map((entry) => ({
        name: toolName(entry.id),
        description: `${entry.summary} Read-only vOps capability '${entry.id}'.`,
        inputSchema: entry.inputSchema,
      }));
    return [
      ...readTools,
      {
        name: 'vops_propose_plan',
        description:
          'Create a governed semantic vOps plan. This never executes it; vOps policy may create an approval.',
        inputSchema: planSchema(this.plannableCapabilities()),
      },
      {
        name: 'vops_propose_intent',
        description:
          'Prepare a deterministic catalog-availability intent for explicit signed admin activation. This does not activate or execute it.',
        inputSchema: intentSchema(this.plannableCapabilities().filter((entry) => entry !== 'server.destroy')),
      },
    ];
  }

  async execute(
    tool: string,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<RemoteAgentToolResult> {
    try {
      const input = asObject(rawInput);
      if (tool === 'vops_propose_plan') return this.proposePlan(input, context);
      if (tool === 'vops_propose_intent') return this.proposeIntent(input, context);
      return this.read(tool, input, context);
    } catch (error) {
      return {
        content: boundedJson({ error: safeToolError(error) }),
        success: false,
      };
    }
  }

  private async read(
    tool: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<RemoteAgentToolResult> {
    const capability = capabilityName(tool);
    if (!REMOTE_CHAT_CAPABILITIES.has(capability)) {
      throw new Error(`Remote agent tool '${capability}' is outside the read-only contract.`);
    }
    await context.onStatus('using_tool', capability);
    const result = await this.broker.invoke(
      context.sessionToken,
      capability,
      input,
      { objective: `Remote read-only query: ${capability}` },
    );
    return {
      content: boundedJson(redactSecrets(result.operation?.result ?? result).value),
      success: true,
    };
  }

  private async proposePlan(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<RemoteAgentToolResult> {
    await context.onStatus('using_tool', 'governed plan');
    const result = await this.broker.createPlan(context.sessionToken, {
      objective: boundedRequired(input.objective, 'objective', 500),
      ...(input.environment ? { environment: String(input.environment) as any } : {}),
      ...(input.target ? { target: String(input.target) } : {}),
      steps: Array.isArray(input.steps)
        ? input.steps.map((step) => {
            const row = asObject(step);
            return {
              capability: String(row.capability ?? ''),
              input: asObject(row.input),
            };
          })
        : [],
      successCriteria: stringArray(input.successCriteria, 12, 300),
      excludedEffects: stringArray(input.excludedEffects, 12, 300),
    });
    if (result.approval) await context.onApproval?.(result.approval.id);
    return { content: boundedJson(result), success: true };
  }

  private async proposeIntent(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<RemoteAgentToolResult> {
    await context.onStatus('using_tool', 'conditional intent proposal');
    const trigger = asObject(input.trigger);
    const action = asObject(input.action);
    const constraints = asObject(input.constraints);
    const capability = boundedRequired(action.capability, 'capability', 120);
    if (
      capability === 'server.destroy' ||
      !this.plannableCapabilities().includes(capability)
    ) {
      throw new Error(`Intent capability '${capability}' is not eligible.`);
    }
    const environment = String(action.environment ?? '');
    if (!['development', 'staging', 'production'].includes(environment)) {
      throw new Error("Tool field 'environment' is invalid.");
    }
    const durationHours = boundedNumber(constraints.durationHours, 1, 720, 'durationHours');
    const proposal: RemoteIntentAgentProposal = {
      id: localId('intent'),
      objective: boundedRequired(input.objective, 'objective', 500),
      trigger: {
        type: 'catalog.availability',
        provider: boundedRequired(trigger.provider, 'provider', 80),
        serverType: boundedRequired(trigger.serverType, 'serverType', 120),
        ...(trigger.location
          ? { location: boundedRequired(trigger.location, 'location', 120) }
          : {}),
      },
      action: {
        capability,
        input: asObject(action.input),
        environment: environment as any,
        ...(action.target ? { target: boundedRequired(action.target, 'target', 160) } : {}),
      },
      constraints: {
        expiresAt: new Date(Date.now() + durationHours * 60 * 60_000).toISOString(),
        maxExecutions: 1,
        maxSpendEur: boundedNumber(constraints.maxSpendEur, 0, 100_000, 'maxSpendEur'),
        failureBehavior: 'stop',
      },
    };
    await context.onIntentProposal?.(proposal);
    return {
      content: boundedJson({
        proposal,
        state: 'awaiting_signed_admin_activation',
        executed: false,
      }),
      success: true,
    };
  }

  private plannableCapabilities(): string[] {
    return this.registry
      .list()
      .filter((entry) => entry.access !== 'read' && entry.supportsPlan)
      .map((entry) => entry.id);
  }
}

export function toolName(capability: string): string {
  return `vops_${capability.replaceAll('.', '_')}`;
}

export function capabilityName(tool: string): string {
  const suffix = tool.startsWith('vops_') ? tool.slice(5) : tool;
  for (const capability of REMOTE_CHAT_CAPABILITIES) {
    if (capability.replaceAll('.', '_') === suffix) return capability;
  }
  return suffix;
}

function planSchema(plannable: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['objective', 'steps'],
    properties: {
      objective: { type: 'string', minLength: 1, maxLength: 500 },
      environment: { enum: ['development', 'staging', 'production'] },
      target: { type: 'string', minLength: 1, maxLength: 160 },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['capability', 'input'],
          properties: {
            capability: { enum: plannable },
            input: { type: 'object', maxProperties: 48 },
          },
        },
      },
      successCriteria: stringArraySchema(12, 300),
      excludedEffects: stringArraySchema(12, 300),
    },
  };
}

function intentSchema(plannable: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['objective', 'trigger', 'action', 'constraints'],
    properties: {
      objective: { type: 'string', minLength: 1, maxLength: 500 },
      trigger: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'serverType'],
        properties: {
          provider: { type: 'string', minLength: 1, maxLength: 80 },
          serverType: { type: 'string', minLength: 1, maxLength: 120 },
          location: { type: 'string', minLength: 1, maxLength: 120 },
        },
      },
      action: {
        type: 'object',
        additionalProperties: false,
        required: ['capability', 'input', 'environment'],
        properties: {
          capability: { enum: plannable },
          input: { type: 'object', maxProperties: 48 },
          environment: { enum: ['development', 'staging', 'production'] },
          target: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
      constraints: {
        type: 'object',
        additionalProperties: false,
        required: ['durationHours', 'maxSpendEur'],
        properties: {
          durationHours: { type: 'integer', minimum: 1, maximum: 720 },
          maxSpendEur: { type: 'number', minimum: 0, maximum: 100_000 },
        },
      },
    },
  };
}

function stringArraySchema(maxItems: number, maxLength: number) {
  return {
    type: 'array',
    maxItems,
    items: { type: 'string', maxLength },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((entry) => String(entry).slice(0, maxLength))
    : [];
}

function boundedRequired(value: unknown, field: string, max: number): string {
  const result = String(value ?? '').trim();
  if (!result || result.length > max) throw new Error(`Tool field '${field}' is invalid.`);
  return result;
}

function boundedNumber(value: unknown, min: number, max: number, field: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new Error(`Tool field '${field}' is invalid.`);
  }
  return result;
}

function boundedJson(value: unknown): string {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json) <= MAX_TOOL_OUTPUT_BYTES
    ? json
    : JSON.stringify({ truncated: true, reason: 'Tool output exceeded the remote-agent limit.' });
}

function safeToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /token|credential|secret|private.?key|authorization|cookie/i.test(message)
    ? 'The vOps tool rejected the request.'
    : message.slice(0, 500);
}
