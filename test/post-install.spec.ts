import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml } from '@flui-cloud/spec';
import type { CatalogAppManifest, CatalogPostInstallStep } from '@flui-cloud/spec';
import {
  buildPostInstallScript,
  effectiveAuthMode,
  parsePostInstallOutput,
  resolveCommand,
  selectPostInstall,
} from '../src/apps/post-install';
import { normalizeManifest } from '../src/apps/spec-normalize';

const step = (over: Partial<CatalogPostInstallStep>): CatalogPostInstallStep =>
  ({ name: 'x', exec: { command: ['/bin/sh', '-c', 'true'] }, ...over }) as CatalogPostInstallStep;

describe('which postInstall steps vops runs', () => {
  it('runs an ungated exec step', () => {
    const out = selectPostInstall([step({ name: 'configure' })], { primary: 'app' });
    expect(out).toEqual([
      { name: 'configure', component: 'app', command: ['/bin/sh', '-c', 'true'], needsFqdn: false },
    ]);
  });

  it('targets the primary component unless the step names another', () => {
    const steps = [step({ name: 'a' }), step({ name: 'b', exec: { command: ['true'], container: 'db' } })];
    expect(selectPostInstall(steps, { primary: 'web' }).map((s) => s.component)).toEqual(['web', 'db']);
  });

  it('skips a step gated on an auth mode vops never deploys', () => {
    // vops runs no identity provider, so an oidc-only step must not fire — it would
    // configure the app against a provider that does not exist.
    const steps = [
      step({ name: 'proxy', when: { authMode: ['native', 'oidc'] } }),
      step({ name: 'oidc', when: { authMode: 'oidc' } }),
    ];
    const out = selectPostInstall(steps, { primary: 'app', auth: { default: 'native', modes: ['native', 'oidc'] } });
    expect(out.map((s) => s.name)).toEqual(['proxy']);
  });

  it('falls back to the app login when the manifest defaults to oidc but offers native', () => {
    expect(effectiveAuthMode({ default: 'oidc', modes: ['native', 'oidc'] })).toBe('native');
    expect(effectiveAuthMode({ mode: 'native' })).toBe('native');
    expect(effectiveAuthMode(undefined)).toBe('none');
  });

  it('runs an option-gated step only when that option defaults on', () => {
    const steps = [step({ name: 'office', when: { option: 'office' } })];
    const ctx = { primary: 'app' };
    expect(selectPostInstall(steps, { ...ctx, options: [{ key: 'office', label: 'o', default: false }] })).toHaveLength(0);
    expect(selectPostInstall(steps, { ...ctx, options: [{ key: 'office', label: 'o', default: true }] })).toHaveLength(1);
  });

  it('ignores a step vops cannot execute', () => {
    const http = { name: 'bootstrap', http: { method: 'POST', path: '/x' } } as unknown as CatalogPostInstallStep;
    expect(selectPostInstall([http], { primary: 'app' })).toHaveLength(0);
  });
});

describe('resolving a step onto this install', () => {
  const fqdnStep = selectPostInstall(
    [step({ exec: { command: ['occ', '--value={{install.resolvedFqdn}}'] } })],
    { primary: 'app' },
  )[0];

  it('substitutes the published hostname', () => {
    expect(resolveCommand(fqdnStep, { fqdn: 'app.example.com', name: 'app' })).toEqual([
      'occ',
      '--value=app.example.com',
    ]);
  });

  it('refuses to run a hostname-dependent step with no hostname', () => {
    // Better not to run than to configure the app with an empty domain.
    expect(resolveCommand(fqdnStep, { name: 'app' })).toBeNull();
  });
});

describe('the script and its output', () => {
  const script = buildPostInstallScript({
    runs: [{ name: 'trust-proxy', container: 'vops-ha-app', command: ['/bin/sh', '-c', "echo 'hi'"] }],
    services: ['vops-ha-app.service'],
  });

  it('quotes every argument and never echoes the command', () => {
    expect(script).toContain(`podman exec 'vops-ha-app' '/bin/sh' '-c' 'echo '\\''hi'\\'''`);
    expect(script).not.toContain('set -x');
  });

  it('restarts the app, since a config file is only read at startup', () => {
    expect(script).toContain("systemctl restart 'vops-ha-app.service'");
  });

  it('reads back a clean run', () => {
    const out = parsePostInstallOutput(
      ['@@steps', 'trust-proxy=0', '@@restart', 'vops-ha-app.service=active', '@@diag', '@@done'].join('\n'),
    );
    expect(out).toEqual({ failed: [], notActive: [] });
  });

  it('reports a failed step with its output, and a service that stayed down', () => {
    const out = parsePostInstallOutput(
      [
        '@@steps',
        'trust-proxy=1',
        '@@restart',
        'vops-ha-app.service=failed',
        '@@diag',
        '### trust-proxy',
        'sh: /config/configuration.yaml: not found',
        '@@done',
      ].join('\n'),
    );
    expect(out.failed).toEqual([
      { name: 'trust-proxy', detail: 'sh: /config/configuration.yaml: not found' },
    ]);
    expect(out.notActive).toEqual(['vops-ha-app.service']);
  });

  it('does not mistake a step output line for a step result', () => {
    // The diagnostics live in their own section precisely so `key=value` in an
    // app's stderr cannot be read back as "a step named key exited value".
    const out = parsePostInstallOutput(
      ['@@steps', 'a=0', '@@restart', 's=active', '@@diag', '### a', 'count=3', '@@done'].join('\n'),
    );
    expect(out.failed).toEqual([]);
  });
});

describe('the Home Assistant manifest', () => {
  // HA answers 400 to every proxied request until configuration.yaml says a proxy
  // is in front — and the http integration reads no environment variable, so this
  // step is the only thing standing between a deploy and a broken URL.
  const manifest = parseYaml(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'catalog', 'home-assistant.flui.yaml'), 'utf8'),
  ) as CatalogAppManifest;
  const plan = normalizeManifest(manifest, 'home-assistant');

  it('carries a step that trusts the reverse proxy', () => {
    expect(plan.postInstall?.map((s) => s.name)).toEqual(['trust-reverse-proxy']);
  });

  it('never creates configuration.yaml, and appends only once', () => {
    const cmd = plan.postInstall?.[0].command.join(' ') ?? '';
    // Creating the file would leave HA without `default_config:` — no onboarding.
    expect(cmd).toContain('test -f /config/configuration.yaml');
    expect(cmd).toContain('grep -q use_x_forwarded_for');
    expect(cmd).toContain('use_x_forwarded_for: true');
    expect(cmd).toContain('trusted_proxies');
  });

  it('needs no hostname, so it runs whether or not the app is exposed', () => {
    expect(plan.postInstall?.[0].needsFqdn).toBe(false);
  });
});
