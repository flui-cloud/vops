import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { RelayClient } from './relay-client';

/** Starts the outbound transport only in the long-lived local API process. */
@Injectable()
export class RemoteRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly relay: RelayClient) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.relay.startConfigured();
  }

  onApplicationShutdown(): void {
    this.relay.stopConnection();
  }
}
