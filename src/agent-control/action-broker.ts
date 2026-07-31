import { Injectable } from '@nestjs/common';
import { AgentEnvironment, AgentOperation, AgentSession } from './agent-model';
import { AgentSessionManager } from './agent-session-manager';
import { CapabilityRegistry } from './capability-registry';
import { PlanEngine, CreatePlanInput } from './plan-engine';
import { PolicyEngine } from './policy-engine';
import { ApprovalManager } from './approval-manager';
import { CoreActionExecutor } from './core-action-executor';
import { OperationManager } from './operation-manager';
import { AgentControlError } from './agent-control-error';
import { AgentStore } from './agent-store';
import { localId } from './ids';
import { redactSecrets } from './redaction';
import { summariseVerification } from './verification';

@Injectable()
export class ActionBroker {
  constructor(
    private readonly sessions: AgentSessionManager,
    private readonly registry: CapabilityRegistry,
    private readonly plans: PlanEngine,
    private readonly policy: PolicyEngine,
    private readonly approvals: ApprovalManager,
    private readonly executor: CoreActionExecutor,
    private readonly operations: OperationManager,
    private readonly store: AgentStore,
  ) {}

  async createPlan(token: string | undefined, input: CreatePlanInput) {
    const session = await this.sessions.authenticate(token);
    const plan = await this.plans.create(session, input);
    const approval = plan.status === 'awaiting_approval'
      ? await this.approvals.requestForPlan(plan, `Approve: ${plan.objective}`)
      : undefined;
    return { plan, approval };
  }

  async invoke(
    token: string | undefined,
    capability: string,
    input: Record<string, unknown>,
    opts: { objective?: string; environment?: AgentEnvironment; target?: string } = {},
  ): Promise<{ plan: Awaited<ReturnType<PlanEngine['get']>>; approval?: Awaited<ReturnType<ApprovalManager['requestForPlan']>>; operation?: AgentOperation }> {
    const session = await this.sessions.authenticate(token);
    const plan = await this.plans.create(session, {
      objective: opts.objective ?? `Run ${capability}`,
      environment: opts.environment,
      target: opts.target,
      steps: [{ capability, input }],
    });
    if (plan.status === 'awaiting_approval') {
      const approval = await this.approvals.requestForPlan(plan, `Approve ${capability}.`);
      return { plan, approval };
    }
    return { plan, operation: await this.executePlanForSession(session, plan.id) };
  }

  async executePlan(token: string | undefined, planId: string): Promise<AgentOperation> {
    const session = await this.sessions.authenticate(token);
    return this.executePlanForSession(session, planId);
  }

  async validatePlan(token: string | undefined, planId: string) {
    const session = await this.sessions.authenticate(token);
    const plan = await this.plans.get(planId);
    if (plan.sessionId !== session.id) {
      throw new AgentControlError('VOPS_AGENT_SCOPE_DENIED', 'The plan belongs to a different session.', 'denied');
    }
    return { plan, validation: await this.plans.validate(plan) };
  }

  async requestScopeExpansion(
    token: string | undefined,
    input: {
      capability: string;
      reason: string;
      target?: string;
      environment?: AgentEnvironment;
    },
  ) {
    const session = await this.sessions.authenticate(token);
    const capability = this.registry.describe(input.capability);
    return this.approvals.requestScopeExpansion({
      sessionId: session.id,
      capability: input.capability,
      reason: input.reason,
      risk: capability.risk,
      target: input.target,
      environment: input.environment,
      effects: capability.possibleEffects,
      reversible: capability.reversible,
    });
  }

  private async executePlanForSession(session: AgentSession, planId: string): Promise<AgentOperation> {
    let plan = await this.plans.get(planId);
    if (plan.sessionId !== session.id) {
      throw new AgentControlError('VOPS_AGENT_SCOPE_DENIED', 'The plan belongs to a different session.', 'denied');
    }
    if (plan.status === 'awaiting_approval') {
      await this.approvals.requireApprovedForPlan(plan.id);
      plan = await this.plans.setStatus(plan.id, 'approved');
    }
    plan = await this.plans.requireExecutable(plan.id, session.id);

    const operation = await this.operations.create({
      sessionId: session.id,
      planId: plan.id,
      rollbackAvailable: plan.rollback.available,
    });
    await this.sessions.incrementOperation(session.id);
    await this.plans.setStatus(plan.id, 'running');
    await this.operations.transition(operation.id, 'running');
    const results: Array<{ step: string; capability: string; output: unknown }> = [];

    try {
      for (const step of plan.steps) {
        if (await this.operations.shouldCancel(operation.id)) {
          await this.operations.transition(operation.id, 'cancelled');
          await this.plans.setStatus(plan.id, 'cancelled');
          return this.operations.get(operation.id);
        }
        this.requireStepAllowed(session, plan, step);
        await this.operations.transition(operation.id, 'running', {
          currentStep: step.id,
          capability: step.capability,
        });
        const output = await this.executor.execute(step.capability, structuredClone(step.input), {
          session,
          plan,
          operationId: operation.id,
        });
        results.push({ step: step.id, capability: step.capability, output: redactSecrets(output).value });
        await this.store.appendEvent({
          eventId: localId('evt'),
          timestamp: new Date().toISOString(),
          sessionId: session.id,
          actor: session.actor.client,
          operationId: operation.id,
          eventType: 'operation.step_succeeded',
          capability: step.capability,
          target: plan.target,
          summary: `${step.id} ${step.capability} succeeded.`,
          detail: { step: step.id },
        });
      }
      await this.operations.transition(operation.id, 'verifying');
      const succeeded = await this.operations.transition(operation.id, 'succeeded', {
        result: results,
        verification: summariseVerification(results),
      });
      await this.plans.setStatus(plan.id, 'succeeded');
      return succeeded;
    } catch (error) {
      const control = asControlError(error);
      await this.operations.transition(operation.id, 'failed', {
        error: { code: control.code, message: control.message, recoverable: control.recoverable },
      });
      await this.plans.setStatus(plan.id, 'failed');
      throw control;
    }
  }

  /** Policy is re-evaluated per step at execution time: an approval authorises a plan,
   * it does not survive a session that was paused, narrowed or revoked meanwhile. */
  private requireStepAllowed(
    session: AgentSession,
    plan: Awaited<ReturnType<PlanEngine['get']>>,
    step: { capability: string; input: Record<string, unknown> },
  ): void {
    const decision = this.policy.evaluate({
      session,
      capability: step.capability,
      input: step.input,
      environment: plan.environment,
      approvedPlan: { ...plan, status: 'approved' },
    });
    if (decision.effect === 'allow') return;
    const approvalNeeded = decision.effect === 'approval_required';
    throw new AgentControlError(
      approvalNeeded ? 'VOPS_AGENT_APPROVAL_REQUIRED' : 'VOPS_AGENT_SCOPE_DENIED',
      decision.reason,
      approvalNeeded ? 'approval_required' : 'denied',
      true,
    );
  }
}

function asControlError(error: unknown): AgentControlError {
  if (error instanceof AgentControlError) return error;
  if (error instanceof Error) {
    return new AgentControlError('VOPS_AGENT_OPERATION_FAILED', error.message, 'failed', true);
  }
  const message = typeof error === 'string' ? error : 'The operation failed.';
  return new AgentControlError('VOPS_AGENT_OPERATION_FAILED', message, 'failed', true);
}
