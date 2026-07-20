import * as fs from 'node:fs';
import { CloudProvider } from '@flui-cloud/infra';
import { VopsPlanFile } from '../dto/plan-file.dto';

const DEFAULT_IMAGE: Record<string, string> = {
  [CloudProvider.HETZNER]: 'ubuntu-24.04',
  [CloudProvider.SCALEWAY]: 'ubuntu_noble',
  [CloudProvider.OVH]: 'Ubuntu 24.04',
  // Cherry image slugs are per-plan and must be listed from the API — no safe
  // cross-plan default. Supply one via `--image` or the CHERRY_IMAGE env var.
  [CloudProvider.CHERRY]: '',
};

export function defaultImage(provider: CloudProvider): string {
  return DEFAULT_IMAGE[provider] ?? 'ubuntu-24.04';
}

export function writePlanFile(path: string, plan: VopsPlanFile): void {
  fs.writeFileSync(path, JSON.stringify(plan, null, 2));
}

export function readPlanFile(path: string): VopsPlanFile {
  const plan = JSON.parse(fs.readFileSync(path, 'utf8')) as VopsPlanFile;
  if (plan.version !== 'vops.plan.v1') {
    throw new Error(
      `Unsupported plan version '${plan.version}' (expected vops.plan.v1).`,
    );
  }
  return plan;
}
