import * as path from 'node:path';
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
  DnsProvider,
  DnsProviderFactory,
  HetznerDnsService,
  ScalewayDnsService,
} from '@flui-cloud/infra';
import { LocalCredentialProvider } from './lib/credentials/local-credential-provider';
import { LocalStore } from './lib/store/local-store';
import { MetricsStore } from './lib/store/metrics-store';
import { MetricsProbeService } from './metrics/metrics-probe.service';
import { vopsEnvFiles } from './lib/env-files';
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
import { VopsHostShellService } from './host-ops/host-shell.service';
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
import { VopsAppsService } from './apps/vops-apps.service';
import { VopsAgentApiService } from './agent-api/vops-agent-api.service';
import { VopsSpecService } from './spec/vops-spec.service';
import { VopsBuildService } from './build/vops-build.service';
import { VopsAppShellService } from './apps/app-shell.service';
import { VopsIngressService } from './apps/vops-ingress.service';
import { CapabilityRegistry } from './agent-control/capability-registry';
import { AgentStore } from './agent-control/agent-store';
import { AgentSessionManager } from './agent-control/agent-session-manager';
import { PolicyEngine } from './agent-control/policy-engine';
import { ApprovalManager } from './agent-control/approval-manager';
import { PlanEngine } from './agent-control/plan-engine';
import { OperationManager } from './agent-control/operation-manager';
import { CredentialResolver } from './agent-control/credential-resolver';
import { CoreActionExecutor } from './agent-control/core-action-executor';
import { ActionBroker } from './agent-control/action-broker';
import { AgentSafetyState } from './agent-control/agent-safety-state';
import { KnowledgeService } from './agent-kit/knowledge.service';
import { RelayClient } from './remote/relay-client';
import { RemoteStore } from './remote/remote-store';
import { RemoteCryptoService } from './remote/remote-crypto.service';
import { DeviceRegistry } from './remote/device-registry';
import { PairingService } from './remote/pairing.service';
import { RemoteGateway } from './remote/remote-gateway';
import { RemoteMessenger } from './remote/remote-messenger';
import { RemoteSyncService } from './remote/remote-sync.service';
import { CodexAppServerAdapter } from './remote/codex-app-server.adapter';
import { RemoteAgentRouter } from './remote/remote-agent-router';
import { ConversationService } from './remote/conversation.service';
import { RemoteCommandHandler } from './remote/remote-command.handler';
import { IntentService } from './remote/intent.service';
import { OpenAICompatibleAgentAdapter } from './remote/openai-compatible-agent.adapter';
import { RemoteAgentToolsService } from './remote/remote-agent-tools.service';
import { RemoteAgentMcpBridge } from './remote/remote-agent-mcp-bridge';
import { RemoteAgentPolicyStore } from './remote/remote-agent-policy';
import { RemoteAgentRegistry } from './remote/remote-agent-registry';
import { ClaudeCodeAdapter } from './remote/claude-code.adapter';
import { OpenCodeAdapter } from './remote/opencode.adapter';
import { AntigravityAdapter } from './remote/antigravity.adapter';

/**
 * vops runtime. Deliberately light: it wires the Hetzner + Scaleway provider and
 * capabilities services directly (they depend only on ConfigService, mappers,
 * LabelService and ICredentialProvider), reusing the exact Flui provider code
 * paths without dragging the heavy object-storage / Kubernetes transitive deps
 * of the full per-provider Nest modules.
 */
// Load creds from the vops package .env and the profile dir regardless of the
// working directory — `vops` is symlinked globally, so cwd is rarely vops/.
// Package .env takes precedence; cwd .env stays a dev convenience. The list is
// resolved by lib/env-files so `bin/run` (which populates process.env first) and
// this module always agree on which files a profile may read.
const ENV_FILES = vopsEnvFiles({
  cwd: '.',
  packageEnv: path.resolve(__dirname, '../../../.env'),
});

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

    HetznerDnsService,
    ScalewayDnsService,
    {
      provide: DnsProviderFactory,
      useFactory: (hetzner: HetznerDnsService, scaleway: ScalewayDnsService) =>
        new DnsProviderFactory([
          { provider: DnsProvider.HETZNER, service: hetzner },
          { provider: DnsProvider.SCALEWAY, service: scaleway },
        ]),
      inject: [HetznerDnsService, ScalewayDnsService],
    },

    LocalStore,
    MetricsStore,
    MetricsProbeService,
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
    VopsHostShellService,
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
    VopsIngressService,
    VopsAppsService,
    VopsAppShellService,
    VopsAgentApiService,
    VopsSpecService,
    VopsBuildService,
    CapabilityRegistry,
    AgentStore,
    AgentSessionManager,
    AgentSafetyState,
    PolicyEngine,
    ApprovalManager,
    PlanEngine,
    OperationManager,
    CredentialResolver,
    CoreActionExecutor,
    ActionBroker,
    KnowledgeService,
    RelayClient,
    RemoteStore,
    RemoteCryptoService,
    DeviceRegistry,
    PairingService,
    RemoteMessenger,
    RemoteSyncService,
    RemoteAgentToolsService,
    RemoteAgentMcpBridge,
    RemoteAgentPolicyStore,
    CodexAppServerAdapter,
    ClaudeCodeAdapter,
    OpenCodeAdapter,
    AntigravityAdapter,
    OpenAICompatibleAgentAdapter,
    RemoteAgentRegistry,
    RemoteAgentRouter,
    ConversationService,
    IntentService,
    RemoteCommandHandler,
    RemoteGateway,
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
    VopsHostShellService,
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
    VopsIngressService,
    VopsAppsService,
    VopsAppShellService,
    VopsAgentApiService,
    VopsSpecService,
    VopsBuildService,
    LocalStore,
    MetricsStore,
    MetricsProbeService,
    CapabilityRegistry,
    AgentStore,
    AgentSessionManager,
    AgentSafetyState,
    PolicyEngine,
    ApprovalManager,
    PlanEngine,
    OperationManager,
    CredentialResolver,
    CoreActionExecutor,
    ActionBroker,
    KnowledgeService,
    RelayClient,
    RemoteStore,
    RemoteCryptoService,
    DeviceRegistry,
    PairingService,
    RemoteMessenger,
    RemoteSyncService,
    RemoteAgentToolsService,
    RemoteAgentMcpBridge,
    RemoteAgentPolicyStore,
    CodexAppServerAdapter,
    ClaudeCodeAdapter,
    OpenCodeAdapter,
    AntigravityAdapter,
    OpenAICompatibleAgentAdapter,
    RemoteAgentRegistry,
    RemoteAgentRouter,
    ConversationService,
    IntentService,
    RemoteCommandHandler,
    RemoteGateway,
  ],
})
export class VopsModule {}
