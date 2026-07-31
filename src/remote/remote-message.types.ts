export interface RemoteSyncRequest {
  type: 'sync.request';
  request_id: string;
}

export interface RemoteChatUserMessage {
  type: 'chat.user_message';
  request_id: string;
  conversation_id?: string;
  provider?: import('./remote-agent.types').CodingAgentProviderId;
  content: string;
}

export interface RemoteChatCancelMessage {
  type: 'chat.cancel';
  request_id: string;
  target_request_id: string;
  conversation_id?: string;
}

export type SignedRemoteCommandType =
  | 'approval.decision'
  | 'operation.cancel_request'
  | 'operation.rollback_request'
  | 'agent.pause_request'
  | 'agent.resume_request'
  | 'agent.revoke_request'
  | 'agents.stop_all_request'
  | 'notification.dismiss_request'
  | 'intent.create_request'
  | 'intent.pause_request'
  | 'intent.revoke_request';

export interface SignedRemoteCommandPayload {
  protocol_version: 1;
  command_id: string;
  device_id: string;
  node_id: string;
  type: SignedRemoteCommandType;
  subject: {
    kind: 'approval' | 'operation' | 'agent_session' | 'notification' | 'intent' | 'control_node';
    id: string;
    version: number;
  };
  plan_hash?: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
  parameters: Record<string, unknown>;
}

export interface SignedRemoteCommandV1 {
  payload: SignedRemoteCommandPayload;
  key_id: string;
  signature: string;
}

export interface RemoteCommandRequest {
  type: 'remote.command';
  request_id: string;
  signed_command: SignedRemoteCommandV1;
}

export type RemoteInboundPayload =
  | RemoteSyncRequest
  | RemoteChatUserMessage
  | RemoteChatCancelMessage
  | RemoteCommandRequest;

export interface RemoteSyncSnapshot {
  type: 'sync.snapshot';
  request_id: string;
  generated_at: string;
  control_node: {
    state: 'online';
    authority: 'local';
    emergency_stop: boolean;
  };
  devices: { active: number };
  agents: {
    active: number;
    paused: number;
  };
  agent_providers: import('./remote-agent.types').AgentProviderStatus[];
  agent_policy: {
    default_provider: import('./remote-agent.types').CodingAgentProviderId;
    fallback_order: import('./remote-agent.types').CodingAgentProviderId[];
    deterministic_fallback: boolean;
  };
  agent_sessions: Array<{
    id: string;
    version: number;
    display_name: string;
    objective: string;
    status: string;
    project: string;
    expires_at: string;
  }>;
  approvals: Array<{
    id: string;
    version: number;
    status: string;
    reason: string;
    risk: string;
    target?: string;
    environment?: string;
    expires_at: string;
    plan?: {
      id: string;
      hash: string;
      objective: string;
      session_id: string;
      steps: Array<{ id: string; capability: string; input: Record<string, unknown>; risk: string }>;
      expected_effects: string[];
      excluded_effects: string[];
      rollback: { available: boolean; limitations: string[] };
    };
  }>;
  operations: Array<{
    id: string;
    version: number;
    state: string;
    capability?: string;
    updated_at: string;
    rollback_available: boolean;
  }>;
  targets: Array<{
    name: string;
    provider?: string;
    address?: string;
  }>;
  applications: Array<{
    name: string;
    status?: string;
    target?: string;
  }>;
  conversations: Array<{
    id: string;
    title: string;
    status: string;
    provider: string;
    updated_at: string;
  }>;
  intents: Array<{
    id: string;
    device_id: string;
    version: number;
    objective: string;
    status: string;
    trigger: Record<string, unknown>;
    action: Record<string, unknown>;
    constraints: Record<string, unknown>;
    plan_id: string;
    plan_hash: string;
    execution_count: number;
    created_at: string;
    updated_at: string;
    last_checked_at?: string;
    matched_at?: string;
    operation_id?: string;
    last_error?: string;
  }>;
}

export type RemoteChatOutbound =
  | {
      type: 'chat.accepted';
      request_id: string;
      conversation_id: string;
      provider: string;
    }
  | {
      type: 'chat.status';
      request_id: string;
      conversation_id: string;
      status: 'thinking' | 'using_tool';
      detail?: string;
    }
  | {
      type: 'chat.text_delta';
      request_id: string;
      conversation_id: string;
      sequence: number;
      delta: string;
    }
  | {
      type: 'chat.completed';
      request_id: string;
      conversation_id: string;
      message_id: string;
      final_sequence: number;
      provider: string;
    }
  | {
      type: 'chat.cancelled';
      request_id: string;
      target_request_id: string;
      conversation_id?: string;
      authoritative: true;
      already_terminal?: boolean;
    }
  | {
      type: 'chat.failed';
      request_id: string;
      conversation_id?: string;
      code: string;
      message: string;
      recoverable: boolean;
    };

export function parseRemoteInboundPayload(value: unknown): RemoteInboundPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Remote payload must be an object.');
  }
  const row = value as Record<string, unknown>;
  const requestId = boundedString(row.request_id, 'request_id', 128);
  if (row.type === 'sync.request') {
    return { type: 'sync.request', request_id: requestId };
  }
  if (row.type === 'chat.user_message') {
    const content = boundedString(row.content, 'content', 8_000).trim();
    if (!content) throw new Error('Remote chat content cannot be empty.');
    return {
      type: 'chat.user_message',
      request_id: requestId,
      content,
      ...(row.provider
        ? { provider: parseProvider(row.provider) }
        : {}),
      ...(row.conversation_id
        ? { conversation_id: boundedString(row.conversation_id, 'conversation_id', 128) }
        : {}),
    };
  }
  if (row.type === 'chat.cancel') {
    return {
      type: 'chat.cancel',
      request_id: requestId,
      target_request_id: boundedString(row.target_request_id, 'target_request_id', 128),
      ...(row.conversation_id
        ? { conversation_id: boundedString(row.conversation_id, 'conversation_id', 128) }
        : {}),
    };
  }
  if (row.type === 'remote.command') {
    if (!row.signed_command || typeof row.signed_command !== 'object' || Array.isArray(row.signed_command)) {
      throw new Error('Remote signed_command must be an object.');
    }
    return {
      type: 'remote.command',
      request_id: requestId,
      signed_command: row.signed_command as SignedRemoteCommandV1,
    };
  }
  throw new Error(`Unsupported remote payload type '${String(row.type)}'.`);
}

function parseProvider(value: unknown): import('./remote-agent.types').CodingAgentProviderId {
  const provider = boundedString(value, 'provider', 80);
  const supported = [
    'codex',
    'claude-code',
    'opencode',
    'antigravity',
    'openai-compatible',
  ];
  if (!supported.includes(provider)) throw new Error(`Unsupported remote provider '${provider}'.`);
  return provider as import('./remote-agent.types').CodingAgentProviderId;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new Error(`Remote ${field} must be between 1 and ${max} characters.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`Remote ${field} contains unsupported control characters.`);
  }
  return value;
}
