import {
  CloudProvider,
  CredentialType,
  CredentialFieldDefinition,
} from '@flui-cloud/infra';

/** Per-provider credential state for the UI. Carries field metadata, never values. */
export interface VopsCredentialStatus {
  provider: CloudProvider;
  displayName: string;
  credentialType: CredentialType;
  fields: CredentialFieldDefinition[];
  configured: boolean;
}

export interface VopsCredentialSaveResult {
  provider: CloudProvider;
  configured: true;
  validation: { ok: boolean; message: string | null };
}
