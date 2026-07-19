import { BadRequestException, Injectable } from '@nestjs/common';
import { BenchProfile, BenchResultV1, BenchSample } from './bench.model';
import { clampRuns } from './bench-plan';
import { BenchProgress, VopsBenchService } from './vops-bench.service';

export interface BenchPlanItem {
  id: string;
  willRun: boolean;
  reason?: string;
}

export interface BenchRunState {
  runId: string;
  host: string;
  profile: BenchProfile;
  startedAt: string;
  state: 'running' | 'done' | 'error';
  runs: number;
  plan: BenchPlanItem[];
  progress: BenchProgress[];
  samples: BenchSample[];
  result?: BenchResultV1;
  error?: string;
}

export interface BenchStartOptions {
  profile?: BenchProfile;
  install?: boolean;
  runs?: number;
}

const RETENTION = 20;

/**
 * Runs `VopsBenchService.run` in the background and exposes an in-memory,
 * pollable view of the run for the dashboard: accumulated per-probe progress and
 * the per-probe steal/load samples. The service's own per-host guard is the
 * backstop; this pre-checks it so the API answers 400 instead of a late reject.
 */
@Injectable()
export class BenchRunRegistry {
  private readonly runs = new Map<string, BenchRunState>();

  constructor(private readonly bench: VopsBenchService) {}

  start(name: string, opts: BenchStartOptions = {}): { runId: string } {
    if (this.activeFor(name)) {
      throw new BadRequestException(`A benchmark is already running for host '${name}'.`);
    }
    const profile = opts.profile ?? 'quick';
    const runs = clampRuns(opts.runs);
    const runId = `r-${Date.now().toString(36)}`;
    const st: BenchRunState = {
      runId,
      host: name,
      profile,
      startedAt: new Date().toISOString(),
      state: 'running',
      runs,
      plan: [],
      progress: [],
      samples: [],
    };
    this.runs.set(runId, st);
    this.evict();
    this.bench
      .run(name, {
        profile,
        install: opts.install,
        runs,
        onPlan: (probes) => {
          st.plan = probes.map((p) => ({ id: p.id, willRun: p.willRun, reason: p.reason }));
        },
        onProgress: (p: BenchProgress) => {
          st.progress.push(p);
          if (p.samples?.length) st.samples.push(...p.samples);
        },
      })
      .then((result) => {
        st.state = 'done';
        st.result = result;
      })
      .catch((err) => {
        st.state = 'error';
        st.error = err instanceof Error ? err.message : String(err);
      });
    return { runId };
  }

  get(runId: string): BenchRunState | null {
    return this.runs.get(runId) ?? null;
  }

  activeFor(host: string): BenchRunState | null {
    let latest: BenchRunState | null = null;
    for (const st of this.runs.values()) {
      if (st.host === host && st.state === 'running') latest = st;
    }
    return latest;
  }

  private evict(): void {
    if (this.runs.size <= RETENTION) return;
    for (const [id, st] of this.runs) {
      if (this.runs.size <= RETENTION) break;
      if (st.state !== 'running') this.runs.delete(id);
    }
  }
}
