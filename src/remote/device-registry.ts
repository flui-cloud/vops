import { Injectable } from '@nestjs/common';
import { AgentStore } from '../agent-control/agent-store';
import { localId } from '../agent-control/ids';
import {
  DEFAULT_DEVICE_RESTRICTIONS,
  RemoteDevice,
  RemoteDeviceRestrictions,
  RemoteDeviceRole,
} from './remote-model';
import { RemoteStore } from './remote-store';
import { RelayClient } from './relay-client';
import { IntentService } from './intent.service';

@Injectable()
export class DeviceRegistry {
  constructor(
    private readonly store: RemoteStore,
    private readonly audit: AgentStore,
    private readonly relay: RelayClient,
    private readonly intents: IntentService,
  ) {}

  async register(input: {
    routeId: string;
    label: string;
    role: RemoteDeviceRole;
    signingPublicKey: string;
    exchangePublicKey: string;
    keyId: string;
    restrictions?: Partial<RemoteDeviceRestrictions>;
  }): Promise<RemoteDevice> {
    const existing = await this.store.getDeviceByRoute(input.routeId);
    if (existing && existing.status !== 'revoked') throw new Error('This device route is already paired.');
    const now = new Date().toISOString();
    const device: RemoteDevice = {
      id: localId('device'),
      routeId: input.routeId,
      label: cleanLabel(input.label),
      role: input.role,
      status: 'active',
      signingPublicKey: input.signingPublicKey,
      exchangePublicKey: input.exchangePublicKey,
      keyId: input.keyId,
      restrictions: normalizeRestrictions(input.role, input.restrictions),
      pairedAt: now,
      updatedAt: now,
    };
    await this.store.saveDevice(device);
    await this.event(device, 'remote.device.paired', `Paired remote device '${device.label}'.`);
    return device;
  }

  async list(): Promise<RemoteDevice[]> {
    return this.store.listDevices();
  }

  async get(id: string): Promise<RemoteDevice> {
    const device = await this.store.getDevice(id);
    if (!device) throw new Error(`Remote device '${id}' was not found.`);
    return device;
  }

  async getActiveByRoute(routeId: string): Promise<RemoteDevice> {
    const device = await this.store.getDeviceByRoute(routeId);
    if (!device || device.status !== 'active') throw new Error('Remote device is not active.');
    if (device.restrictions.validUntil && Date.parse(device.restrictions.validUntil) <= Date.now()) {
      throw new Error('Remote device grant expired.');
    }
    return device;
  }

  async touch(id: string): Promise<RemoteDevice> {
    const device = await this.get(id);
    const now = new Date().toISOString();
    const updated = { ...device, lastSeenAt: now, updatedAt: now };
    await this.store.saveDevice(updated);
    return updated;
  }

  async suspend(id: string): Promise<RemoteDevice> {
    return this.setStatus(id, 'suspended');
  }

  async resume(id: string): Promise<RemoteDevice> {
    return this.setStatus(id, 'active');
  }

  async revoke(id: string): Promise<RemoteDevice> {
    return this.setStatus(id, 'revoked');
  }

  async setRole(id: string, role: RemoteDeviceRole): Promise<RemoteDevice> {
    const device = await this.get(id);
    if (device.status === 'revoked') throw new Error('A revoked device cannot receive a new role.');
    const updated = {
      ...device,
      role,
      restrictions: normalizeRestrictions(role, device.restrictions),
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveDevice(updated);
    await this.event(updated, 'remote.device.role_changed', `Changed remote device role to ${role}.`);
    return updated;
  }

  private async setStatus(id: string, status: RemoteDevice['status']): Promise<RemoteDevice> {
    const device = await this.get(id);
    if (device.status === 'revoked' && status !== 'revoked') throw new Error('A revoked device cannot be resumed.');
    const now = new Date().toISOString();
    const updated: RemoteDevice = {
      ...device,
      status,
      updatedAt: now,
      ...(status === 'revoked' ? { revokedAt: now } : {}),
      ...(status === 'suspended' ? { suspendedAt: now } : {}),
    };
    await this.store.saveDevice(updated);
    if (status === 'suspended' || status === 'revoked') {
      await this.intents.disableForDevice(updated.id, status === 'revoked');
    }
    await this.relay.setDeviceRouteState(updated.routeId, status).catch(() => {
      // The local authorization state is authoritative. RelayClient reconciles
      // all route states before each subsequent transport connection.
    });
    await this.event(updated, `remote.device.${status}`, `Remote device ${status}.`);
    return updated;
  }

  private async event(device: RemoteDevice, eventType: string, summary: string): Promise<void> {
    await this.audit.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      actor: 'local_user',
      eventType,
      summary,
      detail: { deviceId: device.id, label: device.label, role: device.role, status: device.status },
    });
  }
}

function normalizeRestrictions(
  role: RemoteDeviceRole,
  input: Partial<RemoteDeviceRestrictions> = {},
): RemoteDeviceRestrictions {
  const baseline =
    role === 'viewer'
      ? { ...DEFAULT_DEVICE_RESTRICTIONS, maxRisk: 'read_only' as const, approvalKinds: [] }
      : role === 'approver'
        ? DEFAULT_DEVICE_RESTRICTIONS
        : { ...DEFAULT_DEVICE_RESTRICTIONS, environments: ['development', 'staging', 'production'] as const };
  return {
    projects: input.projects ?? baseline.projects,
    targets: input.targets ?? baseline.targets,
    environments: input.environments ?? [...baseline.environments],
    maxRisk: role === 'viewer' ? 'read_only' : (input.maxRisk ?? baseline.maxRisk),
    approvalKinds: role === 'viewer' ? [] : (input.approvalKinds ?? baseline.approvalKinds),
    maxProviderSpendEur: Math.max(0, input.maxProviderSpendEur ?? baseline.maxProviderSpendEur),
    ...(input.validUntil ? { validUntil: input.validUntil } : {}),
  };
}

function cleanLabel(label: string): string {
  const value = String(label ?? '').trim().replace(/[\u0000-\u001f]/g, '');
  if (!value || value.length > 80) throw new Error('Device label must be between 1 and 80 characters.');
  return value;
}
