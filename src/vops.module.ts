import * as path from 'node:path';
import * as os from 'node:os';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  ProviderCoreModule,
  CapabilitiesProviderFactory,
  ProviderFactory,
  FirewallProviderFactory,
  CloudProvider,
  HetznerCapabilitiesService,
  ScalewayCapabilitiesService,
  ContaboCapabilitiesService,
  ContaboProviderService,
  OvhCapabilitiesService,
  OvhProviderService,
  OvhFirewallService,
  HetznerProviderService,
  HetznerFirewallService,
  ScalewayProviderService,
  ScalewayFirewallService,
  ScalewayInstancesAdapter,
  ScalewayBareMetalAdapter,
  ScalewayVpcAdapter,
  ScalewayIamAdapter,
  CherryProviderService,
  CherryCapabilitiesService,
} from '@flui-cloud/infra';
import { LocalCredentialProvider } from './lib/credentials/local-credential-provider';
import { LocalStore } from './lib/store/local-store';
import { VopsProvidersService } from './providers/vops-providers.service';
import { VopsCredentialsService } from './credentials/vops-credentials.service';
import { VopsCatalogService } from './catalog/vops-catalog.service';
import { VopsWriteGateService } from './safety/vops-write-gate.service';
import { VopsServersService } from './servers/vops-servers.service';
import { VopsFirewallService } from './firewall/vops-firewall.service';
import { VopsServerFirewallService } from './firewall/vops-server-firewall.service';
import { VopsVnetService } from './vnet/vops-vnet.service';
import { VopsRegionsService } from './regions/vops-regions.service';
import { VopsSshKeysService } from './ssh-keys/vops-ssh-keys.service';
import { RealSshExec } from './lib/ssh-exec';
import { VopsHostsService } from './hosts/vops-hosts.service';
import { VopsHostKeysService } from './host-ops/vops-host-keys.service';
import { VopsHostConnService } from './host-ops/vops-host-conn.service';
import { VopsHostStatusService } from './host-ops/vops-host-status.service';
import { VopsHostHardenService } from './host-ops/vops-host-harden.service';
import { VopsSshLockdownService } from './host-ops/vops-ssh-lockdown.service';
import { VopsHostUpdateService } from './host-ops/vops-host-update.service';
import { VopsHostFirewallService } from './host-ops/vops-host-firewall.service';
import { VopsOpsRotationService } from './host-ops/vops-ops-rotation.service';
import { VopsMonitorService } from './monitor/vops-monitor.service';
import { VopsBackupService } from './backup/vops-backup.service';
import { VopsAgentService } from './agent/vops-agent.service';
import { VopsBenchService } from './bench/vops-bench.service';

/**
 * vops runtime. Deliberately light: it wires the Hetzner + Scaleway provider and
 * capabilities services directly (they depend only on ConfigService, mappers,
 * LabelService and ICredentialProvider), reusing the exact Flui provider code
 * paths without dragging the heavy object-storage / Kubernetes transitive deps
 * of the full per-provider Nest modules.
 */
// Load creds from the vops package .env and the profile dir regardless of the
// working directory — `vops` is symlinked globally, so cwd is rarely vops/.
// Package .env takes precedence; cwd .env stays a dev convenience.
const ENV_FILES = [
  path.resolve(__dirname, '../../../.env'),
  path.join(os.homedir(), '.config', 'vops', '.env'),
  '.env',
];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ENV_FILES }),
    ProviderCoreModule,
  ],
  providers: [
    LocalCredentialProvider,
    { provide: 'ICredentialProvider', useExisting: LocalCredentialProvider },

    HetznerCapabilitiesService,
    ScalewayCapabilitiesService,
    ContaboCapabilitiesService,
    OvhCapabilitiesService,
    CherryCapabilitiesService,
    {
      provide: CapabilitiesProviderFactory,
      useFactory: (
        hetzner: HetznerCapabilitiesService,
        scaleway: ScalewayCapabilitiesService,
        contabo: ContaboCapabilitiesService,
        ovh: OvhCapabilitiesService,
        cherry: CherryCapabilitiesService,
      ) =>
        new CapabilitiesProviderFactory([
          { provider: CloudProvider.HETZNER, service: hetzner },
          { provider: CloudProvider.SCALEWAY, service: scaleway },
          { provider: CloudProvider.CONTABO, service: contabo },
          { provider: CloudProvider.OVH, service: ovh },
          { provider: CloudProvider.CHERRY, service: cherry },
        ]),
      inject: [
        HetznerCapabilitiesService,
        ScalewayCapabilitiesService,
        ContaboCapabilitiesService,
        OvhCapabilitiesService,
        CherryCapabilitiesService,
      ],
    },

    HetznerProviderService,
    ScalewayInstancesAdapter,
    ScalewayBareMetalAdapter,
    ScalewayVpcAdapter,
    ScalewayIamAdapter,
    ScalewayProviderService,
    ContaboProviderService,
    OvhProviderService,
    // Cherry Servers: full provisioning. Reads CHERRY_API_KEY / CHERRY_PROJECT_ID
    // from config (same env channel as OVH's OS_*). No native firewall → host-nftables.
    CherryProviderService,
    {
      provide: ProviderFactory,
      useFactory: (
        hetzner: HetznerProviderService,
        scaleway: ScalewayProviderService,
        contabo: ContaboProviderService,
        ovh: OvhProviderService,
        cherry: CherryProviderService,
      ) =>
        new ProviderFactory([
          { provider: CloudProvider.HETZNER, service: hetzner },
          { provider: CloudProvider.SCALEWAY, service: scaleway },
          { provider: CloudProvider.CONTABO, service: contabo },
          { provider: CloudProvider.OVH, service: ovh },
          { provider: CloudProvider.CHERRY, service: cherry },
        ]),
      inject: [
        HetznerProviderService,
        ScalewayProviderService,
        ContaboProviderService,
        OvhProviderService,
        CherryProviderService,
      ],
    },

    HetznerFirewallService,
    ScalewayFirewallService,
    OvhFirewallService,
    {
      provide: FirewallProviderFactory,
      useFactory: (
        hetzner: HetznerFirewallService,
        scaleway: ScalewayFirewallService,
        ovh: OvhFirewallService,
      ) =>
        new FirewallProviderFactory([
          { provider: CloudProvider.HETZNER, service: hetzner },
          { provider: CloudProvider.SCALEWAY, service: scaleway },
          { provider: CloudProvider.OVH, service: ovh },
        ]),
      inject: [HetznerFirewallService, ScalewayFirewallService, OvhFirewallService],
    },

    LocalStore,
    VopsProvidersService,
    VopsCredentialsService,
    VopsCatalogService,
    VopsWriteGateService,
    VopsServersService,
    VopsFirewallService,
    VopsVnetService,
    VopsRegionsService,
    VopsSshKeysService,
    { provide: 'SshExec', useFactory: () => new RealSshExec() },
    VopsHostsService,
    VopsHostKeysService,
    VopsHostConnService,
    VopsHostStatusService,
    VopsHostHardenService,
    VopsSshLockdownService,
    VopsHostUpdateService,
    VopsHostFirewallService,
    VopsServerFirewallService,
    VopsOpsRotationService,
    VopsMonitorService,
    VopsBackupService,
    VopsAgentService,
    VopsBenchService,
  ],
  exports: [
    VopsProvidersService,
    VopsCredentialsService,
    VopsCatalogService,
    VopsServersService,
    VopsFirewallService,
    VopsVnetService,
    VopsRegionsService,
    VopsSshKeysService,
    VopsHostsService,
    VopsHostKeysService,
    VopsHostConnService,
    VopsHostStatusService,
    VopsHostHardenService,
    VopsSshLockdownService,
    VopsHostUpdateService,
    VopsHostFirewallService,
    VopsServerFirewallService,
    VopsOpsRotationService,
    VopsMonitorService,
    VopsBackupService,
    VopsAgentService,
    VopsBenchService,
    LocalStore,
  ],
})
export class VopsModule {}
