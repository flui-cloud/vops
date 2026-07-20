import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

/**
 * Local-first encrypted store for vops. Secrets (provider tokens / key pairs)
 * live under ~/.config/vops/profiles/<profile>/secrets.json.enc, encrypted with
 * AES-256-GCM using a per-profile random key file. Nothing is sent anywhere.
 *
 * Crypto layout (documented for the future Go port): the on-disk value is
 * `iv(hex):authTag(hex):ciphertext(hex)`; the key is 32 raw bytes in `.key`.
 */
export class LocalConfigStore {
  private readonly profileDir: string;
  private readonly secretsPath: string;
  private readonly keyPath: string;

  constructor(profile = process.env.VOPS_PROFILE ?? 'default') {
    const base = process.env.VOPS_CONFIG_DIR ??
      path.join(os.homedir(), '.config', 'vops');
    this.profileDir = path.join(base, 'profiles', profile);
    this.secretsPath = path.join(this.profileDir, 'secrets.json.enc');
    this.keyPath = path.join(this.profileDir, '.key');
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

  private readSecrets(): {
    tokens?: Record<string, string>;
    credentials?: Record<string, Record<string, string>>;
  } {
    if (!fs.existsSync(this.secretsPath)) return {};
    const decrypted = this.decrypt(fs.readFileSync(this.secretsPath, 'utf8'));
    return JSON.parse(decrypted);
  }

  private writeSecrets(secrets: unknown): void {
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
