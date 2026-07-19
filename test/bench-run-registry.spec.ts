import { BenchRunRegistry } from '../src/bench/bench-run-registry';
import { BenchProgress, RunOptions, VopsBenchService } from '../src/bench/vops-bench.service';
import { BenchResultV1, BenchSample } from '../src/bench/bench.model';
import { ProbePlan } from '../src/bench/bench-plan';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const sample = (probe: string, steal: number): BenchSample => ({ probe, t: 1, steal, load1: 0.1 });

function result(host: string): BenchResultV1 {
  return {
    schema: 'vops.bench.v1',
    id: 'b-x',
    profile: 'quick',
    profileVersion: 1,
    mode: 'in-vivo',
    host: { name: host },
    startedAt: '2026-07-14T00:00:00Z',
    durationMs: 1000,
    meta: { cpuModel: 'x', cores: 2, memGb: 4, virt: 'kvm', kernel: '6', osPretty: 'os', toolVersions: {} },
    baseline: { load1: 0, steal: 0 },
    runs: 1,
    probes: [],
    samples: [],
    steal: { avg: 0, max: 0 },
    warnings: [],
  };
}

class FakeBench {
  lastOpts: RunOptions | null = null;
  runs = 0;
  private resolvers = new Map<string, { resolve: (r: BenchResultV1) => void; reject: (e: unknown) => void }>();

  run(name: string, opts: RunOptions = {}): Promise<BenchResultV1> {
    this.runs += 1;
    this.lastOpts = opts;
    return new Promise<BenchResultV1>((resolve, reject) => {
      this.resolvers.set(name, { resolve, reject });
    });
  }

  emit(p: BenchProgress): void {
    this.lastOpts?.onProgress?.(p);
  }
  emitPlan(probes: ProbePlan[]): void {
    this.lastOpts?.onPlan?.(probes);
  }
  finish(name: string, r: BenchResultV1): void {
    this.resolvers.get(name)?.resolve(r);
  }
  fail(name: string, e: unknown): void {
    this.resolvers.get(name)?.reject(e);
  }
}

function make(): { reg: BenchRunRegistry; fake: FakeBench } {
  const fake = new FakeBench();
  const reg = new BenchRunRegistry(fake as unknown as VopsBenchService);
  return { reg, fake };
}

describe('BenchRunRegistry', () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 1));
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns a runId and starts in the running state', () => {
    const { reg } = make();
    const { runId } = reg.start('h1', {});
    expect(runId).toMatch(/^r-/);
    const st = reg.get(runId);
    expect(st?.state).toBe('running');
    expect(st?.host).toBe('h1');
  });

  it('clamps and passes the run count through to the service and the state', () => {
    const { reg, fake } = make();
    const { runId } = reg.start('h1', { runs: 9 });
    expect(reg.get(runId)?.runs).toBe(5);
    expect(fake.lastOpts?.runs).toBe(5);
  });

  it('captures the probe plan while the run is still in flight', () => {
    const { reg, fake } = make();
    const { runId } = reg.start('h1', {});
    expect(reg.get(runId)?.plan).toEqual([]);
    fake.emitPlan([
      { id: 'cpu.multi', tool: 'sevenz', willRun: true },
      { id: 'disk.rr4k', tool: 'fio', willRun: false, reason: 'tool missing: fio' },
    ]);
    const st = reg.get(runId);
    expect(st?.state).toBe('running');
    expect(st?.plan).toEqual([
      { id: 'cpu.multi', willRun: true, reason: undefined },
      { id: 'disk.rr4k', willRun: false, reason: 'tool missing: fio' },
    ]);
  });

  it('accumulates progress events and concatenates samples', () => {
    const { reg, fake } = make();
    const { runId } = reg.start('h1', {});
    fake.emit({ index: 1, total: 2, probe: 'cpu.multi', status: 'start' });
    fake.emit({ index: 1, total: 2, probe: 'cpu.multi', status: 'done', metrics: { mips: 100 }, samples: [sample('cpu.multi', 3)] });
    fake.emit({ index: 2, total: 2, probe: 'disk.rr4k', status: 'done', metrics: { iops: 9 }, samples: [sample('disk.rr4k', 1), sample('disk.rr4k', 2)] });
    const st = reg.get(runId);
    expect(st?.progress).toHaveLength(3);
    expect(st?.samples.map((s) => s.steal)).toEqual([3, 1, 2]);
  });

  it('transitions to done with the result on resolve', async () => {
    const { reg, fake } = make();
    const { runId } = reg.start('h1', {});
    fake.finish('h1', result('h1'));
    await tick();
    const st = reg.get(runId);
    expect(st?.state).toBe('done');
    expect(st?.result?.host.name).toBe('h1');
  });

  it('captures the error message on reject without an unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const { reg, fake } = make();
    const { runId } = reg.start('h1', {});
    fake.fail('h1', new Error('ssh down'));
    await tick();
    process.off('unhandledRejection', unhandled);
    const st = reg.get(runId);
    expect(st?.state).toBe('error');
    expect(st?.error).toBe('ssh down');
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('refuses a second run for a host already running', () => {
    const { reg } = make();
    reg.start('h1', {});
    expect(() => reg.start('h1', {})).toThrow(/already running/);
  });

  it('activeFor finds the live run for a host', () => {
    const { reg } = make();
    const { runId } = reg.start('h1', {});
    expect(reg.activeFor('h1')?.runId).toBe(runId);
    expect(reg.activeFor('other')).toBeNull();
  });

  it('evicts the oldest finished runs beyond the retention cap', async () => {
    const { reg, fake } = make();
    const first = reg.start('host-0', {});
    fake.finish('host-0', result('host-0'));
    await tick();
    for (let i = 1; i <= 24; i += 1) {
      const host = 'host-' + i;
      reg.start(host, {});
      fake.finish(host, result(host));
      await tick();
    }
    expect(reg.get(first.runId)).toBeNull();
  });
});
