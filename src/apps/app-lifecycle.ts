import { BadRequestException } from '@nestjs/common';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostConnService } from '../host-ops/vops-host-conn.service';
import { resolveSshTarget } from '../host-ops/ssh-target';
import { assertHostWritable } from '../safety/host-write-gate';
import { LocalStore } from '../lib/store/local-store';
import { resolveInstall } from './app-resolve';
import { AppEndpoint, AppInstallV1 } from './app.model';
import { VopsIngressService } from './vops-ingress.service';
import { UnitStatus, parseStatusOutput } from './app-parse';
import { accessView, flipBind, ingressHostPorts, rebindEndpoints } from './app-deploy-support';
import {
  appUnitDir,
  buildDeployScript,
  buildLogsScript,
  buildRemoveScript,
  buildRestartScript,
  buildStatusScript,
  prereqServiceNames,
} from './app-scripts';
import { ingressUrl } from './app-deploy-view';
import type { AppCredentialsView, AppPreflightResult } from './vops-apps.service';

const PREFLIGHT_TIMEOUT = 30_000;
const DEPLOY_TIMEOUT = 900_000;
const REMOVE_TIMEOUT = 240_000;
const REVEAL_TIMEOUT = 20_000;
/** Podman secret names are `vops-<app>-<comp>-<key>` — reject anything else before it hits a shell. */
const SAFE_SECRET = /^[a-zA-Z0-9._-]+$/;

/** Dependencies a lifecycle operation on an already-deployed install needs. `VopsAppsService`
 * structurally satisfies this (its constructor-injected fields + its `preflight` method), so
 * its methods delegate here by passing `this`. */
export interface AppOpsDeps {
  hosts: VopsHostsService;
  keys: VopsSshKeysService;
  conn: VopsHostConnService;
  ssh: SshExec;
  store: LocalStore;
  ingress: VopsIngressService;
  preflight(name: string): Promise<AppPreflightResult>;
}

function targetFor(deps: AppOpsDeps, hostName: string): SshTarget {
  const host = deps.hosts.show(hostName);
  return resolveSshTarget(host, deps.keys);
}

export async function getInstall(deps: AppOpsDeps, name: string, host?: string): Promise<AppInstallV1> {
  return resolveInstall(deps.store, name, host);
}

/** The resolved login block for a deployed install (URL + parts; no secret values),
 * plus the ingress basic-auth gate fronting it, if any. */
export async function credentialsView(deps: AppOpsDeps, name: string, host?: string): Promise<AppCredentialsView> {
  const install = await getInstall(deps, name, host);
  const ingress = install.ingress ? { hostname: install.ingress.hostname, tls: install.ingress.tls } : undefined;
  const access = install.access ? accessView(install.access, install.endpoints, install.primary, ingress) : undefined;
  const auth = install.ingress?.auth;
  if (!access && !auth) throw new BadRequestException(`'${name}' has no credentials block.`);
  const gate = auth ? { ...auth, url: ingressUrl(ingress) } : undefined;
  return { app: install.name, host: install.host, access, gate };
}

/** Read back ONE access-referenced secret over SSH — gated to secrets the manifest's `access`
 * block exposes (never a DB/internal secret), only on explicit user action. */
export async function revealSecret(deps: AppOpsDeps, name: string, secret: string, host?: string): Promise<{ secret: string; value: string }> {
  const install = await getInstall(deps, name, host);
  const allowed = new Set(
    [install.access?.username?.secret, install.access?.password?.secret, install.ingress?.auth?.secret].filter(Boolean),
  );
  if (!allowed.has(secret)) throw new BadRequestException(`'${secret}' is not a revealable credential of '${name}'.`);
  if (!SAFE_SECRET.test(secret)) throw new BadRequestException(`Invalid secret name.`);
  const target = targetFor(deps, install.host);
  const res = await deps.ssh.runScript(
    target,
    `podman secret inspect --showsecret --format '{{.SecretData}}' '${secret}'`,
    { timeoutMs: REVEAL_TIMEOUT, sudo: true },
  );
  const value = res.stdout.trim();
  if (!value) {
    throw new BadRequestException(`Could not read '${secret}' on '${install.host}' — needs podman ≥ 5 (\`--showsecret\`).`);
  }
  return { secret, value };
}

export async function statusView(deps: AppOpsDeps, name: string, host?: string): Promise<{ install: AppInstallV1; units: UnitStatus[]; containers: string[] }> {
  const install = await getInstall(deps, name, host);
  const target = targetFor(deps, install.host);
  const services = install.components.map((c) => `${c.container}.service`);
  const res = await deps.ssh.runScript(target, buildStatusScript(install.name, services), { timeoutMs: PREFLIGHT_TIMEOUT, sudo: true });
  return { install, ...parseStatusOutput(res.stdout) };
}

/** Restart the app's own containers (not prereq volumes/pod units) and report
 * back the same shape `statusView()` does — a quick self-recovery action, not a
 * redeploy: units/images/secrets are untouched. */
export async function restartApp(deps: AppOpsDeps, name: string, onHost?: string): Promise<{ install: AppInstallV1; units: UnitStatus[]; containers: string[] }> {
  const install = await getInstall(deps, name, onHost);
  const host = deps.hosts.show(install.host);
  assertHostWritable(host);
  const target = resolveSshTarget(host, deps.keys);
  const services = install.components.map((c) => `${c.container}.service`);
  const res = await deps.ssh.runScript(target, buildRestartScript(install.name, services), { timeoutMs: PREFLIGHT_TIMEOUT, sudo: true });
  await deps.store.appendAudit('app.restart', { app: install.name, host: install.host });
  return { install, ...parseStatusOutput(res.stdout) };
}

export async function logsView(deps: AppOpsDeps, name: string, lines = 200, host?: string): Promise<string> {
  const install = await getInstall(deps, name, host);
  const target = targetFor(deps, install.host);
  const primary = install.components.find((c) => c.name === install.primary) ?? install.components[0];
  const res = await deps.ssh.runScript(target, buildLogsScript(primary.container, lines), { timeoutMs: PREFLIGHT_TIMEOUT, sudo: true });
  return res.stdout;
}

/** Drop the local record of an install whose host is gone from inventory. vops
 * can't reach it, so nothing is torn down remotely — if that server still exists,
 * its containers must be removed by hand. */
async function forgetOrphan(deps: AppOpsDeps, install: AppInstallV1, dryRun: boolean): Promise<{ removed: boolean; purge: boolean; host: string; orphaned: boolean }> {
  if (dryRun) return { removed: false, purge: false, host: install.host, orphaned: true };
  await deps.store.deleteInstall(install.host, install.name);
  await deps.store.appendAudit('app.forget', { app: install.name, host: install.host, reason: 'host-missing' });
  return { removed: true, purge: false, host: install.host, orphaned: true };
}

export async function removeApp(
  deps: AppOpsDeps,
  name: string,
  opts: { purge?: boolean; dryRun?: boolean } = {},
  onHost?: string,
): Promise<{ removed: boolean; purge: boolean; host: string; orphaned?: boolean }> {
  const install = await getInstall(deps, name, onHost);
  const host = deps.hosts.get(install.host);
  if (!host) return forgetOrphan(deps, install, !!opts.dryRun);
  assertHostWritable(host);
  const script = buildRemoveScript({
    unitDir: appUnitDir(install.name),
    services: install.components.map((c) => `${c.container}.service`),
    prereqServices: prereqServiceNames(install.pod, install.volumes),
    containers: install.components.map((c) => c.container),
    pod: install.pod,
    secrets: install.secrets,
    volumes: install.volumes,
    purge: !!opts.purge,
  });
  if (opts.dryRun) return { removed: false, purge: !!opts.purge, host: install.host };
  if (install.ingress) await deps.ingress.cleanupForRemoval(host, install);
  const target = resolveSshTarget(host, deps.keys);
  await deps.ssh.runScript(target, script, { timeoutMs: REMOVE_TIMEOUT, sudo: true });
  await deps.store.deleteInstall(install.host, install.name);
  await deps.store.appendAudit('app.remove', { app: install.name, host: install.host, purge: !!opts.purge });
  return { removed: true, purge: !!opts.purge, host: install.host };
}

/** Detach from ingress: drop the route + A-record. A `--public` install rebinds its
 * routed port to 0.0.0.0; a default (loopback) install stays on 127.0.0.1 so detaching
 * a domain never silently re-exposes the app to the internet. */
export async function unexposeApp(deps: AppOpsDeps, name: string, onHost?: string): Promise<{ app: string; host: string; endpoints: AppEndpoint[] }> {
  const install = await getInstall(deps, name, onHost);
  const host = deps.hosts.show(install.host);
  assertHostWritable(host);
  if (!install.ingress) throw new BadRequestException(`'${name}' is not exposed via ingress.`);
  await deps.conn.assertReady(install.host);
  const target = resolveSshTarget(host, deps.keys);

  const wantsPublic = install.publish === 'public';
  const flipped = wantsPublic ? flipBind(install.units, ingressHostPorts(install.ingress)) : install.units;
  const pf = await deps.preflight(install.host);
  await deps.ssh.runScript(
    target,
    buildDeployScript({
      unitDir: appUnitDir(install.name),
      units: flipped,
      secrets: [],
      services: install.components.map((c) => `${c.container}.service`),
      prereqServices: prereqServiceNames(install.pod, install.volumes),
      quadletGenerator: pf.facts.quadletGenerator,
    }),
    { timeoutMs: DEPLOY_TIMEOUT, sudo: true },
  );
  await deps.ingress.cleanupForRemoval(host, install);

  const endpoints = rebindEndpoints(install, wantsPublic ? host.address : '127.0.0.1', wantsPublic ? 'public' : 'loopback');
  const next = { ...install, units: flipped, endpoints, updatedAt: new Date().toISOString() };
  delete next.ingress;
  await deps.store.saveInstall(next);
  await deps.store.appendAudit('app.unexpose', { app: name, host: install.host });
  return { app: name, host: install.host, endpoints };
}
