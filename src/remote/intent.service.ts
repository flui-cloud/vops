import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ActionBroker } from '../agent-control/action-broker';
import { AgentSessionManager } from '../agent-control/agent-session-manager';
import { AgentStore } from '../agent-control/agent-store';
import { ApprovalManager } from '../agent-control/approval-manager';
import { CapabilityRegistry } from '../agent-control/capability-registry';
import { localId } from '../agent-control/ids';
import { VopsCatalogService } from '../catalog/vops-catalog.service';
import { LocalConfigStore } from '../lib/config/local-config-store';
import { profileDir } from '../lib/profile';
import { RemoteDevice, RemoteIntent } from './remote-model';
import { RemoteMessenger } from './remote-messenger';
import { RemoteStore } from './remote-store';

const CHECK_INTERVAL_MS = 60_000;
const MAX_INTENT_LIFETIME_MS = 30 * 24 * 60 * 60_000;

export interface RemoteIntentProposal {
  id: string;
  objective: string;
  trigger: RemoteIntent['trigger'];
  action: RemoteIntent['action'];
  constraints: RemoteIntent['constraints'];
}

@Injectable()
export class IntentService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly secrets = new LocalConfigStore();
  private timer?: NodeJS.Timeout;
  private checking = false;

  constructor(
    private readonly store: RemoteStore,
    private readonly sessions: AgentSessionManager,
    private readonly capabilities: CapabilityRegistry,
    private readonly broker: ActionBroker,
    private readonly approvals: ApprovalManager,
    private readonly catalog: VopsCatalogService,
    private readonly messenger: RemoteMessenger,
    private readonly audit: AgentStore,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async create(device: RemoteDevice, proposal: RemoteIntentProposal): Promise<RemoteIntent> {
    validateProposal(proposal);
    if (await this.store.getIntent(proposal.id)) throw new Error('Intent ID already exists.');
    const capability = this.capabilities.describe(proposal.action.capability);
    if (!capability.enabled || !capability.supportsPlan || capability.access === 'read') {
      throw new Error('Intent action must be an enabled planned mutation.');
    }
    if (capability.risk === 'destructive' || riskRank(capability.risk) > riskRank(device.restrictions.maxRisk)) {
      throw new Error('Intent action risk exceeds the device grant.');
    }
    if (!device.restrictions.environments.includes(proposal.action.environment)) {
      throw new Error('Intent environment is outside the device grant.');
    }
    if (
      proposal.action.target &&
      device.restrictions.targets.length &&
      !device.restrictions.targets.includes(proposal.action.target)
    ) {
      throw new Error('Intent target is outside the device grant.');
    }
    if (proposal.constraints.maxSpendEur > device.restrictions.maxProviderSpendEur) {
      throw new Error('Intent spending cap exceeds the device grant.');
    }

    const workspace = path.join(profileDir(), 'remote-intent-workspace');
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const all = this.capabilities.list({ includeUnavailable: true }).map((entry) => entry.id);
    const created = await this.sessions.create({
      client: 'other',
      displayName: `Conditional intent ${proposal.id}`,
      objective: proposal.objective,
      repository: workspace,
      mode: 'advisory',
      targets: proposal.action.target ? [proposal.action.target] : device.restrictions.targets,
      environments: [proposal.action.environment],
      permissions: {
        allow: [],
        allowWithinApprovedPlan: [proposal.action.capability],
        requireApproval: [],
        deny: all.filter((entry) => entry !== proposal.action.capability),
      },
      expiresInMinutes: 12 * 60,
      maxOperations: 1,
      maxProviderSpendEur: proposal.constraints.maxSpendEur,
    });
    await this.sessions.extendForConditionalIntent(
      created.session.id,
      proposal.constraints.expiresAt,
    );
    const planned = await this.broker.createPlan(created.token, {
      objective: proposal.objective,
      environment: proposal.action.environment,
      target: proposal.action.target,
      steps: [{ capability: proposal.action.capability, input: proposal.action.input }],
      successCriteria: ['The deterministic trigger matched within the approved intent window.'],
      excludedEffects: ['No action outside the signed intent constraints is authorized.'],
    });
    if (!planned.approval) {
      throw new Error('Conditional intent action must produce an explicit plan approval.');
    }
    await this.approvals.approve(
      planned.approval.id,
      `Pre-authorized by signed admin intent ${proposal.id}.`,
      `remote_device:${device.id}`,
    );
    const now = new Date().toISOString();
    const intent: RemoteIntent = {
      ...proposal,
      deviceId: device.id,
      version: 1,
      status: 'active',
      agentSessionId: created.session.id,
      planId: planned.plan.id,
      planHash: planned.plan.hash,
      approvalId: planned.approval.id,
      executionCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveIntent(intent);
    this.secrets.setCredentials(secretKey(intent.id), { token: created.token });
    await this.event(intent, 'remote.intent.activated', 'Activated a signed conditional intent.');
    return intent;
  }

  async pause(id: string, deviceId: string): Promise<RemoteIntent> {
    return this.transition(id, deviceId, 'paused');
  }

  async revoke(id: string, deviceId: string): Promise<RemoteIntent> {
    const intent = await this.transition(id, deviceId, 'revoked');
    await this.deactivate(intent);
    return intent;
  }

  async disableForDevice(deviceId: string, revoke: boolean): Promise<void> {
    const intents = (await this.store.listIntents()).filter(
      (entry) =>
        entry.deviceId === deviceId &&
        (entry.status === 'active' || entry.status === 'paused'),
    );
    for (const intent of intents) {
      const status = revoke ? 'revoked' : 'paused';
      const updated = await this.update(intent, { status });
      await this.event(
        updated,
        `remote.intent.${status}`,
        `Conditional intent ${status} because its authorizing device was ${revoke ? 'revoked' : 'suspended'}.`,
      );
      if (revoke) await this.deactivate(updated);
    }
  }

  async tick(now = new Date()): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const intents = await this.store.listIntents();
      for (const intent of intents.filter((entry) => entry.status === 'active')) {
        if (Date.parse(intent.constraints.expiresAt) <= now.getTime()) {
          const expired = await this.update(intent, { status: 'expired' });
          await this.event(expired, 'remote.intent.expired', 'Conditional intent expired.');
          await this.deactivate(expired);
          await this.notify(expired);
          continue;
        }
        await this.evaluate(intent, now);
      }
    } finally {
      this.checking = false;
    }
  }

  private async evaluate(intent: RemoteIntent, now: Date): Promise<void> {
    try {
      const availability = await this.catalog.availability(
        intent.trigger.provider,
        intent.trigger.serverType,
        true,
      );
      const plan = availability.plans.find((entry) =>
        entry.id.toLowerCase() === intent.trigger.serverType.toLowerCase() ||
        entry.name.toLowerCase() === intent.trigger.serverType.toLowerCase(),
      );
      const matched = Boolean(
        plan && (
          plan.everywhere ||
          plan.locations.some((entry) =>
            entry.available === true &&
            (!intent.trigger.location ||
              entry.location.toLowerCase() === intent.trigger.location.toLowerCase()),
          )
        ),
      );
      const checked = await this.update(intent, { lastCheckedAt: now.toISOString() });
      if (!matched) return;
      const triggered = await this.update(checked, {
        status: 'triggered',
        matchedAt: now.toISOString(),
      });
      await this.event(triggered, 'remote.intent.matched', 'Conditional intent trigger matched.');
      await this.execute(triggered);
    } catch (error) {
      const failed = await this.update(intent, {
        status: 'failed',
        lastError: safeError(error),
      });
      await this.event(failed, 'remote.intent.failed', 'Conditional intent evaluation failed.');
      await this.deactivate(failed);
      await this.notify(failed);
    }
  }

  private async execute(intent: RemoteIntent): Promise<void> {
    const token = this.secrets.getCredentials(secretKey(intent.id))?.token;
    if (!token) throw new Error('Intent execution credential is unavailable.');
    let executing = await this.update(intent, { status: 'executing' });
    try {
      const operation = await this.broker.executePlan(token, intent.planId);
      executing = await this.update(executing, {
        status: operation.state === 'succeeded' ? 'succeeded' : 'failed',
        executionCount: 1,
        operationId: operation.id,
        ...(operation.error ? { lastError: operation.error.message } : {}),
      });
      await this.event(
        executing,
        operation.state === 'succeeded' ? 'remote.intent.succeeded' : 'remote.intent.failed',
        `Conditional intent execution ${operation.state}.`,
      );
      await this.deactivate(executing);
      await this.notify(executing);
    } catch (error) {
      const failed = await this.update(executing, {
        status: 'failed',
        executionCount: 1,
        lastError: safeError(error),
      });
      await this.event(failed, 'remote.intent.failed', 'Conditional intent execution failed.');
      await this.deactivate(failed);
      await this.notify(failed);
    }
  }

  private async transition(
    id: string,
    deviceId: string,
    status: 'paused' | 'revoked',
  ): Promise<RemoteIntent> {
    const intent = await this.store.getIntent(id);
    if (!intent || intent.deviceId !== deviceId) throw new Error('Intent is unavailable to this device.');
    if (!['active', 'paused'].includes(intent.status)) {
      if (intent.status === status) return intent;
      throw new Error(`Intent is ${intent.status} and cannot become ${status}.`);
    }
    const updated = await this.update(intent, { status });
    await this.event(updated, `remote.intent.${status}`, `Conditional intent ${status}.`);
    return updated;
  }

  private async update(intent: RemoteIntent, patch: Partial<RemoteIntent>): Promise<RemoteIntent> {
    const updated: RemoteIntent = {
      ...intent,
      ...patch,
      version: intent.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveIntent(updated);
    return updated;
  }

  private async notify(intent: RemoteIntent): Promise<void> {
    const device = await this.store.getDevice(intent.deviceId);
    if (!device || device.status !== 'active') return;
    await this.messenger.send(device, 'notification', {
      type: 'intent.updated',
      intent: publicIntent(intent),
    }, 60 * 60_000).catch(() => undefined);
  }

  private async deactivate(intent: RemoteIntent): Promise<void> {
    await Promise.resolve(this.sessions.revoke(intent.agentSessionId)).catch(() => undefined);
    this.secrets.remove(secretKey(intent.id));
  }

  private async event(intent: RemoteIntent, eventType: string, summary: string): Promise<void> {
    await this.audit.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      sessionId: intent.agentSessionId,
      actor: 'intent_watcher',
      eventType,
      summary,
      detail: publicIntent(intent),
    });
  }
}

export function publicIntent(intent: RemoteIntent) {
  return {
    id: intent.id,
    device_id: intent.deviceId,
    version: intent.version,
    objective: intent.objective,
    status: intent.status,
    trigger: intent.trigger,
    action: intent.action,
    constraints: intent.constraints,
    plan_id: intent.planId,
    plan_hash: intent.planHash,
    execution_count: intent.executionCount,
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
    ...(intent.lastCheckedAt ? { last_checked_at: intent.lastCheckedAt } : {}),
    ...(intent.matchedAt ? { matched_at: intent.matchedAt } : {}),
    ...(intent.operationId ? { operation_id: intent.operationId } : {}),
    ...(intent.lastError ? { last_error: intent.lastError } : {}),
  };
}

function validateProposal(proposal: RemoteIntentProposal): void {
  if (!/^intent_[A-Za-z0-9_-]{16,128}$/.test(proposal?.id ?? '')) {
    throw new Error('Intent ID is invalid.');
  }
  if (typeof proposal.objective !== 'string' || !proposal.objective.trim() || proposal.objective.length > 500) {
    throw new Error('Intent objective is invalid.');
  }
  if (
    proposal.trigger?.type !== 'catalog.availability' ||
    !bounded(proposal.trigger.provider, 80) ||
    !bounded(proposal.trigger.serverType, 120) ||
    (proposal.trigger.location !== undefined && !bounded(proposal.trigger.location, 120))
  ) {
    throw new Error('Intent availability trigger is invalid.');
  }
  if (
    !proposal.action ||
    !bounded(proposal.action.capability, 120) ||
    !['development', 'staging', 'production'].includes(proposal.action.environment) ||
    !proposal.action.input ||
    typeof proposal.action.input !== 'object' ||
    Array.isArray(proposal.action.input)
  ) {
    throw new Error('Intent action is invalid.');
  }
  const expires = Date.parse(proposal.constraints?.expiresAt);
  if (
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    expires - Date.now() > MAX_INTENT_LIFETIME_MS ||
    proposal.constraints.maxExecutions !== 1 ||
    !Number.isFinite(proposal.constraints.maxSpendEur) ||
    proposal.constraints.maxSpendEur < 0 ||
    proposal.constraints.failureBehavior !== 'stop'
  ) {
    throw new Error('Intent constraints are invalid.');
  }
}

function bounded(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function secretKey(id: string): string {
  return `vops-remote-intent-${id}`;
}

function riskRank(risk: string): number {
  return ['read_only', 'low', 'medium', 'high', 'destructive'].indexOf(risk);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Intent failed.';
  return /token|credential|secret|key/i.test(message)
    ? 'Intent failed inside the local control plane.'
    : message.slice(0, 500);
}
