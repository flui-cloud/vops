import * as crypto from 'node:crypto';
import { LocalConfigStore } from './config/local-config-store';

/**
 * Thin client for the hosted comparison API used by the `vops watch` commands
 * and by the catalog reads. Ownership is a TOFU opaque token: we generate one
 * locally, keep it in the same encrypted local store as provider creds, and send
 * it as a Bearer. It never leaves this machine except as the auth header to the
 * user's chosen endpoint. Read-only comparison endpoints need no token — see
 * `publicJson`, which is what makes catalog reads work with zero configuration.
 */
const CLOUD_KEY = 'flui-cloud';
// The API is its own host: vops.flui.cloud serves the static landing (its nginx
// has no /api location at all, so every path under /api 404s). Pointing the
// default here is what lets an unconfigured install read the catalog.
const DEFAULT_API = process.env.VOPS_CLOUD_API ?? 'https://vops-api.flui.cloud';

export type ChannelType = 'ntfy' | 'webhook' | 'telegram' | 'feed' | 'webpush';
export type EventKind = 'availability' | 'price' | 'uptime';

/** How old the served snapshot is. Every public catalog read carries one so the
 * CLI can label the data instead of passing a cache off as a live reading. */
export interface CatalogStaleness {
  updatedAt: number | null;
  ageSeconds: number | null;
  staleAfterSeconds: number;
  stale: boolean;
}

export interface RemoteAvailabilityPlan {
  plan: string;
  status: 'available' | 'limited' | 'sold-out' | 'recovered';
  vcpu: number;
  ram: number;
  regions: Array<{ code: string; up: boolean }>;
}

/**
 * Shape of `GET /api/availability`. Note `everywhere` carries plan NAMES only —
 * the server drops the region list for plans that are up in every region, so the
 * client must represent that as its own state rather than an empty location set.
 */
export interface RemoteAvailabilityReport {
  provider: string;
  /** false when the provider exposes no real per-location availability. */
  live: boolean;
  limited: RemoteAvailabilityPlan[];
  everywhere: string[];
  ratio: { limited: number; total: number };
  meta: CatalogStaleness;
}

export interface ChannelInput {
  type: ChannelType;
  topic?: string;
  server?: string;
  url?: string;
  secret?: string;
  chatId?: string;
  linkCode?: string;
  /** For 'webpush': an already-activated push device id (from the PWA flow). */
  deviceId?: string;
}

export interface WatchInput {
  provider: string;
  serverType: string;
  location?: string;
  kinds?: EventKind[];
  channels: ChannelInput[];
}

export interface CloudWatch {
  id: string;
  provider: string;
  serverType: string;
  location: string | null;
  kinds: string[];
  channels: string[];
  createdAt: string;
}

export interface NotifyIntent {
  provider: string;
  serverType: string;
  location?: string;
  architecture?: string;
}

export interface NotifyResult {
  watchId: string;
  status: string;
  activationUrl: string;
  expiresAt: string;
  target: {
    provider: string;
    serverType: string;
    location: string | null;
    available?: boolean;
    monthly?: number | null;
    hourly?: number | null;
  };
}

export interface FeedEvent {
  provider: string;
  serverType: string;
  location: string;
  kind: EventKind;
  fromState: string | null;
  toState: string;
  at: string;
}

export interface UptimeInput {
  name: string;
  target: string;
  /** `tcp:<port>` | `http:<url>` | `https:<url>` | `ping`. */
  check?: string;
  interval?: number;
  expectStatus?: string;
  channels?: ChannelInput[];
}

export interface CloudUptimeMonitor {
  id: string;
  name: string;
  target: string;
  check: string;
  interval: number;
  expectStatus: string | null;
  state: 'up' | 'down' | 'unknown';
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  certExpiresAt: string | null;
  createdAt: string;
}

export interface MonitorRegistration {
  hostId: string;
  ingestToken: string;
}

export interface MonitorHostStatus {
  hostId: string;
  name: string;
  lastSeen: string | null;
  state: 'ok' | 'alert' | 'silent' | 'unknown';
  openAlerts: Array<{ id: string; severity: string; summary: string }>;
}

export class CloudClient {
  private readonly store = new LocalConfigStore();

  config(): { apiUrl: string; token: string } | null {
    const creds = this.store.getCredentials(CLOUD_KEY);
    if (!creds?.token) return null;
    return { apiUrl: creds.apiUrl || DEFAULT_API, token: creds.token };
  }

  /** Persist endpoint + token, minting a fresh token when none is supplied. */
  connect(apiUrl?: string, token?: string): { apiUrl: string; token: string } {
    const existing = this.config();
    const next = {
      apiUrl: apiUrl ?? existing?.apiUrl ?? DEFAULT_API,
      token: token ?? existing?.token ?? `tok_${crypto.randomBytes(24).toString('hex')}`,
    };
    this.store.setCredentials(CLOUD_KEY, next);
    return next;
  }

  /**
   * Probe the vops-landing API before we trust it. Hits the unauthenticated
   * liveness endpoint; throws (without persisting anything) if it is not a
   * healthy vops-landing instance.
   */
  async verifyReachable(apiUrl: string): Promise<void> {
    const base = apiUrl.replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000) });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`vops-landing API not reachable at ${apiUrl} (${reason}). Not saved.`);
    }
    if (!res.ok) {
      throw new Error(`vops-landing API at ${apiUrl} returned HTTP ${res.status}. Not saved.`);
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (body?.ok !== true) {
      throw new Error(`${apiUrl} did not respond as a vops-landing API. Not saved.`);
    }
  }

  /** Verify the endpoint is reachable, THEN persist it (verify-before-set). */
  async setEndpoint(apiUrl?: string, token?: string): Promise<{ apiUrl: string; token: string }> {
    const target = apiUrl ?? this.config()?.apiUrl ?? DEFAULT_API;
    await this.verifyReachable(target);
    return this.connect(apiUrl, token);
  }

  private require(): { apiUrl: string; token: string } {
    const cfg = this.config();
    if (!cfg) throw new Error('Not connected. Run: vops watch login');
    return cfg;
  }

  /** Base URL for unauthenticated reads: the configured endpoint if the user ran
   * `vops watch login`, otherwise the default. Deliberately never calls
   * `require()` — catalog reads must work on a fresh install with no config. */
  private publicBase(): string {
    return (this.config()?.apiUrl ?? DEFAULT_API).replace(/\/$/, '');
  }

  /** Per-location availability for a provider. No credentials, no token. */
  async availabilityReport(provider: string): Promise<RemoteAvailabilityReport> {
    return this.publicJson<RemoteAvailabilityReport>(
      `/api/availability?provider=${encodeURIComponent(provider)}`,
    );
  }

  async createWatch(input: WatchInput): Promise<CloudWatch> {
    return this.json<CloudWatch>('POST', '/api/watches', input);
  }

  /**
   * "Notify me" intent for the vops notification app (Web Push). Creates a
   * pending watch with no channel yet and returns an activation URL the user
   * opens on their phone to register the push device.
   */
  async notifyIntent(intent: NotifyIntent): Promise<NotifyResult> {
    return this.json<NotifyResult>('POST', '/api/watches/notify', intent);
  }

  async listWatches(): Promise<CloudWatch[]> {
    const body = await this.json<{ watches: CloudWatch[] }>('GET', '/api/watches');
    return body.watches;
  }

  async removeWatch(id: string): Promise<void> {
    await this.json('DELETE', `/api/watches/${encodeURIComponent(id)}`);
  }

  async feed(since?: string, limit = 50): Promise<FeedEvent[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (since) q.set('since', since);
    const body = await this.json<{ events: FeedEvent[] }>('GET', `/api/feed?${q.toString()}`);
    return body.events;
  }

  // ---- Uptime monitors (H4): external black-box probing by the relay ----

  async createUptime(input: UptimeInput): Promise<CloudUptimeMonitor> {
    return this.json<CloudUptimeMonitor>('POST', '/api/uptime', input);
  }

  async listUptime(): Promise<CloudUptimeMonitor[]> {
    const body = await this.json<{ monitors: CloudUptimeMonitor[] }>('GET', '/api/uptime');
    return body.monitors;
  }

  async removeUptime(id: string): Promise<void> {
    await this.json('DELETE', `/api/uptime/${encodeURIComponent(id)}`);
  }

  // ---- Host monitor (H5): dead-man's switch; the host cron POSTs heartbeats ----

  async registerMonitorHost(
    name: string,
    intervalSec: number,
    channels?: ChannelInput[],
  ): Promise<MonitorRegistration> {
    return this.json<MonitorRegistration>('POST', '/api/monitor/hosts', { name, intervalSec, channels });
  }

  async monitorHostStatus(hostId: string): Promise<MonitorHostStatus> {
    return this.json<MonitorHostStatus>('GET', `/api/monitor/hosts/${encodeURIComponent(hostId)}`);
  }

  async removeMonitorHost(hostId: string): Promise<void> {
    await this.json('DELETE', `/api/monitor/hosts/${encodeURIComponent(hostId)}`);
  }

  async linkTelegram(): Promise<{ code: string; url: string | null }> {
    return this.json('POST', '/api/telegram/link');
  }

  async telegramStatus(code: string): Promise<{ linked: boolean }> {
    return this.json('GET', `/api/telegram/link/${encodeURIComponent(code)}`);
  }

  /** SSE stream of new transitions; resolves when the connection ends. */
  async streamFeed(onEvent: (e: FeedEvent) => void, signal?: AbortSignal): Promise<void> {
    const { apiUrl, token } = this.require();
    const res = await fetch(`${apiUrl}/api/feed/stream`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`stream failed (HTTP ${res.status})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (line) onEvent(JSON.parse(line.slice(5).trim()) as FeedEvent);
      }
    }
  }

  /**
   * GET an unauthenticated catalog endpoint. Separate from `json` because that
   * one calls `require()` and would demand `vops watch login` for a read that
   * needs no identity at all. Errors name the host: when the catalog is the only
   * data source, "which server did I fail to reach" is the whole diagnosis.
   */
  private async publicJson<T>(path: string): Promise<T> {
    const base = this.publicBase();
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not reach the vops catalog at ${base} (${reason}).`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(safeMessage(text) ?? `vops catalog at ${base} returned HTTP ${res.status}`);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { apiUrl, token } = this.require();
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      const message = safeMessage(text) ?? `HTTP ${res.status}`;
      throw new Error(message);
    }
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
}

function safeMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { message?: string | string[] };
    if (Array.isArray(parsed.message)) return parsed.message.join('; ');
    return parsed.message ?? null;
  } catch {
    return null;
  }
}
