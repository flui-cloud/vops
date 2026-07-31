import { Injectable } from '@nestjs/common';
import { AgentSessionManager } from '../agent-control/agent-session-manager';
import { AgentSafetyState } from '../agent-control/agent-safety-state';
import { AgentStore } from '../agent-control/agent-store';
import { VopsAppsService } from '../apps/vops-apps.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { DeviceRegistry } from './device-registry';
import { RemoteDevice } from './remote-model';
import { RemoteSyncSnapshot } from './remote-message.types';
import { RemoteStore } from './remote-store';
import { publicIntent } from './intent.service';
import { RemoteAgentRegistry } from './remote-agent-registry';

@Injectable()
export class RemoteSyncService {
  constructor(
    private readonly sessions: AgentSessionManager,
    private readonly safety: AgentSafetyState,
    private readonly agentStore: AgentStore,
    private readonly devices: DeviceRegistry,
    private readonly hosts: VopsHostsService,
    private readonly apps: VopsAppsService,
    private readonly remoteStore: RemoteStore,
    private readonly agentProviders: RemoteAgentRegistry,
  ) {}

  async snapshot(device: RemoteDevice, requestId: string): Promise<RemoteSyncSnapshot> {
    const [
      sessions,
      approvals,
      plans,
      operations,
      devices,
      applications,
      conversations,
      intents,
      agentProviders,
    ] =
      await Promise.all([
        this.sessions.list(),
        this.agentStore.listApprovals(),
        this.agentStore.listPlans(),
        this.agentStore.listOperations(),
        this.devices.list(),
        this.apps.list(),
        this.remoteStore.listConversations(device.id),
        this.remoteStore.listIntents(device.id),
        this.agentProviders.providers(),
      ]);
    const targetScope = new Set(device.restrictions.targets);
    const inScope = (target?: string) =>
      !targetScope.size || (target ? targetScope.has(target) : true);

    return {
      type: 'sync.snapshot',
      request_id: requestId,
      generated_at: new Date().toISOString(),
      control_node: {
        state: 'online',
        authority: 'local',
        emergency_stop: this.safety.current().active,
      },
      devices: { active: devices.filter((entry) => entry.status === 'active').length },
      agents: {
        active: sessions.filter((entry) => entry.status === 'active').length,
        paused: sessions.filter((entry) => entry.status === 'paused').length,
      },
      agent_providers: agentProviders,
      agent_policy: {
        default_provider: this.agentProviders.policy().defaultProvider,
        fallback_order: this.agentProviders.policy().fallbackOrder,
        deterministic_fallback: this.agentProviders.policy().deterministicFallback,
      },
      agent_sessions: sessions.slice(0, 50).map((entry) => ({
        id: entry.id,
        version: Date.parse(entry.updatedAt),
        display_name: entry.actor.displayName,
        objective: entry.objective,
        status: entry.status,
        project: entry.repository.name,
        expires_at: entry.limits.expiresAt,
      })),
      approvals: approvals
        .filter((entry) => inScope(entry.target))
        .slice(0, 50)
        .map((entry) => ({
          id: entry.id,
          version: Date.parse(entry.requestedAt),
          status: entry.status,
          reason: entry.reason,
          risk: entry.risk,
          ...(entry.target ? { target: entry.target } : {}),
          ...(entry.environment ? { environment: entry.environment } : {}),
          expires_at: entry.expiresAt,
          ...approvalPlanField(entry.planId
            ? plans.find((plan) => plan.id === entry.planId)
            : undefined),
        })),
      operations: operations.slice(0, 50).map((entry) => ({
        id: entry.id,
        version: Date.parse(entry.updatedAt),
        state: entry.state,
        ...(entry.capability ? { capability: entry.capability } : {}),
        updated_at: entry.updatedAt,
        rollback_available: entry.rollbackAvailable,
      })),
      targets: this.hosts
        .list()
        .filter((entry) => inScope(entry.name))
        .map((entry) => ({
          name: entry.name,
          ...(entry.provider ? { provider: entry.provider } : {}),
        })),
      applications: applications
        .filter((entry) => inScope(entry.host))
        .map((entry) => ({
          name: entry.name,
          ...(entry.status ? { status: entry.status } : {}),
          target: entry.host,
        })),
      conversations: conversations.map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: entry.status,
        provider: entry.agentProvider,
        updated_at: entry.updatedAt,
      })),
      intents: intents.map(publicIntent),
    };
  }
}

function approvalPlan(plan: Awaited<ReturnType<AgentStore['listPlans']>>[number] | undefined) {
  if (!plan) return undefined;
  return {
    id: plan.id,
    hash: plan.hash,
    objective: plan.objective,
    session_id: plan.sessionId,
    steps: plan.steps.map((entry) => ({
      id: entry.id,
      capability: entry.capability,
      input: entry.input,
      risk: entry.risk,
    })),
    expected_effects: plan.estimatedEffects,
    excluded_effects: plan.excludedEffects,
    rollback: plan.rollback,
  };
}

function approvalPlanField(
  plan: Awaited<ReturnType<AgentStore['listPlans']>>[number] | undefined,
) {
  const view = approvalPlan(plan);
  return view ? { plan: view } : {};
}
