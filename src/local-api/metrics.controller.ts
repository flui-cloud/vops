import { BadRequestException, Body, Controller, Get, HttpException, Param, Post, Query } from '@nestjs/common';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHost } from '../hosts/host.model';
import { MetricsStore, LatestSnapshot } from '../lib/store/metrics-store';
import { hostKey } from '../lib/store/host-key';
import { RANGES, isHistoryRange } from '../lib/store/metrics-buckets';
import { MetricsProbeService } from '../metrics/metrics-probe.service';
import { MetricsCollectorService } from '../metrics/metrics-collector.service';
import { SIGNAL_IDS, signalsOf } from '../metrics/signals';
import { BatteryDepth } from '../host-ops/status-battery';

const HTTP_TOO_MANY = 429;
/** A human clicking Refresh twice is one probe; a script in a loop is not. */
const MANUAL_MIN_GAP_MS = 15_000;

/**
 * What the dashboard reads instead of probing hosts itself. Every response comes
 * out of the local SQLite store, so opening the page costs no SSH at all — the
 * collector already did the work, and the seven-day history is there at first
 * paint rather than accumulating while you watch.
 */
@Controller('api/metrics')
export class MetricsController {
  private readonly lastManualAt = new Map<string, number>();

  constructor(
    private readonly hosts: VopsHostsService,
    private readonly store: MetricsStore,
    private readonly probe: MetricsProbeService,
    private readonly collector: MetricsCollectorService,
  ) {}

  @Get()
  async fleet() {
    const hosts = this.hosts.list();
    const snapshots = new Map((await this.store.latest()).map((s) => [s.hostKey, s]));
    return {
      collector: this.collector.state(),
      signalIds: SIGNAL_IDS,
      hosts: hosts.map((h) => this.summary(h, snapshots.get(hostKey(h)))),
    };
  }

  @Get(':name')
  async host(@Param('name') name: string) {
    const host = this.hosts.show(name);
    const [snapshot] = await this.store.latest([hostKey(host)]);
    return {
      ...this.summary(host, snapshot),
      depth: snapshot?.depth ?? null,
      report: snapshot?.report ?? null,
    };
  }

  @Get(':name/history')
  async history(@Param('name') name: string, @Query('range') range = '24h') {
    if (!isHistoryRange(range)) {
      throw new BadRequestException(`Unknown range '${range}'. Use one of: ${Object.keys(RANGES).join(', ')}.`);
    }
    const host = this.hosts.show(name);
    const { seconds, stepSeconds } = RANGES[range];
    const to = Math.floor(Date.now() / 1000);
    return { range, ...(await this.store.history(hostKey(host), to - seconds, to, stepSeconds)) };
  }

  @Post(':name/refresh')
  async refresh(@Param('name') name: string, @Body() body: { depth?: BatteryDepth }) {
    const host = this.hosts.show(name);
    // A probe already in flight is awaited rather than refused: the user asked,
    // and they are about to get a fresh result either way. Only *starting* one
    // is rate limited.
    if (!this.probe.busy(name)) this.assertNotTooSoon(name);

    // Default full: someone clicking Refresh wants the checks, not just the gauges.
    await this.probe.probe(name, body?.depth ?? 'full');
    this.collector.noteManualRefresh(host);
    return this.host(name);
  }

  private assertNotTooSoon(name: string): void {
    const now = Date.now();
    const since = now - (this.lastManualAt.get(name) ?? 0);
    if (since < MANUAL_MIN_GAP_MS) {
      throw new HttpException(
        {
          statusCode: HTTP_TOO_MANY,
          error: 'Too Many Requests',
          message: 'That host was just checked. Give it a moment.',
          retryInMs: MANUAL_MIN_GAP_MS - since,
        },
        HTTP_TOO_MANY,
      );
    }
    this.lastManualAt.set(name, now);
  }

  private summary(host: VopsHost, snap: LatestSnapshot | undefined) {
    const { eligible, reason, nextAt } = this.collector.eligibility(host);
    const findings = snap?.report.findings ?? [];
    return {
      name: host.name,
      hostKey: hostKey(host),
      at: snap ? new Date(snap.ts * 1000).toISOString() : null,
      ageSeconds: snap ? Math.max(0, Math.floor(Date.now() / 1000) - snap.ts) : null,
      reachable: snap?.reachable ?? null,
      latencyMs: snap?.latencyMs ?? null,
      worst: snap?.worst ?? 'ok',
      issues: findings.filter((f) => f.severity === 'warn' || f.severity === 'fail').length,
      collecting: this.probe.busy(host.name),
      eligible,
      ...(reason ? { reason } : {}),
      nextAt: nextAt === null ? null : new Date(nextAt).toISOString(),
      signals: signalsOf(findings),
    };
  }
}
