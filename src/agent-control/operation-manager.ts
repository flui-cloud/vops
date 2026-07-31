import { Injectable } from '@nestjs/common';
import { AgentOperation, AgentOperationState } from './agent-model';
import { AgentStore } from './agent-store';
import { AgentControlError } from './agent-control-error';
import { localId } from './ids';

const TRANSITIONS: Record<AgentOperationState, AgentOperationState[]> = {
  proposed: ['awaiting_approval', 'approved', 'queued', 'cancelled'],
  awaiting_approval: ['approved', 'cancelled'],
  approved: ['queued', 'cancelled'],
  queued: ['running', 'cancelling', 'cancelled'],
  running: ['verifying', 'succeeded', 'failed', 'cancelling'],
  verifying: ['succeeded', 'failed', 'cancelling'],
  succeeded: ['rollback_requested'],
  failed: ['rollback_requested'],
  cancelling: ['cancelled', 'failed'],
  cancelled: [],
  rollback_requested: ['rolling_back', 'rollback_failed'],
  rolling_back: ['rolled_back', 'rollback_failed'],
  rolled_back: [],
  rollback_failed: [],
};

@Injectable()
export class OperationManager {
  constructor(private readonly store: AgentStore) {}

  async create(input: {
    sessionId: string;
    planId: string;
    rollbackAvailable: boolean;
  }): Promise<AgentOperation> {
    const now = new Date().toISOString();
    const operation: AgentOperation = {
      id: localId('op'),
      sessionId: input.sessionId,
      planId: input.planId,
      state: 'queued',
      rollbackAvailable: input.rollbackAvailable,
      cancelRequested: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveOperation(operation);
    await this.event(operation, 'operation.queued', 'Operation queued.');
    return operation;
  }

  async get(id: string): Promise<AgentOperation> {
    const operation = await this.store.getOperation(id);
    if (!operation) throw new AgentControlError('VOPS_AGENT_NOT_FOUND', `Operation '${id}' was not found.`);
    return operation;
  }

  async list(sessionId?: string): Promise<AgentOperation[]> {
    return this.store.listOperations(sessionId);
  }

  async transition(
    id: string,
    state: AgentOperationState,
    patch: Partial<Pick<AgentOperation, 'currentStep' | 'capability' | 'result' | 'error' | 'cancelRequested' | 'verification'>> = {},
  ): Promise<AgentOperation> {
    const operation = await this.get(id);
    if (operation.state === state) return operation;
    if (!TRANSITIONS[operation.state].includes(state)) {
      throw new AgentControlError(
        'VOPS_AGENT_OPERATION_FAILED',
        `Invalid operation transition ${operation.state} → ${state}.`,
      );
    }
    const updated = {
      ...operation,
      ...patch,
      state,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveOperation(updated);
    await this.event(updated, `operation.${state}`, operationSummary(updated));
    return updated;
  }

  async requestCancel(id: string): Promise<AgentOperation> {
    const operation = await this.get(id);
    if (['succeeded', 'failed', 'cancelled', 'rolled_back', 'rollback_failed'].includes(operation.state)) {
      return operation;
    }
    const next = operation.state === 'queued' ? 'cancelled' : 'cancelling';
    return this.transition(id, next, { cancelRequested: true });
  }

  async shouldCancel(id: string): Promise<boolean> {
    return (await this.get(id)).cancelRequested;
  }

  private async event(operation: AgentOperation, eventType: string, summary: string): Promise<void> {
    await this.store.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      sessionId: operation.sessionId,
      actor: 'vops',
      operationId: operation.id,
      eventType,
      capability: operation.capability,
      summary,
      detail: { planId: operation.planId, currentStep: operation.currentStep, error: operation.error },
    });
  }
}

function operationSummary(operation: AgentOperation): string {
  const suffix = operation.currentStep ? ` at ${operation.currentStep}` : '';
  return `Operation ${operation.state}${suffix}.`;
}
