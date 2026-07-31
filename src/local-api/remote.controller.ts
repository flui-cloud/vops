import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RelayClient } from '../remote/relay-client';
import { PairingService } from '../remote/pairing.service';
import { DeviceRegistry } from '../remote/device-registry';
import { RemoteDeviceRole } from '../remote/remote-model';
import { RemoteMessenger } from '../remote/remote-messenger';
import { localId } from '../agent-control/ids';

@Controller('api/remote')
export class RemoteController {
  constructor(
    private readonly relay: RelayClient,
    private readonly pairings: PairingService,
    private readonly devices: DeviceRegistry,
    private readonly messenger: RemoteMessenger,
  ) {}

  @Get('status')
  status() {
    return this.relay.status();
  }

  @Post('enable')
  enable(@Body() body: { relayUrl?: string }) {
    return this.relay.enable(body?.relayUrl, false);
  }

  @Post('disable')
  disable() {
    return this.relay.disable(false);
  }

  @Get('pairings')
  listPairings() {
    return this.pairings.list();
  }

  @Post('pairings')
  createPairing() {
    return this.pairings.create();
  }

  @Post('pairings/:id/confirm')
  confirmPairing(
    @Param('id') id: string,
    @Body() body: { label: string; role: RemoteDeviceRole },
  ) {
    return this.pairings.confirm(id, body);
  }

  @Get('devices')
  listDevices() {
    return this.devices.list();
  }

  @Post('devices/:id/:action')
  deviceAction(
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: { role?: RemoteDeviceRole; message?: string },
  ) {
    if (action === 'revoke') return this.devices.revoke(id);
    if (action === 'suspend') return this.devices.suspend(id);
    if (action === 'resume') return this.devices.resume(id);
    if (action === 'role' && body?.role) return this.devices.setRole(id, body.role);
    if (action === 'notify') return this.notify(id, body?.message);
    throw new Error(`Unsupported remote device action '${action}'.`);
  }

  private async notify(id: string, message?: string) {
    const device = await this.devices.get(id);
    if (device.status !== 'active') throw new Error('Remote device is not active.');
    const eventId = localId('remote_notification');
    const envelope = await this.messenger.send(
      device,
      'notification',
      {
        type: 'notification.event',
        event_id: eventId,
        title: 'vops',
        summary: String(message ?? 'Your local vOps control node sent an encrypted test update.').slice(0, 300),
        severity: 'info',
        created_at: new Date().toISOString(),
      },
      60 * 60_000,
    );
    return {
      eventId,
      messageId: envelope.message_id,
      state: 'encrypted_and_queued',
      push: 'wake-only-best-effort',
    };
  }
}
