export type RemoteTransportState =
  | 'disabled'
  | 'vault_locked'
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline';

export interface RemoteTransportStatus {
  enabled: boolean;
  state: RemoteTransportState;
  nodeId?: string;
  relayUrl?: string;
  connectedAt?: string;
  lastMessageAt?: string;
  lastError?: string;
  reconnectAttempt: number;
  messagesSent: number;
  messagesReceived: number;
}

export interface RemoteEnvelopeV1 {
  protocol_version: 1;
  message_id: string;
  sender_id: string;
  recipient_id: string;
  channel:
    | 'presence'
    | 'notification'
    | 'state_sync'
    | 'chat_request'
    | 'chat_stream'
    | 'approval'
    | 'remote_command'
    | 'delivery_ack'
    | 'key_management';
  created_at: string;
  expires_at: string;
  key_id: string;
  sequence: number;
  ciphertext: string;
}

export type RelayInboundFrame =
  | { type: 'relay.ready'; route_id: string; protocol_version: 1; heartbeat_seconds: number }
  | { type: 'relay.ack'; message_id: string; state: string; reason?: string }
  | { type: 'relay.delivery'; message_id: string; state: 'received' | 'expired' }
  | { type: 'relay.pong'; request_id?: string; at: string }
  | PairingHelloFrame
  | { type: 'envelope'; envelope: RemoteEnvelopeV1 };

export interface PairingHelloFrame {
  type: 'pairing.hello';
  pairing_id: string;
  device_route_id: string;
  signing_public_key: string;
  exchange_public_key: string;
  challenge_signature: string;
}

export type RelayOutboundFrame =
  | { type: 'relay.ping'; request_id: string }
  | { type: 'delivery.ack'; message_id: string }
  | { type: 'envelope'; envelope: RemoteEnvelopeV1 };
