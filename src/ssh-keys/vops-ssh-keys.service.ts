import { BadRequestException, Injectable } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProviderFactory } from '@flui-cloud/infra';
import { resolveProvider, defaultSshUser } from '../lib/providers';
import { LocalStore } from '../lib/store/local-store';
import { profileId } from '../lib/profile';
import { VopsWriteGateService } from '../safety/vops-write-gate.service';

export interface VopsSshKey {
  name: string;
  publicKey: string;
  fingerprint: string;
  privateKeyPath: string;
  /** True when the private key is available locally (enables `vops ssh`). */
  hasPrivateKey: boolean;
  /** True when the key was imported by reference (private lives outside the keystore). */
  imported: boolean;
  /** 'ops' = vops automation key (managed lifecycle); 'user' = the human's own key. */
  role: 'user' | 'ops';
}

/** Reserved name of the single, vops-managed operations key per profile. */
export const OPS_KEY_NAME = 'vops-ops';

/** The ops key and its rotation generations (vops-ops, vops-ops.next, vops-ops.prev). */
export const isOpsKeyName = (name: string): boolean =>
  name === OPS_KEY_NAME || name.startsWith(`${OPS_KEY_NAME}.`);

export interface ImportKeyInput {
  /** Path to an existing PRIVATE key you already use — referenced, never copied. */
  privateKeyPath?: string;
  /** Path to an existing PUBLIC key file. */
  publicKeyPath?: string;
  /** A public key pasted directly (ssh-ed25519 / ssh-rsa …). */
  publicKey?: string;
}

export interface SshConnectInfo {
  provider: string;
  serverId: string;
  serverName: string;
  host: string;
  user: string;
  keyName: string;
  privateKeyPath: string;
  command: string;
}

/**
 * Local SSH key manager. Private keys are generated with `ssh-keygen` and NEVER
 * leave this machine — only the public key is uploaded to a provider on demand,
 * to be referenced at server-creation time. Keys live under the vops profile dir.
 */
@Injectable()
export class VopsSshKeysService {
  constructor(
    private readonly providers: ProviderFactory,
    private readonly writeGate: VopsWriteGateService,
    private readonly store: LocalStore,
  ) {}

  create(name: string): VopsSshKey {
    this.assertName(name);
    this.assertNotReserved(name);
    const dir = this.keysDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const priv = path.join(dir, name);
    if (fs.existsSync(priv)) {
      throw new BadRequestException(`SSH key '${name}' already exists.`);
    }
    // -N "" = no passphrase; the private key stays here at 0600 (ssh-keygen sets it).
    execFileSync(
      'ssh-keygen',
      ['-t', 'ed25519', '-f', priv, '-N', '', '-C', `vops-${name}`],
      { stdio: 'ignore' },
    );
    return this.read(name);
  }

  list(): VopsSshKey[] {
    const dir = this.keysDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.pub'))
      .map((f) => this.read(f.replace(/\.pub$/, '')));
  }

  show(name: string): VopsSshKey {
    this.assertName(name);
    if (!fs.existsSync(path.join(this.keysDir(), `${name}.pub`))) {
      throw new BadRequestException(`SSH key '${name}' not found.`);
    }
    return this.read(name);
  }

  remove(name: string): void {
    this.assertName(name);
    this.assertNotReserved(name);
    const dir = this.keysDir();
    // For imported keys we only drop the pub + the reference sidecar — never the
    // user's own private key that lives outside the keystore.
    for (const p of [
      path.join(dir, name),
      path.join(dir, `${name}.pub`),
      path.join(dir, `${name}.path`),
    ]) {
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }

  /** Upload the PUBLIC key to a provider; returns the provider-side key id. */
  async register(providerName: string, name: string): Promise<{ providerKeyId: string }> {
    const provider = resolveProvider(providerName);
    this.writeGate.assertProviderWritable(provider);
    const key = this.show(name);
    const impl = this.providers.getProvider(provider);
    if (typeof impl.createSSHKey !== 'function') {
      throw new BadRequestException(`Provider '${provider}' does not support SSH key upload.`);
    }
    await this.store.appendAudit('sshkey.register', { provider, name });
    const result = await impl.createSSHKey(name, key.publicKey);
    return { providerKeyId: result.id };
  }

  private read(name: string): VopsSshKey {
    const dir = this.keysDir();
    const pubPath = path.join(dir, `${name}.pub`);
    const publicKey = fs.readFileSync(pubPath, 'utf8').trim();
    let fingerprint = '';
    try {
      fingerprint = execFileSync('ssh-keygen', ['-lf', pubPath], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)[1] ?? '';
    } catch {
      fingerprint = '';
    }
    // A `.path` sidecar means the private key was imported by reference (lives elsewhere).
    const refPath = path.join(dir, `${name}.path`);
    const imported = fs.existsSync(refPath);
    const privateKeyPath = imported
      ? fs.readFileSync(refPath, 'utf8').trim()
      : path.join(dir, name);
    return {
      name,
      publicKey,
      fingerprint,
      privateKeyPath,
      hasPrivateKey: fs.existsSync(privateKeyPath),
      imported,
      role: isOpsKeyName(name) ? 'ops' : 'user',
    };
  }

  /**
   * The single vops operations key for this profile — lazily generated (ed25519,
   * no passphrase) on first use. Everything automated authenticates with it, so
   * revoking vops access never touches the human's own keys.
   */
  ensureOpsKey(): VopsSshKey {
    return this.ensureKeyFile(OPS_KEY_NAME);
  }

  /**
   * The replacement ops key used by `rotate-ops`. Reused if it already exists —
   * NEVER regenerated silently: a host that completed its swap in an aborted run
   * trusts only this key, so regenerating it would lock vops out of that host.
   */
  ensureNextOpsKey(): VopsSshKey {
    return this.ensureKeyFile(`${OPS_KEY_NAME}.next`);
  }

  readOpsKey(suffix: '' | '.next' | '.prev' = ''): VopsSshKey | null {
    const name = OPS_KEY_NAME + suffix;
    return fs.existsSync(path.join(this.keysDir(), `${name}.pub`)) ? this.read(name) : null;
  }

  /**
   * Local private-key paths to try, in order, for an ops session: the current key,
   * then a mid-rotation replacement, then the previous generation. This stateless
   * ladder is what makes a partially-rotated fleet recoverable rather than a cliff.
   */
  opsLadder(): string[] {
    return (['', '.next', '.prev'] as const)
      .map((s) => this.readOpsKey(s))
      .filter((k): k is VopsSshKey => !!k && k.hasPrivateKey)
      .map((k) => k.privateKeyPath);
  }

  /** Promote vops-ops.next → vops-ops (old → vops-ops.prev). Idempotent / crash-safe. */
  promoteNextOpsKey(): void {
    const dir = this.keysDir();
    const p = (n: string, ext = '') => path.join(dir, n + ext);
    const move = (from: string, to: string): void => {
      for (const ext of ['', '.pub']) {
        if (fs.existsSync(p(from, ext))) fs.renameSync(p(from, ext), p(to, ext));
      }
    };
    if (fs.existsSync(p(OPS_KEY_NAME))) move(OPS_KEY_NAME, `${OPS_KEY_NAME}.prev`);
    move(`${OPS_KEY_NAME}.next`, OPS_KEY_NAME);
  }

  private ensureKeyFile(name: string): VopsSshKey {
    const dir = this.keysDir();
    if (fs.existsSync(path.join(dir, `${name}.pub`))) return this.read(name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync(
      'ssh-keygen',
      ['-t', 'ed25519', '-f', path.join(dir, name), '-N', '', '-C', `${name}:${profileId()}`],
      { stdio: 'ignore' },
    );
    return this.read(name);
  }

  /**
   * The exact authorized_keys line for the ops key: restrictive options that block
   * the lateral-movement extras (day-2 ops still run arbitrary diagnostics, so no
   * `command=` restriction) plus a recognizable `vops-ops:<profileId>` comment vops
   * uses to find its own line without parsing key material.
   */
  opsAuthorizedKeysLine(fromCidr?: string): string {
    const key = this.ensureOpsKey();
    const [type, data] = key.publicKey.split(/\s+/);
    return `${this.opsKeyOptions(fromCidr)} ${type} ${data} ${OPS_KEY_NAME}:${profileId()}`;
  }

  /** The restrictive authorized_keys options prefix for the ops key. */
  opsKeyOptions(fromCidr?: string): string {
    return [
      ...(fromCidr ? [`from="${fromCidr}"`] : []),
      'no-agent-forwarding',
      'no-X11-forwarding',
      'no-user-rc',
    ].join(',');
  }

  /** Local private-key path for host operations; null when none usable. */
  keyPathFor(keyName?: string): string | null {
    try {
      const key = this.resolveKey(keyName);
      return key.hasPrivateKey ? key.privateKeyPath : null;
    } catch {
      return null;
    }
  }

  /** The user key vops would use (explicit name, else the sole user key), or null. */
  resolveUserKey(keyName?: string): VopsSshKey | null {
    try {
      return this.resolveKey(keyName);
    } catch {
      return null;
    }
  }

  /**
   * Import a key you already use. A private key is REFERENCED (its path is recorded,
   * the secret is never copied into the keystore); a public key is stored so it can
   * be uploaded to a provider. Enough to `vops ssh` (with a private ref) or to
   * register an existing public key.
   */
  import(name: string, input: ImportKeyInput): VopsSshKey {
    this.assertName(name);
    this.assertNotReserved(name);
    const dir = this.keysDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const pubPath = path.join(dir, `${name}.pub`);
    if (fs.existsSync(pubPath)) {
      throw new BadRequestException(`SSH key '${name}' already exists.`);
    }

    let publicKey: string | undefined;
    if (input.privateKeyPath) {
      const priv = path.resolve(untilde(input.privateKeyPath));
      if (!fs.existsSync(priv)) {
        throw new BadRequestException(`Private key not found: ${priv}`);
      }
      // Derive the public key from the private one — never read/copy the secret elsewhere.
      publicKey = execFileSync('ssh-keygen', ['-y', '-f', priv], { encoding: 'utf8' }).trim();
      fs.writeFileSync(path.join(dir, `${name}.path`), priv, { mode: 0o600 });
    } else if (input.publicKeyPath) {
      publicKey = fs.readFileSync(untilde(input.publicKeyPath), 'utf8').trim();
    } else if (input.publicKey) {
      publicKey = input.publicKey.trim();
    }
    if (!publicKey) {
      throw new BadRequestException(
        'Nothing to import — provide a private key path, a public key path, or a public key string.',
      );
    }
    assertPublicKey(publicKey);
    fs.writeFileSync(pubPath, publicKey + '\n', { mode: 0o644 });
    return this.read(name);
  }

  /** Resolve how to SSH into a server: its public IP + which local private key to use. */
  async connectInfo(
    providerName: string,
    serverIdOrName: string,
    opts: { user?: string; keyName?: string } = {},
  ): Promise<SshConnectInfo> {
    const provider = resolveProvider(providerName);
    const impl = this.providers.getProvider(provider);
    const server =
      (await impl.getServerDetailsAsDto(serverIdOrName).catch(() => null)) ??
      (await this.findByName(providerName, serverIdOrName));
    if (!server) {
      throw new BadRequestException(`Server '${serverIdOrName}' not found on ${providerName}.`);
    }
    if (!server.public_ip) {
      throw new BadRequestException(`Server '${server.name}' has no public IP to connect to.`);
    }
    const key = this.resolveKey(opts.keyName);
    if (!key.hasPrivateKey) {
      throw new BadRequestException(
        `Key '${key.name}' has no local private key (public-only import). Import it with --from <privkey> to connect.`,
      );
    }
    const user = opts.user ?? defaultSshUser(provider);
    return {
      provider,
      serverId: server.id,
      serverName: server.name,
      host: server.public_ip,
      user,
      keyName: key.name,
      privateKeyPath: key.privateKeyPath,
      command: `ssh -i ${key.privateKeyPath} ${user}@${server.public_ip}`,
    };
  }

  private resolveKey(keyName?: string): VopsSshKey {
    if (keyName) return this.show(keyName);
    // The ops key is automation-only — never the implicit choice for a human session.
    const usable = this.list().filter((k) => k.hasPrivateKey && k.role === 'user');
    if (usable.length === 1) return usable[0];
    if (usable.length === 0) {
      throw new BadRequestException('No usable SSH key found. Create or import one first.');
    }
    throw new BadRequestException(
      `Multiple SSH keys available (${usable.map((k) => k.name).join(', ')}). Choose one with --key.`,
    );
  }

  private async findByName(providerName: string, name: string) {
    const provider = resolveProvider(providerName);
    const servers = await this.providers.getProvider(provider).listServersAsDto();
    return servers.find((s) => s.name === name) ?? null;
  }

  private assertName(name: string): void {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new BadRequestException(
        'Key name may only contain letters, digits, dot, dash and underscore.',
      );
    }
  }

  private assertNotReserved(name: string): void {
    if (isOpsKeyName(name)) {
      throw new BadRequestException(
        `'${name}' is a reserved vops operations key name (managed lifecycle). ` +
          `Use 'vops host key install-ops' / 'vops ssh-key rotate-ops' instead.`,
      );
    }
  }

  private keysDir(): string {
    const base = process.env.VOPS_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'vops');
    const profile = process.env.VOPS_PROFILE ?? 'default';
    return path.join(base, 'profiles', profile, 'keys');
  }
}

function untilde(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function assertPublicKey(key: string): void {
  if (!/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+)\s+\S+/.test(key)) {
    throw new BadRequestException(
      'That does not look like an OpenSSH public key (expected e.g. "ssh-ed25519 AAAA...").',
    );
  }
}
