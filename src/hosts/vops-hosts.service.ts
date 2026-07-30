import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CloudProvider, ProviderFactory } from '@flui-cloud/infra';
import { LocalStore } from '../lib/store/local-store';
import { profileDir } from '../lib/profile';
import { SshExec } from '../lib/ssh-exec';
import { resolveProvider, defaultSshUser } from '../lib/providers';
import { notFound } from '../agent-api/agent-http-errors';
import { VopsSshKey, VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { SshOutcome, deriveConnState, sshOutcome } from '../host-ops/ssh-conn';
import { VopsHost, VopsHostOs, OsFamily } from './host.model';

export interface HostAddInput {
  address: string;
  user?: string;
  port?: number;
  userKeyName?: string;
  tags?: string[];
}

export interface HostProbe {
  reachable: boolean;
  message?: string;
  os?: VopsHostOs;
}

/**
 * SSH-plane inventory. A host lives in the profile store (hosts.json) and is
 * never mutated on `remove` — removing a host forgets it locally, it never
 * touches the server. Connectivity/OS probing is best-effort: an unreachable
 * host is a warning, not a failure (the machine may simply be off).
 */
@Injectable()
export class VopsHostsService {
  constructor(
    private readonly providers: ProviderFactory,
    private readonly keys: VopsSshKeysService,
    @Inject('SshExec') private readonly ssh: SshExec,
    private readonly store: LocalStore,
  ) {}

  list(): VopsHost[] {
    if (!fs.existsSync(this.hostsPath())) return [];
    const raw = JSON.parse(fs.readFileSync(this.hostsPath(), 'utf8'));
    return Array.isArray(raw?.hosts) ? (raw.hosts as VopsHost[]) : [];
  }

  get(name: string): VopsHost | undefined {
    return this.list().find((h) => h.name === name);
  }

  show(name: string): VopsHost {
    const host = this.get(name);
    if (!host) {
      throw notFound('VOPS_HOST_NOT_FOUND', `Host '${name}' not found.`, 'List the inventory with `vops host list --json`.');
    }
    return host;
  }

  remove(name: string): void {
    const hosts = this.list();
    if (!hosts.some((h) => h.name === name)) {
      throw new BadRequestException(`Host '${name}' not found.`);
    }
    this.save(hosts.filter((h) => h.name !== name));
  }

  /** Persist a modified host (used by ops services to update opsKeyInstalled/os). */
  update(host: VopsHost): void {
    const hosts = this.list().map((h) => (h.name === host.name ? host : h));
    this.save(hosts);
  }

  /** Assign (or clear) the local user key used to reach this host. */
  setUserKey(name: string, keyName?: string): VopsHost {
    const host = this.show(name);
    // Pinning a key that does not exist locally would leave the host unreachable with no
    // hint why — the dashboard picks from a list, a CLI argument is free text.
    if (keyName && !this.keys.list().some((k) => k.name === keyName)) {
      throw notFound('VOPS_SSH_KEY_NOT_FOUND', `No local SSH key named '${keyName}'.`, 'List the local keys with `vops ssh-key list --json`.');
    }
    host.userKeyName = keyName || undefined;
    this.update(host);
    return host;
  }

  /** Opt a host in/out of SSH management (false = provider-only). */
  setSshManaged(name: string, managed: boolean): VopsHost {
    const host = this.show(name);
    host.sshManaged = managed;
    this.update(host);
    return host;
  }

  async add(name: string, input: HostAddInput): Promise<{ host: VopsHost; probe: HostProbe }> {
    this.assertName(name);
    if (this.get(name)) throw new BadRequestException(`Host '${name}' already exists.`);
    const host: VopsHost = {
      name,
      address: input.address,
      user: input.user ?? 'root',
      port: input.port ?? 22,
      userKeyName: input.userKeyName,
      opsKeyInstalled: false,
      tags: input.tags ?? [],
      addedAt: new Date().toISOString(),
    };
    const probe = await this.probe(host);
    if (probe.os) host.os = probe.os;
    this.save([...this.list(), host]);
    await this.store.appendAudit('host.add', { name, address: host.address });
    return { host, probe };
  }

  /** Resolve a provider server by id or name; throws if the provider doesn't have it. */
  private async resolveProviderServer(provider: CloudProvider, serverIdOrName: string) {
    const impl = this.providers.getProvider(provider);
    const server =
      (await impl.getServerDetailsAsDto(serverIdOrName).catch(() => null)) ??
      (await impl.listServersAsDto().then((all) => all.find((s) => s.name === serverIdOrName)));
    if (!server) {
      throw new BadRequestException(`Server '${serverIdOrName}' not found on ${provider}.`);
    }
    return server;
  }

  async import(
    providerName: string,
    serverIdOrName: string,
  ): Promise<{ host: VopsHost; probe: HostProbe }> {
    const provider = resolveProvider(providerName);
    const server = await this.resolveProviderServer(provider, serverIdOrName);
    if (!server.public_ip) {
      throw new BadRequestException(`Server '${server.name}' has no public IP.`);
    }
    if (this.get(server.name)) throw new BadRequestException(`Host '${server.name}' already exists.`);
    const host: VopsHost = {
      name: server.name,
      address: server.public_ip,
      user: defaultSshUser(provider),
      port: 22,
      opsKeyInstalled: false,
      provider,
      providerServerId: server.id,
      tags: [],
      addedAt: new Date().toISOString(),
    };
    const probe = await this.probe(host);
    if (probe.os) host.os = probe.os;
    this.save([...this.list(), host]);
    await this.store.appendAudit('host.import', { provider, name: host.name });
    return { host, probe };
  }

  /**
   * Idempotent link between a provider server and the SSH plane: returns the
   * host already tracking this server, otherwise imports it. Lets the UI act on
   * a server without a separate "add host" step.
   */
  async ensureFromServer(providerName: string, serverIdOrName: string): Promise<VopsHost> {
    const provider = resolveProvider(providerName);
    const linked = this.list().find(
      (h) => h.provider === provider && (h.providerServerId === serverIdOrName || h.name === serverIdOrName),
    );
    if (linked) return linked;
    const server = await this.resolveProviderServer(provider, serverIdOrName);
    // A host may already track this machine by name without the provider link
    // (e.g. it was added as an external host). Adopt it into the provider plane
    // so Manage reuses that record instead of colliding on the unique name.
    const existing = this.get(server.name);
    if (existing) {
      const adopted: VopsHost = { ...existing, provider, providerServerId: server.id };
      if (!adopted.os) {
        const probe = await this.probe(adopted);
        if (probe.os) adopted.os = probe.os;
      }
      this.update(adopted);
      await this.store.appendAudit('host.adopt', { provider, name: adopted.name });
      return adopted;
    }
    const { host } = await this.import(provider, serverIdOrName);
    return host;
  }

  /** Connectivity + OS detection over one SSH session, caching the conn state. Best-effort.
   * With no key pinned, `resolveUserKey` picks the only usable one — but refuses to choose
   * among several, which would otherwise leave the host `no-key` and every later command blocked.
   * Trying them settles it by evidence: the key that authenticates IS this host's key. */
  private async probe(host: VopsHost): Promise<HostProbe> {
    const pinned = this.keys.resolveUserKey(host.userKeyName);
    if (pinned?.hasPrivateKey) return (await this.probeWith(host, pinned)).probe;
    if (!host.userKeyName) {
      for (const candidate of this.keys.usableUserKeys()) {
        const { probe, outcome } = await this.probeWith(host, candidate);
        if (probe.reachable) {
          host.userKeyName = candidate.name;
          return probe;
        }
        // Only an auth refusal means "wrong key". A network failure refuses every key, so
        // trying the rest would just pay the same timeout again.
        if (!outcome.reachable) return probe;
      }
    }
    const { state, message } = deriveConnState({ reachable: false, hasKey: false, authorized: false, keyKind: 'none', host });
    host.conn = { state, keyKind: 'none', reachable: false, hasKey: false, authorized: false, message, checkedAt: new Date().toISOString() };
    return { reachable: false, message: `no local key opens this host — assign one with \`vops host key set ${host.name} <key>\` (added anyway)` };
  }

  /** One attempt with one key. Returns the raw outcome alongside the probe so the caller can
   * tell "wrong key" (retry with another) from "host down" (retrying is pointless). */
  private async probeWith(host: VopsHost, uk: VopsSshKey): Promise<{ probe: HostProbe; outcome: SshOutcome }> {
    const at = new Date().toISOString();
    const res = await this.ssh.run(
      { host, keyPath: uk.privateKeyPath },
      'cat /etc/os-release 2>/dev/null || true',
      { timeoutMs: 12_000 },
    );
    const o = sshOutcome(res.code, res.stderr);
    const { state, message } = deriveConnState({ reachable: o.reachable, hasKey: true, authorized: o.authorized, keyKind: 'user', host, reason: o.reason });
    host.conn = {
      state, keyKind: 'user', keyName: uk.name, publicKey: uk.publicKey,
      reachable: o.reachable, hasKey: true, authorized: o.authorized, message, checkedAt: at,
    };
    if (res.code !== 0) {
      return { probe: { reachable: false, message: (res.stderr.trim() || 'unreachable') + ' (added anyway)' }, outcome: o };
    }
    return { probe: { reachable: true, os: parseOsRelease(res.stdout) }, outcome: o };
  }

  private assertName(name: string): void {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new BadRequestException(
        'Host name may only contain letters, digits, dot, dash and underscore.',
      );
    }
  }

  private hostsPath(): string {
    return path.join(profileDir(), 'hosts.json');
  }

  private save(hosts: VopsHost[]): void {
    const dir = profileDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.hostsPath(), JSON.stringify({ hosts }, null, 2) + '\n', { mode: 0o600 });
  }
}

const FAMILY_BY_ID: Record<string, OsFamily> = {
  debian: 'debian', ubuntu: 'debian', raspbian: 'debian',
  rhel: 'rhel', centos: 'rhel', fedora: 'rhel', rocky: 'rhel', almalinux: 'rhel', ol: 'rhel',
  alpine: 'alpine',
};

/** Parse /etc/os-release into a family + pretty label (pure, tested). */
export function parseOsRelease(text: string): VopsHostOs {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) fields[m[1]] = m[2].replaceAll(/^"|"$/g, '');
  }
  const ids = [fields.ID, ...(fields.ID_LIKE?.split(/\s+/) ?? [])].filter(Boolean);
  const family = ids.map((id) => FAMILY_BY_ID[id.toLowerCase()]).find(Boolean) ?? 'unknown';
  return { family, pretty: fields.PRETTY_NAME || fields.NAME || 'unknown' };
}
