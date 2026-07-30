import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Command } from '@oclif/core';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { runAgentCommand } from '../src/agent-api/agent-output';
import { approvalPending, approvalRequired } from '../src/safety/approval-gate';
import { deployBody } from '../src/apps/deploy-flags';
import type { DeployFlags } from '../src/apps/deploy-flags';
import type { DeployPlanView, DeployResult, VopsAppsService } from '../src/apps/vops-apps.service';

/**
 * The refusal branch is the one an agent most needs to parse — it is the branch that says
 * "ask the user". These pin that a command advertising `--json` puts an envelope and NOTHING
 * ELSE on stdout when it refuses, and leaves with 5 rather than a generic 1.
 */

class FakeExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function fakeCommand(id: string) {
  const out: string[] = [];
  const errors: { message: string; suggestions?: string[] }[] = [];
  const cmd = {
    id,
    log: (line = '') => {
      out.push(line);
    },
    exit: (code = 0): never => {
      throw new FakeExit(code);
    },
    error: (message: string, opts: { exit?: number; suggestions?: string[] } = {}): never => {
      errors.push({ message, suggestions: opts.suggestions });
      throw new FakeExit(opts.exit ?? 2);
    },
  };
  return { cmd: cmd as unknown as Command, out, errors };
}

async function exitCodeOf(fn: () => Promise<void>): Promise<number> {
  try {
    await fn();
    return ExitCode.SUCCESS;
  } catch (err) {
    if (err instanceof FakeExit) return err.code;
    throw err;
  }
}

const refusal = {
  data: { removed: false, purge: false, host: 'web1' },
  ...approvalPending({ operation: 'Remove app', target: 'gitea on web1', consequence: 'Volumes and secrets are kept.' }),
  nextActions: [{ command: 'vops app remove gitea --yes --json', description: 'Remove it once the user has approved' }],
};

describe('a refusal under --json', () => {
  it('puts one parseable envelope on stdout and nothing else', async () => {
    const { cmd, out } = fakeCommand('app:remove');
    const code = await exitCodeOf(() =>
      runAgentCommand(cmd, 'vops app remove', true, async () => refusal, () => {
        throw new Error('the human rendering must not run under --json');
      }),
    );

    const env = JSON.parse(out.join('\n'));
    expect(env.schemaVersion).toBe('1');
    expect(env.command).toBe('vops app remove');
    expect(env.status).toBe('error');
    expect(env.requiresApproval).toBe(true);
    expect(env.data).toEqual({ removed: false, purge: false, host: 'web1' });
    expect(env.errors[0].code).toBe('VOPS_APPROVAL_REQUIRED');
    expect(env.errors[0].category).toBe('approval');
    expect(env.errors[0].recoverable).toBe(false);
    expect(env.nextActions[0].command).toBe('vops app remove gitea --yes --json');
    expect(code).toBe(ExitCode.APPROVAL_REQUIRED);
  });

  it('carries the plan in data, so the agent can show what it is asking approval for', async () => {
    const { cmd, out } = fakeCommand('app:remove');
    await exitCodeOf(() => runAgentCommand(cmd, 'vops app remove', true, async () => refusal, () => undefined));
    expect(JSON.parse(out.join('\n')).data.host).toBe('web1');
  });

  it('still flags requiresApproval when the refusal is thrown rather than returned', async () => {
    const { cmd, out } = fakeCommand('app:unexpose');
    const code = await exitCodeOf(() =>
      runAgentCommand(cmd, 'vops app unexpose', true, async () => {
        throw approvalRequired({ operation: 'Detach ingress', target: 'gitea', approved: false });
      }, () => undefined),
    );

    const env = JSON.parse(out.join('\n'));
    expect(env.data).toBeNull();
    expect(env.requiresApproval).toBe(true);
    expect(env.errors[0].category).toBe('approval');
    expect(code).toBe(ExitCode.APPROVAL_REQUIRED);
  });

  it('keeps the human rendering on the human path, and still exits 5', async () => {
    const { cmd, out, errors } = fakeCommand('app:remove');
    const code = await exitCodeOf(() =>
      runAgentCommand(cmd, 'vops app remove', false, async () => refusal, () => cmd.log('Would remove gitea from web1')),
    );

    expect(out).toEqual(['Would remove gitea from web1']);
    expect(errors[0].message).toContain('has not been approved');
    expect(errors[0].suggestions?.[0]).toContain('--yes');
    expect(code).toBe(ExitCode.APPROVAL_REQUIRED);
  });

  it('exits 0 and emits no error once approval is given', async () => {
    const { cmd, out } = fakeCommand('app:remove');
    const code = await exitCodeOf(() =>
      runAgentCommand(cmd, 'vops app remove', true, async () => ({ data: { removed: true, purge: false, host: 'web1' } }), () => undefined),
    );

    const env = JSON.parse(out.join('\n'));
    expect(env.status).toBe('success');
    expect(env.errors).toEqual([]);
    expect(env.requiresApproval).toBe(false);
    expect(code).toBe(ExitCode.SUCCESS);
  });
});

describe('the shared deploy gate (app install / app deploy)', () => {
  const plan = { app: 'gitea', host: 'web1', files: {}, warnings: ['host has no swap'] } as unknown as DeployPlanView;
  const result = { app: 'gitea', host: 'web1', components: [], endpoints: [], smoke: 'ok' } as unknown as DeployResult;
  const svc = {
    deploy: async (_source: unknown, _host: string, opts: { dryRun?: boolean }) => (opts.dryRun ? plan : result),
  } as unknown as Pick<VopsAppsService, 'deploy'>;

  const flags = (over: Partial<DeployFlags> = {}): DeployFlags => ({
    host: 'web1',
    tls: true,
    staging: false,
    'expose-direct': false,
    yes: false,
    'dry-run': false,
    json: true,
    ...over,
  });

  it('refuses without --yes, with the plan as the payload and the approval category', async () => {
    const body = await deployBody(svc, { catalog: 'gitea' }, flags());
    expect(body.data).toBe(plan);
    expect(body.requiresApproval).toBe(true);
    expect(body.errors?.[0].category).toBe('approval');
    expect(body.warnings?.[0]).toEqual({ code: 'VOPS_DEPLOY_ADVISORY', message: 'host has no swap' });
    expect(body.nextActions?.[0].command).toBe('vops app install gitea --host web1 --yes --json');
  });

  it('names the manifest form of the command when the deploy came from a file', async () => {
    const body = await deployBody(svc, { file: './flui.yaml' }, flags());
    expect(body.nextActions?.[0].command).toBe('vops app deploy -f ./flui.yaml --host web1 --yes --json');
  });

  it('carries the flags the invocation was made with into the re-run', async () => {
    const body = await deployBody(svc, { file: './flui.yaml' }, flags({ image: 'ghcr.io/me/app:abc', domain: 'a.example.com', 'dry-run': true }));
    expect(body.nextActions?.[0].command).toBe(
      'vops app deploy -f ./flui.yaml --host web1 --image ghcr.io/me/app:abc --domain a.example.com --yes --json',
    );
  });

  it('deploys and reports no error once --yes is given', async () => {
    const body = await deployBody(svc, { catalog: 'gitea' }, flags({ yes: true }));
    expect(body.data).toBe(result);
    expect(body.errors).toBeUndefined();
    // --host is carried: a deploy of the same app onto a second host is exactly what makes the
    // bare-name follow-up ambiguous, and it is this deploy that creates that state.
    expect(body.nextActions?.[0].command).toBe('vops app status gitea --host web1 --json');
  });

  it('renders the plan under --dry-run --yes without deploying or refusing', async () => {
    const body = await deployBody(svc, { catalog: 'gitea' }, flags({ yes: true, 'dry-run': true }));
    expect(body.data).toBe(plan);
    expect(body.errors).toBeUndefined();
  });
});

/**
 * Wording drifts; the invariant does not. A command that refuses for want of `--yes` must
 * produce an `approval` failure — a bare `this.error(…, { exit: 1 })` is indistinguishable
 * from "it broke", and the natural response to "it broke" is a retry of a destructive command.
 */
describe('every --yes gate routes through the approval helper', () => {
  const root = path.join(__dirname, '..', 'src');
  const read = (f: string): string => fs.readFileSync(path.join(root, f), 'utf8');

  const migrated = [
    ['apps', 'deploy-flags.ts'],
    ['commands', 'app', 'remove.ts'],
    ['commands', 'app', 'expose.ts'],
    ['commands', 'app', 'unexpose.ts'],
    ['commands', 'app', 'setup.ts'],
    ['commands', 'backup', 'restore.ts'],
    ['commands', 'host', 'firewall.ts'],
    ['commands', 'servers', 'delete.ts'],
    ['commands', 'ssh-key', 'delete.ts'],
    ['commands', 'watch', 'host', 'remove.ts'],
    // These two refuse inside the service, the one place the CLI and the local API share.
    ['firewall', 'vops-firewall.service.ts'],
    ['vnet', 'vops-vnet.service.ts'],
    // The same, for the one gate standing in front of a billable machine.
    ['servers', 'vops-servers.service.ts'],
  ].map((p) => path.join(...p));

  it.each(migrated)('%s produces an approval failure, not a bare error', (file) => {
    expect({ file, gated: /approval(Required|Pending)|assertApproved/.test(read(file)) }).toEqual({ file, gated: true });
  });

  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return p.endsWith('.ts') ? [p] : [];
    });

  it('leaves no consent refusal answering with a generic exit 1', () => {
    const refusal = /(Refusing to[^\n]*|Re-run with --yes[^\n]*|without --yes[^\n]*)\{ exit: 1 \}/;
    const offenders = sources(root)
      .filter((f) => refusal.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f))
      .sort();

    expect(offenders).toEqual([]);
  });
});

/**
 * `--json` must mean one thing across the CLI, not a bespoke object on success and
 * nothing at all on failure with a generic exit 1. These pin the contract *generically*: a
 * command that advertises `--json` puts one envelope on stdout and leaves with the code
 * docs/errors.md assigns to the error it reports. A table, not one test per command, so the
 * next family that grows is covered by adding a row.
 */
describe('every --json command speaks the envelope', () => {
  const root = path.join(__dirname, '..');

  const commandsDir = path.join(root, 'src', 'commands');
  const commandFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return commandFiles(p);
      return p.endsWith('.ts') ? [p] : [];
    });

  it('leaves no command declaring its own --json flag outside the shared one', () => {
    const offenders = commandFiles(commandsDir)
      .filter((f) => /\bjson:\s*Flags\.boolean/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(commandsDir, f))
      .sort();
    expect(offenders).toEqual([]);
  });

  it('routes every --json command through the envelope helpers', () => {
    const offenders = commandFiles(commandsDir)
      .filter((f) => {
        const s = fs.readFileSync(f, 'utf8');
        return s.includes('agentJsonFlag') && !/runAgentCommand|emitEnvelope/.test(s);
      })
      .map((f) => path.relative(commandsDir, f))
      .sort();
    expect(offenders).toEqual([]);
  });
});

/**
 * The same contract observed from outside, since the defect was only visible at the process
 * boundary: stdout had to be parseable and `$?` had to be the documented code. Runs against an
 * empty throwaway profile, so nothing here reads or writes the user's real inventory, and only
 * commands that need neither network nor credentials are listed.
 */
describe('the envelope contract at the process boundary', () => {
  const root = path.join(__dirname, '..');
  const bin = path.join(root, 'bin', 'run');

  interface Case {
    argv: string[];
    exit: number;
    command: string;
    /** Error code the envelope must carry, when the case is a failure. */
    code?: string;
  }

  const cases: Case[] = [
    { argv: ['providers', 'list'], exit: 0, command: 'vops providers list' },
    { argv: ['ssh-key', 'list'], exit: 0, command: 'vops ssh-key list' },
    { argv: ['bench', 'list'], exit: 0, command: 'vops bench list' },
    { argv: ['app', 'catalog'], exit: 0, command: 'vops app catalog' },
    { argv: ['host', 'list'], exit: 0, command: 'vops host list' },
    // The control: this one already conformed and must stay that way.
    { argv: ['host', 'show', 'nonexistent-host-xyz'], exit: 2, command: 'vops host show', code: 'VOPS_HOST_NOT_FOUND' },
    { argv: ['host', 'key', 'status', 'nonexistent-host-xyz'], exit: 2, command: 'vops host key status', code: 'VOPS_HOST_NOT_FOUND' },
    { argv: ['host', 'agent', 'status', 'nonexistent-host-xyz'], exit: 2, command: 'vops host agent status', code: 'VOPS_HOST_NOT_FOUND' },
    { argv: ['watch', 'host', 'status', 'nonexistent-host-xyz'], exit: 2, command: 'vops watch host status', code: 'VOPS_HOST_NOT_FOUND' },
    // A destructive command with no --yes: an approval refusal, never a generic failure.
    { argv: ['ssh-key', 'delete', 'whatever'], exit: 5, command: 'vops ssh-key delete', code: 'VOPS_APPROVAL_REQUIRED' },
    // The same contract when the gate is inside the service rather than the command. Both
    // refuse before any provider call, so neither needs a credential or the network.
    { argv: ['firewall', 'create', '--provider', 'hetzner', '--name', 'vops-x'], exit: 5, command: 'vops firewall create', code: 'VOPS_APPROVAL_REQUIRED' },
    { argv: ['vnet', 'delete', 'net-nonexistent', '--provider', 'hetzner'], exit: 5, command: 'vops vnet delete', code: 'VOPS_APPROVAL_REQUIRED' },
  ];

  const results = new Map<string, { code: number; stdout: string }>();

  const run = (argv: string[], configDir: string): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [bin, ...argv, '--json'],
        { env: { ...process.env, VOPS_CONFIG_DIR: configDir }, encoding: 'utf8' },
        (err, stdout) => resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout }),
      );
    });

  beforeAll(async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-envelope-'));
    await Promise.all(
      cases.map(async (c) => {
        results.set(c.argv.join(' '), await run(c.argv, configDir));
      }),
    );
  }, 120_000);

  it.each(cases.map((c) => [c.argv.join(' '), c] as const))('%s --json', (key, c) => {
    const got = results.get(key);
    const env = JSON.parse(got?.stdout ?? '');
    expect({ exit: got?.code, schemaVersion: env.schemaVersion, command: env.command }).toEqual({
      exit: c.exit,
      schemaVersion: '1',
      command: c.command,
    });
    expect(Array.isArray(env.errors)).toBe(true);
    expect(Array.isArray(env.nextActions)).toBe(true);
    expect(env.status).toBe(c.code ? 'error' : 'success');
    if (c.code) expect(env.errors[0].code).toBe(c.code);
  });
});
