import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { VopsModule } from '../vops.module';
import { ProvidersController } from './providers.controller';
import { OpsController } from './ops.controller';
import { FirewallController } from './firewall.controller';
import { VnetController } from './vnet.controller';
import { SshKeysController } from './ssh-keys.controller';
import { HostsController } from './hosts.controller';
import { RootController } from './root.controller';
import { WatchController } from './watch.controller';
import { VopsWatchService } from '../watch/vops-watch.service';
import { SessionGuard } from './session.guard';

/** HTTP surface for the local UI. Reuses VopsModule services; no logic here. */
@Module({
  imports: [VopsModule],
  controllers: [
    ProvidersController,
    OpsController,
    FirewallController,
    VnetController,
    SshKeysController,
    HostsController,
    RootController,
    WatchController,
  ],
  providers: [
    VopsWatchService,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class LocalApiModule {}
