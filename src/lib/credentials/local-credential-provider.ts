import { Injectable, NotFoundException } from '@nestjs/common';
import { ICredentialProvider } from '@flui-cloud/infra';
import { CloudProvider } from '@flui-cloud/infra';
import { BearerTokenDto } from '@flui-cloud/infra';
import { LocalConfigStore } from '../config/local-config-store';

const CONTABO_TOKEN_URL =
  'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token';

/**
 * File-backed ICredentialProvider for vops. Lets the shared provider services
 * run locally with tokens read from the encrypted local store / environment —
 * never a DB, never a remote backend.
 */
@Injectable()
export class LocalCredentialProvider implements ICredentialProvider {
  private readonly store = new LocalConfigStore();
  private contaboToken: { value: BearerTokenDto; expiresAt: number } | null = null;

  async getActiveApiToken(provider: CloudProvider): Promise<string> {
    const name = this.name(provider);
    if (provider === CloudProvider.SCALEWAY) {
      const creds = this.store.getCredentials(name);
      if (!creds?.secretKey) throw this.missing(name);
      return creds.secretKey;
    }
    const token = this.store.getToken(name);
    if (!token) throw this.missing(name);
    return token;
  }

  async getActiveAccessKeyPair(
    provider: CloudProvider,
  ): Promise<{ accessKey: string; secretKey: string }> {
    const name = this.name(provider);
    const creds = this.store.getCredentials(name);
    if (!creds?.accessKey || !creds?.secretKey) throw this.missing(name);
    return { accessKey: creds.accessKey, secretKey: creds.secretKey };
  }

  /**
   * Contabo uses OAuth2 (password grant). Exchange the client + user credentials
   * for a bearer token and cache it until shortly before it expires. Credentials
   * come from the environment (CONTABO_CLIENT_ID / _CLIENT_SECRET / _API_USER /
   * _API_PASSWORD) — nothing leaves this machine except the auth request itself.
   */
  async getActiveBearerToken(provider: CloudProvider): Promise<BearerTokenDto> {
    if (provider !== CloudProvider.CONTABO) {
      throw new Error(`Bearer token authentication is not supported for ${provider}.`);
    }
    if (this.contaboToken && this.contaboToken.expiresAt > Date.now()) {
      return this.contaboToken.value;
    }

    const clientId = process.env.CONTABO_CLIENT_ID;
    const clientSecret = process.env.CONTABO_CLIENT_SECRET;
    const username = process.env.CONTABO_API_USER;
    const password = process.env.CONTABO_API_PASSWORD;
    if (!clientId || !clientSecret || !username || !password) {
      throw this.missing(
        'contabo (set CONTABO_CLIENT_ID, CONTABO_CLIENT_SECRET, CONTABO_API_USER, CONTABO_API_PASSWORD)',
      );
    }

    const res = await fetch(CONTABO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: clientId,
        client_secret: clientSecret,
        username,
        password,
      }),
    });
    if (!res.ok) {
      throw new Error(`Contabo authentication failed (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
    };
    const token: BearerTokenDto = {
      access_token: data.access_token,
      token_type: 'Bearer',
      expires_in: data.expires_in,
      refresh_token: data.refresh_token,
    };
    // Refresh 30s before the real expiry (default 5 min if unspecified).
    const ttlMs = ((data.expires_in ?? 300) - 30) * 1000;
    this.contaboToken = { value: token, expiresAt: Date.now() + ttlMs };
    return token;
  }

  private name(provider: CloudProvider): string {
    if (provider === CloudProvider.HETZNER) return 'hetzner';
    if (provider === CloudProvider.SCALEWAY) return 'scaleway';
    if (provider === CloudProvider.CONTABO) return 'contabo';
    if (provider === CloudProvider.OVH) return 'ovh';
    throw new Error(`Unsupported provider: ${provider}`);
  }

  private missing(name: string): NotFoundException {
    return new NotFoundException(
      `No credentials configured for ${name}. Run: vops config set ${name}`,
    );
  }
}
