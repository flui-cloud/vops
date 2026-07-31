import { Injectable, Optional } from '@nestjs/common';
import { AgentEnvironment, AgentPlan, AgentSession } from './agent-model';
import { CapabilityDefinition, CapabilityRegistry } from './capability-registry';
import { AgentSafetyState } from './agent-safety-state';

export interface PolicyRequest {
  session: AgentSession;
  capability: string;
  input: Record<string, unknown>;
  environment: AgentEnvironment;
  approvedPlan?: AgentPlan;
}

export interface PolicyDecision {
  effect: 'allow' | 'approval_required' | 'deny';
  reason: string;
  capability: CapabilityDefinition;
}

@Injectable()
export class PolicyEngine {
  constructor(
    private readonly registry: CapabilityRegistry,
    @Optional() private readonly safety?: AgentSafetyState,
  ) {}

  evaluate(request: PolicyRequest): PolicyDecision {
    const capability = this.registry.describe(request.capability);
    const session = request.session;
    if (this.safety?.current().active && capability.access !== 'read') {
      return decision('deny', 'Agent mutations are disabled by the emergency stop.', capability);
    }
    if (!capability.enabled) return decision('deny', capability.unavailableReason ?? 'Capability unavailable.', capability);
    if (session.status !== 'active') return decision('deny', `Session is ${session.status}.`, capability);
    const outOfScope = scopeDenial(session, capability, request);
    if (outOfScope) return decision('deny', outOfScope, capability);
    if (matches(session.permissions.deny, capability.id)) {
      return decision('deny', `${capability.id} is denied by the session policy.`, capability);
    }
    if (capability.id === 'server.provision' && session.limits.maxProviderSpendEur <= 0) {
      return decision('deny', 'This session has a zero provider-spend limit.', capability);
    }
    if (capability.risk === 'read_only' && matches(session.permissions.allow, capability.id)) {
      return decision('allow', 'Read-only capability is included in the session grant.', capability);
    }
    if (matches(session.permissions.allow, capability.id)) {
      return decision('allow', 'Capability is included in the session grant.', capability);
    }
    if (
      request.approvedPlan?.status === 'approved' &&
      request.approvedPlan.sessionId === session.id &&
      (matches(session.permissions.allowWithinApprovedPlan, capability.id) ||
        matches(session.permissions.requireApproval, capability.id))
    ) {
      return decision('allow', 'Capability is included in the approved plan.', capability);
    }
    if (
      matches(session.permissions.requireApproval, capability.id) ||
      matches(session.permissions.allowWithinApprovedPlan, capability.id) ||
      capability.approvalDefaults[request.environment] !== 'session_grant'
    ) {
      return decision('approval_required', 'The capability requires an approved plan or explicit grant.', capability);
    }
    return decision('deny', `${capability.id} is not granted to this session.`, capability);
  }
}

/** A host-scoped capability names its host only through an application, so a request that
 * carries no host cannot be proven in-scope — it is refused rather than resolved late. */
function scopeDenial(
  session: AgentSession,
  capability: CapabilityDefinition,
  request: PolicyRequest,
): string | undefined {
  if (!session.scope.environments.includes(request.environment)) {
    return `Environment '${request.environment}' is outside the session scope.`;
  }
  if (!session.scope.targets.length) return undefined;
  const target = targetFrom(request.input);
  if (target) {
    return session.scope.targets.includes(target)
      ? undefined
      : `Target '${target}' is outside the session scope.`;
  }
  if (capability.hostScoped) {
    return `${capability.id} acts on one host: set 'host' to one of ${session.scope.targets.join(', ')}.`;
  }
  return undefined;
}

function matches(patterns: string[], capability: string): boolean {
  return patterns.some((pattern) => pattern === '*' || pattern === capability);
}

function targetFrom(input: Record<string, unknown>): string | undefined {
  for (const key of ['target', 'host', 'id']) {
    if (typeof input[key] === 'string' && input[key]) return String(input[key]);
  }
  return undefined;
}

function decision(
  effect: PolicyDecision['effect'],
  reason: string,
  capability: CapabilityDefinition,
): PolicyDecision {
  return { effect, reason, capability };
}
