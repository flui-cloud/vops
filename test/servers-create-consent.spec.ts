import { BadRequestException } from '@nestjs/common';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { toFailure } from '../src/agent-api/agent-output';
import { VopsServersService } from '../src/servers/vops-servers.service';
import { VopsWriteGateService } from '../src/safety/vops-write-gate.service';
import type { VopsPlanFile } from '../src/dto/plan-file.dto';

/**
 * `servers create --from-plan <plan>` without `--yes` refused inside the service with a bare
 * `BadRequestException`, which `toFailure` deliberately leaves generic — so the last gate before a
 * billable machine reached the shell as VOPS_OPERATION_FAILED / exit 1, "it broke, maybe retry",
 * while the `app`, `host`, `firewall` and `vnet` gates all answer `approval` / exit 5. The refusal
 * must stay an HTTP 400 too: the same service is what the local API calls.
 */

const node = {
  name: 'cx22',
  supportsHourlyBilling: true,
  bareMetal: false,
  prices: [{ location: 'nbg1', priceHourly: { net: '0.006' }, priceMonthly: { net: '3.79' } }],
};

const capabilities = {
  getCapabilitiesService: () => ({
    getStaticCapabilities: () => ({ pricing: { billingCycle: 'hourly', currency: 'EUR' } }),
  }),
};

const planFile = (over: Partial<VopsPlanFile> = {}): VopsPlanFile => ({
  version: 'vops.plan.v1',
  action: 'server.create',
  provider: 'hetzner',
  name: 'vops-cx22-abc',
  plan: 'cx22',
  location: 'nbg1',
  image: 'debian-12',
  sshKey: { mode: 'none', id: null },
  billingGate: { providerBilling: 'hourly', planSupportsHourly: true, bareMetal: false, allowed: true, guided: false, reason: null },
  estimatedCost: { hourly: 0.006, monthly: 3.79, currency: 'EUR' },
  createdAt: new Date().toISOString(),
  ...over,
});

const audit: string[] = [];

function service(createServer?: (c: unknown) => Promise<unknown>): VopsServersService {
  const providers = { getProvider: () => ({ createServer }) };
  const catalog = { planNodeSize: async () => node };
  const store = { appendAudit: async (event: string) => void audit.push(event) };
  // The real write gate, so the billing authority is proven to pass *before* consent is asked.
  const writeGate = new VopsWriteGateService(capabilities as never);
  return new VopsServersService(
    providers as never,
    capabilities as never,
    catalog as never,
    writeGate,
    store as never,
    {} as never,
    {} as never,
  );
}

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (err) {
    return err;
  }
}

describe('servers create without --yes', () => {
  it('is an approval refusal with exit 5, not a generic failure', async () => {
    const failure = toFailure(await refusalOf(() => service().create(planFile(), { dryRun: false, yes: false })));

    expect({ code: failure.error.code, category: failure.error.category, exit: failure.exitCode }).toEqual({
      code: 'VOPS_APPROVAL_REQUIRED',
      category: 'approval',
      exit: ExitCode.APPROVAL_REQUIRED,
    });
    // No amount of retrying produces consent.
    expect(failure.error.recoverable).toBe(false);
  });

  it('names the machine and the cost consequence it is asking approval for', async () => {
    const failure = toFailure(await refusalOf(() => service().create(planFile(), { dryRun: false, yes: false })));

    expect(failure.error.message).toContain('vops-cx22-abc');
    expect(failure.error.message).toContain('cx22 in nbg1');
    expect(failure.error.message).toMatch(/billable|charg/i);
    expect(failure.error.suggestedAction).toContain('--yes');
  });

  it('stays an HTTP 400, so the dashboard still reads the reason', async () => {
    const err = await refusalOf(() => service().create(planFile(), { dryRun: false, yes: false }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getStatus()).toBe(400);
  });

  it('creates nothing while refusing', async () => {
    const created: unknown[] = [];
    const svc = service(async (c) => {
      created.push(c);
      return { serverId: 's-1', status: 'running' };
    });
    await refusalOf(() => svc.create(planFile(), { dryRun: false, yes: false }));
    expect(created).toEqual([]);
  });

  it('--dry-run still previews without asking for consent', async () => {
    const out = await service().create(planFile(), { dryRun: true, yes: false });
    expect(out).toMatchObject({ dryRun: true, server: null });
  });

  it('creates once --yes is given', async () => {
    const created: unknown[] = [];
    const svc = service(async (c) => {
      created.push(c);
      return { serverId: 's-1', status: 'running', ipAddress: '1.2.3.4' };
    });

    await expect(svc.create(planFile(), { dryRun: false, yes: true })).resolves.toMatchObject({
      dryRun: false,
      server: { id: 's-1', ip: '1.2.3.4', status: 'running' },
    });
    expect(created).toHaveLength(1);
  });
});
