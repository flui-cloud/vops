import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CloudProvider } from '@flui-cloud/infra';
import { LocalConfigStore } from '../src/lib/config/local-config-store';
import {
  hydrateEnvFromStore,
  clearEnvForProvider,
  isProviderConfigured,
} from '../src/lib/credentials/provider-credentials';

const TMP = path.join(os.tmpdir(), 'vops-cred-lib-test');

describe('provider-credentials lib', () => {
  let store: LocalConfigStore;

  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    process.env.VOPS_CONFIG_DIR = TMP;
    delete process.env.CHERRY_API_KEY;
    delete process.env.CHERRY_PROJECT_ID;
    store = new LocalConfigStore();
  });
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

  it('hydrates env from the store, but never overrides an existing value', () => {
    store.setCredentials(CloudProvider.CHERRY, { apiKey: 'tok', projectId: 'p1' });
    process.env.CHERRY_API_KEY = 'from-env'; // pre-set → must win
    hydrateEnvFromStore(store);
    expect(process.env.CHERRY_API_KEY).toBe('from-env');
    expect(process.env.CHERRY_PROJECT_ID).toBe('p1'); // was absent → filled
  });

  it('force applies the stored value immediately (post-save path)', () => {
    store.setCredentials(CloudProvider.CHERRY, { apiKey: 'new', projectId: 'p2' });
    process.env.CHERRY_API_KEY = 'stale';
    hydrateEnvFromStore(store, { force: true, only: CloudProvider.CHERRY });
    expect(process.env.CHERRY_API_KEY).toBe('new');
  });

  it('clears env vars for a provider', () => {
    process.env.CHERRY_API_KEY = 'x';
    process.env.CHERRY_PROJECT_ID = 'y';
    clearEnvForProvider(CloudProvider.CHERRY);
    expect(process.env.CHERRY_API_KEY).toBeUndefined();
    expect(process.env.CHERRY_PROJECT_ID).toBeUndefined();
  });

  it('reports configured from store record or env vars', () => {
    expect(isProviderConfigured(store, CloudProvider.CHERRY)).toBe(false);
    store.setCredentials(CloudProvider.CHERRY, { apiKey: 'a', projectId: 'b' });
    expect(isProviderConfigured(store, CloudProvider.CHERRY)).toBe(true);

    // env-only (no store record) also counts as configured
    const fresh = (() => {
      fs.rmSync(TMP, { recursive: true, force: true });
      return new LocalConfigStore();
    })();
    process.env.CHERRY_API_KEY = 'a';
    process.env.CHERRY_PROJECT_ID = 'b';
    expect(isProviderConfigured(fresh, CloudProvider.CHERRY)).toBe(true);
  });
});
