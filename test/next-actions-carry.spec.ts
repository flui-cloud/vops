import * as fs from 'node:fs';
import * as path from 'node:path';
import { Parser } from '@oclif/core';

// chalk 5 is ESM and these command modules import it for their human rendering, which this suite
// never reaches — it only reads their flag definitions.
jest.mock('chalk', () => new Proxy({}, { get: () => (s: string) => s }));

import AppDeploy from '../src/commands/app/deploy';
import AppInstall from '../src/commands/app/install';
import BackupRestore, { restoreInvocation } from '../src/commands/backup/restore';
import { deployBody } from '../src/apps/deploy-flags';
import type { DeployFlags } from '../src/apps/deploy-flags';
import type { DeployPlanView, VopsAppsService } from '../src/apps/vops-apps.service';

/**
 * `next-actions.spec.ts` proves every emitted command and flag *exists*. It cannot see the other
 * half: a follow-up that omits a flag the caller passed parses perfectly, every token in it is
 * real, and it still fails — `app deploy --image …` suggesting a re-run without `--image`, which
 * a `kind: Application` manifest can never satisfy.
 *
 * So this guard re-parses the emitted command with the *real* flag definitions of the command it
 * names, and asserts the result is the invocation that produced it. An omission is then a failing
 * diff rather than an invisible one, and a flag that does not belong to the named command (the
 * `app install` / `app deploy` split) fails the parse.
 */

/** Secret-bearing flags are carried by name with a placeholder — their value must not be echoed. */
const REDACTED = new Set(['set', 'registry-token', 'auth-pass']);
/** Consent and output flags: deliberately rewritten, since the follow-up is the approved re-run. */
const REWRITTEN = new Set(['yes', 'dry-run']);

function dropped(original: Record<string, unknown>, followUp: Record<string, unknown>): string[] {
  return Object.entries(original)
    .filter(([k, v]) => !REWRITTEN.has(k) && v !== undefined)
    .filter(([k, v]) => {
      const got = followUp[k];
      if (got === undefined) return true;
      if (!REDACTED.has(k)) return JSON.stringify(got) !== JSON.stringify(v);
      if (k !== 'set') return false;
      const keys = (xs: unknown) => (xs as string[]).map((p) => p.slice(0, p.indexOf('=')));
      return JSON.stringify(keys(got)) !== JSON.stringify(keys(v));
    })
    .map(([k]) => k);
}

const reparse = async (cmd: { flags: object }, command: string, head: string) => {
  expect(command.startsWith(`${head} `)).toBe(true);
  const argv = command.slice(head.length).trim().split(' ');
  return Parser.parse(argv, { flags: cmd.flags as never, strict: true });
};

describe('a re-run action carries the invocation it replaces', () => {
  const plan = { app: 'gitea', host: 'web1', files: {}, warnings: [] } as unknown as DeployPlanView;
  const svc = { deploy: async () => plan } as unknown as Pick<VopsAppsService, 'deploy'>;

  const shared: DeployFlags = {
    host: 'web1',
    name: 'tools',
    set: ['ADMIN_PASSWORD=hunter2', 'LOCALE=it'],
    domain: 'tools.example.com',
    email: 'ops@example.com',
    tls: false,
    staging: true,
    'expose-direct': true,
    'force-dns': true,
    public: false,
    auth: 'basic',
    'auth-user': 'admin',
    'auth-pass': 'sup3r-s3cret',
    yes: false,
    'dry-run': true,
    json: true,
  };
  const full: DeployFlags = { ...shared, image: 'ghcr.io/me/app:abc1234', 'registry-user': 'me', 'registry-token': 'ghp_liveToken' };

  beforeEach(() => {
    delete process.env.VOPS_REGISTRY_TOKEN;
  });

  const followUp = async (source: { catalog?: string; file?: string }, flags: DeployFlags): Promise<string> => {
    const body = await deployBody(svc, source, flags);
    return body.nextActions?.[0].command ?? '';
  };

  it('app deploy keeps --image, without which the re-run cannot succeed', async () => {
    const command = await followUp({ file: './flui.yaml' }, full);
    const { flags } = await reparse(AppDeploy, command, 'vops app deploy');

    expect(flags.image).toBe('ghcr.io/me/app:abc1234');
    expect(dropped({ ...full, file: './flui.yaml' }, flags)).toEqual([]);
    expect(flags.yes).toBe(true);
    expect(flags['dry-run']).toBe(false);
  });

  it('app install keeps its flags and none that app install does not declare', async () => {
    const command = await followUp({ catalog: 'gitea' }, shared);
    const { flags } = await reparse(AppInstall, command, 'vops app install gitea');

    expect(dropped({ ...shared }, flags)).toEqual([]);
  });

  it('never echoes a secret value into the command string', async () => {
    const commands = [await followUp({ file: './flui.yaml' }, full), await followUp({ catalog: 'gitea' }, shared)];
    for (const command of commands) {
      for (const secret of ['hunter2', 'sup3r-s3cret', 'ghp_liveToken']) {
        expect({ command, secret, leaked: command.includes(secret) }).toEqual({ command, secret, leaked: false });
      }
    }
  });

  it('names the flags whose values it redacted, so the caller knows to re-supply them', async () => {
    const body = await deployBody(svc, { file: './flui.yaml' }, full);
    expect(body.nextActions?.[0].description).toContain('--set');
    expect(body.nextActions?.[0].description).toContain('--registry-token');
    expect(body.nextActions?.[0].description).toContain('--auth-pass');
  });

  it('omits --registry-token when it came from the environment the re-run also reads', async () => {
    process.env.VOPS_REGISTRY_TOKEN = 'ghp_liveToken';
    const command = await followUp({ file: './flui.yaml' }, full);
    expect(command).not.toContain('--registry-token');
  });

  it('backup restore carries the snapshot and target that were approved', async () => {
    const command = restoreInvocation('web1', { snapshot: 'abc1234', target: '/restore/2026-07-29' });
    const { flags } = await reparse(BackupRestore, command, 'vops backup restore web1');

    expect(flags.snapshot).toBe('abc1234');
    expect(flags.target).toBe('/restore/2026-07-29');
    expect(flags.yes).toBe(true);
  });

  it('carries --project into the follow-up, which otherwise reads a different directory', () => {
    const src = (p: string[]): string => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
    for (const file of [['commands', 'deploy', 'plan.ts'], ['commands', 'build', 'setup.ts'], ['commands', 'build', 'run.ts']]) {
      expect({ file, carries: /carried\(flagArg\('project'/.test(src(file)) }).toEqual({ file, carries: true });
    }
  });
});

/**
 * A new re-run site must be registered here, so the round-trip coverage above is a rule rather
 * than something three commands happen to have.
 */
describe('every re-run reconstruction is covered', () => {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      return p.endsWith('.ts') ? [p] : [];
    });

  it('lists exactly the reconstructions this suite knows about', () => {
    const root = path.join(__dirname, '..', 'src');
    const sites = walk(root)
      // Second alternative: a reconstruction assembled from parts rather than one template
      // (`bench host` builds an array so it can drop the flags it was not given).
      .filter((f) => /command: `[^`]*--yes --json`|'--yes --json',\n\s*\]\.join|deployInvocation\(source, flags\)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f))
      .sort();

    // `app remove` reconstructs by hand and already carries its only flag (`--purge`); it is
    // listed so a second flag added to it has to come past this test. `bench host` joined the
    // list when its refusal moved onto the envelope — it carries --profile/--runs/--install,
    // the flags that decide which benchmark the user actually approved.
    expect(sites).toEqual([
      path.join('apps', 'deploy-flags.ts'),
      path.join('commands', 'app', 'remove.ts'),
      path.join('commands', 'backup', 'restore.ts'),
      path.join('commands', 'bench', 'host.ts'),
      path.join('commands', 'deploy', 'plan.ts'),
    ]);
  });
});
