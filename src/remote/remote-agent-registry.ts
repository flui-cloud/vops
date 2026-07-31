import { Injectable } from '@nestjs/common';
import { AntigravityAdapter } from './antigravity.adapter';
import { ClaudeCodeAdapter } from './claude-code.adapter';
import { CodexAppServerAdapter } from './codex-app-server.adapter';
import { OpenAICompatibleAgentAdapter } from './openai-compatible-agent.adapter';
import { OpenCodeAdapter } from './opencode.adapter';
import { RemoteAgentPolicyStore } from './remote-agent-policy';
import {
  AgentProviderStatus,
  CodingAgentProviderId,
  RemoteAgentAdapter,
  RemoteAgentProviderId,
  RemoteAgentTurn,
  RemoteAgentTurnResult,
} from './remote-agent.types';

const STATUS_CACHE_MS = 15_000;

@Injectable()
export class RemoteAgentRegistry {
  private readonly adapters: Map<CodingAgentProviderId, RemoteAgentAdapter>;
  private nativeCache?: {
    expiresAt: number;
    statuses: Awaited<ReturnType<RemoteAgentAdapter['status']>>[];
  };
  private readonly active = new Map<CodingAgentProviderId, number>();

  constructor(
    codex: CodexAppServerAdapter,
    claude: ClaudeCodeAdapter,
    opencode: OpenCodeAdapter,
    antigravity: AntigravityAdapter,
    compatible: OpenAICompatibleAgentAdapter,
    private readonly policyStore: RemoteAgentPolicyStore,
  ) {
    this.adapters = new Map(
      [codex, claude, opencode, antigravity, compatible].map((adapter) => [adapter.id, adapter]),
    );
  }

  policy() {
    return this.policyStore.read();
  }

  adapter(provider: CodingAgentProviderId): RemoteAgentAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Unknown remote agent provider '${provider}'.`);
    return adapter;
  }

  async providers(): Promise<AgentProviderStatus[]> {
    const policy = this.policyStore.read();
    const nativeStatuses = await this.nativeStatuses();
    const statuses = nativeStatuses.map((native) => {
      const provider = native.id as CodingAgentProviderId;
      const active = (this.active.get(provider) ?? 0) > 0;
      const enabled = policy.enabledProviders.includes(provider);
      const fallbackIndex = policy.fallbackOrder.indexOf(provider);
      return {
        ...native,
        state: !enabled ? 'disabled' as const : active ? 'busy' as const : native.state,
        enabled,
        selectable: enabled && !active && native.state === 'ready',
        isDefault: native.id === policy.defaultProvider,
        ...(fallbackIndex >= 0 ? { fallbackRank: fallbackIndex + 1 } : {}),
      };
    });
    statuses.push({
      id: 'deterministic',
      displayName: 'Deterministic summary',
      kind: 'deterministic',
      state: policy.deterministicFallback ? 'ready' : 'disabled',
      installed: true,
      authenticated: true,
      headless: true,
      enabled: policy.deterministicFallback,
      selectable: policy.deterministicFallback,
      isDefault: false,
      capabilities: {
        streaming: false,
        semanticTools: false,
        planProposal: false,
        intentProposal: false,
        cancellation: true,
        existingAuthentication: true,
      },
    });
    return statuses;
  }

  async run(
    provider: CodingAgentProviderId,
    turn: RemoteAgentTurn,
  ): Promise<RemoteAgentTurnResult> {
    if ((this.active.get(provider) ?? 0) > 0) {
      throw new Error(`Remote provider '${provider}' is busy.`);
    }
    this.active.set(provider, 1);
    try {
      return await this.adapter(provider).run(turn);
    } finally {
      this.active.delete(provider);
    }
  }

  async resolve(requested?: CodingAgentProviderId): Promise<RemoteAgentProviderId> {
    const policy = this.policyStore.read();
    const primary = requested ?? policy.defaultProvider;
    if (requested && !policy.enabledProviders.includes(requested)) {
      throw new Error(`Remote provider '${requested}' is disabled by local policy.`);
    }
    const statuses = await this.providers();
    const ready = unique([primary, ...policy.fallbackOrder]).find(
      (provider) => statuses.find((status) => status.id === provider)?.selectable,
    );
    if (ready) return ready;
    if (policy.deterministicFallback) return 'deterministic';
    throw new Error('No locally approved remote agent provider is available.');
  }

  candidates(requested: CodingAgentProviderId | undefined, statuses: AgentProviderStatus[]) {
    const policy = this.policyStore.read();
    const primary = requested ?? policy.defaultProvider;
    if (requested && !policy.enabledProviders.includes(requested)) {
      throw new Error(`Remote provider '${requested}' is disabled by local policy.`);
    }
    return {
      primary,
      providers: unique([primary, ...policy.fallbackOrder])
        .filter((provider) => statuses.find((status) => status.id === provider)?.selectable),
      deterministicFallback: policy.deterministicFallback,
    };
  }

  private async nativeStatuses() {
    if (this.nativeCache && this.nativeCache.expiresAt > Date.now()) {
      return this.nativeCache.statuses;
    }
    const statuses = await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.status()),
    );
    this.nativeCache = { statuses, expiresAt: Date.now() + STATUS_CACHE_MS };
    return statuses;
  }
}

function unique(values: CodingAgentProviderId[]): CodingAgentProviderId[] {
  return [...new Set(values)];
}
