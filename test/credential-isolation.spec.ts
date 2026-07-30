import * as path from 'node:path';
import { activeProfile, vopsEnvFiles } from '../src/lib/env-files';
import {
  credentialWriteRefusal,
  credentialWriteSummary,
} from '../src/lib/config/credential-write';

const BASE = path.join(path.sep, 'tmp', 'vops-env-files-test');

/**
 * `VOPS_PROFILE` has to isolate credentials, not just the encrypted store.
 * Env-based providers (Contabo, OVH's OS_*, Cherry) read `process.env`, so a
 * shared `.env` loaded under every profile left a throwaway profile holding the
 * user's real tokens.
 */
describe('vopsEnvFiles', () => {
  const saved = { dir: process.env.VOPS_CONFIG_DIR, profile: process.env.VOPS_PROFILE };

  beforeEach(() => {
    process.env.VOPS_CONFIG_DIR = BASE;
    delete process.env.VOPS_PROFILE;
  });
  afterAll(() => {
    if (saved.dir === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = saved.dir;
    if (saved.profile === undefined) delete process.env.VOPS_PROFILE;
    else process.env.VOPS_PROFILE = saved.profile;
  });

  it('keeps the default profile on the list it always loaded', () => {
    expect(vopsEnvFiles({ cwd: '.', packageEnv: '/pkg/.env' })).toEqual([
      '/pkg/.env',
      path.join(BASE, '.env'),
      '.env',
    ]);
  });

  it('treats an explicit "default" and an unset profile the same', () => {
    process.env.VOPS_PROFILE = 'default';
    expect(vopsEnvFiles({ cwd: '.' })).toEqual([path.join(BASE, '.env'), '.env']);
  });

  it('gives a named profile only its own .env — never the shared one', () => {
    process.env.VOPS_PROFILE = 'throwaway';
    expect(vopsEnvFiles({ cwd: '.', packageEnv: '/pkg/.env' })).toEqual([
      path.join(BASE, 'profiles', 'throwaway', '.env'),
    ]);
  });

  it('follows VOPS_CONFIG_DIR, so a scratch config dir inherits nothing', () => {
    process.env.VOPS_CONFIG_DIR = '/tmp/scratch';
    expect(vopsEnvFiles()).toEqual(['/tmp/scratch/.env']);
  });

  it('reads a blank profile as the default one', () => {
    process.env.VOPS_PROFILE = '  ';
    expect(activeProfile()).toBe('default');
  });
});

/**
 * A `config set` must not overwrite a live Hetzner token with a placeholder and exit 0.
 */
describe('credentialWriteRefusal', () => {
  const base = {
    provider: 'hetzner',
    profile: 'default',
    profileDir: '/home/u/.config/vops/profiles/default',
  };

  it('refuses to replace an existing credential, naming the profile', () => {
    const refusal = credentialWriteRefusal({ ...base, existing: true, force: false });
    expect(refusal).toContain('already has a credential in profile "default"');
    expect(refusal).toContain(base.profileDir);
    expect(refusal).toContain('--force');
  });

  it('allows the first write for a provider', () => {
    expect(credentialWriteRefusal({ ...base, existing: false, force: false })).toBeNull();
  });

  it('allows a deliberate rotation with --force', () => {
    expect(credentialWriteRefusal({ ...base, existing: true, force: true })).toBeNull();
  });

  it('names the profile it wrote to in the confirmation', () => {
    expect(credentialWriteSummary({ ...base, existing: false })).toContain(
      'Stored hetzner credentials in profile "default"',
    );
    expect(credentialWriteSummary({ ...base, existing: true })).toContain('Replaced');
  });
});
