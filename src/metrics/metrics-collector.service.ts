import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { profileDir } from '../lib/profile';
import { inChunks } from '../lib/chunked';
import { FLEET_CONCURRENCY } from '../host-ops/vops-host-status.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import { MetricsStore } from '../lib/store/metrics-store';
import { hostKey } from '../lib/store/host-key';
import { MetricsProbeService } from './metrics-probe.service';
import { HostSchedule, ScheduleConfig, dueHosts, onManualRefresh, onResult } from './collector-schedule';

const TICK_MS = 30_000;
const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_FULL_INTERVAL_MS = 30 * 60_000;
const DEFAULT_RETENTION_DAYS = 7;
const PRUNE_EVERY_MS = 60 * 60_000;

export interface CollectorState {
  enabled: boolean;
  intervalMs: number;
  fullIntervalMs: number;
  retentionDays: number;
  running: boolean;
  lastRunAt: string | null;
  lastCycleMs: number | null;
}

export interface HostEligibility {
  eligible: boolean;
  reason?: string;
  nextAt: number | null;
}

/**
 * The background half of monitoring: probe every managed host on a timer, keep a
 * seven-day history, and prune it. This is what lets the dashboard open with data
 * already on screen and — the real reason it exists — what lets vops notice
 * something with no page open.
 *
 * Registered in LocalApiModule, deliberately NOT in VopsModule: `getVopsApp()`
 * builds a VopsModule context for every CLI command and runs its bootstrap hooks,
 * so a collector living there would start SSH-probing the fleet on `vops compare`.
 * `test/collector-placement.spec.ts` holds that line.
 */
@Injectable()
export class MetricsCollectorService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private collecting = false;
  private lastPrunedAt = 0;
  private lastRunAt: number | null = null;
  private lastCycleMs: number | null = null;
  private readonly schedules = new Map<string, HostSchedule>();

  constructor(
    private readonly hosts: VopsHostsService,
    private readonly probe: MetricsProbeService,
    private readonly store: MetricsStore,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get enabled(): boolean {
    return process.env.VOPS_METRICS_DISABLED !== '1';
  }

  get config(): ScheduleConfig {
    return {
      intervalMs: envMs('VOPS_METRICS_INTERVAL_MS', DEFAULT_INTERVAL_MS),
      fullIntervalMs: envMs('VOPS_METRICS_FULL_INTERVAL_MS', DEFAULT_FULL_INTERVAL_MS),
    };
  }

  get retentionDays(): number {
    return Math.max(1, envMs('VOPS_METRICS_RETENTION_DAYS', DEFAULT_RETENTION_DAYS));
  }

  state(): CollectorState {
    return {
      enabled: this.enabled,
      ...this.config,
      retentionDays: this.retentionDays,
      running: this.collecting,
      lastRunAt: this.lastRunAt === null ? null : new Date(this.lastRunAt).toISOString(),
      lastCycleMs: this.lastCycleMs,
    };
  }

  /** Why a host is or isn't being collected, so a card can say so instead of
   * showing an empty chart with no explanation. */
  eligibility(host: VopsHost): HostEligibility {
    const nextAt = this.schedules.get(hostKey(host))?.nextAt ?? null;
    if (host.sshManaged === false) return { eligible: false, reason: 'provider-only', nextAt: null };
    if (host.conn?.state !== 'ready') return { eligible: false, reason: 'ssh-not-ready', nextAt: null };
    return { eligible: true, nextAt };
  }

  /** Called after a user-triggered refresh: clears any backoff penalty. */
  noteManualRefresh(host: VopsHost): void {
    const key = hostKey(host);
    const s = this.schedules.get(key);
    if (s) this.schedules.set(key, onManualRefresh(s, Date.now(), this.config));
  }

  private async tick(): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;
    const started = Date.now();
    try {
      await this.cycle(started);
    } catch {
      /* a failed cycle must not kill the timer */
    } finally {
      this.collecting = false;
      this.lastRunAt = started;
      this.lastCycleMs = Date.now() - started;
    }
  }

  private async cycle(now: number): Promise<void> {
    const inventory = this.readInventory();
    if (inventory === null) return;

    const eligible = inventory.filter((h) => this.eligibility(h).eligible);
    const due = dueHosts(
      this.schedules,
      eligible.map((h) => ({ name: h.name, key: hostKey(h) })),
      now,
      this.config,
      (name) => this.probe.busy(name),
    );

    const byName = new Map(inventory.map((h) => [h.name, h]));
    await inChunks(due, FLEET_CONCURRENCY, async (item) => {
      let ok = false;
      try {
        ok = (await this.probe.probe(item.name, item.depth)).reachable;
      } finally {
        const host = byName.get(item.name);
        const key = host ? hostKey(host) : '';
        const s = this.schedules.get(key);
        if (s) this.schedules.set(key, onResult(s, item.depth, ok, Date.now(), this.config));
      }
    });

    await this.maybePrune(now, inventory);
  }

  private async maybePrune(now: number, inventory: VopsHost[]): Promise<void> {
    if (now - this.lastPrunedAt < PRUNE_EVERY_MS) return;
    this.lastPrunedAt = now;
    await this.store.prune(this.retentionDays, inventory.map((h) => hostKey(h)));
  }

  /**
   * `null` means "the inventory could not be established", which must stop the
   * cycle rather than be read as an empty fleet: `hosts.list()` answers [] for a
   * missing or unreadable file, and passing that on to the orphan sweep would
   * delete every host's history.
   */
  private readInventory(): VopsHost[] | null {
    if (!fs.existsSync(path.join(profileDir(), 'hosts.json'))) return null;
    try {
      return this.hosts.list();
    } catch {
      return null;
    }
  }
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]?.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
