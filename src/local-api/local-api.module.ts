import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { VopsModule } from '../vops.module';
import { ProvidersController } from './providers.controller';
import { CredentialsController } from './credentials.controller';
import { OpsController } from './ops.controller';
import { FirewallController } from './firewall.controller';
import { VnetController } from './vnet.controller';
import { SshKeysController } from './ssh-keys.controller';
import { HostsController } from './hosts.controller';
import { RootController } from './root.controller';
import { WatchController } from './watch.controller';
import { BenchController } from './bench.controller';
import { AppsController } from './apps.controller';
import { IngressController } from './ingress.controller';
import { SystemController } from './system.controller';
import { VopsWatchService } from '../watch/vops-watch.service';
import { BenchRunRegistry } from '../bench/bench-run-registry';
import { SessionGuard } from './session.guard';

/** HTTP surface for the local UI. Reuses VopsModule services; no logic here. */
@Module({
  imports: [VopsModule],
  controllers: [
    ProvidersController,
    CredentialsController,
    OpsController,
    FirewallController,
    VnetController,
    SshKeysController,
    HostsController,
    RootController,
    WatchController,
    BenchController,
    AppsController,
    IngressController,
    SystemController,
  ],
  providers: [
    VopsWatchService,
    BenchRunRegistry,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class LocalApiModule {}
