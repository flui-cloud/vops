import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import {
  AgentSession,
  AgentSessionPermissions,
  AgentSessionStatus,
  CreateAgentSessionInput,
  CreatedAgentSession,
} from './agent-model';
import { AgentStore } from './agent-store';
import { AgentControlError } from './agent-control-error';
import { hashToken, localId, sessionTokenValue } from './ids';

const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 12 * 60;

const DEFAULT_PERMISSIONS: AgentSessionPermissions = {
  allow: [
    'repository.inspect',
    'flui_spec.read',
    'flui_spec.generate',
    'flui_spec.validate',
    'catalog.list',
    'catalog.describe',
    'provider.list',
    'provider.prices.compare',
    'target.list',
    'target.inspect',
    'server.list',
    'server.inspect',
    'application.plan_deploy',
    'application.status',
    'logs.read_recent',
    'healthcheck.run',
    'firewall.inspect',
  ],
  allowWithinApprovedPlan: [
    'catalog.install',
    'application.deploy',
    'application.restart',
    'server.harden',
    'firewall.open_port',
    'firewall.close_port',
  ],
  requireApproval: ['server.provision'],
  deny: ['server.destroy', 'application.rollback'],
};

@Injectable()
export class AgentSessionManager {
  constructor(private readonly store: AgentStore) {}

  async create(input: CreateAgentSessionInput): Promise<CreatedAgentSession> {
    if (input.mode === 'protected') {
      throw new AgentControlError(
        'VOPS_AGENT_UNSUPPORTED',
        'Protected mode is not implemented. Create an advisory session instead.',
        'failed',
        true,
      );
    }
    const repository = resolveRepository(input.repository);
    const now = new Date();
    const expiresInMinutes = Math.max(1, Math.min(input.expiresInMinutes ?? DEFAULT_MINUTES, MAX_MINUTES));
    const token = sessionTokenValue();
    const permissions = mergePermissions(input.permissions);
    const session: AgentSession = {
      id: localId('ses'),
      actor: {
        type: 'coding_agent',
        client: input.client,
        ...(input.clientVersion ? { clientVersion: input.clientVersion } : {}),
        displayName: input.displayName ?? clientLabel(input.client),
      },
      objective: input.objective.trim(),
      mode: 'advisory',
      status: 'active',
      repository: { path: repository, name: path.basename(repository) },
      scope: {
        projects: [path.basename(repository)],
        targets: [...new Set(input.targets ?? [])],
        environments: [...new Set(input.environments ?? (['staging'] as const))],
      },
      permissions,
      limits: {
        expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000).toISOString(),
        maxOperations: Math.max(1, Math.min(input.maxOperations ?? 50, 1000)),
        maxProviderSpendEur: Math.max(0, input.maxProviderSpendEur ?? 0),
      },
      operationCount: 0,
      providerSpendEur: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.store.saveSession(session, hashToken(token));
    await this.event(session, 'session.created', `Created advisory session for ${session.actor.displayName}.`);
    return { session, token };
  }

  async authenticate(token: string | undefined): Promise<AgentSession> {
    if (!token) {
      throw new AgentControlError(
        'VOPS_AGENT_AUTH_REQUIRED',
        'An active vOps agent session token is required.',
        'denied',
        true,
      );
    }
    const session = await this.store.getSessionByTokenHash(hashToken(token));
    if (!session) {
      throw new AgentControlError('VOPS_AGENT_TOKEN_INVALID', 'The agent session token is invalid.', 'denied');
    }
    if (new Date(session.limits.expiresAt).getTime() <= Date.now()) {
      if (session.status !== 'expired') await this.setStatus(session.id, 'expired');
      throw new AgentControlError('VOPS_AGENT_SESSION_EXPIRED', 'The agent session has expired.', 'denied', true);
    }
    if (session.status !== 'active') {
      throw new AgentControlError(
        'VOPS_AGENT_SESSION_INACTIVE',
        `The agent session is ${session.status}.`,
        'denied',
        session.status === 'paused',
      );
    }
    if (session.operationCount >= session.limits.maxOperations) {
      throw new AgentControlError(
        'VOPS_AGENT_SCOPE_DENIED',
        `The session reached its ${session.limits.maxOperations}-operation limit.`,
        'denied',
        true,
      );
    }
    return session;
  }

  async list(): Promise<AgentSession[]> {
    const sessions = await this.store.listSessions();
    await Promise.all(
      sessions
        .filter((session) => session.status === 'active' && new Date(session.limits.expiresAt).getTime() <= Date.now())
        .map((session) => this.setStatus(session.id, 'expired')),
    );
    return this.store.listSessions();
  }

  async show(id: string): Promise<AgentSession> {
    const session = await this.store.getSession(id);
    if (!session) throw new AgentControlError('VOPS_AGENT_NOT_FOUND', `Agent session '${id}' was not found.`);
    return session;
  }

  async pause(id: string): Promise<AgentSession> {
    return this.setStatus(id, 'paused');
  }

  async resume(id: string): Promise<AgentSession> {
    const session = await this.show(id);
    if (new Date(session.limits.expiresAt).getTime() <= Date.now()) {
      throw new AgentControlError('VOPS_AGENT_SESSION_EXPIRED', 'An expired session cannot be resumed.');
    }
    return this.setStatus(id, 'active');
  }

  async revoke(id: string): Promise<AgentSession> {
    return this.setStatus(id, 'revoked');
  }

  async stopAll(): Promise<AgentSession[]> {
    const active = (await this.list()).filter((session) => session.status === 'active' || session.status === 'paused');
    return Promise.all(active.map((session) => this.setStatus(session.id, 'revoked')));
  }

  async incrementOperation(id: string): Promise<AgentSession> {
    const session = await this.show(id);
    const updated = { ...session, operationCount: session.operationCount + 1, updatedAt: new Date().toISOString() };
    await this.store.saveSession(updated);
    return updated;
  }

  /** Refuse a commitment the session cannot afford, then book it. The cap is a running
   * budget: without booking, an agent could buy any number of resources that are each
   * individually under the limit. */
  async commitProviderSpend(id: string, monthlyEur: number): Promise<AgentSession> {
    const session = await this.show(id);
    const committed = session.providerSpendEur ?? 0;
    const total = committed + Math.max(0, monthlyEur);
    if (total > session.limits.maxProviderSpendEur) {
      throw new AgentControlError(
        'VOPS_AGENT_SCOPE_DENIED',
        `This commitment costs ${monthlyEur.toFixed(2)} EUR/month. The session has already committed ` +
          `${committed.toFixed(2)} of its ${session.limits.maxProviderSpendEur.toFixed(2)} EUR/month budget.`,
        'denied',
        true,
      );
    }
    const updated = { ...session, providerSpendEur: total, updatedAt: new Date().toISOString() };
    await this.store.saveSession(updated);
    await this.event(
      updated,
      'session.spend_committed',
      `Committed ${monthlyEur.toFixed(2)} EUR/month; ${total.toFixed(2)} of ${session.limits.maxProviderSpendEur.toFixed(2)} used.`,
    );
    return updated;
  }

  async extendForConditionalIntent(id: string, expiresAt: string): Promise<AgentSession> {
    const session = await this.show(id);
    const expires = Date.parse(expiresAt);
    if (
      !session.actor.displayName.startsWith('Conditional intent ') ||
      !Number.isFinite(expires) ||
      expires <= Date.now() ||
      expires - Date.now() > 30 * 24 * 60 * 60_000
    ) {
      throw new AgentControlError(
        'VOPS_AGENT_SCOPE_DENIED',
        'Only a bounded conditional-intent session may receive an extended expiry.',
        'denied',
      );
    }
    const updated: AgentSession = {
      ...session,
      limits: { ...session.limits, expiresAt: new Date(expires).toISOString() },
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveSession(updated);
    await this.event(updated, 'session.intent_expiry_set', 'Bound session expiry to its conditional intent.');
    return updated;
  }

  async grantScope(
    id: string,
    grant: { capability: string; target?: string; environment?: AgentSession['scope']['environments'][number] },
  ): Promise<AgentSession> {
    const session = await this.show(id);
    const updated: AgentSession = {
      ...session,
      scope: {
        ...session.scope,
        targets: grant.target ? unique([...session.scope.targets, grant.target]) : session.scope.targets,
        environments: grant.environment
          ? unique([...session.scope.environments, grant.environment])
          : session.scope.environments,
      },
      permissions: {
        ...session.permissions,
        allow: unique([...session.permissions.allow, grant.capability]),
        deny: session.permissions.deny.filter((entry) => entry !== grant.capability),
        requireApproval: session.permissions.requireApproval.filter((entry) => entry !== grant.capability),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveSession(updated);
    await this.event(updated, 'session.scope_granted', `Granted ${grant.capability} to the session.`);
    return updated;
  }

  /** The counterpart of `grantScope`: take permission away without discarding the session.
   * A revoked capability is moved to `deny` rather than merely dropped, so a later plan
   * cannot re-acquire it through an approval. */
  async narrowScope(
    id: string,
    narrow: { capabilities?: string[]; targets?: string[]; expiresAt?: string; maxProviderSpendEur?: number },
  ): Promise<AgentSession> {
    const session = await this.show(id);
    const removed = narrow.capabilities ?? [];
    const keeps = (entries: string[]) => entries.filter((entry) => !removed.includes(entry));
    const updated: AgentSession = {
      ...session,
      scope: {
        ...session.scope,
        targets: narrow.targets ? unique(narrow.targets) : session.scope.targets,
      },
      permissions: {
        allow: keeps(session.permissions.allow),
        allowWithinApprovedPlan: keeps(session.permissions.allowWithinApprovedPlan),
        requireApproval: keeps(session.permissions.requireApproval),
        deny: unique([...session.permissions.deny, ...removed]),
      },
      limits: {
        ...session.limits,
        ...(narrow.expiresAt ? { expiresAt: new Date(narrow.expiresAt).toISOString() } : {}),
        ...(narrow.maxProviderSpendEur === undefined
          ? {}
          : { maxProviderSpendEur: Math.max(0, narrow.maxProviderSpendEur) }),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveSession(updated);
    await this.event(updated, 'session.scope_narrowed', narrowSummary(narrow));
    return updated;
  }

  private async setStatus(id: string, status: AgentSessionStatus): Promise<AgentSession> {
    const session = await this.show(id);
    const updated = { ...session, status, updatedAt: new Date().toISOString() };
    await this.store.saveSession(updated);
    await this.event(updated, `session.${status}`, `Session ${status}.`);
    return updated;
  }

  private async event(session: AgentSession, eventType: string, summary: string): Promise<void> {
    await this.store.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      actor: session.actor.client,
      eventType,
      summary,
      detail: { objective: session.objective, mode: session.mode },
    });
  }
}

function resolveRepository(input: string): string {
  const resolved = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${resolved} is not a directory.`);
  return resolved;
}

function mergePermissions(input?: Partial<AgentSessionPermissions>): AgentSessionPermissions {
  return {
    allow: unique(input?.allow ?? DEFAULT_PERMISSIONS.allow),
    allowWithinApprovedPlan: unique(input?.allowWithinApprovedPlan ?? DEFAULT_PERMISSIONS.allowWithinApprovedPlan),
    requireApproval: unique(input?.requireApproval ?? DEFAULT_PERMISSIONS.requireApproval),
    deny: unique(input?.deny ?? DEFAULT_PERMISSIONS.deny),
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function narrowSummary(narrow: {
  capabilities?: string[];
  targets?: string[];
  expiresAt?: string;
  maxProviderSpendEur?: number;
}): string {
  const parts = [
    ...(narrow.capabilities?.length ? [`revoked ${narrow.capabilities.join(', ')}`] : []),
    ...(narrow.targets ? [`targets limited to ${narrow.targets.join(', ') || 'none'}`] : []),
    ...(narrow.expiresAt ? ['expiry shortened'] : []),
    ...(narrow.maxProviderSpendEur === undefined ? [] : [`spend limit set to ${narrow.maxProviderSpendEur}`]),
  ];
  return parts.length ? `Narrowed the session: ${parts.join('; ')}.` : 'Narrowed the session.';
}

function clientLabel(client: string): string {
  const labels: Record<string, string> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
    antigravity: 'Antigravity',
    other: 'Coding agent',
  };
  return labels[client] ?? client;
}
