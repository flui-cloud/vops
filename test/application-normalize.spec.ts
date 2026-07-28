import type { ApplicationManifest } from '@flui-cloud/spec';
import { normalizeApplication } from '../src/apps/application-normalize';
import { NormalizeError } from '../src/apps/spec-normalize';
import { registryHostOf } from '../src/apps/app-source';

const base = (deploy: Partial<ApplicationManifest['deploy']> = {}): ApplicationManifest => ({
  kind: 'Application',
  apiVersion: 'flui.cloud/v1beta1',
  metadata: { name: 'my-api' },
  build: { strategy: 'dockerfile', dockerfile: './Dockerfile' },
  deploy: { port: 3000, ...deploy } as ApplicationManifest['deploy'],
});

const IMAGE = 'ghcr.io/me/my-api:abc1234';

describe('normalizeApplication', () => {
  it('projects one manifest onto one container, with the image supplied at deploy time', () => {
    const { plan } = normalizeApplication(base({ healthcheck: { path: '/health' } }), { image: IMAGE });
    expect(plan.kind).toBe('application');
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]).toMatchObject({
      name: 'app',
      container: 'vops-my-api-app',
      image: IMAGE,
      ports: [{ name: 'http', container: 3000, expose: true, protocol: 'http' }],
      health: { type: 'http', path: '/health', port: 3000 },
    });
    expect(plan.primary).toBe('app');
  });

  it('refuses to normalize without an image — vops never builds', () => {
    expect(() => normalizeApplication(base(), { image: '' })).toThrow(NormalizeError);
    expect(() => normalizeApplication(base(), { image: '  ' })).toThrow(/vops build run/);
  });

  it('smoke-tests the health path, or falls back to the port', () => {
    const withHealth = normalizeApplication(base({ healthcheck: { path: '/ready' } }), { image: IMAGE }).plan;
    expect(withHealth.smokeTest).toMatchObject({ type: 'http', path: '/ready', expectedStatus: 200 });

    const without = normalizeApplication(base(), { image: IMAGE }).plan;
    expect(without.smokeTest).toMatchObject({ type: 'tcp', port: 3000 });
  });

  it('splits env into plain values and Podman secrets', () => {
    const { plan } = normalizeApplication(
      base({
        env: {
          NODE_ENV: 'production',
          SESSION_SECRET: { valueFrom: { generate: 'secret', length: 48, format: 'hex' } },
          API_KEY: { valueFrom: { secretRef: 'api-key' } },
          DB_PASSWORD: { valueFrom: { userInput: { sensitive: true } } },
          REGION: { valueFrom: { userInput: { default: 'eu' } } },
        },
      }),
      { image: IMAGE },
    );
    const c = plan.components[0];
    expect(c.env).toEqual([
      { name: 'NODE_ENV', value: 'production' },
      { name: 'REGION', value: 'eu' },
    ]);
    expect(c.secrets.map((s) => [s.name, s.target])).toEqual([
      ['vops-my-api-app-session-secret', 'SESSION_SECRET'],
      ['vops-my-api-app-api-key', 'API_KEY'],
      ['vops-my-api-app-db-password', 'DB_PASSWORD'],
    ]);
    expect(c.secrets[0].generate).toEqual({ length: 48, format: 'hex' });
  });

  it('accepts the deprecated array form of env', () => {
    const { plan } = normalizeApplication(base({ env: [{ name: 'PORT', value: '3000' }] }), { image: IMAGE });
    expect(plan.components[0].env).toEqual([{ name: 'PORT', value: '3000' }]);
  });

  it('reports what a single host cannot honour instead of dropping it silently', () => {
    const manifest = base({
      scaling: { min: 1, max: 5 },
      resources: { profile: 'medium', requests: { cpu: '500m' } },
      env: { BUILD_ONLY: { value: 'x', delivery: 'build' }, EMPTY: {} },
    });
    manifest.environments = { staging: { branch: 'develop' } };
    const { plan, warnings } = normalizeApplication(manifest, { image: IMAGE });

    expect(warnings.join('\n')).toMatch(/deploy\.scaling is not applied/);
    expect(warnings.join('\n')).toMatch(/environments\{\} is not applied/);
    expect(warnings.join('\n')).toMatch(/resources\.profile: medium is not applied/);
    expect(warnings.join('\n')).toMatch(/BUILD_ONLY is delivery: build/);
    expect(warnings.join('\n')).toMatch(/EMPTY declares neither value nor valueFrom/);
    expect(plan.warnings).toEqual(warnings);
    expect(plan.components[0].env).toEqual([]);
  });

  it('turns resources.limits into Podman limits', () => {
    const { plan } = normalizeApplication(
      base({ resources: { limits: { cpu: '500m', memory: '512Mi' } } }),
      { image: IMAGE },
    );
    expect(plan.components[0]).toMatchObject({ cpu: '0.5', memory: '512m' });
  });

  it('refuses a cross-service reference it cannot resolve on one host', () => {
    expect(() =>
      normalizeApplication(base({ env: { DB: { valueFrom: { service: 'postgres' } } } }), { image: IMAGE }),
    ).toThrow(/valueFrom\.service/);
  });

  it('keeps {{app.domain}} for the ingress to resolve at deploy time', () => {
    const { plan } = normalizeApplication(base({ env: { PUBLIC_URL: 'https://{{app.domain}}' } }), { image: IMAGE });
    expect(plan.needsAppDomain).toBe(true);
  });

  it('marks an internal app as not exposed', () => {
    const { plan } = normalizeApplication(base({ exposure: 'internal' }), { image: IMAGE });
    expect(plan.components[0].ports[0].expose).toBe(false);
  });
});

describe('registryHostOf', () => {
  it('recognises a registry host, and only a host', () => {
    expect(registryHostOf('ghcr.io/me/app:tag')).toBe('ghcr.io');
    expect(registryHostOf('registry.example.com:5000/app')).toBe('registry.example.com:5000');
    expect(registryHostOf('localhost/app')).toBe('localhost');
    expect(registryHostOf('library/nginx:1.27')).toBeNull();
    expect(registryHostOf('nginx')).toBeNull();
  });
});
