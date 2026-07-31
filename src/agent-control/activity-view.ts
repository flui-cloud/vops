import { AgentOperation, AgentPlan, AgentSession } from './agent-model';
import { CapabilityDefinition } from './capability-registry';

export interface ActivityLine {
  operationId: string;
  at: string;
  durationMs: number;
  actor: string;
  sessionId: string;
  planId: string;
  /** One sentence a human can read without opening anything: what was done, where. */
  headline: string;
  target?: string;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'running';
  verification: 'passed' | 'degraded' | 'failed' | 'not_verified';
  /** Named checks that did not pass, so the row can say why it is not a clean success. */
  failedChecks: string[];
  error?: string;
  steps: Array<{ step: string; action: string; detail?: string }>;
}

export interface ActivityInputs {
  operations: AgentOperation[];
  plans: AgentPlan[];
  sessions: AgentSession[];
  capabilities: CapabilityDefinition[];
}

/** Turn the raw operation/plan/session records into rows the Agents page can render
 * directly. Kept pure and outside the controller so the phrasing is unit-testable. */
export function activityLines(input: ActivityInputs): ActivityLine[] {
  const planById = new Map(input.plans.map((plan) => [plan.id, plan]));
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]));
  const actionById = new Map(input.capabilities.map((entry) => [entry.id, entry.action]));
  return input.operations
    .map((operation) => line(operation, planById.get(operation.planId), sessionById.get(operation.sessionId), actionById))
    .sort((a, b) => b.at.localeCompare(a.at));
}

function line(
  operation: AgentOperation,
  plan: AgentPlan | undefined,
  session: AgentSession | undefined,
  actions: Map<string, string>,
): ActivityLine {
  const steps = (plan?.steps ?? []).map((step) => ({
    step: step.id,
    action: actions.get(step.capability) ?? step.capability,
    detail: subject(step.input),
  }));
  const target = plan?.target ?? steps.map((step) => step.detail).find(Boolean);
  return {
    operationId: operation.id,
    at: operation.updatedAt,
    durationMs: Math.max(0, Date.parse(operation.updatedAt) - Date.parse(operation.createdAt)),
    actor: session?.actor.displayName ?? session?.actor.client ?? 'unknown agent',
    sessionId: operation.sessionId,
    planId: operation.planId,
    headline: headline(plan, steps, target),
    ...(target ? { target } : {}),
    outcome: outcome(operation),
    verification: operation.verification?.status ?? 'not_verified',
    failedChecks: (operation.verification?.checks ?? []).flatMap((check) => check.failed),
    ...(operation.error ? { error: operation.error.message } : {}),
    steps,
  };
}

function headline(
  plan: AgentPlan | undefined,
  steps: ActivityLine['steps'],
  target: string | undefined,
): string {
  if (plan?.objective) return plan.objective;
  if (!steps.length) return 'Ran a plan that is no longer stored.';
  const first = steps[0].action;
  const rest = steps.length > 1 ? ` and ${steps.length - 1} more step(s)` : '';
  return target ? `${first} on ${target}${rest}` : `${first}${rest}`;
}

function outcome(operation: AgentOperation): ActivityLine['outcome'] {
  if (operation.state === 'succeeded') return 'succeeded';
  if (['failed', 'rollback_failed'].includes(operation.state)) return 'failed';
  if (['cancelled', 'cancelling'].includes(operation.state)) return 'cancelled';
  return 'running';
}

/** What the step acted on, in the order the policy engine itself resolves a target. */
function subject(input: Record<string, unknown>): string | undefined {
  for (const key of ['host', 'target', 'name', 'id']) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}
