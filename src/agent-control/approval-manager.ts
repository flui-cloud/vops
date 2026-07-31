import { Injectable } from '@nestjs/common';
import { AgentApproval, AgentPlan } from './agent-model';
import { AgentStore } from './agent-store';
import { AgentControlError } from './agent-control-error';
import { localId } from './ids';
import { AgentSessionManager } from './agent-session-manager';

@Injectable()
export class ApprovalManager {
  constructor(
    private readonly store: AgentStore,
    private readonly sessions: AgentSessionManager,
  ) {}

  async requestForPlan(plan: AgentPlan, reason: string): Promise<AgentApproval> {
    const existing = (await this.store.listApprovals('pending')).find((entry) => entry.planId === plan.id);
    if (existing) return existing;
    const highest = [...plan.steps].sort((a, b) => riskRank(b.risk) - riskRank(a.risk))[0];
    const now = new Date();
    const approval: AgentApproval = {
      id: localId('apr'),
      sessionId: plan.sessionId,
      planId: plan.id,
      status: 'pending',
      reason,
      risk: highest?.risk ?? 'read_only',
      ...(plan.target ? { target: plan.target } : {}),
      environment: plan.environment,
      expectedEffects: plan.estimatedEffects,
      reversible: plan.rollback.available ? 'conditional' : false,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    };
    await this.store.saveApproval(approval);
    await this.event(approval, 'approval.requested', 'Plan approval requested.');
    return approval;
  }

  async requestScopeExpansion(input: {
    sessionId: string;
    capability: string;
    reason: string;
    risk: AgentApproval['risk'];
    target?: string;
    environment?: AgentApproval['environment'];
    effects?: string[];
    reversible?: AgentApproval['reversible'];
  }): Promise<AgentApproval> {
    const now = new Date();
    const approval: AgentApproval = {
      id: localId('apr'),
      sessionId: input.sessionId,
      capability: input.capability,
      status: 'pending',
      reason: input.reason,
      risk: input.risk,
      ...(input.target ? { target: input.target } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      expectedEffects: input.effects ?? [],
      reversible: input.reversible ?? false,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    };
    await this.store.saveApproval(approval);
    await this.event(approval, 'approval.scope_requested', `Scope expansion requested for ${input.capability}.`);
    return approval;
  }

  async list(status?: string): Promise<AgentApproval[]> {
    const approvals = await this.store.listApprovals(status);
    const expired = approvals.filter(
      (approval) => approval.status === 'pending' && new Date(approval.expiresAt).getTime() <= Date.now(),
    );
    await Promise.all(expired.map((approval) => this.decide(approval.id, 'expired', 'Approval window expired.')));
    return expired.length ? this.store.listApprovals(status) : approvals;
  }

  async approve(
    id: string,
    reason = 'Approved by the local user.',
    actor = 'local_user',
  ): Promise<AgentApproval> {
    return this.decide(id, 'approved', reason, actor);
  }

  async deny(
    id: string,
    reason = 'Denied by the local user.',
    actor = 'local_user',
  ): Promise<AgentApproval> {
    return this.decide(id, 'denied', reason, actor);
  }

  async requireApprovedForPlan(planId: string): Promise<AgentApproval> {
    const approval = (await this.store.listApprovals()).find((entry) => entry.planId === planId);
    if (!approval || approval.status !== 'approved') {
      throw new AgentControlError(
        'VOPS_AGENT_APPROVAL_REQUIRED',
        `Plan '${planId}' has not been approved.`,
        'approval_required',
        true,
        approval,
      );
    }
    return approval;
  }

  private async decide(
    id: string,
    status: Extract<AgentApproval['status'], 'approved' | 'denied' | 'expired'>,
    reason: string,
    actor = 'vops',
  ): Promise<AgentApproval> {
    const approval = await this.store.getApproval(id);
    if (!approval) throw new AgentControlError('VOPS_AGENT_NOT_FOUND', `Approval '${id}' was not found.`);
    if (approval.status !== 'pending') {
      if (approval.status === status) return approval;
      throw new AgentControlError('VOPS_AGENT_PLAN_INVALID', `Approval '${id}' is already ${approval.status}.`);
    }
    if (status === 'approved' && new Date(approval.expiresAt).getTime() <= Date.now()) {
      return this.decide(id, 'expired', 'Approval window expired.', 'vops');
    }
    const updated: AgentApproval = {
      ...approval,
      status,
      decidedAt: new Date().toISOString(),
      decisionReason: reason,
    };
    await this.store.saveApproval(updated);
    if (status === 'approved' && updated.capability && !updated.planId) {
      await this.sessions.grantScope(updated.sessionId, {
        capability: updated.capability,
        target: updated.target,
        environment: updated.environment,
      });
    }
    await this.event(updated, `approval.${status}`, `Approval ${status}.`, actor);
    return updated;
  }

  private async event(
    approval: AgentApproval,
    eventType: string,
    summary: string,
    actor = 'vops',
  ): Promise<void> {
    await this.store.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      sessionId: approval.sessionId,
      actor,
      eventType,
      capability: approval.capability,
      target: approval.target,
      summary,
      detail: { approvalId: approval.id, planId: approval.planId, reason: approval.reason },
    });
  }
}

function riskRank(risk: AgentApproval['risk']): number {
  return ['read_only', 'low', 'medium', 'high', 'destructive'].indexOf(risk);
}
