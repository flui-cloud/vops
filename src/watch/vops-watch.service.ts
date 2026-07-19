import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { CloudClient, CloudUptimeMonitor, CloudWatch, NotifyIntent, NotifyResult } from '../lib/cloud-client';

export interface NotifyView extends NotifyResult {
  /** PNG data-URL of the activation URL, generated locally (nothing leaves the box). */
  qr: string;
}

/**
 * UI-facing bridge to the vops-landing notification API. The token stays in the
 * local encrypted store (via CloudClient) and never reaches the browser — the
 * local-api proxies every call. Delivery follows vops-landing and offers the
 * same three peer channels: Telegram, ntfy, and Web Push (the "vops notification
 * app", activated by opening the returned URL on a phone).
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
      // `server`, not `url`: the landing reads `server` for ntfy and `url` only
      // for webhooks, so sending `url` silently dropped a custom ntfy server and
      // published to ntfy.sh instead.
      channels: [{ type: 'ntfy', topic: input.topic, ...(input.server ? { server: input.server } : {}) }],
    });
    return { watchId: watch.id };
  }

  /**
   * Telegram: mint a one-time link code and hand back the `t.me` deep link, plus
   * a QR so the link can be followed from a phone while sitting at a desktop.
   * The chat id is resolved server-side from the code and never reaches this box.
   */
  async telegramLink(): Promise<{ code: string; url: string | null; qr: string | null }> {
    const link = await this.client.linkTelegram();
    const qr = link.url ? await QRCode.toDataURL(link.url, { margin: 1, width: 200 }) : null;
    return { ...link, qr };
  }

  telegramStatus(code: string): Promise<{ linked: boolean }> {
    return this.client.telegramStatus(code);
  }

  /** Arm the watch once the user has tapped Start in Telegram. */
  async telegram(input: NotifyIntent & { linkCode: string }): Promise<{ watchId: string }> {
    const watch = await this.client.createWatch({
      provider: input.provider,
      serverType: input.serverType,
      location: input.location,
      kinds: ['availability'],
      channels: [{ type: 'telegram', linkCode: input.linkCode }],
    });
    return { watchId: watch.id };
  }

  /** Availability/price watches — for the unified "My watchers" dashboard panel. */
  list(): Promise<CloudWatch[]> {
    return this.client.listWatches();
  }

  removeWatch(id: string): Promise<void> {
    return this.client.removeWatch(id);
  }

  /** External black-box uptime monitors — same panel, different entity. */
  uptimeList(): Promise<CloudUptimeMonitor[]> {
    return this.client.listUptime();
  }

  removeUptime(id: string): Promise<void> {
    return this.client.removeUptime(id);
  }
}
