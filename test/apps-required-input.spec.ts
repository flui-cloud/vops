import type { CatalogAppManifest } from '@flui-cloud/spec';
import { normalizeManifest, inputRequired } from '../src/apps/spec-normalize';
import { applyOverrides, assertSecretsSatisfied, pruneUnsetOptional } from '../src/apps/app-deploy-support';
import { AppPlan } from '../src/apps/app.model';

function manifest(env: unknown[]): CatalogAppManifest {
  return {
    apiVersion: 'flui.cloud/v1beta1',
    kind: 'CatalogApp',
    metadata: {
      id: 'demo', name: 'Demo', description: 'x',
      appKind: 'APPLICATION', category: 'example', version: '1.0.0', license: 'MIT',
    },
    spec: {
      type: 'standalone',
      image: { registry: 'docker.io', repository: 'library/nginx', tag: '1.27' },
      ports: [{ name: 'http', internal: 80, expose: true, protocol: 'http' }],
      env,
      resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
      scaling: { horizontal: { enabled: false }, vertical: { enabled: false } },
      healthcheck: { type: 'http', path: '/', port: 80 },
    },
  } as unknown as CatalogAppManifest;
}

const optionalSecret = { name: 'TELEGRAM', valueFrom: { userInput: { sensitive: true, required: false } } };
const requiredSecret = { name: 'OPENROUTER', valueFrom: { userInput: { sensitive: true } } };
const requiredPlain = { name: 'SITE', valueFrom: { userInput: { required: true } } };
const groupA = { name: 'OPENAI', valueFrom: { userInput: { sensitive: true, group: 'llm' } } };
const groupB = { name: 'ANTHROPIC', valueFrom: { userInput: { sensitive: true, group: 'llm' } } };

const secretsOf = (p: AppPlan) => p.components.flatMap((c) => c.secrets);
const targets = (p: AppPlan) => secretsOf(p).map((s) => s.target);

describe('inputRequired — required decoupled from sensitive', () => {
  it('defaults to sensitive when required is absent', () => {
    expect(inputRequired({})).toBe(false);
    expect(inputRequired({ sensitive: true })).toBe(true);
  });
  it('an explicit required overrides sensitive in both directions', () => {
    expect(inputRequired({ sensitive: true, required: false })).toBe(false);
    expect(inputRequired({ required: true })).toBe(true);
  });
});

describe('pruneUnsetOptional', () => {
  it('drops an optional secret left unset', () => {
    const plan = normalizeManifest(manifest([optionalSecret, requiredSecret]), 'demo');
    expect(targets(plan)).toEqual(expect.arrayContaining(['TELEGRAM', 'OPENROUTER']));
    pruneUnsetOptional(plan);
    expect(targets(plan)).toContain('OPENROUTER');
    expect(targets(plan)).not.toContain('TELEGRAM');
  });

  it('keeps an optional secret that was provided via --set', () => {
    const plan = normalizeManifest(manifest([optionalSecret, requiredSecret]), 'demo');
    applyOverrides(plan, { TELEGRAM: 'tok', OPENROUTER: 'key' });
    pruneUnsetOptional(plan);
    expect(targets(plan)).toEqual(expect.arrayContaining(['TELEGRAM', 'OPENROUTER']));
  });
});

describe('assertSecretsSatisfied — required inputs must carry a value', () => {
  it('passes once optional-unset is pruned and required secret is set', () => {
    const plan = normalizeManifest(manifest([optionalSecret, requiredSecret]), 'demo');
    applyOverrides(plan, { OPENROUTER: 'key' });
    pruneUnsetOptional(plan);
    expect(() => assertSecretsSatisfied(plan)).not.toThrow();
  });

  it('throws when a required secret is unset', () => {
    const plan = normalizeManifest(manifest([requiredSecret]), 'demo');
    pruneUnsetOptional(plan);
    expect(() => assertSecretsSatisfied(plan)).toThrow(/Missing required inputs/);
  });

  it('throws when a required non-secret input is unset', () => {
    const plan = normalizeManifest(manifest([requiredPlain]), 'demo');
    pruneUnsetOptional(plan);
    expect(() => assertSecretsSatisfied(plan)).toThrow(/SITE/);
  });

  it('passes when a required non-secret input is provided', () => {
    const plan = normalizeManifest(manifest([requiredPlain]), 'demo');
    applyOverrides(plan, { SITE: 'my site' });
    pruneUnsetOptional(plan);
    expect(() => assertSecretsSatisfied(plan)).not.toThrow();
  });
});

describe('userInput.group — at least one of', () => {
  it('marks grouped members individually optional (not required)', () => {
    expect(inputRequired({ sensitive: true, group: 'llm' })).toBe(false);
    const plan = normalizeManifest(manifest([groupA, groupB]), 'demo');
    for (const s of secretsOf(plan).filter((x) => ['OPENAI', 'ANTHROPIC'].includes(x.target))) {
      expect(s.group).toBe('llm');
      expect(s.optional).toBe(true);
    }
  });

  it('refuses when no group member is provided', () => {
    const plan = normalizeManifest(manifest([groupA, groupB]), 'demo');
    expect(() => assertSecretsSatisfied(plan)).toThrow(/Missing required input group "llm"/);
  });

  it('lists every option in the refusal message', () => {
    const plan = normalizeManifest(manifest([groupA, groupB]), 'demo');
    expect(() => assertSecretsSatisfied(plan)).toThrow(/OPENAI.*ANTHROPIC|ANTHROPIC.*OPENAI/);
  });

  it('passes when any one member is provided, and prunes the rest', () => {
    const plan = normalizeManifest(manifest([groupA, groupB]), 'demo');
    applyOverrides(plan, { OPENAI: 'sk-x' });
    expect(() => assertSecretsSatisfied(plan)).not.toThrow();
    pruneUnsetOptional(plan);
    expect(targets(plan)).toContain('OPENAI');
    expect(targets(plan)).not.toContain('ANTHROPIC');
  });
});
