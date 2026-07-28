import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DnsProviderFactory } from '@flui-cloud/infra';
import { SshExec, SshTarget } from '../lib/ssh-exec';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostConnService } from '../host-ops/vops-host-conn.service';
import { resolveSshTarget } from '../host-ops/ssh-target';
import { assertHostWritable } from '../safety/host-write-gate';
import { LocalStore } from '../lib/store/local-store';
import { hasNativeFirewall, resolveProvider } from '../lib/providers';
import { splitSections } from '../host-ops/status-battery';
import { VopsHost } from '../hosts/host.model';
import { AppIngressRoute, AppInstallV1, AppIngressState, AppPlan, IngressBinding } from './app.model';
import { RESOLVER_PROD, RESOLVER_STAGING } from './ingress-render';
import { IngressGate } from './ingress-auth';
import { buildIngressAuthSecretScript, buildIngressDownScript, buildIngressPrecheckScript, buildProxyReadScript } from './ingress-scripts';
import { parseIngressPrecheck } from './app-parse';
import { DEFAULT_PROXY, IngressProxy, ProxyKind, ProxyRouteRenderInput, ingressProxy, parseProxyKind } from './ingress-proxy';
import { assertValidHostname, isSslip, routedPorts, sslipHostname } from './ingress-hostname';
import { deleteARecord, ensureARecord, listWritableZones, previewARecord } from './ingress-dns';
import { DomainOption, domainOptions } from './domain-options';
import { DnsConflictError } from './ingress-dns-plan';
import { AuthResolve, HttpProbe, probeHttp, probeHttps, resolvesAuthoritative } from './ingress-probe';

const PRECHECK_TIMEOUT = 30_000;
const INSTALL_TIMEOUT = 300_000;
const ROUTE_TIMEOUT = 30_000;
const CERT_POLL_ATTEMPTS = 20;
const CERT_POLL_SLEEP_MS = 3_000;
const REACH_ATTEMPTS = 6;
const REACH_SLEEP_MS = 3_000;

export interface FirewallGuidance {
  kind: 'native' | 'host-nftables' | 'none';
  hint: string;
}
export interface IngressUpResult {
  host: string;
  proxy: ProxyKind;
  active: boolean;
  health: boolean;
  alreadyUp: boolean;
  image: string;
  email: string;
  firewall: FirewallGuidance;
}
export interface IngressStatusResult {
  host: string;
  proxy: ProxyKind;
  installed: boolean;
  active: boolean;
  health: number;
  container: string | null;
  routes: string[];
}
export interface IngressUpOptions {
  email?: string;
  /** Backend to install (default keeps an existing host's, else DEFAULT_PROXY). */
  proxy?: ProxyKind;
  /** Test-only: point the ACME resolver at a private directory (Pebble). */
  caServer?: string;
  caBundle?: { path: string; content: string };
}
export interface BindingOptions {
  domain?: string;
  tls?: boolean;
  staging?: boolean;
  exposeDirect?: boolean;
  /** Repoint a hostname whose DNS record already points somewhere else. */
  forceDns?: boolean;
}
export interface BindingResolution {
  binding: IngressBinding;
  staging: boolean;
  /** hostname is a shared demo domain (sslip.io) → certs are best-effort. */
  sslip: boolean;
  warnings: string[];
}
export interface AttachResult {
  state: AppIngressState;
  reachable: boolean;
  tlsConfirmed: boolean;
  note: string;
}

/** The vops ingress: a per-host Traefik singleton that fronts apps with a real hostname + ACME TLS.
 * Pure rendering/parse live in `ingress-{render,scripts,hostname,dns,probe}`; this file orchestrates. */
@Injectable()
export class VopsIngressService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    private readonly conn: VopsHostConnService,
    @Inject('SshExec') private readonly ssh: SshExec,
    private readonly store: LocalStore,
    private readonly dns: DnsProviderFactory,
  ) {}

  /** The hostnames this install could actually use, ranked. Listing zones is best-effort by
   * design: a missing credential or transient API failure degrades to BYO/temporary domain, never blocks exposing. */
  async domainOptions(hostName: string, installName: string): Promise<DomainOption[]> {
    const host = this.hosts.show(hostName);
    const zones = await listWritableZones(this.dns).catch(() => []);
    return domainOptions({ hostAddress: host.address, installName, zones });
  }

  async status(hostName: string): Promise<IngressStatusResult> {
    const host = this.hosts.show(hostName);
    const target = resolveSshTarget(host, this.keys);
    const proxy = await this.proxyFor(target);
    const res = await this.ssh.runScript(target, proxy.buildStatus(), { timeoutMs: PRECHECK_TIMEOUT, sudo: true });
    const s = proxy.parseStatus(res.stdout);
    return { host: host.name, proxy: proxy.kind, installed: s.container != null || s.active, ...s };
  }

  /** Install/refresh the ingress (Traefik or Caddy). Idempotent; refuses if :80/:443 is
   * held by another process. The backend is opts.proxy, else the host's existing one,
   * else DEFAULT_PROXY. */
  async up(hostName: string, opts: IngressUpOptions = {}): Promise<IngressUpResult> {
    const host = this.hosts.show(hostName);
    assertHostWritable(host);
    await this.conn.assertReady(hostName);
    const target = resolveSshTarget(host, this.keys);
    const email = opts.email ?? process.env.VOPS_ACME_EMAIL ?? '';
    if (!email) throw new BadRequestException('An ACME account email is required. Pass --email you@example.com (or set VOPS_ACME_EMAIL).');

    const pre = parseIngressPrecheck(
      (await this.ssh.runScript(target, buildIngressPrecheckScript(), { timeoutMs: PRECHECK_TIMEOUT, sudo: true })).stdout,
    );
    if (!pre.podmanVersion) throw new BadRequestException('Podman is not installed. Run `vops app setup ' + host.name + '` first.');
    assertPortsFree(pre, host.name);

    const existing = await this.readProxyKind(target);
    const proxy = ingressProxy(opts.proxy ?? existing ?? DEFAULT_PROXY);
    const { staticConfig, unit } = proxy.renderInstall({ email, selinux: pre.selinux, caServer: opts.caServer, caBundle: opts.caBundle });
    const res = await this.ssh.runScript(
      target,
      proxy.buildInstall({ staticConfig, unit, image: proxy.image, caBundle: opts.caBundle }),
      { timeoutMs: INSTALL_TIMEOUT, sudo: true },
    );
    const out = proxy.parseInstall(res.stdout);
    if (!out.ok) {
      throw new BadRequestException(`Ingress failed to start (active=${out.active} health=${out.health}, pull=${out.pull}).\n${out.diag || res.stderr.trim()}`);
    }
    await this.store.appendAudit('ingress.up', { host: host.name, proxy: proxy.kind, image: proxy.image });
    return { host: host.name, proxy: proxy.kind, active: out.active, health: out.health, alreadyUp: pre.active, image: proxy.image, email, firewall: this.firewallGuidance(host) };
  }

  /** The host's ingress backend from its marker (null when it has no ingress yet). */
  private async readProxyKind(target: SshTarget): Promise<ProxyKind | null> {
    const out = (await this.ssh.runScript(target, buildProxyReadScript(), { timeoutMs: PRECHECK_TIMEOUT, sudo: true })).stdout;
    return parseProxyKind(out);
  }

  /** The adapter for a host's running ingress (marker-less legacy hosts are Traefik). */
  private async proxyFor(target: SshTarget): Promise<IngressProxy> {
    return ingressProxy((await this.readProxyKind(target)) ?? 'traefik');
  }

  async down(hostName: string, opts: { purge?: boolean; force?: boolean } = {}): Promise<{ host: string; purged: boolean; detached: string[] }> {
    const host = this.hosts.show(hostName);
    assertHostWritable(host);
    const routed = (await this.store.listInstalls(host.name)).filter((i) => i.ingress);
    if (routed.length && !opts.force) {
      throw new BadRequestException(`${routed.length} app(s) still routed through ingress (${routed.map((i) => i.name).join(', ')}). Detach them or pass --force.`);
    }
    const detached: string[] = [];
    for (const summary of routed) {
      const install = await this.store.getInstall(summary.name);
      if (install) {
        await this.detachInstall(install);
        detached.push(install.name);
      }
    }
    const target = resolveSshTarget(host, this.keys);
    await this.ssh.runScript(target, buildIngressDownScript(!!opts.purge), { timeoutMs: PRECHECK_TIMEOUT, sudo: true });
    await this.store.appendAudit('ingress.down', { host: host.name, purge: !!opts.purge, detached });
    return { host: host.name, purged: !!opts.purge, detached };
  }

  /** Turn a `--domain` intent into a host binding (pure decision, no I/O). Ingress is
   * opt-in: only `--domain` (any value, incl. `auto`) or an app that can't run without
   * a domain (`{{app.domain}}`) triggers it — a bare `domain.auto` manifest does not. */
  resolveBinding(plan: AppPlan, host: VopsHost, opts: BindingOptions): BindingResolution | null {
    const wantsDomain = !!opts.domain || plan.needsAppDomain;
    if (!wantsDomain) return null;

    const rps = routedPorts(plan);
    if (!rps.length) throw new BadRequestException(`'${plan.name}' exposes no HTTP port to route — a domain needs an HTTP endpoint.`);

    const warnings: string[] = [];
    const hostname = this.resolveHostname(opts.domain, host, plan.name, warnings);
    const sslip = isSslip(hostname);
    const tls = opts.tls ?? plan.domain?.tls ?? true;
    const staging = !!opts.staging || plan.domain?.provider === 'lets-encrypt-staging';
    if (plan.domain?.certChallenge === 'dns-01') warnings.push('certChallenge dns-01 is not supported — using http-01 (no wildcard).');
    if (sslip && tls && !staging) warnings.push('sslip.io shares one Let’s Encrypt rate-limit bucket — certificates are best-effort. Use --domain <your-domain> for reliable TLS.');

    return {
      binding: {
        hostname,
        tls,
        exposeDirect: !!opts.exposeDirect,
        routes: rps.map((rp) => ({ component: rp.component, containerPort: rp.containerPort, path: rp.path, stripPrefix: rp.stripPrefix })),
      },
      staging,
      sslip,
      warnings,
    };
  }

  private resolveHostname(domain: string | undefined, host: VopsHost, installName: string, warnings: string[]): string {
    if (domain && domain !== 'auto') return assertValidHostname(domain);
    // Zero-config default: derive an sslip.io hostname from the host's IP, prefixed
    // with the install name so multiple apps on one host don't collide at '/'.
    const name = sslipHostname(host.address, installName);
    warnings.push(`No --domain given → using ${name} (sslip.io demo domain).`);
    return name;
  }

  /** Look at DNS before anything is built — `attachRoute` runs after the container is up, so a
   * hostname clash discovered there would leave a deployed app unreachable. */
  async preflightDns(
    host: VopsHost,
    binding: IngressBinding,
    opts: { force?: boolean; report?: boolean } = {},
  ): Promise<string | null> {
    if (isSslip(binding.hostname)) return null;

    const { zone, plan } = await previewARecord(this.dns, binding.hostname, host.address);
    if (!zone || !plan) {
      return `${binding.hostname} is not in a DNS zone vops can write to — point an A record at ${host.address} yourself before the certificate can be issued.`;
    }
    if (plan.action === 'conflict') {
      const conflict = new DnsConflictError(binding.hostname, plan);
      if (!opts.force && !opts.report) throw conflict;
      return opts.force
        ? `${binding.hostname} already points elsewhere — --force-dns will repoint it.`
        : conflict.message;
    }
    if (plan.action === 'reuse') {
      return `${binding.hostname} already points at ${host.address} — the existing record is reused, not duplicated.`;
    }
    return null;
  }

  /** Attach a deployed app to ingress: DNS → plain route → laptop reachability gate → TLS.
   * When a `gate` is passed the route is **born gated**: its Podman secret is created
   * (aborting before any route is written if that fails) and every route render — plain
   * and TLS — carries the basic-auth block, so the app is never publicly reachable ungated. */
  async attachRoute(host: VopsHost, install: AppInstallV1, binding: IngressBinding, staging: boolean, gate?: IngressGate, forceDns = false): Promise<AttachResult> {
    const target = resolveSshTarget(host, this.keys);
    const proxy = await this.proxyFor(target);
    const routes = this.resolveRoutes(install, binding);
    const entries = routes.map((r) => ({ hostPort: r.hostPort, path: r.path, stripPrefix: r.stripPrefix }));
    const root = routes.find((r) => r.path === '/') ?? routes[0];
    const extras = routes.filter((r) => r !== root);
    const certResolver = staging ? RESOLVER_STAGING : RESOLVER_PROD;
    const routeFile = proxy.routeFile(install.name);
    const route = (tls: boolean) => ({ app: install.name, hostname: binding.hostname, tls, staging, certResolver, routes: entries, auth: gate?.routeAuth });

    if (gate?.secret) await this.ensureGateSecret(target, gate.secret);

    // Before anything is written: a name already pointing elsewhere belongs to
    // someone, and DNS has no undo. `ensureARecord` refuses rather than repoint.
    const dnsRecord = isSslip(binding.hostname)
      ? undefined
      : await ensureARecord(this.dns, binding.hostname, host.address, { force: forceDns });

    // Plain-HTTP routes first: makes http://<host> live and serves the ACME challenge.
    await this.writeRoute(target, proxy, route(false));

    const base: AppIngressState = {
      hostname: binding.hostname, tls: false, staging, component: root.component, hostPort: root.hostPort,
      ...(extras.length ? { routes: extras } : {}),
      exposeDirect: binding.exposeDirect, certResolver, routeFile, dns: dnsRecord,
      ...(gate ? { auth: gate.state } : {}), attachedAt: new Date().toISOString(),
    };
    if (!binding.tls) return { state: base, reachable: true, tlsConfirmed: false, note: 'plain HTTP (tls disabled)' };

    // Preflight the exact path LE takes (authoritative-nameserver DNS + direct :80 with a Host
    // header, no laptop DNS involved), retried briefly to absorb A-record propagation delay.
    const { dns: dnsCheck, http: probe } = await this.waitReachable(binding.hostname, host.address, dnsRecord?.zoneName);
    if (!dnsCheck.resolved || !probe.reachable) {
      return { state: base, reachable: false, tlsConfirmed: false, note: notReadyNote(binding.hostname, host.address, install.name, dnsCheck, probe) };
    }

    // Reachable → enable TLS + HTTP→HTTPS redirect; the proxy runs ACME in-process.
    await this.writeRoute(target, proxy, route(true));
    const cert = await this.pollCert(target, proxy, binding.hostname, host.address);
    const env = staging ? 'staging' : 'production';
    if (cert.ok) {
      return { state: { ...base, tls: true, dns: dnsRecord }, reachable: true, tlsConfirmed: true, note: `TLS active (${env} cert)` };
    }
    if (cert.hardError) {
      // Hard ACME failure: the TLS route redirects :80→:443, where the proxy serves its
      // untrusted default cert → the app is effectively down. Revert to plain HTTP.
      await this.writeRoute(target, proxy, route(false));
      return { state: base, reachable: true, tlsConfirmed: false, note: `ACME failed (${cert.hardError}) — reverted to plain HTTP so ${install.name} stays reachable. Fix the cause and rerun \`vops app expose ${install.name}\`.` };
    }
    // Soft timeout: still issuing — keep the TLS route, the proxy retries in-process.
    return { state: { ...base, tls: true, dns: dnsRecord }, reachable: true, tlsConfirmed: false, note: `TLS requested (${env}); certificate still issuing — check \`vops ingress status ${host.name}\`.` };
  }

  /** Route + A-record teardown for an install that is about to be deleted (no store write). */
  async cleanupForRemoval(host: VopsHost, install: AppInstallV1): Promise<void> {
    if (!install.ingress) return;
    await this.detachRoute(host, install.name);
    if (install.ingress.dns) await deleteARecord(this.dns, install.ingress.dns);
  }

  /** Remove an app's route (keeps the app running on its loopback port). */
  async detachRoute(host: VopsHost, app: string): Promise<void> {
    const target = resolveSshTarget(host, this.keys);
    const proxy = await this.proxyFor(target);
    await this.ssh.runScript(target, proxy.buildRouteRemove(app), { timeoutMs: ROUTE_TIMEOUT, sudo: true });
  }

  /** Full detach: drop the route, delete the auto A-record, clear stored ingress state.
   * The app stays deployed; callers that need the port back on 0.0.0.0 redeploy it. */
  async detachInstall(install: AppInstallV1): Promise<void> {
    const host = this.hosts.show(install.host);
    await this.detachRoute(host, install.name);
    if (install.ingress?.dns) await deleteARecord(this.dns, install.ingress.dns);
    const next = { ...install, updatedAt: new Date().toISOString() };
    delete next.ingress;
    await this.store.saveInstall(next);
  }

  firewallGuidance(host: VopsHost): FirewallGuidance {
    const provider = host.provider ? safeProvider(host.provider) : null;
    if (provider && hasNativeFirewall(provider)) {
      return { kind: 'native', hint: `Open 80,443/tcp in the ${host.provider} firewall (e.g. \`vops firewall ${host.name}\`) — the provider filter must allow them for ACME + traffic.` };
    }
    return {
      kind: provider ? 'host-nftables' : 'none',
      hint: `Ensure 80,443/tcp are open to the internet for this host — HTTP-01 needs inbound :80.`,
    };
  }

  /** Map each binding route to the host port the app actually published for it. */
  private resolveRoutes(install: AppInstallV1, binding: IngressBinding): AppIngressRoute[] {
    return binding.routes.map((r) => {
      const comp = install.components.find((c) => c.name === r.component);
      const pub = comp?.published.find((p) => p.container === r.containerPort);
      if (!pub) throw new BadRequestException(`No published port ${r.containerPort} on component '${r.component}' to route.`);
      return { component: r.component, containerPort: r.containerPort, hostPort: pub.host, path: r.path, stripPrefix: r.stripPrefix };
    });
  }

  private async writeRoute(target: SshTarget, proxy: IngressProxy, o: ProxyRouteRenderInput): Promise<void> {
    await this.ssh.runScript(target, proxy.buildRouteWrite(o.app, proxy.renderRoute(o)), { timeoutMs: ROUTE_TIMEOUT, sudo: true });
  }

  /** Create the gate's Podman secret before any route is written, so there is never a
   * state where the app is publicly routed without a recoverable gate password. */
  private async ensureGateSecret(target: SshTarget, secret: { name: string; plaintext: string }): Promise<void> {
    const res = await this.ssh.runScript(target, buildIngressAuthSecretScript(secret.name, secret.plaintext), { timeoutMs: ROUTE_TIMEOUT, sudo: true });
    if (splitSections(res.stdout).auth?.trim() !== 'ok') {
      throw new BadRequestException(`Could not create the ingress auth secret '${secret.name}' — aborting before exposing the app ungated.`);
    }
  }

  /** Probe the LE path (authoritative-NS resolution + :80 to the host IP), retrying
   * briefly so a just-created A-record's propagation delay doesn't read as unreachable. */
  private async waitReachable(hostname: string, ip: string, zoneHint?: string): Promise<{ dns: AuthResolve; http: HttpProbe }> {
    let dns = await resolvesAuthoritative(hostname, ip, zoneHint);
    let http = await probeHttp(hostname, ip);
    for (let i = 1; i < REACH_ATTEMPTS && (!dns.resolved || !http.reachable); i += 1) {
      await sleep(REACH_SLEEP_MS);
      if (!dns.resolved) dns = await resolvesAuthoritative(hostname, ip, zoneHint);
      if (!http.reachable) http = await probeHttp(hostname, ip);
    }
    return { dns, http };
  }

  /** Poll for the cert from the laptop (HTTPS handshake) while asking the host, every
   * other round, whether a cert landed or ACME hard-failed — so a rate-limit/CAA/
   * validation error aborts the poll early instead of waiting out the full timeout. */
  private async pollCert(target: SshTarget, proxy: IngressProxy, hostname: string, ip: string): Promise<CertPollResult> {
    for (let i = 0; i < CERT_POLL_ATTEMPTS; i += 1) {
      if (await probeHttps(hostname, ip)) return { ok: true, hardError: null };
      if (i % 2 === 1) {
        const cp = proxy.parseCertProbe(
          (await this.ssh.runScript(target, proxy.buildCertProbe(hostname), { timeoutMs: ROUTE_TIMEOUT, sudo: true })).stdout,
        );
        if (cp.issued && (await probeHttps(hostname, ip))) return { ok: true, hardError: null };
        if (cp.hardError) return { ok: false, hardError: cp.hardError };
      }
      await sleep(CERT_POLL_SLEEP_MS);
    }
    return { ok: false, hardError: null };
  }
}

interface CertPollResult {
  ok: boolean;
  /** A definitive ACME failure reason (revert to plain HTTP), or null when soft/timeout. */
  hardError: string | null;
}

/** The "left on plain HTTP" note when the LE preflight (authoritative DNS + :80) fails. */
function notReadyNote(hostname: string, ip: string, appName: string, dnsCheck: AuthResolve, probe: HttpProbe): string {
  const why = dnsCheck.reason ? ` (${dnsCheck.reason})` : '';
  const reasons = [
    ...(dnsCheck.resolved ? [] : [`${hostname} does not resolve to ${ip} at its authoritative nameservers${why}`]),
    ...(probe.reachable ? [] : [`:80 unreachable (${probe.error ?? 'no response'})`]),
  ];
  return `Not ready for TLS, left on plain HTTP: ${reasons.join('; ')}. Retry with \`vops app expose ${appName}\` once fixed.`;
}

function assertPortsFree(pre: { active: boolean; port80: string | null; port443: string | null }, host: string): void {
  if (pre.active) return; // already our ingress → re-config, not a conflict
  const clash = pre.port80 ?? pre.port443;
  if (!clash) return;
  const which = [pre.port80 ? '80' : '', pre.port443 ? '443' : ''].filter(Boolean).join('/');
  const k3sHint = /traefik|k3s/i.test(clash)
    ? ' This looks like a k3s ingress — vops ingress targets non-k3s hosts; use the k3s ingress here.'
    : '';
  throw new BadRequestException(`Port ${which} on '${host}' is held by '${clash}'.${k3sHint} Free it or choose another host.`);
}

function safeProvider(name: string) {
  try {
    return resolveProvider(name);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
