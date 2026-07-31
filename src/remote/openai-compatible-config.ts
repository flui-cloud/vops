import { LocalConfigStore } from '../lib/config/local-config-store';

const CONFIG_KEY = 'vops-remote-openai-compatible';

export interface OpenAICompatibleConfig {
  enabled: boolean;
  displayName: string;
  baseUrl: string;
  model: string;
  supportsToolCalls: boolean;
  configuredAt: string;
}

export class OpenAICompatibleConfigStore {
  private readonly store = new LocalConfigStore();

  read(): (OpenAICompatibleConfig & { apiKey?: string }) | null {
    const row = this.store.getCredentials(CONFIG_KEY);
    if (!row?.baseUrl || !row.model) return null;
    return {
      enabled: row.enabled === 'true',
      displayName: row.displayName || 'OpenAI-compatible provider',
      baseUrl: row.baseUrl,
      model: row.model,
      supportsToolCalls: row.supportsToolCalls === 'true',
      configuredAt: row.configuredAt,
      ...(row.apiKey ? { apiKey: row.apiKey } : {}),
    };
  }

  save(input: {
    displayName: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    supportsToolCalls: boolean;
  }): OpenAICompatibleConfig {
    const baseUrl = validateBaseUrl(input.baseUrl);
    const config: OpenAICompatibleConfig = {
      enabled: true,
      displayName: bounded(input.displayName, 'display name', 80),
      baseUrl,
      model: bounded(input.model, 'model', 160),
      supportsToolCalls: input.supportsToolCalls,
      configuredAt: new Date().toISOString(),
    };
    this.store.setCredentials(CONFIG_KEY, {
      enabled: 'true',
      displayName: config.displayName,
      baseUrl: config.baseUrl,
      model: config.model,
      supportsToolCalls: String(config.supportsToolCalls),
      configuredAt: config.configuredAt,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    });
    return config;
  }

  remove(): void {
    this.store.remove(CONFIG_KEY);
  }
}

function validateBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Provider base URL cannot contain credentials, query, or fragment.');
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Provider URL must use HTTPS, except for a loopback local endpoint.');
  }
  return url.toString().replace(/\/$/, '');
}

function bounded(value: string, label: string, max: number): string {
  const clean = String(value ?? '').trim();
  if (!clean || clean.length > max) throw new Error(`Provider ${label} is invalid.`);
  return clean;
}
