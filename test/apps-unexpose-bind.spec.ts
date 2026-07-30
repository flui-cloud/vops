// chalk 5 is ESM and the command module imports it for its human rendering, which these cases
// never reach — they read its help text and its refusal.
jest.mock('chalk', () => new Proxy({}, { get: () => (s: string) => s }));

import { unexposeApp } from '../src/apps/app-lifecycle';
import type { AppOpsDeps } from '../src/apps/app-lifecycle';
import type { AppInstallV1 } from '../src/apps/app.model';
import AppUnexpose from '../src/commands/app/unexpose';

/**
 * `app unexpose` said in three places that it rebinds the port to `0.0.0.0`. It does
 * that only for a `--public` install; a default install stays on `127.0.0.1` so detaching a domain
 * never silently publishes the app. The code was right and the prose was wrong, in the dangerous
 * direction — a user believing it either looks for a port that is not listening, or avoids a safe
 * command. These pin the behaviour and the three strings that describe it to each other.
 */

const UNIT = 'vops-it-tools-app.container';

const install = (publish?: 'loopback' | 'public'): AppInstallV1 =>
  ({
    name: 'it-tools',
    appId: 'it-tools',
    host: 'web1',
    primary: 'app',
    components: [{ name: 'app', container: 'vops-it-tools-app', image: 'x', published: [] }],
    units: { [UNIT]: '[Container]\nPublishPort=127.0.0.1:20000:80\n' },
    secrets: [],
    volumes: [],
    endpoints: [{ component: 'app', port: 20000, url: 'https://tools.example.com', reach: 'ingress' }],
    ingress: { hostname: 'tools.example.com', tls: true, hostPort: 20000 },
    publish,
    status: 'deployed',
  }) as unknown as AppInstallV1;

function harness(inst: AppInstallV1) {
  const scripts: string[] = [];
  const saved: AppInstallV1[] = [];
  const deps = {
    hosts: { show: () => ({ name: 'web1', address: '203.0.113.7' }) },
    keys: { keyPathFor: () => '/tmp/nonexistent-key' },
    conn: { assertReady: async () => {} },
    ssh: {
      runScript: async (_t: unknown, script: string) => {
        scripts.push(script);
        return { stdout: '', stderr: '', code: 0 };
      },
    },
    store: {
      findInstalls: async () => [inst],
      saveInstall: async (i: AppInstallV1) => saved.push(i),
      appendAudit: async () => {},
    },
    ingress: { cleanupForRemoval: async () => {} },
    preflight: async () => ({ facts: { quadletGenerator: '/usr/libexec/podman/quadlet' } }),
  } as unknown as AppOpsDeps;
  return { deps, scripts, saved };
}

describe('what unexpose actually rebinds', () => {
  it('leaves a default install on 127.0.0.1 and reports it as loopback', async () => {
    const { deps, scripts, saved } = harness(install());
    const res = await unexposeApp(deps, 'it-tools');

    expect(res.endpoints).toEqual([{ component: 'app', port: 20000, url: 'http://127.0.0.1:20000', reach: 'loopback' }]);
    expect(saved[0].units[UNIT]).toContain('PublishPort=127.0.0.1:20000:80');
    expect(scripts.join('\n')).not.toContain('PublishPort=0.0.0.0:20000:80');
  });

  it('puts a --public install back on 0.0.0.0 and reports the host address', async () => {
    const { deps, scripts, saved } = harness(install('public'));
    const res = await unexposeApp(deps, 'it-tools');

    expect(res.endpoints).toEqual([{ component: 'app', port: 20000, url: 'http://203.0.113.7:20000', reach: 'public' }]);
    expect(saved[0].units[UNIT]).toContain('PublishPort=0.0.0.0:20000:80');
    expect(scripts.join('\n')).toContain('PublishPort=0.0.0.0:20000:80');
  });
});

describe('what unexpose says it rebinds', () => {
  const refusalMessage = async (): Promise<string> => {
    const cmd = new AppUnexpose(['it-tools'], { runHook: async () => ({}) } as never);
    const messages: string[] = [];
    Object.assign(cmd, {
      log: () => {},
      error: (m: string): never => {
        messages.push(String(m));
        throw new Error('exit');
      },
    });
    await cmd.run().catch(() => {});
    return messages.join('\n');
  };

  const prose = async (): Promise<Array<[string, string]>> => [
    ['description', AppUnexpose.description],
    ['--yes', String(AppUnexpose.flags.yes.description)],
    ['refusal', await refusalMessage()],
  ];

  it('never promises 0.0.0.0 without saying that only --public gets it', async () => {
    for (const [where, text] of await prose()) {
      expect({ where, unqualified: text.includes('0.0.0.0') && !text.includes('--public') }).toEqual({ where, unqualified: false });
    }
  });

  it('names the loopback bind a default install actually keeps', async () => {
    for (const [where, text] of await prose()) {
      expect({ where, honest: text.includes('127.0.0.1') }).toEqual({ where, honest: true });
    }
  });
});
