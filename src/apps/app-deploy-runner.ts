/** The SSH round-trips of a deploy that are pure "render a script → run it → parse"
 * (smoke gate, diagnostics, postInstall) — kept off `VopsAppsService` so it stays decision-only. */
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { AppPlan, SmokeTestPlan } from './app.model';
import { HostDeployPlan } from './app-plan';
import { SmokeOutcome, parseHttpSmoke, parseTcpSmoke, parsePullOutput } from './app-parse';
import { httpPrimary } from './app-deploy-support';
import {
  RegistryLogin,
  buildDiagScript,
  buildPullScript,
  buildSmokeHttpScript,
  buildSmokeTcpScript,
  pullBudgetSeconds,
} from './app-scripts';
import { START_TIMEOUT_SEC } from './quadlet-render';
import { buildPostInstallScript, parsePostInstallOutput, resolveCommand } from './post-install';

const PREFLIGHT_TIMEOUT = 30_000;
/** Slack over the pull phase's own deadline for the SSH round-trip itself. */
const PULL_SLACK = 60_000;
/** Fixed cost of a deploy round-trip (units, secrets, daemon-reload); the per-unit start budget
 * is added on top, so the script always finishes and reports WHICH unit blew its budget instead
 * of being cut off by the SSH call with nothing to say. */
const DEPLOY_BASE_TIMEOUT = 180_000;
const SMOKE_TIMEOUT = 300_000;
/** Seconds the app gets to answer for the FIRST time when the manifest asks for nothing. */
const SMOKE_WINDOW = 120;
/** Spacing between probes — also how a manifest's `retries` converts to wall clock. */
const SMOKE_SPACING = 5;
/** Ceiling on what a manifest can claim, so one bad number can't hang a deploy for an hour. */
const SMOKE_WINDOW_MAX = 600;
/** Slack over the window for the SSH round-trip itself; the script exits on its own deadline. */
const SMOKE_SLACK = 30_000;

/** A manifest may ask for a LONGER startup window, never a shorter one — a cold VPS pulling an
 * image for the first time is nothing like the cached local podman a manifest was written
 * against (`smokeTest.retries: 3` meant 15s, and rolled back apps that were merely slow).
 * Both `timeoutSeconds` (the budget, read literally) and `retries` (attempts × the probe's fixed
 * spacing — the only meaning it ever had here) land on the same wall-clock window. */
function startupWindow(st?: SmokeTestPlan): number {
  const asked = Math.max(st?.timeoutSeconds ?? 0, (st?.retries ?? 0) * SMOKE_SPACING);
  return Math.min(SMOKE_WINDOW_MAX, Math.max(SMOKE_WINDOW, asked));
}

export interface Runner {
  ssh: SshExec;
  target: SshTarget;
}

export async function runSmoke(r: Runner, plan: AppPlan, hp: HostDeployPlan): Promise<SmokeOutcome> {
  const st = plan.smokeTest;
  if (st?.type === 'skip') return { ok: true, detail: `skipped (${st.reason ?? 'no smoke test'})` };
  const published = hp.ports[plan.primary]?.[0];
  if (!published) return { ok: true, detail: 'no exposed port to probe' };

  const window = startupWindow(st);
  const timeoutMs = window * 1000 + SMOKE_SLACK;

  if (st?.type === 'http' || (!st && httpPrimary(plan))) {
    const expect = st?.expectedStatus ?? 200;
    const script = buildSmokeHttpScript(published.host, st?.path ?? '/', expect, window);
    const res = await r.ssh.runScript(r.target, script, { timeoutMs });
    return parseHttpSmoke(res.stdout, expect, published.host);
  }
  const script = buildSmokeTcpScript(published.host, window);
  const res = await r.ssh.runScript(r.target, script, { timeoutMs });
  return parseTcpSmoke(res.stdout, published.host);
}

/** How long the deploy round-trip may take: the units it starts each own a `TimeoutStartSec`,
 * and a flat budget shorter than their sum meant the transport gave up first and threw the
 * script's own diagnosis away — which is why a stuck deploy would otherwise end with no error
 * text. */
export function deployTimeoutMs(serviceCount: number): number {
  return DEPLOY_BASE_TIMEOUT + START_TIMEOUT_SEC * 1000 * Math.max(1, serviceCount);
}

/** Download every image BEFORE a single unit starts. Left to the `podman run` inside the unit,
 * the pull is charged to `TimeoutStartSec`: systemd kills the download at the budget, and
 * `Restart=always` starts it again from zero — a first install of an image-heavy app can never
 * finish. Failing here names the image instead of reporting "services not active". */
export async function pullImages(
  r: Runner,
  images: string[],
  registry?: RegistryLogin,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const script = buildPullScript({ images, ...(registry ? { registry } : {}) });
  const timeoutMs = pullBudgetSeconds(new Set(images).size) * 1000 + PULL_SLACK;
  const res = await r.ssh.runScript(r.target, script, { timeoutMs, sudo: true });
  const pull = parsePullOutput(res.stdout);
  if (!pull.ran) {
    return { ok: false, error: `Image pull did not complete on ${r.target.host.name}. ${res.stderr.trim()}`.trim() };
  }
  if (pull.failed.length) {
    return {
      ok: false,
      error: `Image pull failed: ${pull.failed.join(', ')} — check the tag exists and the host can reach the registry.`,
    };
  }
  return { ok: true };
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
