import { Injectable } from '@nestjs/common';
import { BatteryDepth } from '../host-ops/status-battery';
import { HostStatusResult, VopsHostStatusService } from '../host-ops/vops-host-status.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import { MetricsStore } from '../lib/store/metrics-store';
import { hostKey, newHostUid } from '../lib/store/host-key';
import { sampleFrom } from './signals';

/**
 * The only thing in vops that probes a host and keeps the result.
 *
 * Two properties matter here. First, single-flight: `ssh-exec` disables
 * multiplexing, so every probe is a fresh TCP + auth handshake, and before this
 * existed two open dashboard tabs meant two `ssh` processes per host per poll.
 * Overlapping callers now share one probe. Second, everything routed through it
 * feeds the history for free — a manual refresh is a real sample, not a detour.
 */
@Injectable()
export class MetricsProbeService {
  private readonly inFlight = new Map<string, Promise<HostStatusResult>>();

  constructor(
    private readonly hosts: VopsHostsService,
    private readonly status: VopsHostStatusService,
    private readonly store: MetricsStore,
  ) {}

  busy(name: string): boolean {
    return this.inFlight.has(name);
  }

  probe(name: string, depth: BatteryDepth = 'full'): Promise<HostStatusResult> {
    const running = this.inFlight.get(name);
    if (running) return running;

    const started = this.run(name, depth).finally(() => this.inFlight.delete(name));
    this.inFlight.set(name, started);
    return started;
  }

  private async run(name: string, depth: BatteryDepth): Promise<HostStatusResult> {
    const host = this.hosts.show(name);
    const result = await this.status.status(name, depth);
    await this.persist(host, result, depth);
    return result;
  }

  /** Persisting must never break a probe the user is watching. */
  private async persist(host: VopsHost, result: HostStatusResult, depth: BatteryDepth): Promise<void> {
    try {
      const key = await this.stableKey(host);
      const at = Date.now();
      await this.store.touchHost(key, host, Math.floor(at / 1000));
      await this.store.record(key, sampleFrom(result, at));
      await this.store.saveLatest(key, {
        ts: Math.floor(at / 1000),
        reachable: result.reachable,
        latencyMs: Math.round(result.latencyMs),
        worst: result.report.worst,
        depth,
        report: result.report,
      });
    } catch {
      /* the probe still stands on its own */
    }
  }

  /**
   * Mint the host's uid the first time we store anything for it, and carry the
   * history it already accumulated under the derived key across to it. Done here
   * rather than in `hosts.list()`, which would turn every CLI read into a write.
   */
  private async stableKey(host: VopsHost): Promise<string> {
    if (host.uid) return hostKey(host);
    const derived = hostKey(host);
    const uid = newHostUid();
    this.hosts.update({ ...host, uid });
    const key = hostKey({ ...host, uid });
    await this.store.rekey(derived, key);
    return key;
  }
}
