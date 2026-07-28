import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExitCode, agentError, envelope, exitCodeFor } from '../src/agent-api/agent-envelope';
import { buildCapabilities } from '../src/agent-api/agent-capabilities';
import { findWorkflow } from '../src/agent-api/agent-workflow';
import { initProject, readProject, updateProject } from '../src/agent-api/agent-project';
import { hashInputs, listPlans, loadPlan, planId, savePlan, stableStringify } from '../src/agent-api/plan-store';
import { toSpecErrors, toSpecWarnings } from '../src/spec/spec-errors';
import { renderWorkflow, imageName, imageTagForSha, parseRepoSlug, MANAGED_MARKER } from '../src/build/github-workflow';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vops-agent-'));
}

describe('agent envelope', () => {
  it('reports error status as soon as one error is present', () => {
    const ok = envelope('vops spec validate', { valid: true });
    expect(ok.status).toBe('success');

    const bad = envelope('vops spec validate', null, { errors: [agentError('X', 'validation', 'nope')] });
    expect(bad.status).toBe('error');
    expect(bad.schemaVersion).toBe('1');
  });

  it('maps a category to the exit code an agent branches on', () => {
    expect(exitCodeFor('validation')).toBe(ExitCode.VALIDATION);
    expect(exitCodeFor('approval')).toBe(ExitCode.APPROVAL_REQUIRED);
    expect(exitCodeFor('auth')).toBe(ExitCode.AUTH);
    expect(exitCodeFor('operational')).toBe(ExitCode.FAILURE);
  });

  it('defaults recoverable by category and always links documentation', () => {
    expect(agentError('A', 'validation', 'm').recoverable).toBe(true);
    expect(agentError('B', 'auth', 'm').recoverable).toBe(false);
    expect(agentError('C', 'auth', 'm').documentation).toMatch(/errors\.md#c$/);
  });
});

describe('capabilities', () => {
  const probe = {
    vopsVersion: '0.1.1',
    specVersion: '0.8.1',
    products: 59,
    buildingBlocks: 7,
    templates: 13,
    vault: 'locked' as const,
    configured: null,
  };

  it('reports what is implemented, separately from what is configured', () => {
    const r = buildCapabilities(probe);
    expect(r.capabilities.specValidation).toBe(true);
    expect(r.capabilities.previewDeployment).toBe(false);
    expect(r.credentials).toEqual({ vault: 'locked', configured: null });
    expect(r.catalog).toEqual({ products: 59, buildingBlocks: 7, frameworkTemplates: 13 });
  });

  it('turns an empty catalog off rather than claiming it', () => {
    const r = buildCapabilities({ ...probe, products: 0, buildingBlocks: 0 });
    expect(r.capabilities.catalog).toBe(false);
    expect(r.capabilities.buildingBlocks).toBe(false);
  });
});

describe('workflow map', () => {
  it('keeps repository analysis and template choice with the agent', () => {
    const w = findWorkflow('custom-app')!;
    expect(w.stages.find((s) => s.id === 'analyse')!.owner).toBe('agent');
    expect(w.stages.find((s) => s.id === 'analyse')!.commands).toEqual([]);
    expect(w.stages.find((s) => s.id === 'template')!.owner).toBe('agent');
  });

  it('marks every persistent stage as needing approval', () => {
    const w = findWorkflow('custom-app')!;
    for (const id of ['host', 'apply', 'harden']) {
      expect(w.stages.find((s) => s.id === id)!.approval).toBe('C');
    }
  });

  it('returns null for an unknown workflow', () => {
    expect(findWorkflow('nope')).toBeNull();
  });
});

describe('project directory', () => {
  it('creates .vops once and is idempotent afterwards', () => {
    const dir = tmpdir();
    const defaults = { name: 'demo', spec: 'flui.yaml', vopsVersion: '0.1.1', now: '2026-07-26T00:00:00.000Z' };

    const first = initProject(dir, defaults);
    expect(first.created).toContain(path.join('.vops', 'project.json'));
    expect(fs.existsSync(path.join(dir, '.vops', 'plans'))).toBe(true);

    const second = initProject(dir, defaults);
    expect(second.created).toEqual([]);
    expect(second.project.createdAt).toBe(defaults.now);
  });

  it('keeps plans and reports out of git', () => {
    const dir = tmpdir();
    initProject(dir, { name: 'demo', spec: 'flui.yaml', vopsVersion: '0.1.1', now: 'x' });
    const ignore = fs.readFileSync(path.join(dir, '.vops', '.gitignore'), 'utf8');
    const rules = ignore.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    expect(rules).toEqual(['plans/', 'reports/', 'cache/']);
  });

  it('merges a patch without losing what was already recorded', () => {
    const dir = tmpdir();
    const defaults = { name: 'demo', spec: 'flui.yaml', vopsVersion: '0.1.1', now: 'x' };
    initProject(dir, defaults);
    updateProject(dir, { repo: { owner: 'me', repo: 'app', branch: 'main' } }, defaults);
    updateProject(dir, { spec: 'deploy/flui.yaml' }, defaults);

    const project = readProject(dir)!;
    expect(project.repo).toEqual({ owner: 'me', repo: 'app', branch: 'main' });
    expect(project.spec).toBe('deploy/flui.yaml');
  });
});

describe('plan store', () => {
  const inputs = { spec: 'flui.yaml', specHash: 'abc', host: 'web1', image: 'ghcr.io/me/app:1' };

  it('hashes over content, so identical plans share an id and a changed one does not', () => {
    const a = hashInputs(inputs, { app: 'x' });
    const b = hashInputs({ ...inputs }, { app: 'x' });
    const c = hashInputs({ ...inputs, host: 'web2' }, { app: 'x' });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(planId(a)).toHaveLength(12);
  });

  it('is insensitive to key order but not to values', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('round-trips a stored plan and lists it', () => {
    const dir = tmpdir();
    initProject(dir, { name: 'demo', spec: 'flui.yaml', vopsVersion: '0.1.1', now: 'x' });
    const hash = hashInputs(inputs, { app: 'demo' });
    const stored = {
      schemaVersion: 1 as const,
      id: planId(hash),
      hash,
      createdAt: '2026-07-26T00:00:00.000Z',
      vopsVersion: '0.1.1',
      inputs,
      plan: { app: 'demo' },
    };
    savePlan(dir, stored);

    expect(loadPlan(dir, stored.id)).toEqual(stored);
    expect(listPlans(dir).map((p) => p.id)).toEqual([stored.id]);
    expect(loadPlan(dir, planId(hashInputs(inputs, { app: 'other' })))).toBeNull();
  });

  it('never stores a registry token — credentials are not part of a plan', () => {
    expect(Object.keys(inputs)).not.toContain('registry');
    expect(stableStringify(inputs)).not.toMatch(/token/i);
  });

  it('rejects a plan id that is not a hash', () => {
    expect(() => loadPlan(tmpdir(), '../../etc/passwd')).toThrow(/Invalid plan id/);
  });
});

describe('spec error mapping', () => {
  it('gives a missing field its own code and points at the field itself', () => {
    const [e] = toSpecErrors([
      { path: '/deploy/port', message: "must have required property 'port'", params: { missingProperty: 'port' } },
    ]);
    expect(e.code).toBe('VOPS_SPEC_MISSING_FIELD');
    expect(e.path).toBe('/deploy/port');
    expect(e.recoverable).toBe(true);
    expect(e.suggestedAction).toMatch(/vops spec schema/);
  });

  it('separates an unknown field from a wrong value', () => {
    expect(toSpecErrors([{ path: '/deploy', message: 'must NOT have additional properties' }])[0].code).toBe('VOPS_SPEC_UNKNOWN_FIELD');
    expect(toSpecErrors([{ path: '/deploy/exposure', message: 'must be equal to one of the allowed values' }])[0].code).toBe('VOPS_SPEC_INVALID_VALUE');
    expect(toSpecErrors([{ path: '/kind', message: 'unsupported kind' }])[0].code).toBe('VOPS_SPEC_UNSUPPORTED_KIND');
  });

  it('re-labels a hosted-runtime advisory that vops does honour on a host', () => {
    const [applied] = toSpecWarnings([{ path: '/deploy/env/API_KEY/valueFrom', message: 'not applied on source deploys' }]);
    expect(applied.code).toBe('VOPS_SPEC_APPLIED_LOCALLY');
    expect(applied.message).toMatch(/vops applies this on a single host/);

    const [planned] = toSpecWarnings([{ path: '/deploy/scaling', message: 'not applied' }]);
    expect(planned.code).toBe('VOPS_SPEC_PLANNED_FIELD');
  });
});

describe('github build workflow', () => {
  const params = { owner: 'Flui-Cloud', repo: 'My-App', branch: 'main', dockerfile: './Dockerfile', context: '.' };

  it('lowercases the image path, because GHCR rejects uppercase', () => {
    expect(imageName('Flui-Cloud', 'My-App')).toBe('ghcr.io/flui-cloud/my-app');
    expect(renderWorkflow(params)).toContain('IMAGE_NAME: ghcr.io/flui-cloud/my-app');
  });

  it('tags with the short sha the deploy will reference', () => {
    expect(imageTagForSha('abcdef1234567890')).toBe('abcdef1');
    expect(renderWorkflow(params)).toContain('type=sha,prefix=,format=short');
  });

  it('is marked as vops-managed so setup never clobbers a hand-written workflow', () => {
    expect(renderWorkflow(params).startsWith(MANAGED_MARKER)).toBe(true);
  });

  it('asks for no more permission than pushing a package needs', () => {
    const yaml = renderWorkflow(params);
    expect(yaml).toContain('contents: read');
    expect(yaml).toContain('packages: write');
    expect(yaml).not.toContain('contents: write');
  });

  it('passes build args through when the manifest declares them', () => {
    const yaml = renderWorkflow({ ...params, buildArgs: { NEXT_PUBLIC_API: 'https://api.example.com' } });
    expect(yaml).toContain('build-args: |');
    expect(yaml).toContain('NEXT_PUBLIC_API=https://api.example.com');
    expect(renderWorkflow(params)).not.toContain('build-args');
  });

  it('reads owner/repo out of any remote form', () => {
    expect(parseRepoSlug('git@github.com:me/app.git')).toEqual({ owner: 'me', repo: 'app' });
    expect(parseRepoSlug('https://github.com/me/app')).toEqual({ owner: 'me', repo: 'app' });
    expect(parseRepoSlug('https://github.com/me/app.git')).toEqual({ owner: 'me', repo: 'app' });
    expect(parseRepoSlug('https://gitlab.com/me/app.git')).toBeNull();
  });
});
