export type RemoteDeviceRole = 'viewer' | 'approver' | 'admin';
export type RemoteDeviceStatus = 'pending' | 'active' | 'suspended' | 'revoked';

export interface RemoteDeviceRestrictions {
  projects: string[];
  targets: string[];
  environments: Array<'development' | 'staging' | 'production'>;
  maxRisk: 'read_only' | 'low' | 'medium' | 'high' | 'destructive';
  approvalKinds: string[];
  maxProviderSpendEur: number;
  validUntil?: string;
}

export interface RemoteDevice {
  id: string;
  routeId: string;
  label: string;
  role: RemoteDeviceRole;
  status: RemoteDeviceStatus;
  signingPublicKey: string;
  exchangePublicKey: string;
  keyId: string;
  restrictions: RemoteDeviceRestrictions;
  pairedAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  suspendedAt?: string;
}

export type RemotePairingStatus =
  | 'pending'
  | 'hello_received'
  | 'confirmed'
  | 'expired'
  | 'cancelled';

export interface RemotePairingSession {
  id: string;
  nodeId: string;
  challenge: string;
  status: RemotePairingStatus;
  createdAt: string;
  expiresAt: string;
  deviceRouteId?: string;
  deviceSigningPublicKey?: string;
  deviceExchangePublicKey?: string;
  challengeSignature?: string;
  confirmedDeviceId?: string;
}

export interface RemoteNodePublicIdentity {
  nodeId: string;
  keyId: string;
  signingPublicKey: string;
  exchangePublicKey: string;
  fingerprint: string;
}

export const DEFAULT_DEVICE_RESTRICTIONS: RemoteDeviceRestrictions = {
  projects: [],
  targets: [],
  environments: ['development', 'staging'],
  maxRisk: 'medium',
  approvalKinds: ['plan', 'operation'],
  maxProviderSpendEur: 0,
};

export interface RemoteConversation {
  id: string;
  deviceId: string;
  title: string;
  status: 'active' | 'archived';
  agentProvider: string;
  agentThreadId?: string;
  agentSessionId: string;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteConversationMessage {
  id: string;
  conversationId: string;
  requestId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'status';
  content: string;
  createdAt: string;
}

export interface RemoteIntent {
  id: string;
  deviceId: string;
  version: number;
  objective: string;
  status:
    | 'active'
    | 'paused'
    | 'triggered'
    | 'executing'
    | 'succeeded'
    | 'failed'
    | 'expired'
    | 'revoked';
  trigger: {
    type: 'catalog.availability';
    provider: string;
    serverType: string;
    location?: string;
  };
  action: {
    capability: string;
    input: Record<string, unknown>;
    environment: 'development' | 'staging' | 'production';
    target?: string;
  };
  constraints: {
    expiresAt: string;
    maxExecutions: 1;
    maxSpendEur: number;
    failureBehavior: 'stop';
  };
  agentSessionId: string;
  planId: string;
  planHash: string;
  approvalId: string;
  executionCount: number;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  matchedAt?: string;
  operationId?: string;
  lastError?: string;
}
