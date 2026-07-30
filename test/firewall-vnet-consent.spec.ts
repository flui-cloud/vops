import { BadRequestException } from '@nestjs/common';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { toFailure } from '../src/agent-api/agent-output';
import { VopsFirewallService } from '../src/firewall/vops-firewall.service';
import { VopsVnetService } from '../src/vnet/vops-vnet.service';

/**
 * These two gates refuse *inside the service* — the one place the CLI and the local API
 * share — so a bare `BadRequestException` reached the shell as VOPS_OPERATION_FAILED/1, i.e.
 * "it broke", whose natural response is to retry a destructive command. The refusal must carry
 * the `approval` category (exit 5) while staying an HTTP 400 for the local API.
 */

const audit: Array<{ event: string }> = [];
const store = { appendAudit: async (event: string) => void audit.push({ event }) };
const writeGate = { assertProviderWritable: () => undefined };

function firewallService(api: Record<string, unknown> = {}): VopsFirewallService {
  const factory = { getFirewallProviderOrFail: () => api };
  return new VopsFirewallService(factory as never, writeGate as never, store as never);
}

function vnetService(api: Record<string, unknown> = {}): VopsVnetService {
  const factory = { getProvider: () => api };
  return new VopsVnetService(factory as never, writeGate as never, store as never);
}

async function refusalOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (err) {
    return err;
  }
}

const gates: Array<[string, () => Promise<unknown>]> = [
  ['firewall create', () => firewallService().create({ provider: 'hetzner', name: 'web', rules: [] }, {})],
  ['firewall delete', () => firewallService().delete('hetzner', 'fw-1', {})],
  ['vnet create', () => vnetService().create({ provider: 'hetzner', name: 'core', ipRange: '10.0.0.0/16' }, {})],
  ['vnet delete', () => vnetService().delete('hetzner', 'net-1', {})],
];

describe('firewall and vnet consent refusals', () => {
  it.each(gates)('%s without --yes refuses with approval / exit 5', async (name, run) => {
    const failure = toFailure(await refusalOf(run));
    expect({ name, code: failure.error.code, category: failure.error.category, exit: failure.exitCode }).toEqual({
      name,
      code: 'VOPS_APPROVAL_REQUIRED',
      category: 'approval',
      exit: ExitCode.APPROVAL_REQUIRED,
    });
    expect(failure.error.recoverable).toBe(false);
  });

  it.each(gates)('%s stays an HTTP 400 for the local API', async (_name, run) => {
    const err = await refusalOf(run);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getStatus()).toBe(400);
  });

  it('names the target so the user knows what they are approving', async () => {
    const failure = toFailure(await refusalOf(gates[3][1]));
    expect(failure.error.message).toContain("'net-1'");
    expect(failure.error.suggestedAction).toContain('--yes');
  });

  it('--dry-run previews without asking for consent', async () => {
    await expect(firewallService().create({ provider: 'hetzner', name: 'web' }, { dryRun: true })).resolves.toEqual({
      dryRun: true,
      firewall: null,
    });
    await expect(vnetService().delete('hetzner', 'net-1', { dryRun: true })).resolves.toEqual({ dryRun: true });
  });

  it('lets the write through once --yes is given', async () => {
    const created: string[] = [];
    const api = {
      createFirewall: async (input: { name: string }) => {
        created.push(input.name);
        return { firewallId: 'fw-9' };
      },
      getFirewall: async () => null,
    };
    await expect(firewallService(api).create({ provider: 'hetzner', name: 'web' }, { yes: true })).resolves.toEqual({
      dryRun: false,
      firewall: null,
    });
    expect(created).toEqual(['web']);
  });
});
