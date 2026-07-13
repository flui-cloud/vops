# vops — Extraction Analysis from Flui

> **Status:** Analysis only. No code changes proposed here are implemented.
> **Date:** 2026-07-06
> **Scope:** Evaluate extracting a standalone, local-first VPS-operations CLI (`@flui-cloud/vops`, command `vops`, repo `flui-cloud/vops`) from Flui's provider/infrastructure layer.

---

## 1. Executive summary

**vops is worth extracting, and the extraction is unusually clean** — much cleaner than a typical "carve a tool out of a monolith" exercise. Flui already did most of the decoupling work for its own reasons:

1. **The provider layer is almost entirely TypeORM-free.** Of ~77 non-generated TypeScript files under `src/modules/providers`, only **4** touch TypeORM, and none of those are the core cloud/firewall/DNS/network services. The heavy DB/Kubernetes/reconciliation logic lives one tier up in `infrastructure/*` and `dns/*`, which vops leaves behind.

2. **Credential access is already isolated behind a single 3-method seam** — `ICredentialProvider`. There is exactly one implementation today (DB-backed). Swapping in a ~40-line file/env implementation makes every provider service work unchanged, with no backend and no database.

3. **The generated OpenAPI clients depend only on `axios`.** Hetzner (one client), Scaleway (7 clients + checked-in YAML specs), and Contabo are all self-contained — zero NestJS, zero TypeORM, zero Flui imports. The hardest part of a multi-provider tool (typed API surfaces) is already dependency-free and liftable verbatim.

4. **Flui's own CLI is already a working proof of the exact pattern vops needs.** `cli/` boots the backend's provider services *locally* with no Postgres/Redis, using file-backed repositories bound to TypeORM tokens via a shim, and an AES-256-GCM encrypted profile store under `~/.flui/`. vops can either reuse that skeleton or (recommended) take the *patterns* and drop NestJS.

5. **The safety policy vops wants — "writes only on hourly-billed providers" — is already codified.** `ProviderCapabilities.pricing.billingCycle: 'hourly' | 'monthly'` plus `NodeSizeDto.supportsHourlyBilling`, and the documented **Level 2 (Hourly billing)** capability in `providers/CAPABILITIES.md`, give vops a ready-made, credential-free write-gate.

6. **A local-first, DB-free SSH CA with real short-lived certificates already exists** in `cli/src/services/cli-ca.service.ts` + `cli-ssh.service.ts`. It issues genuine OpenSSH user certificates (`ssh-keygen -s`, default 300s TTL) entirely locally — no daemon, no agent on the VPS.

**Bottom line:** vops is a repackaging-and-narrowing exercise, not a rewrite. The v0 read-only core (providers / capabilities / prices / availability / locations) can be assembled with **zero network-to-a-backend and zero database**. The main net-new work is (a) a file/env `ICredentialProvider`, (b) deciding Nest-lite vs plain-TS wiring, (c) adding `listImages`/`listLocations` (endpoints exist in the generated clients but aren't surfaced as service methods), and (d) a thin oclif command surface with `--json`.

---

## 2. Recommended vops scope

**In scope (the product):** a local-first CLI that lets a developer inspect, compare, and *safely* operate raw VPS resources across Hetzner and Scaleway (and later others) from their own machine, with API tokens that never leave the box.

- **Read-first, always:** providers, capabilities, locations, server types/plans, live prices, live availability, servers, SSH keys, firewalls (read rules), DNS (read zones/records), private networks.
- **Compare & watch:** cross-provider price/spec comparison; availability watch (polling).
- **Guarded writes, hourly-only:** create/delete server, SSH-key registry, firewall rule changes, DNS record changes — enabled only for providers whose `billingCycle === 'hourly'`, behind `--dry-run` → explicit confirmation.
- **Local SSH access (later):** local CA init + short-lived cert issue + `vops access ssh <server>`, reusing the existing DB-free CLI CA.

**Explicitly NOT vops** (stays in Flui — see §4): k3s/control-plane bootstrap, app deployment runtime, workload orchestration, observability install, managed databases, Kubernetes copy-pod snapshot/backup, DNS/cert reconciliation loops, the dashboard, the Flui backend API, and anything that installs software on the target VPS.

vops = **Flui's infrastructure/provider read layer + a narrow, gated write layer**, packaged as a single-binary-feel local CLI. It is deliberately "the layer below Flui": Flui provisions clusters; vops operates individual VPS resources.

---

## 3. Modules to extract (with paths, coupling, difficulty, MVP value)

Legend — **Difficulty:** L (low / lift-as-is or strip decorators), M (medium / pull in siblings or refactor), H (high / heavy coupling). **MVP:** ★ = v0, ☆ = v1+, — = later/never.

### 3.1 Types & models (the portable backbone) — all **L**, all high MVP value

| File | Responsibility | Coupling | Diff | MVP |
|---|---|---|---|---|
| `src/modules/providers/dto/node-size.dto.ts` | Rich server-type model: `cores/memory/disk`, `architecture`, `bareMetal`, `managedFirewall`, **`supportsHourlyBilling`**, per-location `prices[]`, `availability[]` | none (self-contained, "no deps" by design) | L | ★ |
| `src/modules/providers/dto/pricing.dto.ts` | Pricing tree (`PricingDto` → `serverTypes[]` → `prices[]`, hourly/monthly net/gross, VAT) | none | L | ★ |
| `src/modules/management/entities/provider-capabilities.entity.ts` | `ProviderCapabilities` incl. **`pricing.billingCycle`**, `features`, `firewall`, `vnetTopology` — *plain interfaces, no `@Entity`* | none | L | ★ |
| `src/modules/management/entities/provider-region.entity.ts` | `ProviderRegion` (id/name/location/`available`/lat-long/flag) — plain interface | none | L | ★ |
| `src/modules/management/entities/credentials.entity.ts` | `CredentialType` enum + `ProviderCredentials` — plain interface | none | L | ★ |
| `src/modules/providers/enums/cloud-provider.enum.ts` | `CloudProvider` enum (hetzner/scaleway/contabo/byos) | none | L | ★ |
| `src/modules/providers/data/region-coordinates.ts` | Static lat/long per provider region (for `compare`, maps) | none | L | ★ |
| `src/modules/providers/interfaces/provider-capabilities.interface.ts` | `IProviderCapabilitiesService`, `InstanceTypeInfo`, `ProviderInfo`, credential-field metadata | type-only imports | L | ★ |
| `src/modules/providers/interfaces/credential-provider.interface.ts` | The **auth seam** (3 methods) | none | L | ★ |
| `src/modules/providers/interfaces/cloud-provider.interface.ts` | `ICloudProvider` full surface + config/result DTOs | imports Flui DTO/entity types (`ServerResponseDto`, `InstanceEntity`, `SSHKeyDto`) | L→M | ★ |
| `src/modules/providers/interfaces/{firewall,dns,network,volume-export}-provider.interface.ts` | Normalized firewall / DNS / network / volume contracts | none | L | ★/☆ |
| `src/modules/providers/mappers/{node-size,pricing}.mapper.ts` | Provider raw → `NodeSizeDto`/`PricingDto` | generated-client types only | L | ★ |

> **Note on `ICloudProvider`:** it imports `InstanceEntity` (a TypeORM entity, used only for typing `listInstances`) and a few Flui DTOs (`ServerResponseDto`, `DeleteServerDto`, `SSHKeyDto`). For a clean vops, replace these with plain interfaces to shed the `instances`/`infrastructure/servers`/`access` imports. Small, mechanical.

### 3.2 Capabilities services — **L / L-M**

| File | Fetch model | Coupling | Diff | MVP |
|---|---|---|---|---|
| `implementations/hetzner/hetzner-capabilities.service.ts` | static caps hardcoded (`billingCycle:'hourly'`); regions/types **live** (with mock fallback) | `ConfigService`, `ICredentialProvider` | L-M | ★ |
| `implementations/scaleway/scaleway-capabilities.service.ts` | static caps hardcoded (`billingCycle:'hourly'`, `inference`); types **live**, regions **static** | `ICredentialProvider` | L-M | ★ |
| `implementations/contabo/contabo-capabilities.service.ts` | 100% hardcoded, `billingCycle:'monthly'`, `nodeProvisioning:false` | `ConfigService` | L | ☆ |
| `implementations/byos/byos-capabilities.service.ts` | empty/static, `credentialType:'ssh'` | none | L | — |

**Key design lever:** `getStaticCapabilities()` returns feature flags + `billingCycle` + firewall backend **with no network call and no credentials**. `vops providers list` / `capabilities` can run offline. `getCapabilities()` only overlays live regions + instance types.

### 3.3 Cloud provider (server lifecycle) services

| File | Responsibility | Coupling | Diff | MVP |
|---|---|---|---|---|
| `services/hetzner-provider.service.ts` (1576 ln) | Full Hetzner lifecycle: list/create/delete servers, node sizes, pricing, datacenter availability, SSH keys, volumes, power, resize | `ConfigService` (3 env), `ICredentialProvider`, `NodeSizeMapper`, `PricingMapper`, `LabelService`, lazily `HetznerNetworkService`. **No TypeORM.** | L-M | ★ (reads) / ☆ (writes) |
| `implementations/scaleway/scaleway-provider.service.ts` (1977 ln) | Unifies Instances + Elastic Metal behind `ICloudProvider` | `ICredentialProvider`, `LabelService`, 4 adapters. **No TypeORM/ConfigService.** | M | ★ (reads) / ☆ (writes) |
| `implementations/scaleway/scaleway-instances.adapter.ts` (513 ln) | **Cleanest code in the layer** — token-in-arg wrapper over generated `instances` client (servers, types, security groups, private NICs) | `@Injectable`/`Logger` + axios + generated client only | L | ★ |
| `implementations/scaleway/scaleway-baremetal.adapter.ts` (245 ln) | Token-in wrapper over `baremetal` client (`listOffers` = types/pricing) | same as above | L | ☆ |
| `implementations/scaleway/scaleway-iam.adapter.ts` (124 ln) | Org/project resolution + SSH-key CRUD (the one Scaleway adapter that injects `ICredentialProvider`) | `ICredentialProvider` | L | ★ |
| `services/contabo-provider.service.ts` (290 ln) | Mostly stub; only `listInstances` implemented; OAuth2 bearer | `ConfigService`, `ICredentialProvider`, `LabelService` | L | — |

**Reusable niceties:** Hetzner `createAxiosInstance()` (keep-alive, IPv4, **token-redacting** interceptors) and `describeError()` (secret-free error formatter) are worth lifting verbatim.

### 3.4 Firewall / DNS / Network — provider tier (leave the orchestration tier behind)

| File | READ | WRITE | Coupling | Diff | MVP |
|---|---|---|---|---|---|
| `services/hetzner-firewall.service.ts` | `getFirewall`, `listFirewalls`, `getServerIdsByLabelSelector` | create/update/delete, apply/remove | `ICredentialProvider`, `LabelService`, `ConfigService`. No DB. | L | ☆ |
| `services/hetzner-dns.service.ts` | `listZones`, `getZone(ByName)`, `listRecords`, `getRecord`, `testConnection` | create/update/delete, bulk, purgeA | `ICredentialProvider`, `ConfigService` | L | ☆ |
| `services/hetzner-network.service.ts` | `getVNet`, `listVNets` | create/delete VNet, subnets, routes, protection | **raw `token: string` constructor — no DI** (most portable) | L | ☆ |
| `implementations/scaleway/scaleway-firewall.service.ts` | `getFirewall`, `listFirewalls` | create/update/delete, apply/remove | + `InstancesAdapter`, `IamAdapter` | M | ☆ |
| `implementations/scaleway/scaleway-dns.service.ts` | zones/records reads | create/update/delete, bulk | `ICredentialProvider` | L-M | ☆ |
| `implementations/scaleway/scaleway-vpc.adapter.ts` | private-network reads | create/delete PN, subnets, baremetal attach | `ICredentialProvider`, `IamAdapter` | M | ☆ |
| `services/contabo-firewall.service.ts` | (all throw) | (all throw) | none (stub) | — | — |
| `core/firewall/nftables-ruleset.ts` | render/encode/decode (pure) | — | none | L | — |
| `core/factories/{firewall,dns,volume-export}-provider.factory.ts` | registry lookups | — | NestJS DI only → collapse to a plain `Map` | L | ★ |

### 3.5 SSH access / CA / credentials (the DB-free CLI layer — use this, not the backend `access` module)

| File | Responsibility | Coupling | Diff | MVP |
|---|---|---|---|---|
| `cli/src/services/cli-ca.service.ts` | Local ED25519 CA gen; `signPublicKey()` via `ssh-keygen -s`; `getEnrollmentScript()` | filesystem only | L | ☆ |
| `cli/src/services/cli-ssh.service.ts` | Ephemeral keypair → local cert → `ssh -o CertificateFile=...`; operator-key fallback; stream enrollment over SSH | `ssh`/`ssh-keygen` binaries | L | ☆ |
| `cli/src/lib/config-storage.ts` | AES-256-GCM encrypted local config (`config.json` + random `.key`) | filesystem only | L | ★ |
| `cli/src/lib/profile-manager.ts` | `~/.flui/profiles/<name>/` layout, `FLUI_PROFILE`, 0700/0600 modes | filesystem only | L | ★ |
| `cli/src/lib/cli-credential-provider.service.ts` | `ICredentialProvider` implemented over files (no DB) | `ConfigStorage` | L | ★ |
| `cli/src/lib/provider-credential-schemas.ts` | Per-provider credential field shapes (Hetzner single key; Scaleway access+secret) | none | L | ★ |

> **Do not extract the backend `src/modules/access/*` module** (TypeORM entities, `KeyStorageService`, WebSocket terminal). Everything vops needs already exists DB-free in `cli/`.

### 3.6 CLI & MCP patterns (skeleton to imitate)

| Area | File(s) | Reuse |
|---|---|---|
| oclif command shape, `--json`, flags/args | `cli/src/commands/server-types/list.ts`, `config/set.ts` | Pattern (verbatim conventions) |
| Output (chalk + ora, hand-rolled tables) | `server-types/list.ts` `widthOf()` | Pattern; consider a real table lib |
| PKCE browser login (optional, not needed for local-only) | `cli/src/commands/auth/login.ts` | Later, if vops ever talks to a Flui backend — otherwise drop |
| MCP tool pattern | `src/modules/mcp/tools/mcp-tool.util.ts` (`defineTool`, `runGated`, scope tiers, audit), `infrastructure.tools.ts` | Later — for a `vops` MCP surface |

**Generated OpenAPI clients** (`implementations/hetzner/generated/`, `implementations/scaleway/generated/{instances,baremetal,iam,vpc,private-network,flexible-ip,domain}/`, `implementations/contabo/generated/`): **axios-only, lift verbatim** (or regenerate Scaleway from the checked-in `openapi/*.yml`).

---

## 4. Modules to exclude (stay in Flui for now)

| Area | Where | Why excluded from vops |
|---|---|---|
| k3s / control-plane bootstrap | `cli/src/services/cli-k3s-script.service.ts`, `infrastructure/clusters/*`, `k3s-script.service.ts` | Installs a runtime/cluster **on the VPS** — violates hard constraint #1 (no software on target). This is Flui's core, not VPS ops. |
| App deployment runtime / workload orchestration | `applications`, `app-builds`, `scaling`, `catalog`, `templates` | Requires a running cluster + Flui backend state. Out of scope. |
| Observability install | `observability`, `grafana` | Installs stacks into a cluster. |
| Managed databases / DB console | `db-lifecycle`, `database-console`, `storage` | Require cluster/runtime + backend port-forward transport. |
| Kubernetes copy-pod snapshot/backup | `services/volume-export.service.ts` (uses `KubernetesService`, needs kubeconfig) | This is an **in-cluster data-mover**, not VPS block-volume/snapshot API. VPS-level volume/snapshot ops (if wanted) live in the per-provider `*ProviderService`, not here. |
| nftables host firewall backend | `core/firewall/nftables-firewall.backend.ts` | Couples to `ClusterEntity` (DB), `CertificateSignerService`, SSH stack, and hardcodes k3s/flannel CIDRs. Would push config onto the host. Keep only the pure `nftables-ruleset.ts` renderer if ever needed. |
| DNS/cert reconciliation, ACME, SAN/wildcard certs | `dns/*` (entities, schedulers, `acme-certificate.service.ts`, app-endpoint reconciliation) | Flui platform features tied to backend state + cluster ingress. vops only wants the *provider DNS API wrappers* underneath. |
| Firewall reconciliation & cluster rule templates | `infrastructure/firewalls/*` (entities, schedulers, `firewall-rules.template.ts`) | DB + desired-state loops + Kubernetes rule templates. vops wants the raw `IFirewallProvider` only. |
| Dashboard | `flui-dashboard` repo | UI over the Flui backend; not local-first. |
| Backend `access` module | `src/modules/access/*` | DB-coupled CA/SSH + WebSocket terminal. The DB-free `cli/` equivalent supersedes it for vops. |
| MCP server tied to Flui auth (Zitadel scopes, audit repo) | `mcp/services/*`, `mcp/repositories/*` | The *pattern* is reusable; the concrete server (scope resolver → Zitadel roles, TypeORM audit) is backend-bound. |
| Backend `CredentialProviderService` (DB) | `services/credential-provider.service.ts` | Replaced by a file/env impl in vops. |
| Managed-migration machines, resilience, HA tier | `app-migration`, `full-migration`, cross-provider resilience | Whole-platform features requiring Flui runtime everywhere. |

**Principle:** anything that (a) needs the Flui **backend/DB**, (b) needs a **running cluster/kubeconfig**, or (c) installs **software on the target host** is excluded. That cleanly draws the line at "provider API wrapper + local machine only."

---

## 5. vops MVP command list (feasibility + gating)

Notation — **Mode:** R (read) / W (write). **Ver:** target release. **APIs:** provider endpoints. **Modules:** Flui pieces reused. **Risk.**

### v0 — read-only provider core (no DB, no backend; static path needs no credentials)

| Command | Mode | Feasible from existing code? | APIs / Modules | Risk |
|---|---|---|---|---|
| `vops providers list` | R | **Yes, offline.** `getStaticCapabilities()` per provider + `provider-definitions.service.ts` (drop DI) | none / capabilities services, `ProviderInfo` | none |
| `vops providers capabilities <p>` | R | **Yes, offline.** `getStaticCapabilities()` | none / `ProviderCapabilities` | none |
| `vops providers locations <p>` | R | Yes. Hetzner **live** (`listLocations`); Scaleway **static** regions; both fall back to `region-coordinates.ts` | Locations API / capabilities services | low (needs token for live Hetzner; static fallback otherwise) |
| `vops providers prices <p>` | R | Yes. Hetzner `getPricing` (live `/pricing`); Scaleway prices embedded in `getNodeSizes` | Pricing/ServerTypes API / provider services + mappers | low |
| `vops providers plans <p>` / `server-types list` | R | Yes. `getNodeSizes()` → `NodeSizeDto[]` (already exists as `flui server-types list`) | ServerTypes API / provider services | low |
| `vops providers availability <p> --family cx` | R | Yes. Hetzner `getNodeSizes(true)` → datacenter availability map; Scaleway per-zone presence | Datacenters API (HZ) / provider services | low |
| `vops providers compare --cpu 2 --ram 4gb --region eu` | R | Yes (net-new glue over `NodeSizeDto[]`). Filter by cores/memory/region, sort by price; `region-coordinates.ts` for region grouping | provider services + `NodeSizeDto` | low (pure computation) |
| `vops servers list --provider <p>` | R | Yes. `listServersAsDto()` (Hetzner/Scaleway); Contabo `listInstances` | Servers API / provider services | low (needs token) |
| `vops firewalls list --provider <p>` | R | Yes. `IFirewallProvider.listFirewalls` (Hetzner L; Scaleway M) | Firewalls / Security Groups API | low |
| `vops dns zones list --provider <p>` | R | Yes. `IDnsProvider.listZones/listRecords` (Hetzner Cloud DNS RRSets; Scaleway domain v2) | DNS API / dns services | low |

### v1 — compare / watch / richer reads

| Command | Mode | Notes | Ver |
|---|---|---|---|
| `vops providers watch <p> --plan cx22 --location fsn1` | R | Poll `getNodeSizes(true)` availability on an interval; notify on change. Net-new polling loop over existing read. | v1 |
| `vops servers show <id> --provider <p>` | R | `getServerDetailsAsDto` | v1 |
| `vops ssh-keys list --provider <p>` | R | `listSSHKeys` | v1 |
| `vops networks list --provider <p>` | R | `listVNets` / `listPrivateNetworks` | v1 |

### v2+ — guarded writes (hourly-billed providers only)

| Command | Mode | Feasible? | Gating | Ver |
|---|---|---|---|---|
| `vops servers create --provider <p> --plan cx22 --location fsn1 --dry-run` | W | Yes. `createServer(CreateServerConfig)`. **Add `--image`/`listImages`** (Hetzner hardcodes `ubuntu-24.04` today). | `billingCycle==='hourly'` **and** not `bareMetal`; `--dry-run` default → prints plan; real run needs `--yes` | v2 |
| `vops servers delete --provider <p> <id>` | W | Yes. `deleteServer` (Scaleway = `terminate` action) | hourly-only; confirm | v2 |
| `vops servers power on/off <id>` | W | Yes (Hetzner). Scaleway VMs yes; no Hetzner power for some | hourly-only; confirm | v2 |
| `vops firewalls set-rules --provider <p> <fwId>` | W | Yes. `updateFirewallRules` (Hetzner L) | hourly-only; confirm; show diff | v2 |
| `vops dns records set/delete --provider <p>` | W | Yes. `create/update/deleteRecord` | confirm; show diff (DNS write is provider-independent of billing, but still guarded) | v2 |

### v3+ — local SSH access (CA/cert)

| Command | Mode | Feasible? | Ver |
|---|---|---|---|
| `vops access ca init` | local | Yes. `CliCaService.initCa()` (`ssh-keygen -t ed25519`) | v3 |
| `vops access ca status` | R | Yes. `CliCaService.getCaInfo()` | v3 |
| `vops access cert issue --principal user --ttl 15m` | local | Yes. `signPublicKey(pub, ttl, principals)` → real OpenSSH user cert, fully local | v3 (experimental) |
| `vops access ssh <server> --ttl 15m` | local+SSH | Yes. `CliSshService` ephemeral key → cert → `ssh -o CertificateFile`. **Requires one-time CA enrollment on target** (`TrustedUserCAKeys`). | v3 (experimental) |

**Feasibility gaps to fill (small, mechanical):**
- `listImages` / `listLocations` service methods (endpoints exist in generated clients; not surfaced).
- Make `CreateServerConfig.image` actually configurable (Hetzner hardcodes it).
- Harden `signPublicKey` to check `ssh-keygen` exit status (currently reads the cert file and lets a missing file throw).

---

## 6. Provider capability model for vops

Flui's `ProviderCapabilities` is the right foundation; vops needs a **flatter, write-gate-aware** projection. Proposed TypeScript:

```ts
export type BillingModel = 'hourly' | 'monthly' | 'mixed' | 'unknown';
export type CredentialKind =
  | 'api_key'            // Hetzner: single bearer token
  | 'access_key_secret' // Scaleway: accessKey + secretKey
  | 'bearer_token'      // Contabo: OAuth2
  | 'ssh';              // BYOS

export interface RequiredCredentialField {
  key: 'apiKey' | 'accessKey' | 'secretKey' | 'clientId' | 'clientSecret' | 'username' | 'password';
  label: string;
  secret: boolean;
  required: boolean;
  /** Where to find it in the provider console. */
  hint: string;
  /** Env var vops reads for this field, e.g. VOPS_HETZNER_API_KEY. */
  envVar: string;
}

/** A single capability + whether it is READ-only or supports WRITE, and why. */
export interface CapabilitySupport {
  read: boolean;
  write: boolean;
  /** Present when write is false despite the API existing (e.g. monthly billing policy). */
  writeDisabledReason?: string;
}

export interface VopsProviderCapabilities {
  provider: string;                 // 'hetzner' | 'scaleway' | ...
  displayName: string;
  billingModel: BillingModel;       // from ProviderCapabilities.pricing.billingCycle
  /** The master switch. Derived: writeEnabled = billingModel === 'hourly'. */
  writeEnabled: boolean;
  writeDisabledReason?: string;     // e.g. "Provider is monthly-billed; writes are disabled by vops policy."

  credentials: {
    kind: CredentialKind;
    fields: RequiredCredentialField[];
  };

  /** Static feature-presence + per-op read/write gating. */
  features: {
    listServers: CapabilitySupport;      // read: list; write: create/delete
    firewall: CapabilitySupport;         // read: list/get rules; write: mutate
    dns: CapabilitySupport;
    volumes: CapabilitySupport;
    snapshots: CapabilitySupport;
    privateNetwork: CapabilitySupport;
    floatingIp: CapabilitySupport;
    sshKeyRegistry: CapabilitySupport;
    availabilityApi: { read: boolean };  // live availability endpoint present?
    priceApi: { read: boolean };
    powerManagement: CapabilitySupport;
  };

  /** Known locations (static seed + optionally refreshed live). */
  locations: Array<{ id: string; displayName: string; country?: string; latitude?: number; longitude?: number }>;
}
```

**The write-gate rule (single source of truth):**

```ts
export function computeWriteGate(caps: Pick<VopsProviderCapabilities, 'billingModel'>) {
  if (caps.billingModel === 'hourly') return { writeEnabled: true as const };
  return {
    writeEnabled: false as const,
    writeDisabledReason:
      `Writes disabled: provider is '${caps.billingModel}'-billed. ` +
      `vops only permits provisioning on hourly-billed providers (cost-control policy).`,
  };
}
```

**Per-server-type refinement** (for `servers create`): even on an hourly provider, refuse creation of a `bareMetal` plan or one where `supportsHourlyBilling === false`:

```ts
function canCreatePlan(node: NodeSizeDto): boolean {
  return node.supportsHourlyBilling && !node.bareMetal;
}
```

This matches the documented caveat that Scaleway Elastic Metal is monthly-contract even though the provider offers hourly VMs — so the gate is **provider-level `billingCycle` AND per-plan `supportsHourlyBilling && !bareMetal`**.

**Seed values today:** Hetzner `hourly` (write-enabled), Scaleway `hourly` (write-enabled, VMs only), Contabo `monthly` (read-only), BYOS `monthly`/n-a (read-only).

---

## 7. Local-first security model

### 7.1 How Flui does it today
- **Backend:** AES-256-GCM (`KeyStorageService`), key from `SSH_KEY_ENCRYPTION_KEY` env (falls back to a hardcoded default with a warning — a smell vops must not inherit), tokens in TypeORM. No KMS, no keychain.
- **CLI (the model to copy):** AES-256-GCM in `~/.flui/profiles/<name>/config.json`, encryption key auto-generated as `~/.flui/profiles/<name>/.key` (`randomBytes(32)`, mode 0600), format `iv:authTag:ciphertext`. Tokens/credentials encrypted; `apiUrl`/prefs plaintext. Env overrides: `FLUI_API_URL`, `FLUI_API_KEY`, `FLUI_PROFILE`. Masked prompts; `config set` never echoes secret values.

### 7.2 Proposed vops model

**Config file location** (XDG-aware; profiles from day one):
```
~/.config/vops/                      # or $XDG_CONFIG_HOME/vops
  profiles/
    default/
      config.json      # 0600 — { credentials, preferences, metadata }  (secrets AES-256-GCM)
      .key             # 0600 — random 32-byte AES key (this profile's DEK)
      ca/              # 0700 — optional local SSH CA (v3)
  context             # active-profile pointer;  override: VOPS_PROFILE
```

**Token storage strategy (layered, most-secure-available wins):**
1. **Ephemeral env vars (CI-first):** `VOPS_<PROVIDER>_API_KEY`, `VOPS_<PROVIDER>_ACCESS_KEY`, `VOPS_<PROVIDER>_SECRET_KEY`. Never persisted. `--no-store` guaranteed.
2. **OS keychain (opt-in, if feasible):** via `keytar`/`libsecret`/`security`(macOS). If present and `vops config use-keychain` is set, the AES DEK (`.key`) is stored in the keychain instead of on disk, so `config.json` alone is useless.
3. **Encrypted file (default):** AES-256-GCM exactly as the Flui CLI, but **no hardcoded fallback key** — if `.key` is missing, generate; never fall back to a constant.

**Env var naming:** prefix `VOPS_`; provider-scoped as above; plus `VOPS_PROFILE`, `VOPS_CONFIG_DIR`, `VOPS_NO_COLOR`, `VOPS_JSON=1`.

**Security warnings & redaction:**
- **No telemetry, ever, by default.** No network calls except to the selected provider's API. A `--offline` flag hard-fails any command that would touch the network.
- **Redaction:** reuse Hetzner's `describeError()` approach — error/log formatters strip `Authorization`/`X-Auth-Token` headers and never echo token values. A central `redact(str)` runs over every log line and error message, masking anything matching known token shapes.
- **Safe-by-default files:** create dirs 0700, files 0600; refuse to run if `config.json`/`.key` are group/other-readable (print a fix hint).
- **`config set` / prompts:** masked input; echo only field name + `Encryption: AES-256-GCM` + location. `vops config show` masks secrets (`hc_****…last4`) unless `--reveal` **and** a TTY confirmation.

**Safe debug mode:**
- `VOPS_DEBUG=1` raises verbosity but keeps redaction on. There is **no** flag that prints raw tokens. HTTP tracing (`--trace`) logs method+path+status, never headers/bodies that could carry secrets. A separate, loud `--danger-print-token` (hidden from help) is the only way to reveal a token, and it prints a warning first — considered out of scope for v0.

**Threat model summary:** the realistic risks are (a) laptop compromise → mitigated by keychain option + 0600 + per-profile DEK; (b) accidental secret leakage in logs/CI output → mitigated by central redaction + no-telemetry + masked show; (c) CI token persistence → mitigated by env-first ephemeral mode. vops never introduces a server-to-server pivot because there is no server.

---

## 8. CA / ephemeral SSH key feasibility

**What the existing Flui CA does:** it generates an **ED25519 SSH CA** and signs **real short-lived OpenSSH *user certificates*** — not plain-key injection. Signing command (CLI path):
```
ssh-keygen -s <caKeyPath> -I flui-ephemeral-cert -n root,ubuntu,admin -V +300s <pubKeyPath>
```
There are two implementations: a DB-coupled backend one (`src/modules/access/services/certificate-signer.service.ts`, used only by the WebSocket terminal) and a **self-contained, DB-free CLI one** (`cli/src/services/cli-ca.service.ts` + `cli-ssh.service.ts`). The CLI one is exactly what vops needs.

**Answering the feasibility questions:**
- **Depends on backend state?** No (CLI path). CA private key lives at `~/.flui/profiles/<name>/ca/ca_key` (0600); the backend can *reuse* that file but the CLI does not need the backend or DB.
- **Works locally?** Yes, 100%. Per-connection flow: generate ephemeral ED25519 keypair in tmp → sign locally → `ssh -i <ephemeral> -o CertificateFile=<cert> root@host` → delete tmp. Needs only `ssh`/`ssh-keygen` binaries.
- **Requires modifying target VPS sshd?** Yes — **one-time, unavoidable for cert auth**: `sshd_config` must contain `TrustedUserCAKeys <path>` pointing at the CA public key. Installed either at provision time via cloud-init (`FLUI_CA_PUBLIC_KEY` → the init script writes `/etc/ssh/flui_ca.pub` + the `TrustedUserCAKeys` line + `systemctl reload ssh`) or, on an existing host, via an **enrollment script streamed over the operator's existing key** (`getEnrollmentScript()` + `runScriptWithKey()`). **No daemon or agent ever persists on the target** — after enrollment it runs stock sshd.
- **Issues short-lived certs locally?** Yes. `signPublicKey(pub, validitySeconds, principals)` — TTL and principals are parameters.
- **Threat model:** blast radius is a laptop-local CA private key (0600) that can mint certs valid for any host trusting it. Short TTLs (minutes) limit stolen-cert value; the CA key is the crown jewel → keychain-protect the profile DEK, and consider a passphrase on `ca_key` for v3+. This is strictly *safer* than long-lived `authorized_keys` entries because access auto-expires.

**Recommendation for vops:**
- **v0/v1:** ship the local encrypted credential store (`config-storage.ts` pattern) — no CA yet.
- **v3 (experimental, clearly flagged):** lift `cli-ca.service.ts` + `cli-ssh.service.ts`. Expose `vops access ca init | status`, `vops access cert issue`, `vops access ssh <server>`. Gate `ssh`/`enroll` behind an explicit `--enroll` step that shows exactly what it will change on the target (`TrustedUserCAKeys` line) and requires confirmation. Fix the `ssh-keygen` exit-status check before shipping.
- **Keep experimental:** anything that rewrites sshd config on hosts vops didn't provision, and multi-principal certs beyond `root`.

---

## 9. Architecture proposal

**Recommended: a small pnpm monorepo, plain-TS core (drop NestJS), oclif CLI.** Flui's CLI proves the local-embed pattern works, but it drags NestJS + Bull + TypeORM decorators purely as scaffolding. vops is small enough to wire dependencies by hand and stay lean.

```
vops/                         # repo: flui-cloud/vops,  package: @flui-cloud/vops
  packages/
    core/                     # provider registry + orchestration, no I/O framework
      src/
        providers/
          types/              # NodeSizeDto, PricingDto, ProviderCapabilities, ICloudProvider … (lifted, de-Flui'd)
          interfaces/         # ICloudProvider, IFirewallProvider, IDnsProvider, INetworkProvider, ICredentialProvider
          hetzner/            # service + generated client (axios-only)
          scaleway/           # service + adapters + 7 generated clients
          contabo/            # (later)
          registry.ts         # plain Map<Provider, …>  (replaces NestJS factories)
        capabilities/         # static + live capability resolution, write-gate (§6)
        pricing/              # compare/normalize helpers
        availability/         # availability queries + watch loop
        mappers/              # node-size / pricing mappers (lifted)
    config/                   # ProfileManager + AES-256-GCM ConfigStorage + FileCredentialProvider (§7)
    output/                   # table + JSON renderers, redaction (§7)
    safety/                   # write-gate enforcement, dry-run, confirmation prompts
    access/                   # (v3) local CA + ephemeral cert (lifted from cli/)
    cli/                      # oclif commands — thin: parse → core → output
    ui/                       # (later) local web UI over core, localhost-only
```

**Why this shape:**
- **CLI first, JSON always:** every command returns a typed result object; `output/` renders table or JSON (`--json` / `VOPS_JSON=1`). CLI is a thin shell over `core/`.
- **Local-only:** `config/` is the sole I/O for secrets; `core/` only talks to provider APIs. No backend package exists.
- **Provider plugins:** `registry.ts` is a plain map; adding a provider = implement the interfaces + drop in a generated client. Mirrors Flui's `ADD_PROVIDER.md` without the DI ceremony.
- **Future web UI / MCP:** `ui/` and a future `mcp/` package consume `core/` exactly as `cli/` does — no logic duplication. The MCP `defineTool`/`runGated` pattern ports directly, with the write-gate as the "destructive" tier.
- **Reuse by Flui:** if `core/` is clean plain-TS, Flui could later depend on `@flui-cloud/vops-core` and delete its duplicated provider wrappers — but that's a non-goal for v0 and should not constrain vops.

**Alternative (faster to first release):** a single-package `src/{providers,commands,config,credentials,pricing,availability,output,safety,access}` layout. Recommended **only** if the team wants a Reddit-shippable v0 in days rather than a durable monorepo. Start single-package, split to `packages/` when a second consumer (UI/MCP) appears.

---

## 10. Command design

**Decision: use the noun-first, grouped form — `vops providers availability hetzner` — not the flat `vops availability hetzner`.**

Tradeoffs:
- **Grouped (`vops providers <verb> <p>`):** discoverable (`vops providers --help` lists everything provider-scoped), scales as `servers`, `firewalls`, `dns`, `networks`, `access` become peers, and matches Flui's own oclif topic convention (`flui server-types list`, `flui env create`). Slightly more typing.
- **Flat (`vops availability hetzner`):** shorter for the 3-4 headline commands, but pollutes the top-level namespace and reads inconsistently once `servers`/`firewalls` exist (why `vops availability` but `vops servers list`?).

Given vops will grow to servers/firewalls/dns/access, the grouped form wins on consistency. Offer **top-level aliases** for the two or three most-used read commands (`vops prices` → `vops providers prices`, `vops compare` → `vops providers compare`) so the headline demo stays short.

**Taxonomy:**
```
vops providers list
vops providers capabilities <p>
vops providers locations <p>
vops providers plans <p>            # alias: server-types
vops providers prices <p>
vops providers availability <p> [--family cx]
vops providers compare --cpu 2 --ram 4gb --region eu     # alias: vops compare
vops providers watch <p> --plan cx22 --location fsn1

vops servers list --provider <p>
vops servers show <id> --provider <p>
vops servers create --provider <p> --plan cx22 --location fsn1 [--image ...] --dry-run   # gated
vops servers delete --provider <p> <id>                                                   # gated
vops servers power on|off <id> --provider <p>                                             # gated

vops firewalls list --provider <p>
vops firewalls show <fwId> --provider <p>
vops firewalls set-rules <fwId> --provider <p> ...            # gated, diff+confirm

vops dns zones list --provider <p>
vops dns records list <zone> --provider <p>
vops dns records set|delete <zone> ... --provider <p>         # gated, diff+confirm

vops access ca init | status                                 # v3
vops access cert issue --principal user --ttl 15m            # v3
vops access ssh <server> --ttl 15m                           # v3
```

**Global conventions:** `--json` on every read; `--provider/-p` where a provider is needed; `--profile`; `--dry-run` (default on for writes) + `--yes` to confirm; `--offline`; consistent non-zero exit codes; secrets never in argv (use env/prompt).

---

## 11. MVP extraction roadmap

**Phase 0 — Analysis (this document).** No code. **Effort: S. Risk: none.** Deliverable: this file + a go/no-go.

**Phase 1 — Read-only provider core (no writes, no DB, no backend).**
- **Goal:** `core/` + `config/` producing capabilities/locations/plans/prices/availability for Hetzner + Scaleway.
- **Files:** lift `node-size.dto.ts`, `pricing.dto.ts`, `provider-capabilities.entity.ts`, `provider-region.entity.ts`, `credentials.entity.ts`, `cloud-provider.enum.ts`, `region-coordinates.ts`, the capability interfaces, mappers; the Hetzner/Scaleway capabilities + provider services (reads only); the generated clients; implement `FileCredentialProvider` + `ProfileManager` + `ConfigStorage`.
- **Changes:** strip `@Injectable`/`@Inject`; replace `ICredentialProvider` DB impl with file/env; replace `CacheService` with a small file-TTL cache; de-Flui the `ICloudProvider` type imports (plain interfaces); collapse factories to plain maps.
- **Risk:** M (Scaleway dual-credential + per-zone fan-out; generated-client wiring). **Effort: L.**
- **Test:** unit-test mappers with recorded fixtures; contract-test `getStaticCapabilities()` offline; one live smoke per provider behind an env-gated integration flag.

**Phase 2 — CLI package (read commands, table + JSON).**
- **Goal:** oclif `vops providers *` + `vops servers list` + `firewalls/dns list`.
- **Files:** `cli/` commands (imitate `server-types/list.ts`), `output/` (table + JSON + redaction), `safety/` skeleton.
- **Changes:** command classes call `core/`; `--json` suppresses decoration; redaction wraps all output.
- **Risk:** L. **Effort: M.**
- **Test:** golden-file tests on `--json` output; snapshot table rendering; `--help` discoverability.

**Phase 3 — compare & watch.**
- **Goal:** `providers compare` (filter/sort over `NodeSizeDto[]`) and `providers watch` (availability polling + change notification).
- **Files:** `pricing/compare.ts`, `availability/watch.ts`.
- **Risk:** L (pure computation + a poll loop). **Effort: S-M.**
- **Test:** deterministic compare over fixtures; watch loop with a fake clock/injected fetcher.

**Phase 4 — guarded writes (hourly providers only).**
- **Goal:** `servers create/delete/power`, `firewalls set-rules`, `dns records set/delete` — all `--dry-run` first, `--yes` to execute, blocked unless `writeEnabled` (§6).
- **Files:** enable write methods on the provider services; `safety/write-gate.ts`; add `--image`/`listImages`, `listLocations`; make `CreateServerConfig.image` configurable.
- **Changes:** enforce `computeWriteGate` + `canCreatePlan` centrally; every write prints a plan/diff and requires confirmation; audit line to a local log.
- **Risk:** **H** (real money + real resources). Mitigate with dry-run default, explicit confirmation, hourly-only gate, and a loud "this creates a billable server" banner. **Effort: M-L.**
- **Test:** gate unit tests (monthly provider → refused with reason; bare-metal plan → refused); dry-run never calls the API (assert via mock); one gated live create/delete behind a paid-integration flag.

**Phase 5 — optional advanced.**
- **Goal:** local CA/ephemeral SSH (`access *`), local web UI (`ui/`, localhost-only), richer firewall/DNS workflows.
- **Files:** lift `cli-ca.service.ts` + `cli-ssh.service.ts`; add `access/` package; `ui/`.
- **Changes:** harden `ssh-keygen` exit check; explicit `--enroll` with target-change preview; UI reads `core/` only.
- **Risk:** M-H (touching remote sshd; CA key custody). Keep flagged experimental. **Effort: L.**
- **Test:** local cert issue/verify (`ssh-keygen -L`); enrollment against a throwaway VM; UI e2e read-only.

---

## 12. Risks & open questions

- **Generated-client drift:** vops carries Hetzner/Scaleway/Contabo generated clients. Decide whether to vendor them or regenerate from the checked-in Scaleway `openapi/*.yml` in CI. Hetzner ships one 38k-line client; consider tree-shaking to the resources vops uses.
- **`ICloudProvider` type de-Flui'ing:** it imports `InstanceEntity` (TypeORM), `ServerResponseDto`, etc. Cheap to replace with plain interfaces, but it's the one place the interface leaks Flui modules — do it early so nothing else re-couples.
- **Scaleway complexity:** dual credentials (access key + secret), per-zone fan-out, synthetic composite IDs (`zone:sgId`, `region:pnId`), zone-name-as-zoneId in DNS. Most likely source of bugs; needs good fixtures.
- **Availability semantics differ:** Hetzner has a real `/datacenters` availability signal; Scaleway infers availability from which zones return a type. `watch` must document per-provider meaning.
- **Write-gate correctness is safety-critical:** the gate must be provider-level `billingCycle === 'hourly'` **and** per-plan `supportsHourlyBilling && !bareMetal`. Getting this wrong risks a monthly-commitment charge — treat the gate as the highest-test-coverage code in the repo.
- **CA custody:** a laptop-local CA key that any enrolled host trusts is powerful. Keychain-protect the DEK; consider a passphrase on the CA key; keep TTLs short. Never ship a hardcoded fallback encryption key (the backend's `KeyStorageService` default is a smell not to inherit).
- **Contabo/BYOS:** Contabo is mostly a stub (only `listInstances`) and monthly-billed → read-only, low value for v0. BYOS has no provisioning API → not a vops target. Ship both as "listed but read-only," or omit from v0.
- **Naming/website:** `@flui-cloud/vops` vs existing `@flui-cloud/*` scope — confirm the npm org and `vops.flui.cloud` before public release.
- **Relationship to Flui:** if `core/` becomes a clean package, does Flui adopt it and delete its duplicate wrappers? Desirable long-term, explicit non-goal for v0 — don't let it constrain vops's API.

---

## 13. Final decision

**Is vops worth extracting from Flui?**
**Yes.** The provider/capability/pricing layer is already DB-free, credential access is already a single swappable seam, the generated clients are axios-only, and Flui's own CLI is a working proof of local-first provider execution. This is repackaging, not rewriting. There is also a genuine, demo-friendly product here: a local-first, token-stays-local, read-first cross-provider VPS inspector.

**What is the smallest useful v0?**
A read-only CLI, no backend, no database:
```
vops providers list | capabilities <p> | locations <p> | plans <p> | prices <p> | availability <p>
vops providers compare --cpu 2 --ram 4gb --region eu
vops servers list --provider <p>
```
`providers list`/`capabilities` run **fully offline** (static capabilities); the rest need only a local provider token. That is a complete, shippable, Reddit/GitHub-friendly release on its own — "compare Hetzner vs Scaleway prices and availability from your terminal, tokens never leave your machine."

**Which Flui modules are immediately reusable (as-is / trivial strip)?**
`node-size.dto.ts`, `pricing.dto.ts`, `provider-capabilities.entity.ts`, `provider-region.entity.ts`, `credentials.entity.ts`, `cloud-provider.enum.ts`, `region-coordinates.ts`, the capability/provider/firewall/dns/network **interfaces**, the node-size/pricing **mappers**, all **generated OpenAPI clients**, the **Scaleway adapters** (already token-in), **`HetznerNetworkService`** (raw-token ctor), and the CLI's **`ConfigStorage` / `ProfileManager` / `provider-credential-schemas`** and DB-free **CA/SSH** services.

**Which modules need decoupling first?**
- `ICredentialProvider` → write a **file/env implementation** (the single unlock; ~40 lines).
- `ICloudProvider` → replace Flui DTO/entity imports with **plain interfaces**.
- Capabilities/provider **services** → strip `@Injectable`/`@Inject`, replace `CacheService` with a file-TTL cache, hand-wire the registry.
- **Scaleway top-level service** → detach shared-volume/VNet Flui-isms; keep instances/baremetal/iam paths.

**What must absolutely NOT be in v0?**
Any write operation (defer to Phase 4 behind the hourly gate + dry-run); the SSH CA/cert feature (Phase 5, experimental); k3s/cluster/app/observability/DB/runtime anything; the Kubernetes copy-pod snapshot service; the nftables host backend; DNS/cert reconciliation; the dashboard; the Flui backend and its database. v0 touches **only** provider read APIs and the local filesystem.

**What can be the public first release?**
The v0 read-only core above, with `--json` everywhere and the "tokens stay local, zero telemetry" guarantee front-and-center. Headline demo: `vops providers compare --cpu 2 --ram 4gb --region eu` and `vops providers availability hetzner --family cx`. It is self-contained, safe (read-only), useful standalone, and clearly differentiated from Flui — exactly the shape that travels well on GitHub/Reddit.
