import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { CatalogAppType } from '@flui-cloud/spec';
import { loadCatalog } from '../apps/catalog';
import { DeployPlanView, DeployResult, VopsAppsService } from '../apps/vops-apps.service';
import { AppSource } from '../apps/app-source';
import { vopsVersion } from '../build/vops-build.service';
import { LocalConfigStore } from '../lib/config/local-config-store';
import { vaultKey } from '../lib/keyring/vault-session';
import { vaultExists } from '../lib/keyring/vault-store';
import { FRAMEWORK_TEMPLATES } from '../spec/template-registry';
import { specVersion } from '../spec/spec-versions';
import { assertApproved } from '../safety/approval-gate';
import { AgentFailure, ExitCode, agentError } from './agent-envelope';
import { CapabilityReport, buildCapabilities } from './agent-capabilities';
import { InitResult, initProject, updateProject } from './agent-project';
import {
  PLAN_SCHEMA_VERSION,
  PlanInputs,
  StoredPlan,
  hashFile,
  hashInputs,
  loadPlan,
  planId,
  savePlan,
} from './plan-store';
import { VerifyReport, verifyDeployment } from './deploy-verify';

/** The agent-facing orchestration layer: discovery, project state, and the plan → approve → apply
 * loop. Owns no infrastructure logic — deploying goes through `VopsAppsService` exactly as the
 * interactive CLI does, so the JSON and human paths cannot drift. */

export interface PlanRequest extends Omit<PlanInputs, 'specHash'> {
  projectDir: string;
}

export interface PlanCreated {
  id: string;
  hash: string;
  file: string;
  createdAt: string;
  plan: DeployPlanView;
}

@Injectable()
export class VopsAgentApiService {
  constructor(private readonly apps: VopsAppsService) {}

  capabilities(): CapabilityReport {
    const catalog = loadCatalog();
    const store = new LocalConfigStore();
    return buildCapabilities({
      vopsVersion: vopsVersion(),
      specVersion: specVersion(),
      products: catalog.filter((e) => e.type !== CatalogAppType.BUILDING_BLOCK).length,
      buildingBlocks: catalog.filter((e) => e.type === CatalogAppType.BUILDING_BLOCK).length,
      templates: FRAMEWORK_TEMPLATES.length,
      ...this.vaultState(store),
    });
  }

  init(projectDir: string, specFile: string): InitResult {
    return initProject(projectDir, this.projectDefaults(projectDir, specFile));
  }

  /** Render the deploy plan and persist it under its own content hash. */
  async plan(req: PlanRequest): Promise<PlanCreated> {
    const inputs: PlanInputs = { ...withoutProjectDir(req), specHash: hashFile(req.spec) };
    const view = await this.render(req);

    const hash = hashInputs(inputs, view);
    const stored: StoredPlan<DeployPlanView> = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      id: planId(hash),
      hash,
      createdAt: new Date().toISOString(),
      vopsVersion: vopsVersion(),
      inputs,
      plan: view,
    };
    const file = savePlan(req.projectDir, stored);
    this.remember(req.projectDir, req.spec);
    return { id: stored.id, hash, file, createdAt: stored.createdAt, plan: view };
  }

  /** Execute a stored plan, re-derived from its own recorded inputs and compared before anything
   * is touched — an edited manifest, image or host invalidates approval instead of silently deploying. */
  async apply(projectDir: string, id: string, approved: boolean, registry?: { user: string; token: string }): Promise<DeployResult> {
    const stored = loadPlan<DeployPlanView>(projectDir, id);
    if (!stored) {
      throw new AgentFailure(
        agentError('VOPS_PLAN_NOT_FOUND', 'input', `No plan '${id}' under ${path.join(projectDir, '.vops', 'plans')}.`, {
          suggestedAction: 'Create one with `vops deploy plan --spec flui.yaml --host <host>`.',
        }),
        ExitCode.INVALID_INPUT,
      );
    }
    assertApproved({
      operation: `Plan ${id}`,
      target: stored.inputs.host,
      approved,
      consequence: 'It deploys containers and may replace an existing app.',
      suggestedAction: 'Show the plan to the user, then re-run with --yes once they agree.',
    });

    const req: PlanRequest = { ...stored.inputs, projectDir };
    if (hashFile(stored.inputs.spec) !== stored.inputs.specHash) {
      throw stalePlan(id, `${stored.inputs.spec} changed after the plan was approved.`);
    }
    if (hashInputs(stored.inputs, await this.render(req)) !== stored.hash) {
      throw stalePlan(id, 'the host no longer produces the plan that was approved.');
    }
    return (await this.apps.deploy(this.source(req), req.host, { ...this.deployOptions(req), ...(registry ? { registry } : {}) })) as DeployResult;
  }

  async verify(app: string): Promise<VerifyReport> {
    const { install, units, containers } = await this.apps.status(app);
    return verifyDeployment(install, { units, containers });
  }

  private async render(req: PlanRequest): Promise<DeployPlanView> {
    return (await this.apps.deploy(this.source(req), req.host, { ...this.deployOptions(req), dryRun: true })) as DeployPlanView;
  }

  /** Read the credential state WITHOUT unlocking anything — discovery is read-only and must never
   * trigger a passphrase prompt (the whole premise of the progressive unlock). */
  private vaultState(store: LocalConfigStore): { vault: 'legacy' | 'locked' | 'unlocked'; configured: string[] | null } {
    if (!vaultExists(store.profileDir)) return { vault: 'legacy', configured: safeConfigured(store) };
    if (!vaultKey()) return { vault: 'locked', configured: null };
    return { vault: 'unlocked', configured: safeConfigured(store) };
  }

  private source(req: PlanRequest): AppSource {
    return { file: req.spec, ...(req.image ? { image: req.image } : {}) };
  }

  private deployOptions(req: PlanRequest) {
    const auth = req.auth ? { auth: { mode: req.auth as 'basic' | 'none' } } : {};
    const ingress = req.domain
      ? { domain: req.domain, tls: req.tls ?? true, staging: req.staging ?? false, ...auth }
      : undefined;
    return {
      ...(req.name ? { name: req.name } : {}),
      ...(req.set ? { set: req.set } : {}),
      ...(ingress ? { ingress } : {}),
      ...(req.public === undefined ? {} : { public: req.public }),
    };
  }

  private remember(projectDir: string, spec: string): void {
    updateProject(projectDir, { spec }, this.projectDefaults(projectDir, spec));
  }

  private projectDefaults(projectDir: string, spec: string) {
    return {
      name: path.basename(path.resolve(projectDir)),
      spec,
      vopsVersion: vopsVersion(),
      now: new Date().toISOString(),
    };
  }
}

function stalePlan(id: string, why: string): AgentFailure {
  return new AgentFailure(
    agentError('VOPS_PLAN_STALE', 'validation', `Plan ${id} no longer matches reality: ${why}`, {
      suggestedAction: 'Re-run `vops deploy plan`, show the new plan to the user, and get approval again.',
    }),
    ExitCode.VALIDATION,
  );
}

function withoutProjectDir(req: PlanRequest): Omit<PlanInputs, 'specHash'> {
  const { projectDir: _ignored, ...rest } = req;
  return rest;
}

/** A legacy (unsealed) profile lists fine; a sealed one throws until unlocked. */
function safeConfigured(store: LocalConfigStore): string[] | null {
  try {
    return store.listConfigured();
  } catch {
    return null;
  }
}

/** Re-exported so the local API and commands do not reach into agent-project. */
export { readProject } from './agent-project';
