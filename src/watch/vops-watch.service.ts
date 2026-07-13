import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { CloudClient, NotifyIntent, NotifyResult } from '../lib/cloud-client';

export interface NotifyView extends NotifyResult {
  /** PNG data-URL of the activation URL, generated locally (nothing leaves the box). */
  qr: string;
}

/**
 * UI-facing bridge to the vops-landing notification API. The token stays in the
 * local encrypted store (via CloudClient) and never reaches the browser — the
 * local-api proxies every call. Delivery follows vops-landing: Web Push (the
 * "vops notification app", activated by opening the returned URL on a phone) and
 * ntfy topics.
 */
@Injectable()
export class VopsWatchService {
  private readonly client = new CloudClient();

  status(): { connected: boolean; apiUrl: string | null } {
    const cfg = this.client.config();
    return { connected: !!cfg, apiUrl: cfg?.apiUrl ?? null };
  }

  /** Verify the endpoint is reachable, then persist it (verify-before-set). */
  async connect(apiUrl: string): Promise<{ apiUrl: string }> {
    const cfg = await this.client.setEndpoint(apiUrl);
    return { apiUrl: cfg.apiUrl };
  }

  /** Web Push intent → activation URL (+ QR) to open on the phone. */
  async notify(intent: NotifyIntent): Promise<NotifyView> {
    const result = await this.client.notifyIntent(intent);
    const qr = await QRCode.toDataURL(result.activationUrl, { margin: 1, width: 240 });
    return { ...result, qr };
  }

  /** ntfy channel: alerts are published to the user's own ntfy topic. */
  async ntfy(input: NotifyIntent & { topic: string; server?: string }): Promise<{ watchId: string }> {
    const watch = await this.client.createWatch({
      provider: input.provider,
      serverType: input.serverType,
      location: input.location,
      kinds: ['availability'],
      channels: [{ type: 'ntfy', topic: input.topic, ...(input.server ? { url: input.server } : {}) }],
    });
    return { watchId: watch.id };
  }
}
