import { AgentApproval, AgentOperation } from './agent-model';
import { CapabilityDefinition, CapabilityRisk } from './capability-registry';
import { AgentControlError } from './agent-control-error';
import { redactSecrets } from './redaction';

export type McpStatus = 'ok' | 'approval_required' | 'denied' | 'running' | 'failed';

export interface VopsMcpEnvelope<T = unknown> {
  status: McpStatus;
  summary: string;
  data: T;
  risk: {
    level: CapabilityRisk;
    reversible: boolean | 'conditional';
    reason: string;
  };
  approval: {
    required: boolean;
    request_id: string | null;
  };
  operation: {
    id: string | null;
    state: string | null;
    /** What the plan's verification steps concluded. A succeeded operation whose
     * verification is `degraded` or `failed` has not left the target healthy. */
    verification: string | null;
  };
  next_actions: string[];
  error: null | {
    code: string;
    message: string;
    recoverable: boolean;
    detail?: unknown;
  };
}

export function okEnvelope<T>(
  summary: string,
  data: T,
  opts: {
    capability?: CapabilityDefinition;
    operation?: AgentOperation;
    approval?: AgentApproval;
    nextActions?: string[];
  } = {},
): VopsMcpEnvelope<T> {
  const redacted = redactSecrets(data);
  const status: McpStatus = opts.approval
    ? 'approval_required'
    : opts.operation && !['succeeded', 'failed', 'cancelled'].includes(opts.operation.state)
      ? 'running'
      : 'ok';
  return {
    status,
    summary,
    data: redacted.value,
    risk: {
      level: opts.capability?.risk ?? 'read_only',
      reversible: opts.capability?.reversible ?? true,
      reason: opts.capability?.summary ?? 'Product knowledge and metadata only.',
    },
    approval: {
      required: Boolean(opts.approval),
      request_id: opts.approval?.id ?? null,
    },
    operation: {
      id: opts.operation?.id ?? null,
      state: opts.operation?.state ?? null,
      verification: opts.operation?.verification?.status ?? null,
    },
    next_actions: [...(opts.nextActions ?? []), ...verificationActions(opts.operation)],
    error: null,
  };
}

/** A degraded verification is the one case where a succeeded operation still needs the
 * agent to do something, so the envelope says so instead of leaving it to be inferred. */
function verificationActions(operation?: AgentOperation): string[] {
  const verification = operation?.verification;
  if (!verification || verification.status === 'passed' || verification.status === 'not_verified') return [];
  const failed = verification.checks.flatMap((check) => check.failed);
  return [
    failed.length
      ? `Verification is ${verification.status}: ${failed.join(', ')} did not pass. Diagnose before reporting success.`
      : `Verification is ${verification.status}. Diagnose before reporting success.`,
  ];
}

export function errorEnvelope(error: unknown): VopsMcpEnvelope {
  const known = error instanceof AgentControlError
    ? error
    : new AgentControlError(
        'VOPS_AGENT_OPERATION_FAILED',
        error instanceof Error ? error.message : String(error),
      );
  const redacted = redactSecrets(known.detail);
  return {
    status: known.status,
    summary: known.message,
    data: {},
    risk: {
      level: 'read_only',
      reversible: true,
      reason: 'The request did not pass the local control-plane boundary.',
    },
    approval: {
      required: known.status === 'approval_required',
      request_id: null,
    },
    operation: { id: null, state: null, verification: null },
    next_actions: known.recoverable ? ['Correct the request or ask the user for the required scope.'] : [],
    error: {
      code: known.code,
      message: known.message,
      recoverable: known.recoverable,
      ...(redacted.value === undefined ? {} : { detail: redacted.value }),
    },
  };
}
