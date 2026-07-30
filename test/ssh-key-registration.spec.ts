import { publicKeyBody, samePublicKey } from '../src/ssh-keys/public-key';
import { VopsServersService } from '../src/servers/vops-servers.service';

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2Nq';

describe('samePublicKey — the only identity that crosses local ↔ provider', () => {
  it('ignores the comment, which differs between the local file and the provider copy', () => {
    expect(samePublicKey(`${ED} dawit@laptop`, `${ED} imported-by-hetzner`)).toBe(true);
  });

  it('ignores surrounding whitespace and trailing newlines', () => {
    expect(samePublicKey(`  ${ED} a\n`, `${ED}  b`)).toBe(true);
  });

  it('rejects a different key of the same type', () => {
    expect(samePublicKey(`${ED} a`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAdifferent a')).toBe(false);
  });

  it('never matches on garbage — an unparseable key is not "equal" to another unparseable one', () => {
    expect(samePublicKey('', '')).toBe(false);
    expect(samePublicKey('not-a-key', 'not-a-key')).toBe(false);
    expect(publicKeyBody('ssh-ed25519')).toBe('');
  });
});

// The plan recorded `{ mode: 'existing', id: <local name> }` without ever asking the
// provider, so the failure surfaced at `create` — after the user had approved the spend.
describe('servers plan — the SSH key is resolved against the provider, before approval', () => {
  const node = { name: 'cx23', prices: [{ location: 'fsn1', priceHourly: { net: '0.01' }, priceMonthly: { net: '4.00' } }] };

  function svc(lookup: unknown) {
    return new VopsServersService(
      {} as never,
      { getCapabilitiesService: () => ({ getStaticCapabilities: () => ({ pricing: { currency: 'EUR' } }) }) } as never,
      { planNodeSize: async () => node } as never,
      { evaluate: () => ({ allowed: true, guided: false, reason: '' }) } as never,
      {} as never,
      { lookupProviderKey: async () => lookup } as never,
      {} as never,
    );
  }
  const input = { provider: 'hetzner', plan: 'cx23', location: 'fsn1', sshKey: 'laptop' };

  it('records the PROVIDER key id it verified, not the local name', async () => {
    const plan = await svc({ state: 'found', providerKeyId: '98765', providerKeyName: 'dawit' }).plan(input);
    expect(plan.sshKey).toEqual({ mode: 'existing', id: '98765' });
  });

  it('refuses at plan time — exit 2 — naming the command that fixes it', async () => {
    const err = await svc({ state: 'missing' }).plan(input).catch((e) => e);
    expect(err.agent.code).toBe('VOPS_SSH_KEY_NOT_REGISTERED');
    expect(err.exitCode).toBe(2);
    expect(err.agent.suggestedAction).toContain('vops ssh-key register laptop --provider hetzner');
  });

  it('says `unverified` when the check could not run, instead of claiming it passed', async () => {
    const plan = await svc({ state: 'unverifiable', reason: 'ovh does not expose its registered SSH keys' }).plan(input);
    expect(plan.sshKey).toEqual({ mode: 'unverified', id: 'laptop' });
  });

  it('leaves a keyless plan alone (no provider call to make)', async () => {
    const plan = await svc({ state: 'missing' }).plan({ ...input, sshKey: undefined });
    expect(plan.sshKey).toEqual({ mode: 'none', id: null });
  });
});
