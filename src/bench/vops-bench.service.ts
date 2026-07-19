import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { resolveSshTarget } from '../host-ops/ssh-target';
import { splitSections } from '../host-ops/status-battery';
import { LocalStore } from '../lib/store/local-store';
import { VopsHost } from '../hosts/host.model';
import { BenchMeta, BenchProbeResult, BenchProfile, BenchResultV1, BenchSample } from './bench.model';
import {
  PROBE_SPECS,
  ProbeId,
  buildInstallScript,
  buildPreflightScript,
  buildProbeScript,
  expectedSeconds,
} from './bench-scripts';
import { ToolInfo, parseBaseline, parseMeta, parseSamples, parseSpaceKb, parseTools } from './bench-parse';
import {
  ProbePlan,
  ProfileEstimate,
  aggregateProbeRounds,
  assembleResult,
  clampRuns,
  extractMetrics,
  fioSizeKb,
  missingTools,
  probePlan,
  profileEstimates,
} from './bench-plan';

const SAMPLE_CAP = 600;
const PREFLIGHT_TIMEOUT = 40_000;
const INSTALL_TIMEOUT = 600_000;

export interface BenchPreflight {
  host: string;
  profile: BenchProfile;
  meta: BenchMeta;
  baseline: { load1: number; steal: number };
  freeKb: number;
  needKb: number;
  spaceOk: boolean;
  tools: Record<string, ToolInfo>;
  missing: string[];
  probes: ProbePlan[];
  estSeconds: number;
  estimates: Record<BenchProfile, ProfileEstimate>;
}

export interface BenchProgress {
  index: number;
  total: number;
  probe: ProbeId;
  status: 'start' | 'done' | 'skipped';
  note?: string;
  metrics?: Record<string, number>;
  samples?: BenchSample[];
  round?: number;
  rounds?: number;
}

export interface RunOptions {
  profile?: BenchProfile;
  install?: boolean;
  runs?: number;
  onPlan?: (probes: ProbePlan[]) => void;
  onProgress?: (p: BenchProgress) => void;
}

interface Gathered {
  tools: Record<string, ToolInfo>;
  meta: BenchMeta;
  baseline: { load1: number; steal: number };
  freeKb: number;
}

/**
 * `bench host` orchestration: read-only preflight (consent data), then a
 * sequential battery of probes with bounded per-probe timeouts. A disruptive read,
 * so the CLI gates it on `--yes`; a per-host in-memory guard prevents overlap.
 */
@Injectable()
export class VopsBenchService {
  private readonly active = new Set<string>();

  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    @Inject('SshExec') private readonly ssh: SshExec,
    private readonly store: LocalStore,
  ) {}

  async preflight(name: string, profile: BenchProfile = 'quick'): Promise<BenchPreflight> {
    const host = this.hosts.show(name);
    const target = resolveSshTarget(host, this.keys);
    const g = await this.gather(target);
    return this.plan(name, profile, g);
  }

  async run(name: string, opts: RunOptions = {}): Promise<BenchResultV1> {
    const profile = opts.profile ?? 'quick';
    const runs = clampRuns(opts.runs);
    const host = this.hosts.show(name);
    if (this.active.has(host.name)) {
      throw new BadRequestException(`A benchmark is already running for host '${host.name}'.`);
    }
    this.active.add(host.name);
    try {
      const target = resolveSshTarget(host, this.keys);
      let g = await this.gather(target);
      if (opts.install) {
        await this.install(host, target);
        g = await this.gather(target);
      }
      const pre = this.plan(host.name, profile, g);
      opts.onPlan?.(pre.probes);
      await this.store.appendAudit('bench.host.run', {
        host: host.name,
        profile,
        install: !!opts.install,
        runs,
      });
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const { probes, samples } = await this.runProbes(target, profile, pre.probes, runs, opts.onProgress);
      const result = assembleResult({
        host,
        profile,
        startedAt,
        durationMs: Date.now() - started,
        meta: g.meta,
        baseline: g.baseline,
        runs,
        probes,
        samples,
      });
      await this.store.saveBenchRun(result);
      return result;
    } finally {
      this.active.delete(host.name);
    }
  }

  private async gather(target: SshTarget): Promise<Gathered> {
    const res = await this.ssh.runScript(target, buildPreflightScript(), { timeoutMs: PREFLIGHT_TIMEOUT });
    const s = splitSections(res.stdout);
    const tools = parseTools(s.tools ?? '');
    return {
      tools,
      meta: parseMeta(s.meta ?? '', tools),
      baseline: parseBaseline(s.base ?? ''),
      freeKb: parseSpaceKb(s.space ?? ''),
    };
  }

  private plan(name: string, profile: BenchProfile, g: Gathered): BenchPreflight {
    const needKb = 2 * fioSizeKb(profile);
    const spaceOk = Number.isFinite(g.freeKb) && g.freeKb >= needKb;
    const probes = PROBE_SPECS.map((spec) => probePlan(spec, g.tools, spaceOk, needKb));
    const estSeconds = probes
      .filter((p) => p.willRun)
      .reduce((sum, p) => sum + expectedSeconds(p.id, profile), 0);
    return {
      host: name,
      profile,
      meta: g.meta,
      baseline: g.baseline,
      freeKb: g.freeKb,
      needKb,
      spaceOk,
      tools: g.tools,
      missing: missingTools(g.tools),
      probes,
      estSeconds,
      estimates: profileEstimates(g.tools, g.freeKb),
    };
  }

  private async install(host: VopsHost, target: SshTarget): Promise<void> {
    const script = buildInstallScript(host.os?.family ?? 'debian');
    if (!script) return;
    await this.ssh.runScript(target, script, { timeoutMs: INSTALL_TIMEOUT, sudo: true });
  }

  // Rounds-outer / probes-inner: repeating the whole battery interleaves the
  // rounds, so temporal drift hits every probe fairly instead of only the tail.
  private async runProbes(
    target: SshTarget,
    profile: BenchProfile,
    plans: ProbePlan[],
    runs: number,
    onProgress?: (p: BenchProgress) => void,
  ): Promise<{ probes: BenchProbeResult[]; samples: BenchSample[] }> {
    const samples: BenchSample[] = [];
    const byProbe = new Map<ProbeId, BenchProbeResult[]>();
    const total = plans.length;
    for (let round = 1; round <= runs; round += 1) {
      let index = 0;
      for (const plan of plans) {
        index += 1;
        if (!plan.willRun) {
          if (round === 1) {
            byProbe.set(plan.id, [{ id: plan.id, status: 'skipped', note: plan.reason, metrics: {} }]);
            onProgress?.({ index, total, probe: plan.id, status: 'skipped', note: plan.reason, round, rounds: runs });
          }
          continue;
        }
        onProgress?.({ index, total, probe: plan.id, status: 'start', round, rounds: runs });
        const keepFio = plan.id === 'disk.sw1m' && round < runs;
        const { result, probeSamples } = await this.runProbe(target, plan.id, profile, keepFio);
        byProbe.set(plan.id, [...(byProbe.get(plan.id) ?? []), result]);
        samples.push(...probeSamples);
        onProgress?.({
          index,
          total,
          probe: plan.id,
          status: result.status === 'done' ? 'done' : 'skipped',
          note: result.note,
          metrics: result.metrics,
          samples: probeSamples,
          round,
          rounds: runs,
        });
      }
    }
    const probes = plans.map((plan) =>
      aggregateProbeRounds(
        byProbe.get(plan.id) ?? [{ id: plan.id, status: 'skipped', note: plan.reason, metrics: {} }],
      ),
    );
    return { probes, samples: samples.slice(0, SAMPLE_CAP) };
  }

  private async runProbe(
    target: SshTarget,
    id: ProbeId,
    profile: BenchProfile,
    keepFio: boolean,
  ): Promise<{ result: BenchProbeResult; probeSamples: BenchSample[] }> {
    const timeoutMs = (expectedSeconds(id, profile) + 120) * 1000;
    const res = await this.ssh.runScript(target, buildProbeScript(id, profile, keepFio), { timeoutMs });
    const s = splitSections(res.stdout);
    const probeSamples = parseSamples(s.samples ?? '', id);
    const metrics = extractMetrics(id, s[id] ?? '');
    const result: BenchProbeResult = metrics
      ? { id, status: 'done', metrics }
      : { id, status: 'skipped', note: 'malformed output', metrics: {} };
    return { result, probeSamples };
  }
}
