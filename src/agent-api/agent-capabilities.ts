import { AGENT_SCHEMA_VERSION } from './agent-envelope';

/** What this build of vops can actually do — kept separate from whether this machine has
 * credentials configured, so a read-only discovery question never unseals the vault. */

export type CapabilityName =
  | 'catalog'
  | 'buildingBlocks'
  | 'frameworkTemplates'
  | 'specGeneration'
  | 'specValidation'
  | 'ciBuild'
  | 'serverProvisioning'
  | 'serverImport'
  | 'deploymentPlan'
  | 'previewDeployment'
  | 'productionDeployment'
  | 'securityHardening'
  | 'hostFirewall'
  | 'dns'
  | 'certificates'
  | 'verification'
  | 'backup';

export interface CapabilityProbe {
  vopsVersion: string;
  specVersion: string;
  products: number;
  buildingBlocks: number;
  templates: number;
  /** 'legacy' = no sealed vault; 'locked' = sealed and not opened in this process. */
  vault: 'legacy' | 'locked' | 'unlocked';
  /** Providers with stored credentials, or null when the vault is locked. */
  configured: string[] | null;
}

export interface CapabilityReport {
  schemaVersion: typeof AGENT_SCHEMA_VERSION;
  vopsVersion: string;
  specVersion: string;
  capabilities: Record<CapabilityName, boolean>;
  /** Why a capability is off, or what it covers when on. */
  details: Partial<Record<CapabilityName, string>>;
  catalog: { products: number; buildingBlocks: number; frameworkTemplates: number };
  credentials: { vault: CapabilityProbe['vault']; configured: string[] | null };
}

export function buildCapabilities(probe: CapabilityProbe): CapabilityReport {
  const capabilities: Record<CapabilityName, boolean> = {
    catalog: probe.products > 0,
    buildingBlocks: probe.buildingBlocks > 0,
    frameworkTemplates: probe.templates > 0,
    specGeneration: true,
    specValidation: true,
    ciBuild: true,
    serverProvisioning: true,
    serverImport: true,
    deploymentPlan: true,
    previewDeployment: false,
    productionDeployment: true,
    securityHardening: true,
    hostFirewall: true,
    dns: true,
    certificates: true,
    verification: true,
    backup: true,
  };

  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    vopsVersion: probe.vopsVersion,
    specVersion: probe.specVersion,
    capabilities,
    details: {
      catalog: `${probe.products} packaged applications installable with \`vops app install <id>\`.`,
      buildingBlocks: `${probe.buildingBlocks} reusable services (databases, caches, object storage) installable on their own.`,
      frameworkTemplates: `${probe.templates} framework templates for \`vops spec generate\`.`,
      ciBuild:
        'Images are built on GitHub Actions and pulled by the host. vops never builds — not locally, not on the VPS. ' +
        'Supply a ready image with --image to skip the build entirely.',
      previewDeployment: 'Not implemented. Use `vops deploy plan` plus `vops spec validate` before deploying for real.',
      productionDeployment: 'Rootful Podman + Quadlet over SSH. No vops agent is left behind on the server.',
      certificates: 'ACME http-01 through the vops ingress (Caddy or Traefik). dns-01 and wildcards are not implemented.',
      dns: 'A-records are created automatically when the hostname belongs to a zone on a configured DNS provider.',
      securityHardening: '`vops host harden`, `vops host ssh-harden`, `vops host-firewall` — each planned, then applied on approval.',
      backup: '`vops backup` (restic) for deployed app volumes.',
    },
    catalog: {
      products: probe.products,
      buildingBlocks: probe.buildingBlocks,
      frameworkTemplates: probe.templates,
    },
    credentials: { vault: probe.vault, configured: probe.configured },
  };
}
