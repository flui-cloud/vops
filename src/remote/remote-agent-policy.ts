import { Injectable } from '@nestjs/common';
import { LocalConfigStore } from '../lib/config/local-config-store';
import { CodingAgentProviderId } from './remote-agent.types';

const CONFIG_KEY = 'vops-remote-agent-policy-v1';
const PROVIDERS: CodingAgentProviderId[] = [
  'codex',
  'claude-code',
  'opencode',
  'antigravity',
  'openai-compatible',
];

export interface RemoteAgentPolicy {
  defaultProvider: CodingAgentProviderId;
  enabledProviders: CodingAgentProviderId[];
  fallbackOrder: CodingAgentProviderId[];
  deterministicFallback: boolean;
  updatedAt?: string;
}

const DEFAULT_POLICY: RemoteAgentPolicy = {
  defaultProvider: 'codex',
  enabledProviders: ['codex', 'claude-code', 'opencode', 'antigravity'],
  fallbackOrder: [],
  deterministicFallback: true,
};

@Injectable()
export class RemoteAgentPolicyStore {
  private readonly store = new LocalConfigStore();

  read(): RemoteAgentPolicy {
    const row = this.store.getCredentials(CONFIG_KEY);
    if (!row) return copyPolicy(DEFAULT_POLICY);
    const enabledProviders = parseProviders(row.enabledProviders);
    const fallbackOrder = parseProviders(row.fallbackOrder)
      .filter((provider) => enabledProviders.includes(provider));
    return {
      defaultProvider: isProvider(row.defaultProvider)
        ? row.defaultProvider
        : DEFAULT_POLICY.defaultProvider,
      enabledProviders,
      fallbackOrder,
      deterministicFallback: row.deterministicFallback !== 'false',
      ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    };
  }

  setDefault(provider: CodingAgentProviderId): RemoteAgentPolicy {
    const policy = this.read();
    if (!policy.enabledProviders.includes(provider)) {
      throw new Error(`Provider '${provider}' must be enabled before it can be the default.`);
    }
    return this.write({ ...policy, defaultProvider: provider });
  }

  setEnabled(provider: CodingAgentProviderId, enabled: boolean): RemoteAgentPolicy {
    const policy = this.read();
    const enabledProviders = enabled
      ? uniqueProviders([...policy.enabledProviders, provider])
      : policy.enabledProviders.filter((entry) => entry !== provider);
    if (!enabled && policy.defaultProvider === provider) {
      throw new Error(`Provider '${provider}' is the default and cannot be disabled.`);
    }
    return this.write({
      ...policy,
      enabledProviders,
      fallbackOrder: policy.fallbackOrder.filter((entry) => enabledProviders.includes(entry)),
    });
  }

  setFallbackOrder(providers: CodingAgentProviderId[]): RemoteAgentPolicy {
    const policy = this.read();
    const fallbackOrder = uniqueProviders(providers);
    const disabled = fallbackOrder.find((provider) => !policy.enabledProviders.includes(provider));
    if (disabled) throw new Error(`Fallback provider '${disabled}' is not enabled.`);
    return this.write({ ...policy, fallbackOrder });
  }

  setDeterministicFallback(enabled: boolean): RemoteAgentPolicy {
    return this.write({ ...this.read(), deterministicFallback: enabled });
  }

  assertProvider(value: string): CodingAgentProviderId {
    if (!isProvider(value)) throw new Error(`Unknown remote agent provider '${value}'.`);
    return value;
  }

  private write(policy: RemoteAgentPolicy): RemoteAgentPolicy {
    const normalized: RemoteAgentPolicy = {
      ...policy,
      enabledProviders: uniqueProviders(policy.enabledProviders),
      fallbackOrder: uniqueProviders(policy.fallbackOrder),
      updatedAt: new Date().toISOString(),
    };
    this.store.setCredentials(CONFIG_KEY, {
      defaultProvider: normalized.defaultProvider,
      enabledProviders: JSON.stringify(normalized.enabledProviders),
      fallbackOrder: JSON.stringify(normalized.fallbackOrder),
      deterministicFallback: String(normalized.deterministicFallback),
      updatedAt: normalized.updatedAt!,
    });
    return normalized;
  }
}

function parseProviders(value: string | undefined): CodingAgentProviderId[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniqueProviders(parsed.filter((entry): entry is CodingAgentProviderId => isProvider(entry)))
      : [];
  } catch {
    return [];
  }
}

function uniqueProviders(values: CodingAgentProviderId[]): CodingAgentProviderId[] {
  return [...new Set(values)];
}

function isProvider(value: unknown): value is CodingAgentProviderId {
  return typeof value === 'string' && PROVIDERS.includes(value as CodingAgentProviderId);
}

function copyPolicy(policy: RemoteAgentPolicy): RemoteAgentPolicy {
  return {
    ...policy,
    enabledProviders: [...policy.enabledProviders],
    fallbackOrder: [...policy.fallbackOrder],
  };
}
