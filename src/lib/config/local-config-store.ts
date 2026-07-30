import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { requireVaultKey } from '../keyring/vault-session';
import {
  VaultSecrets,
  readHeader,
  readWith,
  vaultExists,
  writeVault,
} from '../keyring/vault-store';

/**
 * Local-first encrypted store for vops. Secrets (provider tokens / key pairs)
 * live under ~/.config/vops/profiles/<profile>/ and never leave the machine.
 *
 * Two on-disk formats, chosen by what is actually present:
 *
 * - **vault** (`secrets.vault.json`) — the key is derived from the user's
 *   passphrase and exists only in memory. Preferred whenever the file exists.
 * - **legacy** (`secrets.json.enc` + `.key`) — the key sat in a file next to the
 *   ciphertext, so anything able to read one could read the other. Still read and
 *   written so an existing install keeps working untouched; `vops keyring init`
 *   moves it across.
 *
 * Crypto layout (documented for the future Go port): both formats store
 * `iv(hex):authTag(hex):ciphertext(hex)` under AES-256-GCM.
 */
export class LocalConfigStore {
  readonly profileDir: string;
  private readonly secretsPath: string;
  private readonly keyPath: string;

  constructor(profile = process.env.VOPS_PROFILE ?? 'default') {
    const base = process.env.VOPS_CONFIG_DIR ??
      path.join(os.homedir(), '.config', 'vops');
    this.profileDir = path.join(base, 'profiles', profile);
    this.secretsPath = path.join(this.profileDir, 'secrets.json.enc');
    this.keyPath = path.join(this.profileDir, '.key');
  }

  /** True once the profile has been moved to the passphrase-derived vault. */
  get sealed(): boolean {
    return vaultExists(this.profileDir);
  }

  getToken(provider: string): string | null {
    return this.readSecrets().tokens?.[provider] ?? null;
  }

  listConfigured(): string[] {
    const secrets = this.readSecrets();
    return [
      ...new Set([
        ...Object.keys(secrets.tokens ?? {}),
        ...Object.keys(secrets.credentials ?? {}),
      ]),
    ];
  }

  getCredentials(provider: string): Record<string, string> | null {
    return this.readSecrets().credentials?.[provider] ?? null;
  }

  setToken(provider: string, token: string): void {
    const secrets = this.readSecrets();
    secrets.tokens = { ...secrets.tokens, [provider]: token };
    this.writeSecrets(secrets);
  }

  setCredentials(provider: string, creds: Record<string, string>): void {
    const secrets = this.readSecrets();
    secrets.credentials = { ...secrets.credentials, [provider]: creds };
    this.writeSecrets(secrets);
  }

  remove(provider: string): void {
    const secrets = this.readSecrets();
    delete secrets.tokens?.[provider];
    delete secrets.credentials?.[provider];
    this.writeSecrets(secrets);
  }

  /** Environment-style credentials adopted out of a plaintext `.env`. */
  getEnv(): Record<string, string> {
    return this.readSecrets().env ?? {};
  }

  setEnv(entries: Record<string, string>): void {
    const secrets = this.readSecrets();
    secrets.env = { ...secrets.env, ...entries };
    this.writeSecrets(secrets);
  }

  removeEnv(names: string[]): void {
    const secrets = this.readSecrets();
    for (const name of names) delete secrets.env?.[name];
    this.writeSecrets(secrets);
  }

  /** `--set` values behind an approved deploy plan. Kept out of `listConfigured()`: they are
   * inputs to one deployment, not a provider the user configured. */
  getPlanSecrets(planId: string): Record<string, string> | null {
    return this.readSecrets().planSecrets?.[planId] ?? null;
  }

  setPlanSecrets(planId: string, values: Record<string, string>): void {
    const secrets = this.readSecrets();
    secrets.planSecrets = { ...secrets.planSecrets, [planId]: values };
    this.writeSecrets(secrets);
  }

  removePlanSecrets(planId: string): void {
    const secrets = this.readSecrets();
    delete secrets.planSecrets?.[planId];
    this.writeSecrets(secrets);
  }

  private readSecrets(): VaultSecrets {
    if (this.sealed) return readWith(this.profileDir, requireVaultKey());
    if (!fs.existsSync(this.secretsPath)) return {};
    return JSON.parse(this.decrypt(fs.readFileSync(this.secretsPath, 'utf8'))) as VaultSecrets;
  }

  private writeSecrets(secrets: VaultSecrets): void {
    if (this.sealed) {
      writeVault(this.profileDir, secrets, requireVaultKey(), readHeader(this.profileDir));
      return;
    }
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.secretsPath, this.encrypt(JSON.stringify(secrets)), {
      mode: 0o600,
    });
  }

  private getKey(): Buffer {
    if (fs.existsSync(this.keyPath)) return fs.readFileSync(this.keyPath);
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    return key;
  }

  private encrypt(plain: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getKey(), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
  }

  private decrypt(payload: string): string {
    const [ivHex, tagHex, dataHex] = payload.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.getKey(),
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }
}
