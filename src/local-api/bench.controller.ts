import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { VopsBenchService } from '../bench/vops-bench.service';
import { BenchRunRegistry } from '../bench/bench-run-registry';
import { LocalStore } from '../lib/store/local-store';
import { renderCompareShare, renderShare } from '../bench/bench-share';
import { readings } from '../bench/bench-bands';
import { compareRuns } from '../bench/bench-compare';
import { BenchProfile, BenchResultV1 } from '../bench/bench.model';

const runHeader = (r: BenchResultV1) => ({
  id: r.id,
  host: r.host.name,
  startedAt: r.startedAt,
  profile: r.profile,
});

/** Benchmark surface for the local UI — history, preflight, and a pollable live run. */
@Controller('api/bench')
export class BenchController {
  constructor(
    private readonly bench: VopsBenchService,
    private readonly registry: BenchRunRegistry,
    private readonly store: LocalStore,
  ) {}

  @Get('runs')
  runs(@Query('host') host?: string) {
    return this.store.listBenchRuns(host);
  }

  @Get('runs/:id')
  run(@Param('id') id: string) {
    return this.loadRun(id);
  }

  @Get('runs/:id/share')
  async share(@Param('id') id: string) {
    return { markdown: renderShare(await this.loadRun(id)) };
  }

  @Get('runs/:id/reading')
  async reading(@Param('id') id: string) {
    return readings(await this.loadRun(id));
  }

  @Get('compare')
  async compare(@Query('a') a?: string, @Query('b') b?: string) {
    const [ra, rb] = await Promise.all([this.loadRun(a), this.loadRun(b)]);
    return { ...compareRuns(ra, rb), a: runHeader(ra), b: runHeader(rb) };
  }

  @Get('compare/share')
  async compareShare(@Query('a') a?: string, @Query('b') b?: string) {
    const [ra, rb] = await Promise.all([this.loadRun(a), this.loadRun(b)]);
    return {
      markdown: renderCompareShare({ ...compareRuns(ra, rb), a: runHeader(ra), b: runHeader(rb) }),
    };
  }

  @Get('hosts/:name/preflight')
  preflight(@Param('name') name: string, @Query('profile') profile?: string) {
    return this.bench.preflight(name, this.profile(profile));
  }

  @Post('hosts/:name/run')
  runHost(
    @Param('name') name: string,
    @Body() body: { profile?: BenchProfile; install?: boolean; yes?: boolean; runs?: number },
  ): { runId: string } {
    if (body?.yes !== true) throw new BadRequestException('Confirmation required: pass yes=true.');
    return this.registry.start(name, { profile: body.profile, install: body.install, runs: body.runs });
  }

  @Get('hosts/:name/active')
  active(@Param('name') name: string) {
    return this.registry.activeFor(name) ?? null;
  }

  @Get('state/:id')
  state(@Param('id') id: string) {
    const st = this.registry.get(id);
    if (!st) throw new BadRequestException(`Unknown bench run '${id}'.`);
    return st;
  }

  private async loadRun(id?: string): Promise<BenchResultV1> {
    const r = id ? await this.store.getBenchRun(id) : null;
    if (!r) throw new BadRequestException(`Unknown bench run '${id ?? ''}'.`);
    return r;
  }

  private profile(value?: string): BenchProfile {
    return value === 'full' ? 'full' : 'quick';
  }
}
