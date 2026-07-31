import { Injectable } from '@nestjs/common';
import { LocalConfigStore } from '../lib/config/local-config-store';

export interface CredentialReference {
  id: string;
  kind: 'provider_account' | 'ssh_identity';
  configured: boolean;
}

/**
 * Resolves logical references inside the trusted local process. This service
 * deliberately has no method that returns a secret to MCP, UI, or CLI output.
 */
@Injectable()
export class CredentialResolver {
  private readonly store = new LocalConfigStore();

  listProviderReferences(): CredentialReference[] {
    return this.store.listConfigured().map((provider) => ({
      id: `provider:${provider}`,
      kind: 'provider_account',
      configured: true,
    }));
  }

  assertProviderReference(reference: string): string {
    if (!reference.startsWith('provider:')) throw new Error(`Invalid provider credential reference '${reference}'.`);
    const provider = reference.slice('provider:'.length);
    if (!this.store.listConfigured().includes(provider)) {
      throw new Error(`Credential reference '${reference}' is not configured.`);
    }
    return provider;
  }
}
