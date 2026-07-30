import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SshExec } from '../lib/ssh-exec';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostConnService } from '../host-ops/vops-host-conn.service';
import { resolveSshTarget } from '../host-ops/ssh-target';
import { assertHostWritable } from '../safety/host-write-gate';
import { LocalStore } from '../lib/store/local-store';
import { splitSections } from '../host-ops/status-battery';
import { VopsHost } from '../hosts/host.model';
import { PODMAN_STATIC_VERSION, podmanStaticForArch, renderPodmanInstall } from './podman-bootstrap';
import { AppEndpoint, AppIngressAuthState, AppInstallSummary, AppInstallV1, AppPlan } from './app.model';
import { BindingOptions, BindingResolution, VopsIngressService } from './vops-ingress.service';
import { IngressAuthIntent, IngressGate, resolveDeployGate } from './ingress-auth';
import { EnsuredRecord } from './ingress-dns';
import { getCatalogEntry } from './catalog';
import { AppSource, AppSourceError, loadAppPlan } from './app-source';
import { refreshAccessValues } from './spec-normalize';
import { PortReservations, planHostDeploy } from './app-plan';
import { deployTimeoutMs, pullImages, runPostInstall } from './app-deploy-runner';
import { gateOrRollback, probeAppData } from './app-rollback';
import { beginInstall, redeployBaseline, withLedgerRevert } from './install-ledger';
import { UNPROBED_DATA } from './app-data-guard';
import { HostFacts, UnitStatus, parsePreflight } from './app-parse';
import {
  AppAccessView,
  accessView,
  applyIngressScheme,
  applyOverrides,
  assertSecretsSatisfied,
  pruneUnsetOptional,
  readiness,
  toInstall,
  toMaterial,
} from './app-deploy-support';
import { buildDeployScript, buildPreflightScript } from './app-scripts';
import { secretReuseWarnings, internalExposureWarnings, resolvePublishIntent, resolveRegistryLogin, planView } from './app-deploy-view';
import {
  AppOpsDeps,
  getInstall,
  credentialsView,
  revealSecret,
  statusView,
  restartApp,
  logsView,
  removeApp,
  unexposeApp,
} from './app-lifecycle';

const PREFLIGHT_TIMEOUT = 30_000;
const SETUP_TIMEOUT = 300_000;

export type { AppSource } from './app-source';

export interface IngressDeployOptions extends BindingOptions {
  email?: string;
  /** Optional ingress basic-auth gate (`--auth basic|none`). */
  auth?: IngressAuthIntent;
}
export interface DeployOptions {
  name?: string;
  set?: Record<string, string>;
  dryRun?: boolean;
  /** Front the app with a domain + TLS via the vops ingress (opt-in). */
  ingress?: IngressDeployOptions;
  /** Bind raw published ports on 0.0.0.0 (reachable from any network the host is on).
   * Undefined = inherit the previous install's intent, else default to loopback-only. */
  public?: boolean;
  /** Pull credentials for a private image registry. Passed straight to the host and
   * never persisted: a stored plan must not be able to leak a token. */
  registry?: { user: string; token: string };
}
export interface AppPreflightResult {
  host: string;
  facts: HostFacts;
  coexistence: boolean;
  ready: boolean;
  issues: string[];
}
export interface DeployPlanView {
  dryRun: true;
  app: string;
  host: string;
  kind: AppPlan['kind'];
  unitDir: string;
  files: Record<string, string>;
  secrets: string[];
  endpoints: AppEndpoint[];
  services: string[];
  coexistence: boolean;
  ingress?: { hostname: string; tls: boolean; staging: boolean; warnings: string[] };
  access?: AppAccessView;
  /** Ingress basic-auth gate that will front the app (preview). */
  gate?: { user: string };
  /** Advisories carried by the manifest or the binding (never a refusal — those throw). */
  warnings?: string[];
}
export interface DeployResult {
  dryRun: false;
  app: string;
  host: string;
  status: AppInstallV1['status'];
  endpoints: AppEndpoint[];
  components: Array<{ name: string; image: string }>;
  smoke: string;
  ingress?: { hostname: string; tls: boolean; note: string; warnings: string[] };
  access?: AppAccessView;
  /** Ingress basic-auth gate fronting the app (never carries the password). */
  gate?: { user: string; secret: string; generated: boolean };
  /** Non-fatal advisories (e.g. a `--set` override that hit an already-existing secret). */
  warnings?: string[];
}
export interface AppCredentialsView {
  app: string;
  host: string;
  /** App login block (undefined for a gate-only app with no manifest `access`). */
  access?: AppAccessView;
  /** Ingress basic-auth gate fronting the app + its login URL. */
  gate?: AppIngressAuthState & { url?: string };
}

/** `vops app` orchestration: preflight → normalize → bind to host → render Quadlet → deploy over
 * SSH → smoke test gate → persist, with rollback on any failure. */
@Injectable()
export class VopsAppsService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly conn: VopsHostConnService,
    @Inject('SshExec') private readonly ssh: SshExec,
    private readonly store: LocalStore,
    private readonly ingress: VopsIngressService,
  ) {}

  /** Plain-object view of this service's fields for the free lifecycle functions in
   * app-lifecycle.ts — a class instance with private fields isn't structurally
   * assignable to a plain interface type, so this rebuilds it as a literal. */
  private opsDeps(): AppOpsDeps {
    return {
      hosts: this.hosts,
      keys: this.keys,
      conn: this.conn,
      ssh: this.ssh,
      store: this.store,
      ingress: this.ingress,
      preflight: (name: string) => this.preflight(name),
    };
  }

  async preflight(name: string): Promise<AppPreflightResult> {
    const host = this.hosts.show(name);
    const target = resolveSshTarget(host, this.keys);
    const res = await this.ssh.runScript(target, buildPreflightScript(), { timeoutMs: PREFLIGHT_TIMEOUT });
    const facts = parsePreflight(res.stdout);
    const issues = readiness(facts);
    return { host: name, facts, coexistence: facts.k3s, ready: issues.length === 0, issues };
  }

  buildAppPlan(source: AppSource, name?: string): AppPlan {
    try {
      return loadAppPlan(source, getCatalogEntry, name).plan;
    } catch (err) {
      if (err instanceof AppSourceError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /** Install Podman 5 (podman-static) on a host that lacks it — restic-pattern bootstrap. */
  async setup(hostName: string): Promise<{ host: string; version: string; quadlet: boolean; conflict: boolean }> {
    const host = this.hosts.show(hostName);
    assertHostWritable(host);
    await this.conn.assertReady(hostName);
    const target = resolveSshTarget(host, this.keys);

    const uname = (await this.ssh.run(target, 'uname -m')).stdout;
    const bin = podmanStaticForArch(uname);
    if (!bin) throw new BadRequestException(`Unsupported CPU arch '${uname.trim()}' (need x86_64 or aarch64).`);

    const res = await this.ssh.runScript(target, renderPodmanInstall(bin), { timeoutMs: SETUP_TIMEOUT, sudo: true });
    if (res.code !== 0) {
      throw new BadRequestException(`podman install failed (${PODMAN_STATIC_VERSION}): ${res.stderr.trim() || 'checksum mismatch'}`);
    }
    const s = splitSections(res.stdout);
    const version = (/(\d{1,4}\.\d{1,4}\.\d{1,4})/.exec(s.version ?? '') ?? [])[1] ?? '';
    if (!version) throw new BadRequestException(`podman install did not report a version: ${res.stdout.trim()}`);
    await this.store.appendAudit('app.setup', { host: host.name, podmanStatic: PODMAN_STATIC_VERSION, version });
    return {
      host: host.name,
      version,
      quadlet: (s.generator ?? '').includes('present'),
      conflict: (s.existing ?? '').includes('conflict'),
    };
  }

  async deploy(source: AppSource, hostName: string, opts: DeployOptions): Promise<DeployPlanView | DeployResult> {
    const host = this.hosts.show(hostName);
    assertHostWritable(host);
    await this.conn.assertReady(hostName);
    const target = resolveSshTarget(host, this.keys);

    const pf = await this.preflight(hostName);
    if (!pf.ready) throw new BadRequestException(`Host '${hostName}' is not ready for apps: ${pf.issues.join(' ')}`);

    const plan = this.buildAppPlan(source, opts.name);
    applyOverrides(plan, opts.set ?? {});
    // Validate required inputs + "at least one of" groups on the FULL plan, before
    // pruning drops the unset optional/group members (a fully-unset group must still
    // be seen). Dry-run previews without enforcing.
    if (!opts.dryRun) assertSecretsSatisfied(plan);
    pruneUnsetOptional(plan);
    refreshAccessValues(plan);
    const resolution = this.ingress.resolveBinding(plan, host, opts.ingress ?? {});
    // On the plan, not on the ingress block: a dry-run and a real deploy both carry `plan.warnings`
    // into the envelope's `warnings[]` as VOPS_DEPLOY_ADVISORY, which is where an agent looks.
    plan.warnings = [...(plan.warnings ?? []), ...internalExposureWarnings(plan, resolution?.binding)];
    const prev = await this.store.getInstall(host.name, plan.name);
    const gate = this.resolveGate(plan, resolution, opts.ingress?.auth, prev);
    const publish = resolvePublishIntent(opts.public, prev);
    const hp = planHostDeploy(plan, pf.facts, host.address, resolution?.binding, publish.mode, await this.portReservations(host.name, plan.name, prev));

    // DNS is checked before the app is built: a hostname that is already taken must
    // stop the run while nothing has been touched, not after the container is up.
    if (resolution) await this.checkDns(host, resolution, opts);

    if (opts.dryRun) return planView(plan, host, hp, resolution, gate);

    const install = toInstall(plan, host, hp, prev);
    install.publish = publish.mode;
    if (gate) install.secrets = [...new Set([...install.secrets, gate.state.secret])];
    // The record is claimed BEFORE the host is touched. An install that never returns — Ctrl-C on
    // a slow pull, a dropped connection, a kill — never reaches the write below, and without a row
    // the pod, units, volumes and secrets it created are invisible to `app list` and out of reach
    // of `app remove`. A failure that rolls the host back takes the row with it.
    await beginInstall(this.store, install);
    const baseline = redeployBaseline(prev);
    const registry = resolveRegistryLogin(plan, opts.registry);
    const generator = pf.facts.quadletGenerator;

    const { smoke, dns } = await withLedgerRevert(this.store, install, prev, async () => {
      // The A record goes in FIRST: its propagation then runs while the ingress installs and the
      // image is pulled, instead of being waited out in full once everything else is done.
      const record = resolution ? await this.ingress.ensureDnsRecord(host, resolution.binding, opts.ingress?.forceDns) : null;
      // Only a redeploy of a confirmed install cannot strand data: its rollback restores the
      // previous units and touches no volume, so it never needs to know what was already there.
      const preexisting = baseline ? UNPROBED_DATA : await probeAppData({ ssh: this.ssh, target }, hp);
      const outcome = await this.withDnsCleanup(record, async () => {
        // Provision the ingress before the app so :80/:443 + the route target are ready.
        if (resolution) await this.ensureIngressUp(host, opts.ingress);
        const pull = await pullImages({ ssh: this.ssh, target }, plan.components.map((c) => c.image), registry);
        if ('error' in pull) throw new BadRequestException(pull.error);
        const res = await this.ssh.runScript(
          target,
          buildDeployScript({
            unitDir: hp.unitDir,
            units: hp.units,
            healthUnits: hp.healthUnits,
            secrets: hp.secrets.map(toMaterial),
            services: hp.services,
            prereqServices: hp.prereqServices,
            quadletGenerator: generator,
            ...(registry ? { registry } : {}),
          }),
          { timeoutMs: deployTimeoutMs(hp.services.length), sudo: true },
        );
        return gateOrRollback({ ssh: this.ssh, target }, { plan, hp, prev: baseline, generator, preexisting }, res);
      });
      return { smoke: outcome, dns: record };
    });

    install.updatedAt = new Date().toISOString();
    await this.store.saveInstall(install);
    await this.store.appendAudit('app.deploy', { app: plan.name, host: host.name, appId: plan.appId, coexistence: hp.coexistence });

    let ingressOut: DeployResult['ingress'];
    if (resolution) {
      const attach = await this.ingress.attachRoute(host, install, resolution.binding, resolution.staging, gate ?? undefined, dns);
      install.ingress = attach.state;
      install.endpoints = applyIngressScheme(install.endpoints, attach.state);
      await this.store.saveInstall(install);
      ingressOut = { hostname: attach.state.hostname, tls: attach.state.tls, note: attach.note, warnings: resolution.warnings };
    }

    const post = await runPostInstall({ ssh: this.ssh, target }, plan, hp, ingressOut?.hostname);

    const access = accessView(
      plan.access,
      install.endpoints,
      plan.primary,
      ingressOut ? { hostname: ingressOut.hostname, tls: ingressOut.tls } : undefined,
    );
    const warnings = [
      ...(plan.warnings ?? []),
      ...secretReuseWarnings(plan, opts.set, prev),
      ...(publish.warning ? [publish.warning] : []),
      ...post.warnings,
    ];
    return {
      dryRun: false,
      app: plan.name,
      host: host.name,
      status: install.status,
      endpoints: install.endpoints,
      components: install.components.map((c) => ({ name: c.name, image: c.image })),
      smoke: post.smoke ?? smoke.detail,
      ...(ingressOut ? { ingress: ingressOut } : {}),
      ...(access ? { access } : {}),
      ...(gate ? { gate: { user: gate.state.user, secret: gate.state.secret, generated: gate.generated } } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }


  /** Everything between writing the A record and the app answering: if any of it fails, the record
   * this run created is removed, so a failed deploy leaves behind no name pointing at nothing. */
  private async withDnsCleanup<T>(dns: EnsuredRecord | null, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      await this.ingress.discardDnsRecord(dns);
      throw e;
    }
  }

  /** Port ownership comes from the install ledger, not from who is listening right now: this app
   * keeps the ports it already published, and every other install on the host keeps its own even
   * while stopped — a stopped app answers no port scan, so the scan alone would give its port away. */
  private async portReservations(hostName: string, appName: string, prev: AppInstallV1 | null): Promise<PortReservations> {
    const siblings = await this.store.listInstalls(hostName);
    return {
      own: Object.fromEntries((prev?.components ?? []).map((c) => [c.name, c.published])),
      others: siblings
        .filter((i) => i.name !== appName && i.status !== 'removed')
        .flatMap((i) => i.endpoints.map((e) => e.port)),
    };
  }

  /** A hostname that is already taken must stop the run before anything is touched,
   * not after the container is up. */
  private async checkDns(host: VopsHost, resolution: BindingResolution, opts: DeployOptions): Promise<void> {
    const dns = await this.ingress.preflightDns(host, resolution.binding, {
      force: opts.ingress?.forceDns,
      report: opts.dryRun,
    });
    if (dns) resolution.warnings.push(dns);
  }

  /** Resolve the ingress basic-auth gate for a deploy, surfacing `--auth basic` without a
   * domain as a 400 rather than a plain error. A firstVisit app — or one whose manifest
   * declares no login of its own — is refused an ungated domain; that refusal already
   * carries its own code and exit status, so it travels untouched. */
  private resolveGate(plan: AppPlan, resolution: BindingResolution | null, intent: IngressAuthIntent | undefined, prev: AppInstallV1 | null): IngressGate | null {
    try {
      return resolveDeployGate(plan.name, {
        hasIngress: !!resolution,
        accessMode: plan.access?.mode,
        authMode: plan.authMode,
        intent,
        prevAuth: prev?.ingress?.auth,
      });
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(e instanceof Error ? e.message : String(e));
    }
  }

  /** Ensure the host's Traefik ingress is running before an app is routed to it. */
  private async ensureIngressUp(host: VopsHost, opts?: IngressDeployOptions): Promise<void> {
    const st = await this.ingress.status(host.name);
    if (st.active && st.health === 200) return;
    await this.ingress.up(host.name, { email: opts?.email });
  }

  async list(host?: string): Promise<AppInstallSummary[]> {
    const installs = await this.store.listInstalls(host);
    // Flag installs whose deploy host has since left the inventory, so the UI can
    // surface it up front (badge + "Forget") instead of every action failing with
    // a raw "Host not found" over SSH.
    return installs.map((i) => (this.hosts.get(i.host) ? i : { ...i, hostMissing: true }));
  }

  async show(name: string, host?: string): Promise<AppInstallV1> {
    return getInstall(this.opsDeps(), name, host);
  }

  /** The resolved login block for a deployed install (URL + parts; no secret values),
   * plus the ingress basic-auth gate fronting it, if any. */
  async credentials(name: string, host?: string): Promise<AppCredentialsView> {
    return credentialsView(this.opsDeps(), name, host);
  }

  /** Read back ONE access-referenced secret over SSH — gated to secrets the manifest's `access`
   * block exposes (never a DB/internal secret), only on explicit user action. */
  async revealCredential(name: string, secret: string, host?: string): Promise<{ secret: string; value: string }> {
    return revealSecret(this.opsDeps(), name, secret, host);
  }

  async status(name: string, host?: string): Promise<{ install: AppInstallV1; units: UnitStatus[]; containers: string[] }> {
    return statusView(this.opsDeps(), name, host);
  }

  /** Restart the app's own containers (not prereq volumes/pod units) and report
   * back the same shape `status()` does — a quick self-recovery action, not a
   * redeploy: units/images/secrets are untouched. */
  async restart(name: string, host?: string): Promise<{ install: AppInstallV1; units: UnitStatus[]; containers: string[] }> {
    return restartApp(this.opsDeps(), name, host);
  }

  async logs(name: string, lines = 200, host?: string): Promise<string> {
    return logsView(this.opsDeps(), name, lines, host);
  }

  async remove(name: string, opts: { purge?: boolean; dryRun?: boolean } = {}, host?: string): Promise<{ removed: boolean; purge: boolean; host: string; orphaned?: boolean }> {
    return removeApp(this.opsDeps(), name, opts, host);
  }

  /** Attach an already-deployed catalog app to ingress (redeploys it with a domain). */
  async expose(name: string, opts: IngressDeployOptions, host?: string): Promise<DeployPlanView | DeployResult> {
    const install = await this.show(name, host);
    if (!getCatalogEntry(install.appId)) {
      throw new BadRequestException(`'${name}' was not deployed from the catalog — re-run \`vops app deploy -f <flui.yaml> --host ${install.host} --domain <host> --yes\` to expose it.`);
    }
    // An app that was already exposed carries its hostname: asking for it again is a chance to
    // mistype a name that is already published in DNS, and it makes the retry this command's own
    // failure notes suggest impossible to run as written.
    const domain = opts.domain ?? install.ingress?.hostname;
    if (!domain) throw new BadRequestException('Pass --domain <host> (or --domain auto for an sslip.io demo host).');
    return this.deploy({ catalog: install.appId }, install.host, { name: install.name, ingress: { ...opts, domain } });
  }

  /** Detach from ingress: drop the route + A-record. A `--public` install rebinds its
   * routed port to 0.0.0.0; a default (loopback) install stays on 127.0.0.1 so detaching
   * a domain never silently re-exposes the app to the internet. */
  async unexpose(name: string, host?: string): Promise<{ app: string; host: string; endpoints: AppEndpoint[] }> {
    return unexposeApp(this.opsDeps(), name, host);
  }

}

