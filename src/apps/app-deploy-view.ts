import { VopsHost } from '../hosts/host.model';
import { AppInstallV1, AppPlan } from './app.model';
import { BindingResolution } from './vops-ingress.service';
import { IngressGate } from './ingress-auth';
import { HostDeployPlan, PublishIntent } from './app-plan';
import { RegistryLogin } from './app-scripts';
import { registryHostOf } from './app-source';
import { accessView } from './app-deploy-support';
import type { DeployPlanView } from './vops-apps.service';

/** Best-effort advisory: `podman secret create` never replaces an existing secret, so a `--set`
 * on a redeploy is silently ignored; suggests `--purge` to actually rotate it. */
/** First line of a step's captured output, appended to the warning that names it. */
export function detailSuffix(detail: string): string {
  const first = detail.split('\n')[0]?.trim();
  return first ? `: ${first}` : '';
}

export function secretReuseWarnings(plan: AppPlan, set: Record<string, string> | undefined, prev: AppInstallV1 | null): string[] {
  if (!prev || !set) return [];
  const secretTargets = new Set(plan.components.flatMap((c) => c.secrets.map((s) => s.target)));
  const reused = Object.keys(set).filter((k) => secretTargets.has(k));
  if (!reused.length) return [];
  return [
    `${reused.join(', ')} already exists from a prior install — the new value is ignored ` +
      '(podman never replaces a secret). Remove with `--purge` then reinstall to change it.',
  ];
}

/** Resolve the raw-port publish intent. Explicit `--public`/`--no-public` wins; otherwise inherit
 * the prior install's intent — a redeploy must never silently take a public endpoint offline. New installs default to loopback-only. */
export function resolvePublishIntent(explicit: boolean | undefined, prev: AppInstallV1 | null): { mode: PublishIntent; warning?: string } {
  if (explicit === true) return { mode: 'public' };
  if (explicit === false) return { mode: 'loopback' };
  if (prev?.publish) return { mode: prev.publish };
  if (prev && hasPublicBind(prev)) {
    return {
      mode: 'public',
      warning:
        `${prev.name} keeps its public 0.0.0.0 binding (reachable from any network the host is on, ` +
        'bypassing the host firewall). Redeploy with `--no-public` to make it local-only.',
    };
  }
  return { mode: 'loopback' };
}

/** Turn `--registry-user/--registry-token` into a `podman login` for the registry the primary
 * image lives on; without both halves the pull stays anonymous, correct for a public image. */
export function resolveRegistryLogin(plan: AppPlan, creds?: { user: string; token: string }): RegistryLogin | undefined {
  if (!creds?.user || !creds?.token) return undefined;
  const primary = plan.components.find((c) => c.name === plan.primary) ?? plan.components[0];
  const host = registryHostOf(primary?.image ?? '');
  if (!host) return undefined;
  return { host, user: creds.user, token: creds.token };
}

export function hasPublicBind(install: AppInstallV1): boolean {
  return install.components.some((c) => c.published.some((p) => p.bind === '0.0.0.0'));
}

export function ingressUrl(ingress?: { hostname: string; tls: boolean }): string | undefined {
  if (!ingress) return undefined;
  return `${ingress.tls ? 'https' : 'http'}://${ingress.hostname}`;
}

export function planView(plan: AppPlan, host: VopsHost, hp: HostDeployPlan, resolution: BindingResolution | null, gate: IngressGate | null, gateWarnings: string[]): DeployPlanView {
  const warnings = [...(plan.warnings ?? []), ...gateWarnings];
  const access = accessView(
    plan.access,
    hp.endpoints,
    plan.primary,
    resolution ? { hostname: resolution.binding.hostname, tls: resolution.binding.tls } : undefined,
  );
  return {
    dryRun: true,
    app: plan.name,
    host: host.name,
    kind: plan.kind,
    unitDir: hp.unitDir,
    files: hp.units,
    secrets: hp.secrets.map((s) => s.name),
    endpoints: hp.endpoints,
    services: hp.services,
    coexistence: hp.coexistence,
    ...(resolution
      ? { ingress: { hostname: resolution.binding.hostname, tls: resolution.binding.tls, staging: resolution.staging, warnings: resolution.warnings } }
      : {}),
    ...(access ? { access } : {}),
    ...(gate ? { gate: { user: gate.state.user } } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
