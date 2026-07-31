import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { stableStringify } from '../agent-api/plan-store';
import {
  AgentEnvironment,
  AgentPlan,
  AgentPlanStatus,
  AgentSession,
} from './agent-model';
import { AgentStore } from './agent-store';
import { CapabilityRegistry } from './capability-registry';
import { PolicyEngine } from './policy-engine';
import { AgentControlError } from './agent-control-error';
import { containsSecretLikeField } from './redaction';
import { localId } from './ids';

export interface CreatePlanInput {
  objective: string;
  environment?: AgentEnvironment;
  target?: string;
  steps: Array<{ capability: string; input?: Record<string, unknown> }>;
  successCriteria?: string[];
  excludedEffects?: string[];
}

export interface PlanValidationResult {
  valid: boolean;
  requiresApproval: boolean;
  errors: Array<{ step?: string; path?: string; message: string }>;
}

@Injectable()
export class PlanEngine {
  constructor(
    private readonly store: AgentStore,
    private readonly registry: CapabilityRegistry,
    private readonly policy: PolicyEngine,
  ) {}

  async create(session: AgentSession, input: CreatePlanInput): Promise<AgentPlan> {
    if (!input.steps.length) {
      throw new AgentControlError('VOPS_AGENT_PLAN_INVALID', 'A plan must contain at least one step.');
    }
    const environment = input.environment ?? session.scope.environments[0] ?? 'staging';
    const errors: PlanValidationResult['errors'] = [];
    let requiresApproval = false;
    const steps = input.steps.map((step, index) => {
      const definition = this.registry.describe(step.capability);
      const stepInput = structuredClone(step.input ?? {});
      const validation = this.registry.validate(step.capability, stepInput);
      errors.push(
        ...validation.errors.map((error) => ({
          step: `step_${index + 1}`,
          path: error.path,
          message: error.message,
        })),
      );
      if (containsSecretLikeField(stepInput)) {
        errors.push({
          step: `step_${index + 1}`,
          message: 'Plans may contain logical credential references, never credential values or secret fields.',
        });
      }
      const policy = this.policy.evaluate({
        session,
        capability: step.capability,
        input: stepInput,
        environment,
      });
      if (policy.effect === 'deny') errors.push({ step: `step_${index + 1}`, message: policy.reason });
      if (policy.effect === 'approval_required') requiresApproval = true;
      return {
        id: `step_${index + 1}`,
        capability: definition.id,
        input: stepInput,
        risk: definition.risk,
      };
    });
    if (errors.length) {
      await this.store.appendEvent({
        eventId: localId('evt'),
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        actor: session.actor.client,
        eventType: 'plan.denied',
        target: input.target,
        summary: 'Rejected an invalid or out-of-scope plan.',
        detail: { objective: input.objective, errors },
      });
      throw new AgentControlError('VOPS_AGENT_PLAN_INVALID', 'The proposed plan is invalid.', 'failed', true, errors);
    }

    const now = new Date().toISOString();
    const base = {
      sessionId: session.id,
      objective: input.objective.trim(),
      environment,
      ...(input.target ? { target: input.target } : {}),
      steps,
      successCriteria: input.successCriteria ?? [],
      estimatedEffects: [...new Set(steps.flatMap((step) => this.registry.describe(step.capability).possibleEffects))],
      excludedEffects: input.excludedEffects ?? [],
      rollback: {
        available: steps.every((step) => this.registry.describe(step.capability).reversible === true),
        limitations: rollbackLimitations(steps.map((step) => this.registry.describe(step.capability).reversible)),
      },
    };
    const plan: AgentPlan = {
      id: localId('plan'),
      hash: hashPlan(base),
      ...base,
      status: requiresApproval ? 'awaiting_approval' : 'approved',
      createdAt: now,
      updatedAt: now,
    };
    await this.store.savePlan(plan);
    await this.store.appendEvent({
      eventId: localId('evt'),
      timestamp: now,
      sessionId: session.id,
      actor: session.actor.client,
      eventType: 'plan.created',
      target: plan.target,
      summary: `Created ${plan.steps.length}-step plan.`,
      detail: { planId: plan.id, hash: plan.hash, effects: plan.estimatedEffects },
    });
    return plan;
  }

  async get(id: string): Promise<AgentPlan> {
    const plan = await this.store.getPlan(id);
    if (!plan) throw new AgentControlError('VOPS_AGENT_NOT_FOUND', `Plan '${id}' was not found.`);
    return plan;
  }

  async list(sessionId?: string): Promise<AgentPlan[]> {
    return this.store.listPlans(sessionId);
  }

  async validate(plan: AgentPlan): Promise<PlanValidationResult> {
    const errors: PlanValidationResult['errors'] = [];
    const expected = hashPlan(planBody(plan));
    if (expected !== plan.hash) errors.push({ message: 'Plan content changed after it was created.' });
    for (const step of plan.steps) {
      const validation = this.registry.validate(step.capability, structuredClone(step.input));
      errors.push(...validation.errors.map((error) => ({ step: step.id, path: error.path, message: error.message })));
    }
    return {
      valid: errors.length === 0,
      requiresApproval: plan.status === 'awaiting_approval',
      errors,
    };
  }

  async requireExecutable(id: string, sessionId: string): Promise<AgentPlan> {
    const plan = await this.get(id);
    if (plan.sessionId !== sessionId) {
      throw new AgentControlError('VOPS_AGENT_SCOPE_DENIED', 'The plan belongs to a different session.', 'denied');
    }
    const validation = await this.validate(plan);
    if (!validation.valid) {
      throw new AgentControlError(
        'VOPS_AGENT_PLAN_STALE',
        'The approved plan no longer matches its content hash.',
        'denied',
        true,
        validation.errors,
      );
    }
    if (plan.status !== 'approved') {
      throw new AgentControlError(
        'VOPS_AGENT_APPROVAL_REQUIRED',
        `Plan '${id}' is ${plan.status}.`,
        'approval_required',
        true,
      );
    }
    return plan;
  }

  async setStatus(id: string, status: AgentPlanStatus): Promise<AgentPlan> {
    const plan = await this.get(id);
    const updated = { ...plan, status, updatedAt: new Date().toISOString() };
    await this.store.savePlan(updated);
    return updated;
  }
}

export function hashPlan(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function planBody(plan: AgentPlan): Omit<AgentPlan, 'id' | 'hash' | 'status' | 'createdAt' | 'updatedAt'> {
  const { id: _id, hash: _hash, status: _status, createdAt: _created, updatedAt: _updated, ...body } = plan;
  return body;
}

function rollbackLimitations(values: Array<boolean | 'conditional'>): string[] {
  if (values.some((value) => value === false)) return ['At least one plan step has no rollback operation.'];
  if (values.some((value) => value === 'conditional')) {
    return ['Rollback depends on state captured by the underlying capability and may not restore persistent data.'];
  }
  return [];
}
