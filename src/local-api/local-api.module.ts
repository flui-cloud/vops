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
import { AgentControlController } from './agent-control.controller';
import { RemoteController } from './remote.controller';
import { RemoteRuntime } from '../remote/remote-runtime';
import { VaultController } from './vault.controller';
import { MetricsController } from './metrics.controller';
import { ServiceController } from './service.controller';
import { MetricsCollectorService } from '../metrics/metrics-collector.service';
import { UnlockThrottle } from '../lib/keyring/unlock-throttle';

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
    AgentControlController,
    RemoteController,
    VaultController,
    MetricsController,
    ServiceController,
  ],
  providers: [
    VopsWatchService,
    BenchRunRegistry,
    RemoteRuntime,
    // Here and NOT in VopsModule: every CLI command builds a VopsModule context
    // and runs its bootstrap hooks, so a collector there would start SSH-probing
    // the fleet on `vops compare`. See test/collector-placement.spec.ts.
    MetricsCollectorService,
    // A factory, not a class provider: the keyring layer stays framework-free.
    { provide: UnlockThrottle, useFactory: () => new UnlockThrottle() },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class LocalApiModule {}
