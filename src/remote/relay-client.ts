import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import WebSocket from 'ws';
import { ensureVaultUnlocked } from '../lib/keyring/unlock';
import { VaultLockedError } from '../lib/keyring/vault-session';
import { RemoteConfig, RemoteConfigStore } from './remote-config';
import {
  RelayInboundFrame,
  RelayOutboundFrame,
  RemoteEnvelopeV1,
  RemoteTransportStatus,
} from './remote-transport.types';
import { RemoteStore } from './remote-store';
import { RemoteDevice } from './remote-model';

const HEARTBEAT_MS = 20_000;
const DEAD_CONNECTION_MS = 65_000;
const MAX_RECONNECT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

type FrameHandler = (frame: RelayInboundFrame) => void | Promise<void>;

@Injectable()
export class RelayClient implements OnApplicationShutdown {
  private readonly configStore = new RemoteConfigStore();
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopping = false;
  private connecting?: Promise<void>;
  private handlers = new Set<FrameHandler>();
  private statusValue: RemoteTransportStatus = emptyStatus();

  constructor(private readonly remoteStore: RemoteStore) {}

  status(): RemoteTransportStatus {
    const { config, vaultLocked } = this.configStore.readSafe();
    if (vaultLocked) return { ...this.statusValue, enabled: true, state: 'vault_locked' };
    if (!config?.enabled) {
      return {
        ...this.statusValue,
        enabled: false,
        state: 'disabled',
        ...(config ? { nodeId: config.nodeId, relayUrl: config.relayUrl } : {}),
      };
    }
    return {
      ...this.statusValue,
      enabled: true,
      state: this.statusValue.state === 'disabled' ? 'offline' : this.statusValue.state,
      nodeId: config.nodeId,
      relayUrl: config.relayUrl,
    };
  }

  async enable(relayUrl?: string, interactive = true): Promise<RemoteTransportStatus> {
    await ensureVaultUnlocked({ interactive });
    const config = this.configStore.candidate(relayUrl);
    await this.verifyRelay(config.relayUrl);
    this.configStore.save(config);
    this.stopping = false;
    await this.connect(config);
    return this.status();
  }

  async disable(interactive = true): Promise<RemoteTransportStatus> {
    await ensureVaultUnlocked({ interactive });
    this.configStore.disable();
    this.stopConnection();
    this.statusValue = { ...this.statusValue, enabled: false, state: 'disabled', reconnectAttempt: 0 };
    return this.status();
  }

  async startConfigured(): Promise<void> {
    const { config, vaultLocked } = this.configStore.readSafe();
    if (vaultLocked) {
      this.statusValue = { ...this.statusValue, enabled: true, state: 'vault_locked' };
      return;
    }
    if (!config?.enabled) return;
    this.stopping = false;
    await this.connect(config).catch((error) => this.onConnectionFailure(error, config));
  }

  stopConnection(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = undefined;
    this.heartbeatTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'remote disabled');
  }

  onApplicationShutdown(): void {
    this.stopConnection();
  }

  onFrame(handler: FrameHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  sendEnvelope(envelope: RemoteEnvelopeV1): void {
    this.send({ type: 'envelope', envelope });
  }

  acknowledge(messageId: string): void {
    this.send({ type: 'delivery.ack', message_id: messageId });
  }

  async registerPairing(pairingId: string, expiresAt: string): Promise<void> {
    const config = this.requireEnabledConfig();
    await requestJson(`${config.relayUrl}/api/remote/pairings`, {
      method: 'POST',
      headers: this.authHeaders(config, true),
      body: JSON.stringify({ pairingId, expiresAt }),
    });
  }

  async setDeviceRouteState(
    routeId: string,
    state: Pick<RemoteDevice, 'status'>['status'],
  ): Promise<void> {
    const config = this.requireEnabledConfig();
    await this.updateDeviceRoute(config, routeId, state);
  }

  async wakeDeviceRoute(routeId: string): Promise<'sent' | 'coalesced' | 'unavailable'> {
    const config = this.requireEnabledConfig();
    const result = await requestJson<{ state?: 'sent' | 'coalesced' | 'unavailable' }>(
      `${config.relayUrl}/api/remote/devices/${encodeURIComponent(routeId)}/wake`,
      {
        method: 'POST',
        headers: this.authHeaders(config),
      },
    );
    return result.state ?? 'unavailable';
  }

  private async connect(config: RemoteConfig): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting = this.open(config).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(config: RemoteConfig): Promise<void> {
    this.statusValue = {
      ...this.statusValue,
      enabled: true,
      state: this.statusValue.reconnectAttempt ? 'reconnecting' : 'connecting',
      nodeId: config.nodeId,
      relayUrl: config.relayUrl,
      lastError: undefined,
    };
    await this.register(config);
    await this.reconcileDeviceRoutes(config);
    const ticket = await this.ticket(config);
    const socketUrl = new URL(config.relayUrl);
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    socketUrl.pathname = `${socketUrl.pathname.replace(/\/$/, '')}/api/remote/socket`;
    socketUrl.searchParams.set('ticket', ticket);
    const socket = new WebSocket(socketUrl);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('relay WebSocket handshake timed out')), REQUEST_TIMEOUT_MS);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const now = new Date().toISOString();
    this.statusValue = {
      ...this.statusValue,
      state: 'online',
      connectedAt: now,
      lastMessageAt: now,
      reconnectAttempt: 0,
      lastError: undefined,
    };
    socket.on('message', (data) => void this.receive(data.toString()));
    socket.on('close', () => this.onClosed(config));
    socket.on('error', () => {
      // Close schedules reconnect. Content and credentials are never logged.
    });
    this.startHeartbeat(config);
  }

  private async receive(raw: string): Promise<void> {
    let frame: RelayInboundFrame;
    try {
      frame = JSON.parse(raw) as RelayInboundFrame;
    } catch {
      this.socket?.close(4002, 'invalid relay JSON');
      return;
    }
    this.statusValue = {
      ...this.statusValue,
      lastMessageAt: new Date().toISOString(),
      messagesReceived: this.statusValue.messagesReceived + 1,
    };
    for (const handler of this.handlers) await handler(frame);
  }

  private send(frame: RelayOutboundFrame): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('The remote relay is not connected.');
    }
    this.socket.send(JSON.stringify(frame));
    this.statusValue = { ...this.statusValue, messagesSent: this.statusValue.messagesSent + 1 };
  }

  private startHeartbeat(config: RemoteConfig): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      const last = Date.parse(this.statusValue.lastMessageAt ?? this.statusValue.connectedAt ?? '');
      if (Number.isFinite(last) && Date.now() - last > DEAD_CONNECTION_MS) {
        this.socket?.terminate();
        return;
      }
      try {
        this.send({ type: 'relay.ping', request_id: `ping_${Date.now()}` });
      } catch (error) {
        this.onConnectionFailure(error, config);
      }
    }, jitter(HEARTBEAT_MS, 0.1));
    this.heartbeatTimer.unref();
  }

  private onClosed(config: RemoteConfig): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.socket = undefined;
    if (!this.stopping) this.scheduleReconnect(config, new Error('relay connection closed'));
  }

  private onConnectionFailure(error: unknown, config: RemoteConfig): void {
    this.socket?.terminate();
    this.socket = undefined;
    if (!this.stopping) this.scheduleReconnect(config, error);
  }

  private scheduleReconnect(config: RemoteConfig, error: unknown): void {
    if (this.reconnectTimer) return;
    const attempt = this.statusValue.reconnectAttempt + 1;
    const base = Math.min(MAX_RECONNECT_MS, 1_000 * 2 ** Math.min(attempt - 1, 6));
    const delay = jitter(base, 0.25);
    this.statusValue = {
      ...this.statusValue,
      state: 'reconnecting',
      reconnectAttempt: attempt,
      lastError: safeError(error),
    };
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(config).catch((nextError) => this.onConnectionFailure(nextError, config));
    }, delay);
    this.reconnectTimer.unref();
  }

  private async register(config: RemoteConfig): Promise<void> {
    await requestJson(`${config.relayUrl}/api/remote/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ routeId: config.nodeId, transportToken: config.transportToken }),
    });
  }

  private async reconcileDeviceRoutes(config: RemoteConfig): Promise<void> {
    const devices = await this.remoteStore.listDevices();
    const results = await Promise.allSettled(
      devices.map((device) => this.updateDeviceRoute(config, device.routeId, device.status)),
    );
    const failures = results.filter((result) => result.status === 'rejected').length;
    if (failures) {
      this.statusValue = {
        ...this.statusValue,
        lastError: `Could not reconcile ${failures} remote device route${failures === 1 ? '' : 's'}.`,
      };
    }
  }

  private async updateDeviceRoute(
    config: RemoteConfig,
    routeId: string,
    state: Pick<RemoteDevice, 'status'>['status'],
  ): Promise<void> {
    await requestJson(`${config.relayUrl}/api/remote/devices/${encodeURIComponent(routeId)}/state`, {
      method: 'POST',
      headers: this.authHeaders(config, true),
      body: JSON.stringify({ state }),
    });
  }

  private async ticket(config: RemoteConfig): Promise<string> {
    const body = await requestJson<{ ticket?: string }>(`${config.relayUrl}/api/remote/tickets`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.transportToken}`,
        'X-Vops-Route-Id': config.nodeId,
        Accept: 'application/json',
      },
    });
    if (!body.ticket) throw new Error('relay did not return a transport ticket');
    return body.ticket;
  }

  private requireEnabledConfig(): RemoteConfig {
    const config = this.configStore.read();
    if (!config?.enabled) throw new Error('Remote transport is not enabled.');
    return config;
  }

  private authHeaders(config: RemoteConfig, json = false): Record<string, string> {
    return {
      Authorization: `Bearer ${config.transportToken}`,
      'X-Vops-Route-Id': config.nodeId,
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private async verifyRelay(relayUrl: string): Promise<void> {
    const body = await requestJson<{ protocolVersion?: number; authority?: string }>(`${relayUrl}/api/remote`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (body.protocolVersion !== 1 || body.authority !== 'opaque-relay-only') {
      throw new Error('The endpoint is not a compatible opaque vOps relay.');
    }
  }
}

async function requestJson<T = unknown>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  if (!response.ok) throw new Error(`relay request failed (HTTP ${response.status})`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

function emptyStatus(): RemoteTransportStatus {
  return {
    enabled: false,
    state: 'disabled',
    reconnectAttempt: 0,
    messagesSent: 0,
    messagesReceived: 0,
  };
}

function safeError(error: unknown): string {
  if (error instanceof VaultLockedError) return 'The local vault is locked.';
  return error instanceof Error ? error.message : 'Relay connection failed.';
}

function jitter(value: number, ratio: number): number {
  return Math.max(250, Math.round(value * (1 - ratio + Math.random() * ratio * 2)));
}
