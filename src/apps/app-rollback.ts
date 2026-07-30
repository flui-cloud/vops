/** The failure half of a deploy: units up + smoke green, or put the host back as it was.
 * Kept off `VopsAppsService` so the service stays decision-only. */
import { BadRequestException } from '@nestjs/common';
import { AppInstallV1, AppPlan } from './app.model';
import { HostDeployPlan } from './app-plan';
import { SmokeOutcome, parseDeployOutput } from './app-parse';
import { Runner, deployTimeoutMs, gatherDiag, runSmoke } from './app-deploy-runner';
import { appUnitDir, buildDeployScript, buildRemoveScript, prereqServiceNames } from './app-scripts';
import {
  HostAppData,
  buildDataProbeScript,
  dataCreatedInRun,
  parseDataProbe,
  reusedDataNote,
} from './app-data-guard';

const PROBE_TIMEOUT = 30_000;
const REMOVE_TIMEOUT = 240_000;

/** A deploy failure that deliberately did NOT put the host back (`VOPS_APP_NO_ROLLBACK=1`):
 * the app is still there, so the ledger row it was installing under must survive with it. */
export class AppLeftRunningError extends BadRequestException {}

export interface RollbackInput {
  plan: AppPlan;
  hp: HostDeployPlan;
  prev: AppInstallV1 | null;
  generator: string;
  /** App data already on the host before this deploy — never removed by the rollback. */
  preexisting: HostAppData;
}

/** Read the host's app data BEFORE the deploy creates any: a first install that fails must
 * remove the volumes and secrets it made (or the retry silently boots on a half-provisioned
 * datadir), and must keep every one it merely found. */
export async function probeAppData(r: Runner, hp: HostDeployPlan): Promise<HostAppData> {
  const script = buildDataProbeScript(hp.volumes, hp.secrets.map((s) => s.name));
  const res = await r.ssh.runScript(r.target, script, { timeoutMs: PROBE_TIMEOUT, sudo: true });
  return parseDataProbe(res.stdout);
}

/** Units up + smoke green, or roll back. Both failures leave the host as it was. */
export async function gateOrRollback(
  r: Runner,
  input: RollbackInput,
  res: { stdout: string; stderr: string },
): Promise<SmokeOutcome> {
  const outcome = parseDeployOutput(res.stdout, input.hp.services);
  const reused = reusedDataNote(input.preexisting);
  if (!outcome.ok) {
    await rollbackDeploy(r, input);
    throw new BadRequestException(
      `Deploy failed (${outcome.error}). ${res.stderr.trim()} Rolled back.${appended(reused)}`.trim(),
    );
  }
  const smoke = await runSmoke(r, input.plan, input.hp);
  if (smoke.ok) return smoke;

  const diag = await gatherDiag(r, input.plan);
  // Escape hatch for debugging a failing deploy: leave it running to inspect.
  if (process.env.VOPS_APP_NO_ROLLBACK === '1') {
    throw new AppLeftRunningError(
      `Smoke test failed (${smoke.detail}). Left running (VOPS_APP_NO_ROLLBACK).${appended(reused)}\n${diag}`,
    );
  }
  await rollbackDeploy(r, input);
  throw new BadRequestException(`Smoke test failed (${smoke.detail}). Rolled back.${appended(reused)}\n${diag}`);
}

function appended(note: string): string {
  return note ? `\n${note}` : '';
}

async function rollbackDeploy(r: Runner, input: RollbackInput): Promise<void> {
  const { plan, hp, prev, generator } = input;
  if (prev) {
    // Redeploy failed → restore the previous units (pinned tags restore the image too).
    const restore = buildDeployScript({
      unitDir: appUnitDir(prev.name),
      units: prev.units,
      secrets: [],
      services: prev.components.map((c) => `${c.container}.service`),
      prereqServices: prereqServiceNames(prev.pod, prev.volumes),
      quadletGenerator: generator,
    });
    await r.ssh.runScript(r.target, restore, { timeoutMs: deployTimeoutMs(prev.components.length), sudo: true });
    return;
  }
  // First install failed → tear down units/containers, plus exactly the volumes and secrets
  // this run created. `purge` here is the script's switch for "delete the names I listed",
  // and the lists hold only what did not exist before the deploy: data the user retained
  // from an earlier install (a non-purging `app remove`) is never in them.
  const created = dataCreatedInRun({ volumes: hp.volumes, secrets: hp.secrets.map((s) => s.name) }, input.preexisting);
  const rm = buildRemoveScript({
    unitDir: hp.unitDir,
    services: hp.services,
    prereqServices: hp.prereqServices,
    containers: plan.components.map((c) => c.container),
    pod: hp.pod,
    secrets: created.secrets,
    volumes: created.volumes,
    purge: true,
  });
  await r.ssh.runScript(r.target, rm, { timeoutMs: REMOVE_TIMEOUT, sudo: true });
}
