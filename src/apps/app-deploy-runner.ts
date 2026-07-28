/** The SSH round-trips of a deploy that are pure "render a script → run it → parse"
 * (smoke gate, diagnostics, postInstall) — kept off `VopsAppsService` so it stays decision-only. */
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { AppPlan } from './app.model';
import { HostDeployPlan } from './app-plan';
import { SmokeOutcome, parseHttpSmoke, parseTcpSmoke } from './app-parse';
import { httpPrimary } from './app-deploy-support';
import { buildDiagScript, buildSmokeHttpScript, buildSmokeTcpScript } from './app-scripts';
import { buildPostInstallScript, parsePostInstallOutput, resolveCommand } from './post-install';

const PREFLIGHT_TIMEOUT = 30_000;
const SMOKE_TIMEOUT = 300_000;
const SMOKE_RETRIES = 24;

export interface Runner {
  ssh: SshExec;
  target: SshTarget;
}

export async function runSmoke(r: Runner, plan: AppPlan, hp: HostDeployPlan): Promise<SmokeOutcome> {
  const st = plan.smokeTest;
  if (st?.type === 'skip') return { ok: true, detail: `skipped (${st.reason ?? 'no smoke test'})` };
  const published = hp.ports[plan.primary]?.[0];
  if (!published) return { ok: true, detail: 'no exposed port to probe' };

  if (st?.type === 'http' || (!st && httpPrimary(plan))) {
    const expect = st?.expectedStatus ?? 200;
    const script = buildSmokeHttpScript(published.host, st?.path ?? '/', expect, st?.retries ?? SMOKE_RETRIES);
    const res = await r.ssh.runScript(r.target, script, { timeoutMs: SMOKE_TIMEOUT });
    return parseHttpSmoke(res.stdout, expect);
  }
  const script = buildSmokeTcpScript(published.host, st?.retries ?? SMOKE_RETRIES);
  const res = await r.ssh.runScript(r.target, script, { timeoutMs: SMOKE_TIMEOUT });
  return parseTcpSmoke(res.stdout);
}

export async function gatherDiag(r: Runner, plan: AppPlan): Promise<string> {
  const primary = plan.components.find((c) => c.name === plan.primary) ?? plan.components[0];
  const res = await r.ssh.runScript(r.target, buildDiagScript(plan.name, primary.container), {
    timeoutMs: PREFLIGHT_TIMEOUT,
    sudo: true,
  });
  return res.stdout.trim();
}

export interface PostInstallReport {
  warnings: string[];
  /** Smoke detail from the re-check after the restart (absent when no step ran). */
  smoke?: string;
}

/** Manifest `postInstall` steps then a restart (config a step writes is only read at startup);
 * called after the route attaches so `{{install.resolvedFqdn}}` resolves. Failures are reported, not rolled back. */
export async function runPostInstall(
  r: Runner,
  plan: AppPlan,
  hp: HostDeployPlan,
  fqdn?: string,
): Promise<PostInstallReport> {
  const runs = (plan.postInstall ?? []).flatMap((step) => {
    const command = resolveCommand(step, { fqdn, name: plan.name });
    const comp = plan.components.find((c) => c.name === step.component);
    return command && comp ? [{ name: step.name, container: comp.container, command }] : [];
  });
  if (!runs.length) return { warnings: [] };

  const res = await r.ssh.runScript(r.target, buildPostInstallScript({ runs, services: hp.services }), {
    timeoutMs: SMOKE_TIMEOUT,
    sudo: true,
  });
  const out = parsePostInstallOutput(res.stdout);
  const smoke = await runSmoke(r, plan, hp);
  return {
    warnings: [
      ...out.failed.map((f) => `post-install step '${f.name}' failed${detailSuffix(f.detail)}`),
      ...out.notActive.map((s) => `${s} did not come back after the post-install restart`),
      ...(smoke.ok ? [] : [`the app did not answer after the post-install restart (${smoke.detail})`]),
    ],
    smoke: smoke.detail,
  };
}

/** First line of a step's captured output, appended to the warning that names it. */
function detailSuffix(detail: string): string {
  const first = detail.split('\n')[0]?.trim();
  return first ? `: ${first}` : '';
}
