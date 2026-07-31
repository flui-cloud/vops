import { Injectable } from '@nestjs/common';
import { AgentSafetyState } from '../agent-control/agent-safety-state';
import { AgentSessionManager } from '../agent-control/agent-session-manager';
import { AgentStore } from '../agent-control/agent-store';
import { ApprovalManager } from '../agent-control/approval-manager';
import { localId } from '../agent-control/ids';
import { OperationManager } from '../agent-control/operation-manager';
import { PlanEngine } from '../agent-control/plan-engine';
import { DeviceRegistry } from './device-registry';
import { RemoteCryptoService } from './remote-crypto.service';
import {
  RemoteCommandRequest,
  SignedRemoteCommandPayload,
  SignedRemoteCommandV1,
} from './remote-message.types';
import { RemoteDevice } from './remote-model';
import { RemoteMessenger } from './remote-messenger';
import { RemoteStore } from './remote-store';
import { IntentService, RemoteIntentProposal } from './intent.service';

const CLOCK_SKEW_MS = 30_000;
const MAX_COMMAND_LIFETIME_MS = 5 * 60_000;
const COMMAND_TYPES = new Set([
  'approval.decision',
  'operation.cancel_request',
  'operation.rollback_request',
  'agent.pause_request',
  'agent.resume_request',
  'agent.revoke_request',
  'agents.stop_all_request',
  'notification.dismiss_request',
  'intent.create_request',
  'intent.pause_request',
  'intent.revoke_request',
]);

export interface RemoteCommandResult {
  type: 'command.completed' | 'command.rejected';
  request_id: string;
  command_id?: string;
  state: 'executed' | 'rejected';
  authoritative: true;
  duplicate?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  completed_at: string;
}

@Injectable()
export class RemoteCommandHandler {
  constructor(
    private readonly crypto: RemoteCryptoService,
    private readonly devices: DeviceRegistry,
    private readonly store: RemoteStore,
    private readonly messenger: RemoteMessenger,
    private readonly approvals: ApprovalManager,
    private readonly plans: PlanEngine,
    private readonly operations: OperationManager,
    private readonly sessions: AgentSessionManager,
    private readonly safety: AgentSafetyState,
    private readonly intents: IntentService,
    private readonly audit: AgentStore,
  ) {}

  async handle(
    envelopeDevice: RemoteDevice,
    request: RemoteCommandRequest,
  ): Promise<void> {
    const signed = request.signed_command;
    const commandId = safeCommandId(signed?.payload?.command_id);
    try {
      const device = await this.verify(envelopeDevice, signed);
      const previous = await this.store.getCommand<RemoteCommandResult>(signed.payload.command_id);
      if (previous) {
        await this.send(device, { ...previous, request_id: request.request_id, duplicate: true });
        return;
      }
      const reserved = await this.store.rememberCommand(
        signed.payload.command_id,
        device.id,
        signed.payload.nonce,
        {
          type: 'command.received',
          request_id: request.request_id,
          command_id: signed.payload.command_id,
          state: 'received',
          authoritative: true,
          received_at: new Date().toISOString(),
        },
      );
      if (!reserved) {
        const duplicate = await this.store.getCommand<RemoteCommandResult>(signed.payload.command_id);
        if (duplicate) {
          await this.send(device, { ...duplicate, request_id: request.request_id, duplicate: true });
          return;
        }
        throw commandError('VOPS_REMOTE_COMMAND_REPLAYED', 'Command ID or nonce was already used.');
      }
      await this.messenger.send(device, 'remote_command', {
        type: 'command.received',
        request_id: request.request_id,
        command_id: signed.payload.command_id,
        state: 'received',
        authoritative: true,
        received_at: new Date().toISOString(),
      }, 5 * 60_000);
      await this.event(device, signed.payload, 'remote.command.received', 'Accepted a signed remote command.');
      const result = await this.execute(device, signed.payload);
      const completed: RemoteCommandResult = {
        type: 'command.completed',
        request_id: request.request_id,
        command_id: signed.payload.command_id,
        state: 'executed',
        authoritative: true,
        result,
        completed_at: new Date().toISOString(),
      };
      await this.store.saveCommandResult(signed.payload.command_id, completed);
      await this.send(device, completed);
      await this.event(device, signed.payload, 'remote.command.completed', 'Completed a signed remote command.');
    } catch (error) {
      const rejected: RemoteCommandResult = {
        type: 'command.rejected',
        request_id: request.request_id,
        ...(commandId ? { command_id: commandId } : {}),
        state: 'rejected',
        authoritative: true,
        error: {
          code: remoteCommandCode(error),
          message: safeCommandError(error),
        },
        completed_at: new Date().toISOString(),
      };
      if (commandId) {
        const existing = await this.store.getCommand(commandId);
        if (existing) await this.store.saveCommandResult(commandId, rejected);
      }
      await this.send(envelopeDevice, rejected).catch(() => undefined);
      await this.event(
        envelopeDevice,
        signed?.payload,
        'remote.command.rejected',
        'Rejected a signed remote command.',
      );
    }
  }

  private async verify(
    envelopeDevice: RemoteDevice,
    signed: SignedRemoteCommandV1,
  ): Promise<RemoteDevice> {
    validateSignedCommandShape(signed);
    const payload = signed.payload;
    const device = await this.devices.getActiveByRoute(envelopeDevice.routeId);
    const node = await this.crypto.ensureNodeIdentity();
    if (device.id !== payload.device_id || payload.node_id !== node.nodeId) {
      throw commandError('VOPS_REMOTE_COMMAND_BINDING', 'Command identity binding failed.');
    }
    if (signed.key_id !== device.keyId) {
      throw commandError('VOPS_REMOTE_COMMAND_KEY', 'Command signing key is not current.');
    }
    const signature = await this.crypto.verifyDeviceSignature(
      payload,
      signed.signature,
      device.signingPublicKey,
    );
    if (!signature) throw commandError('VOPS_REMOTE_COMMAND_SIGNATURE', 'Command signature is invalid.');
    validateCommandTime(payload);
    authorizeRole(device, payload);
    return device;
  }

  private async execute(device: RemoteDevice, payload: SignedRemoteCommandPayload): Promise<unknown> {
    if (payload.type === 'approval.decision') return this.decideApproval(device, payload);
    if (payload.type === 'operation.cancel_request') {
      requireSubject(payload, 'operation');
      const operation = await this.operations.get(payload.subject.id);
      requireVersion(payload, Date.parse(operation.updatedAt));
      await this.requirePlanScope(device, operation.planId);
      return this.operations.requestCancel(operation.id);
    }
    if (payload.type === 'operation.rollback_request') {
      requireSubject(payload, 'operation');
      const operation = await this.operations.get(payload.subject.id);
      requireVersion(payload, Date.parse(operation.updatedAt));
      await this.requirePlanScope(device, operation.planId);
      if (!operation.rollbackAvailable) {
        throw commandError('VOPS_REMOTE_ROLLBACK_UNAVAILABLE', 'This operation has no rollback contract.');
      }
      if (!['succeeded', 'failed'].includes(operation.state)) {
        throw commandError('VOPS_REMOTE_COMMAND_STALE', `Operation is ${operation.state}, not rollback-eligible.`);
      }
      return this.operations.transition(operation.id, 'rollback_requested');
    }
    if (payload.type.startsWith('agent.')) {
      requireSubject(payload, 'agent_session');
      const session = await this.sessions.show(payload.subject.id);
      requireVersion(payload, Date.parse(session.updatedAt));
      requireProjectScope(device, session.repository.name);
      if (payload.type === 'agent.pause_request') return this.sessions.pause(session.id);
      if (payload.type === 'agent.resume_request') return this.sessions.resume(session.id);
      return this.sessions.revoke(session.id);
    }
    if (payload.type === 'agents.stop_all_request') {
      requireSubject(payload, 'control_node');
      await this.safety.activate(`remote_device:${device.id}`, commandReason(payload));
      const sessions = await this.sessions.stopAll();
      return { emergencyStop: this.safety.current(), stoppedSessions: sessions.map((entry) => entry.id) };
    }
    if (payload.type === 'intent.create_request') {
      requireSubject(payload, 'intent');
      requireVersion(payload, 0);
      const proposal = payload.parameters.intent as RemoteIntentProposal;
      if (!proposal || proposal.id !== payload.subject.id) {
        throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Signed intent subject does not match its proposal.');
      }
      return this.intents.create(device, proposal);
    }
    if (payload.type === 'intent.pause_request' || payload.type === 'intent.revoke_request') {
      requireSubject(payload, 'intent');
      const intent = await this.store.getIntent(payload.subject.id);
      if (!intent || intent.deviceId !== device.id) {
        throw commandError('VOPS_REMOTE_SCOPE_DENIED', 'Intent is unavailable to this device.');
      }
      requireVersion(payload, intent.version);
      return payload.type === 'intent.pause_request'
        ? this.intents.pause(intent.id, device.id)
        : this.intents.revoke(intent.id, device.id);
    }
    throw commandError('VOPS_REMOTE_COMMAND_UNSUPPORTED', `Command '${payload.type}' is not enabled yet.`);
  }

  private async decideApproval(
    device: RemoteDevice,
    payload: SignedRemoteCommandPayload,
  ): Promise<unknown> {
    requireSubject(payload, 'approval');
    const approval = await this.audit.getApproval(payload.subject.id);
    if (!approval) throw commandError('VOPS_REMOTE_APPROVAL_NOT_FOUND', 'Approval was not found.');
    requireVersion(payload, Date.parse(approval.requestedAt));
    if (approval.status !== 'pending') {
      throw commandError('VOPS_REMOTE_COMMAND_STALE', `Approval is already ${approval.status}.`);
    }
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      throw commandError('VOPS_REMOTE_COMMAND_EXPIRED', 'Approval expired.');
    }
    if (Date.parse(payload.expires_at) > Date.parse(approval.expiresAt)) {
      throw commandError('VOPS_REMOTE_COMMAND_EXPIRED', 'Command outlives the authoritative approval.');
    }
    if (!approval.planId || !payload.plan_hash) {
      throw commandError('VOPS_REMOTE_PLAN_HASH', 'Approval decision requires an exact plan hash.');
    }
    const plan = await this.plans.get(approval.planId);
    if (plan.hash !== payload.plan_hash) {
      throw commandError('VOPS_REMOTE_PLAN_HASH', 'Plan changed after it was displayed.');
    }
    const validation = await this.plans.validate(plan);
    if (!validation.valid || plan.status !== 'awaiting_approval') {
      throw commandError('VOPS_REMOTE_COMMAND_STALE', 'Plan is no longer approval-eligible.');
    }
    requireDeviceScope(device, plan.target, plan.environment, approval.risk);
    if (!device.restrictions.approvalKinds.includes('plan')) {
      throw commandError('VOPS_REMOTE_SCOPE_DENIED', 'This device cannot approve plans.');
    }
    const decision = String(payload.parameters.decision ?? '');
    const reason = commandReason(payload);
    if (decision === 'approve') {
      return this.approvals.approve(
        approval.id,
        reason || `Approved by remote device ${device.label}.`,
        `remote_device:${device.id}`,
      );
    }
    if (decision === 'deny') {
      return this.approvals.deny(
        approval.id,
        reason || `Denied by remote device ${device.label}.`,
        `remote_device:${device.id}`,
      );
    }
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Approval decision must be approve or deny.');
  }

  private async requirePlanScope(device: RemoteDevice, planId: string): Promise<void> {
    const plan = await this.plans.get(planId);
    const highest = plan.steps
      .map((entry) => entry.risk)
      .sort((left, right) => riskRank(right) - riskRank(left))[0] ?? 'read_only';
    requireDeviceScope(device, plan.target, plan.environment, highest);
  }

  private send(device: RemoteDevice, payload: RemoteCommandResult): Promise<unknown> {
    return this.messenger.send(device, 'remote_command', payload, 5 * 60_000);
  }

  private async event(
    device: RemoteDevice,
    payload: SignedRemoteCommandPayload | undefined,
    eventType: string,
    summary: string,
  ): Promise<void> {
    await this.audit.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      actor: `remote_device:${device.id}`,
      eventType,
      summary,
      detail: {
        commandId: safeCommandId(payload?.command_id),
        commandType: payload?.type,
        subject: payload?.subject,
      },
    });
  }
}

export function validateSignedCommandShape(signed: SignedRemoteCommandV1): void {
  if (!signed || typeof signed !== 'object' || !signed.payload || typeof signed.payload !== 'object') {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Signed command is malformed.');
  }
  const payload = signed.payload;
  if (payload.protocol_version !== 1 || !COMMAND_TYPES.has(payload.type)) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Signed command protocol or type is unsupported.');
  }
  if (!/^cmd_[A-Za-z0-9_-]{16,128}$/.test(payload.command_id ?? '')) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Command ID is invalid.');
  }
  if (!/^device_[A-Za-z0-9_-]{16,128}$/.test(payload.device_id ?? '')) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Device ID is invalid.');
  }
  if (!/^node_[A-Za-z0-9_-]{16,128}$/.test(payload.node_id ?? '')) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Control-node ID is invalid.');
  }
  if (!/^key_[A-Za-z0-9_-]{8,96}$/.test(signed.key_id ?? '') || !/^[A-Za-z0-9_-]{80,128}$/.test(signed.signature ?? '')) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Command signature encoding is invalid.');
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(payload.nonce ?? '')) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Command nonce is invalid.');
  }
  if (
    !payload.subject ||
    typeof payload.subject.id !== 'string' ||
    payload.subject.id.length < 1 ||
    payload.subject.id.length > 160 ||
    !Number.isSafeInteger(payload.subject.version) ||
    payload.subject.version < 0
  ) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Command subject is invalid.');
  }
  if (!payload.parameters || typeof payload.parameters !== 'object' || Array.isArray(payload.parameters)) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Command parameters are invalid.');
  }
  if (Object.keys(payload.parameters).length > 32) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Command has too many parameters.');
  }
  if (payload.plan_hash && !/^[a-f0-9]{64}$/.test(payload.plan_hash)) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Plan hash is invalid.');
  }
}

export function validateCommandTime(payload: SignedRemoteCommandPayload): void {
  const issued = Date.parse(payload.issued_at);
  const expires = Date.parse(payload.expires_at);
  const now = Date.now();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', 'Command timestamps are invalid.');
  }
  if (issued > now + CLOCK_SKEW_MS || expires < now - CLOCK_SKEW_MS) {
    throw commandError('VOPS_REMOTE_COMMAND_EXPIRED', 'Command is expired or materially from the future.');
  }
  if (expires - issued > MAX_COMMAND_LIFETIME_MS) {
    throw commandError('VOPS_REMOTE_COMMAND_EXPIRED', 'Command lifetime exceeds five minutes.');
  }
}

export function authorizeRole(device: RemoteDevice, payload: SignedRemoteCommandPayload): void {
  const adminOnly = new Set([
    'agents.stop_all_request',
    'intent.create_request',
    'intent.pause_request',
    'intent.revoke_request',
  ]);
  if (device.role === 'viewer') {
    throw commandError('VOPS_REMOTE_ROLE_DENIED', 'Viewer devices cannot send commands.');
  }
  if (adminOnly.has(payload.type) && device.role !== 'admin') {
    throw commandError('VOPS_REMOTE_ROLE_DENIED', 'This command requires an admin device.');
  }
}

function requireSubject(payload: SignedRemoteCommandPayload, kind: SignedRemoteCommandPayload['subject']['kind']): void {
  if (payload.subject.kind !== kind) {
    throw commandError('VOPS_REMOTE_COMMAND_INVALID', `Command subject must be ${kind}.`);
  }
}

function requireVersion(payload: SignedRemoteCommandPayload, version: number): void {
  if (payload.subject.version !== version) {
    throw commandError('VOPS_REMOTE_COMMAND_STALE', 'Command subject changed after it was displayed.');
  }
}

function requireDeviceScope(
  device: RemoteDevice,
  target: string | undefined,
  environment: string | undefined,
  risk: string,
): void {
  if (target && device.restrictions.targets.length && !device.restrictions.targets.includes(target)) {
    throw commandError('VOPS_REMOTE_SCOPE_DENIED', `Target '${target}' is outside the device grant.`);
  }
  if (environment && !device.restrictions.environments.includes(environment as any)) {
    throw commandError('VOPS_REMOTE_SCOPE_DENIED', `Environment '${environment}' is outside the device grant.`);
  }
  if (riskRank(risk) > riskRank(device.restrictions.maxRisk)) {
    throw commandError('VOPS_REMOTE_SCOPE_DENIED', `Risk '${risk}' exceeds the device grant.`);
  }
}

function requireProjectScope(device: RemoteDevice, project: string): void {
  if (device.restrictions.projects.length && !device.restrictions.projects.includes(project)) {
    throw commandError('VOPS_REMOTE_SCOPE_DENIED', `Project '${project}' is outside the device grant.`);
  }
}

function commandReason(payload: SignedRemoteCommandPayload): string {
  return typeof payload.parameters.reason === 'string'
    ? payload.parameters.reason.trim().slice(0, 500)
    : '';
}

function riskRank(risk: string): number {
  return ['read_only', 'low', 'medium', 'high', 'destructive'].indexOf(risk);
}

function safeCommandId(value: unknown): string | undefined {
  return typeof value === 'string' && /^cmd_[A-Za-z0-9_-]{16,128}$/.test(value)
    ? value
    : undefined;
}

function commandError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function remoteCommandCode(error: unknown): string {
  return typeof (error as any)?.code === 'string'
    ? String((error as any).code)
    : 'VOPS_REMOTE_COMMAND_REJECTED';
}

function safeCommandError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Remote command was rejected.';
  return /token|credential|secret|private key/i.test(message)
    ? 'Remote command was rejected by the local control plane.'
    : message.slice(0, 500);
}
