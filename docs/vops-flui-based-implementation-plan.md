# vops — Flui-based Implementation Plan (Phase 0: inspection note)

> **Status:** Phase 0 only — inspection & plan. **No code changed.** Follows the first-execution instruction of [`vops-flui-based-implementation-plan-prompt.md`](./vops-flui-based-implementation-plan-prompt.md).
> **Companions:** [`vops-extraction-analysis.md`](./vops-extraction-analysis.md) (module survey), [`vops-doctor-analysis.md`](./vops-doctor-analysis.md) (read-only doctor).
> **Date:** 2026-07-06

---

## 0. Headline finding — the shared module already exists (~80%)

The plan asks us to create **one shared internal module** inside Flui, used by both the Flui backend and vops, reusing the *same code paths* (not copies). **That substrate is already in the repo today** and is already consumed by two different runtimes:

- [`ProviderCoreModule`](../src/modules/providers/provider-core.module.ts) — its own docstring says: *"Shared provider core module … Used by both ProvidersModule (API) and CliProvidersModule (CLI). Does NOT include cloud provider services … because they depend on ICredentialProvider which differs between API (DB) and CLI (file)."*
- The per-provider Nest modules [`HetznerProviderModule`](../src/modules/providers/implementations/hetzner/hetzner-provider.module.ts) and [`ScalewayProviderModule`](../src/modules/providers/implementations/scaleway/scaleway-provider.module.ts) — imported by **both** [`ProvidersModule`](../src/modules/providers/providers.module.ts) (backend) and [`CliProvidersModule`](../cli/src/cli-providers.module.ts) (CLI).
- The DI registry tokens + `multiProvider()` helper in [`core/tokens.ts`](../src/modules/providers/core/tokens.ts), and the four factories (`ProviderFactory`, `FirewallProviderFactory`, `DnsProviderFactory`, `CapabilitiesProviderFactory`).

**The only real difference between the backend and CLI wiring is the `ICredentialProvider` binding** — backend binds `CredentialProviderService` (TypeORM), CLI binds [`CliCredentialProviderService`](../cli/src/lib/cli-credential-provider.service.ts) (encrypted files). That seam is exactly the dependency inversion the plan calls for, and **it already works**: `flui server-types list` today calls `ProviderFactory.getProvider(provider).getNodeSizes(true)` **in-process, with no Postgres, no Redis, no backend HTTP** — the live Hetzner/Scaleway provider service running locally against a file-stored token.

**Consequence for the plan:** this is a *minimum-refactor consolidation*, not a build-from-scratch. We do **not** create `src/modules/infra-core/` and move `providers/*` into it (that would be a large, risky move the plan explicitly discourages). Instead we extract the **duplicated factory-wiring** that `ProvidersModule` and `CliProvidersModule` both hand-roll into one thin, credential-parameterized module, and build vops (CLI + local API + safety) on top of it.

---

## 1. Which modules will be reused directly (same code paths)

All of these are reused **as-is** (imported, not copied). None need to move.

| Concern | Reused artifact | Path | Coupling today |
|---|---|---|---|
| DB-free provider core (mappers, cert factory, common) | `ProviderCoreModule`, `NodeSizeMapper`, `PricingMapper` | `src/modules/providers/provider-core.module.ts`, `providers/mappers/*` | none (already `@Global`, DB-free) |
| Hetzner provider (servers, nodeSizes, pricing, ssh keys, firewall, dns) | `HetznerProviderModule` + its services | `src/modules/providers/implementations/hetzner/hetzner-provider.module.ts`, `providers/services/hetzner-*.ts` | `ICredentialProvider` only |
| Scaleway provider (instances+baremetal, nodeSizes, firewall, dns, vpc) | `ScalewayProviderModule` + adapters | `src/modules/providers/implementations/scaleway/*` | `ICredentialProvider` only |
| Provider selection | `ProviderFactory`, `FirewallProviderFactory`, `DnsProviderFactory`, `CapabilitiesProviderFactory` | `src/modules/providers/core/factories/*` | plain, DI-registered |
| Capability model + billing gate inputs | `ProviderCapabilities`, `NodeSizeDto` (`supportsHourlyBilling`, `bareMetal`, `architecture`), `PricingDto` | `management/entities/provider-capabilities.entity.ts`, `providers/dto/{node-size,pricing}.dto.ts` | plain interfaces/classes, no TypeORM |
| Provider listing / static capabilities | `ProviderDefinitionsService` (DB-free — uses only `CapabilitiesProviderFactory`) | `src/modules/management/services/provider-definitions.service.ts` | none |
| Credential seam | `ICredentialProvider` interface | `src/modules/providers/interfaces/credential-provider.interface.ts` | the seam itself |
| CLI local credential impl | `CliCredentialProviderService` + `ConfigStorage` + `ProfileManager` | `cli/src/lib/cli-credential-provider.service.ts`, `cli/src/lib/{config-storage,profile-manager}.ts` | files only (AES-256-GCM) |
| CLI skeleton (oclif, `--json`, boot) | `getNestApp`/`closeNestApp`, command conventions | `cli/src/lib/nest-app.ts`, `cli/src/commands/server-types/list.ts` (reference) | boots Nest w/o PG/Redis |
| Local file cache precedent | `ServerTypeCacheService` (already caches `getNodeSizes`) | `cli/src/commands/server-types/...` cache service | file-based |
| Doctor primitives | `IpDetectionService`, firewall reads, `verifyDnsResolution`, nip utils | see `vops-doctor-analysis.md` | provider-token / stdlib |

**Explicitly reused read path for research:** `ProviderFactory.getProvider(p).getNodeSizes(true)` (plans+availability), `.getPricing(query)` (prices), `CapabilitiesProviderFactory.getCapabilitiesService(p).getStaticCapabilities()` (capabilities/list, credential-free), `ProviderDefinitionsService.getAllProviders()` (providers list). We deliberately **bypass** `ManagementService.getNodeSizes/getPricing` because that class couples to `ProviderConfigurationRepository` (TypeORM) + backend `CacheService` — `server-types list` already proves the factory path works without it.

---

## 2. Which module becomes the shared internal module

**Recommendation: introduce a thin, credential-parameterized `InfraCoreModule` (dynamic module) that centralizes the provider factory wiring both runtimes currently duplicate.** This is the lightest refactor that satisfies the plan's "one shared module used by Flui backend + vops CLI + vops local API."

Today the factory blocks in `ProvidersModule` (backend, lines ~79–213) and `CliProvidersModule` (CLI, lines ~39–88) are **near-identical hand-rolled `useFactory` registrations** differing only in (a) the credential binding and (b) which providers are registered. We extract that into:

```
src/modules/infra-core/
  infra-core.module.ts        # InfraCoreModule.forRoot({ credentialProvider, providers })
  index.ts                    # re-exports factories, tokens, DTO/types for external consumers
```

`InfraCoreModule.forRoot(opts)` returns a `DynamicModule` that:
- imports `ProviderCoreModule` + the requested per-provider modules (`HetznerProviderModule`, `ScalewayProviderModule`);
- binds `'ICredentialProvider'` to the supplied class (backend → `CredentialProviderService`; vops → `CliCredentialProviderService`);
- provides the four factories built from the registered providers;
- exports the factories + `'ICredentialProvider'`.

Then:
- Backend [`ProvidersModule`](../src/modules/providers/providers.module.ts) imports `InfraCoreModule.forRoot({ credentialProvider: CredentialProviderService, providers: [HETZNER, SCALEWAY, CONTABO, BYOS] })` and keeps only its backend-specific extras (TypeOrmModule.forFeature, controllers, object-storage, nftables, volume-export, seeders).
- A new **`VopsModule`** imports `InfraCoreModule.forRoot({ credentialProvider: LocalCredentialProvider, providers: [HETZNER, SCALEWAY] })` plus the vops-local runtime (§3) — and nothing else.

**Why not `src/modules/infra-core/` with moved files?** The plan says *"do not move large folders unless necessary; prefer wrapper/export module first."* Moving `providers/*` would touch dozens of import sites across the backend and risk breaking Flui. The dynamic-module approach moves **zero provider files**; it only relocates ~130 lines of duplicated wiring and adds one dynamic module. `CliProvidersModule` becomes a 10-line wrapper over `InfraCoreModule.forRoot(...)` (or is absorbed into `VopsModule`).

**Fallback if even that is deemed risky:** skip `InfraCoreModule` entirely for v0 and make `VopsModule` import the existing `CliProvidersModule` verbatim (it already is the vops provider substrate). Consolidation into `InfraCoreModule` can then land as a follow-up. This keeps Phase 1 near-zero-risk. *(Decision point flagged in §6.)*

---

## 3. What local implementations are needed

Most already exist in `cli/`. Net-new items are small. Naming follows the plan; where a Flui equivalent exists we reuse/rename rather than rebuild.

| Plan name | Status | Backing / path |
|---|---|---|
| `LocalCredentialProvider` | **Exists** as `CliCredentialProviderService` | `cli/src/lib/cli-credential-provider.service.ts` — implements `ICredentialProvider` over `ConfigStorage`. Reuse (optionally alias). |
| `LocalConfigStore` | **Exists** as `ConfigStorage` + `ProfileManager` | `cli/src/lib/{config-storage,profile-manager}.ts` — AES-256-GCM `config.json` + random `.key`, profiles under `~/.flui/`. For vops, repoint base dir to `~/.config/vops/` (see §storage). |
| `LocalCacheService` | **Partial** — `ServerTypeCacheService` file cache exists | Generalize to a small file/SQLite TTL cache for prices/availability/capabilities snapshots. Net-new but tiny. |
| `LocalSQLiteStore` | **Net-new** | SQLite (`better-sqlite3`) at `~/.config/vops/profiles/<p>/vops.db` for: provider cache, price/availability/inventory snapshots, plans, doctor reports, audit log, UI state. Schema-versioned (§stable contracts). |
| `LocalAuditLog` | **Net-new** | Append-only table in `vops.db` (+ optional JSONL in `logs/`). Records every create/delete with the resolved billing gate. |
| `LocalPlanStore` | **Net-new** | Plan files under `profiles/<p>/plans/` + a `plans` table; `vops.plan.v1` schema (§plan file). |
| `VopsWriteGateService` (= `ProvisioningSafetyService`) | **Net-new — the one safety chokepoint** | Centralizes hourly-only + per-plan + bare-metal + confirmation logic. Inputs already exist: `ProviderCapabilities.pricing.billingCycle`, `NodeSizeDto.supportsHourlyBilling`/`bareMetal`. |
| `LocalApiModule` | **Net-new** | Nest HTTP app bound to `127.0.0.1`, random port, one-time session token; calls the **same** services as the CLI. |
| `VopsCliModule` | **Net-new (thin)** | oclif commands `vops *` (may live in `cli/` initially; see §7 open question on binary name). |
| `VopsUiModule` | **Net-new** | Static local UI served by the local API; talks only to the local API. |

**Doctor locals** (if Phase 7): TCP/HTTP/TLS/DNS probe primitives — mostly stdlib, see `vops-doctor-analysis.md`.

---

## 4. What commands will be implemented in v0

Thin commands: `parse args → call shared service → render (table | --json)`. All support `--json`, `--profile`, and (writes) `--dry-run`, `--yes`.

**Research / comparison (read-only, Phase 3):**
```
vops providers list                              # ProviderDefinitionsService.getAllProviders (static, no token)
vops providers capabilities <p>                  # getStaticCapabilities (no token)
vops providers locations <p>                      # getCapabilities/regions (token for live)
vops providers plans <p>                          # getNodeSizes(true)
vops providers prices <p>                         # getPricing / node prices
vops providers availability <p> --family cx       # getNodeSizes(true) availability[]
vops compare --cpu 2 --ram 4gb --region eu        # net-new glue over getNodeSizes across providers
```

**Safe provisioning (Phase 4, write-gated):**
```
vops servers plan   --provider <p> --plan cx22 --location fsn1 --image ubuntu-24.04   # → vops.plan.v1 file
vops servers create --from-plan ./vops-plan.json                                       # re-validate gate, --yes/--dry-run
vops servers list   --provider <p>                                                     # listServersAsDto
vops servers show   <id> --provider <p>                                                # getServerDetailsAsDto
vops servers delete <id> --provider <p>                                                # deleteServer, --yes
```

**Local UI (Phase 5–6):** `vops ui` → starts local API on `127.0.0.1:<rand>` + opens browser with session token.

**Optional doctor (Phase 7, read-only):** `vops doctor <domain-or-ip>`, `vops doctor dns|tls|exposure`.

**Gaps to fill for `servers create` (small, already noted in extraction doc):** surface `listImages`/`listLocations` (endpoints exist in generated clients, not exposed as methods); make `CreateServerConfig.image` actually honored (Hetzner hardcodes `ubuntu-24.04`).

---

## 5. What UI / local API endpoints will be implemented in v0

Local API (Nest, `127.0.0.1` only, session-token guard) calling the **same** shared services as the CLI — no business logic in controllers:

```
GET    /api/providers                              # → ProviderDefinitionsService
GET    /api/providers/:p/capabilities
GET    /api/providers/:p/locations
GET    /api/providers/:p/plans
GET    /api/providers/:p/prices
GET    /api/providers/:p/availability
POST   /api/compare
POST   /api/servers/plan                           # → VopsWriteGateService.buildPlan
POST   /api/servers/create                         # → gate re-validate + ProviderFactory.createServer
GET    /api/servers      GET /api/servers/:id       DELETE /api/servers/:id
POST   /api/doctor/run                             # optional
```

**Responses use vops-specific DTOs** (mapped from internal `NodeSizeDto`/`ProviderCapabilities`/`ServerResponseDto`) — internal Flui entity shapes are **not** exposed on the wire (stable-contract rule). UI pages: Providers (capability matrix), Compare, Plan, Servers, optional Doctor. UI reads **only** the local API — never SQLite/files directly.

---

## 6. Known risks

1. **Shared-module refactor vs Flui stability (highest).** `ProvidersModule` is `@Global` and widely depended on. Extracting the factory wiring into `InfraCoreModule.forRoot` must preserve identical exported tokens/providers. *Mitigation:* land `InfraCoreModule` behind the existing exports (backend module keeps exporting the same symbols), run the full backend test/boot to prove parity; keep the §2 fallback (vops imports `CliProvidersModule` unchanged) ready if parity is at risk.
2. **`ManagementService` coupling temptation.** The obvious "research" service (`ManagementService.getNodeSizes/getPricing`) drags TypeORM + `CacheService`. *Mitigation:* vops uses `ProviderFactory`/`ProviderDefinitionsService` directly (proven by `server-types list`); a `LocalCacheService` replaces `CacheService`.
3. **Write gate correctness = money.** A wrong gate can provision a monthly-commitment/bare-metal resource. *Mitigation:* single `VopsWriteGateService`; gate = `billingCycle==='hourly'` **AND** `nodeSize.supportsHourlyBilling && !nodeSize.bareMetal`; dry-run must not call the provider API; heavy test battery (plan §Tests).
4. **Scaleway dual-credential + fan-out.** Scaleway needs accessKey+secretKey and does per-zone fan-out with synthetic composite IDs. `LocalCredentialProvider` must supply both (`getActiveAccessKeyPair` + `getActiveApiToken`). *Mitigation:* `CliCredentialProviderService` already handles this shape; validate live early.
5. **Nest-in-CLI weight / startup.** vops drags NestJS DI (and, via some shared modules, TypeORM entity classes as types). *Mitigation:* keep `VopsModule` minimal (InfraCore + local runtime only); do **not** import backend infrastructure/DB modules. Confirm `getNestApp()` boots with no PG/Redis for the vops module graph.
6. **`InfraCoreModule` scope creep.** Firewall/DNS/VNet/object-storage/nftables also live in the provider modules. *Mitigation:* v0 `InfraCoreModule` exposes only compute/capabilities/pricing/firewall-read/dns-read factories; leave nftables/object-storage/volume-export out of the vops graph.
7. **Local API security.** Binding, session token, redaction. *Mitigation:* `127.0.0.1` only, random port, one-time token in URL then header; tokens never in UI payloads; `--json` and logs redacted.
8. **Naming / packaging.** Plan says stay in-repo, no npm package. But binary is `vops`, scope `@flui-cloud/*` (vs repo's `@flui-cloud/cli`). *Mitigation:* v0 ships `vops` as an additional oclif bin in the existing `cli/` package (or a `vops` bin alias); defer package split. *(Open decision — see below.)*

---

## 7. Exact files / modules to touch (Phase 1+ preview — not yet changed)

**New files (net-new):**
```
src/modules/infra-core/infra-core.module.ts          # InfraCoreModule.forRoot (dynamic)
src/modules/infra-core/index.ts                       # public re-exports (factories, tokens, types)
src/modules/vops/vops.module.ts                       # VopsModule: InfraCore(local creds) + local runtime
src/modules/vops/safety/vops-write-gate.service.ts    # centralized billing/bare-metal gate
src/modules/vops/plans/plan.schema.ts                 # vops.plan.v1 type + validator
src/modules/vops/plans/local-plan-store.ts
src/modules/vops/storage/local-sqlite-store.ts        # better-sqlite3 + schema versioning
src/modules/vops/storage/local-cache.service.ts
src/modules/vops/storage/local-audit-log.ts
src/modules/vops/dto/*.ts                             # vops-facing response DTOs (map from internal)
src/modules/vops/local-api/local-api.module.ts        # 127.0.0.1 Nest app + session guard
src/modules/vops/local-api/*.controller.ts            # thin controllers → shared services
cli/src/commands/providers/{list,capabilities,locations,plans,prices,availability}.ts
cli/src/commands/compare.ts
cli/src/commands/servers/{plan,create,list,show,delete}.ts
cli/src/commands/ui.ts
cli/src/commands/doctor/{index,dns,tls,exposure}.ts    # optional Phase 7
ui/ (or cli/ui/)                                       # static local UI
```

**Edited (minimal, parity-preserving):**
```
src/modules/providers/providers.module.ts             # import InfraCoreModule.forRoot(...); keep backend extras + same exports
cli/src/cli-providers.module.ts                       # reduce to InfraCoreModule.forRoot(local) wrapper (or fold into VopsModule)
cli/package.json                                       # add `vops` bin + oclif topics for providers/servers/compare/ui/doctor
cli/src/lib/profile-manager.ts                        # optional: vops base dir ~/.config/vops (or a VopsProfileManager)
```

**Read-only reuse (imported, not modified):** all of `src/modules/providers/implementations/{hetzner,scaleway}/*`, `providers/services/*`, `providers/core/factories/*`, `providers/core/tokens.ts`, `providers/mappers/*`, `providers/dto/*`, `management/entities/provider-capabilities.entity.ts`, `management/services/provider-definitions.service.ts`, `cli/src/lib/{cli-credential-provider.service,config-storage,profile-manager,nest-app}.ts`, `cli/src/lib/utils/ip-detection.ts`.

**Do NOT touch / exclude from the vops graph:** `infrastructure/clusters/*` (k3s), `applications/*`, `catalog/*`, `observability/*`, `dns/services/*sync*` + reconciliation, `san-/wildcard-certificate.service.ts`, `nftables-firewall.backend.ts`, `volume-export.service.ts`, `mcp/*`, `assistant/*`, object-storage modules, `ManagementService` (DB/cache).

---

## 8. Decisions locked (Phase 0 → Phase 1)

Confirmed with the product owner:

1. **`InfraCoreModule.forRoot` — YES.** Build the dynamic, credential-parameterized shared module (dedups the backend+CLI wiring, gives the plan its named shared module). Backend parity with `ProvidersModule` must be proven before merge.
2. **Dedicated profile dir `~/.config/vops/` — YES.** vops tokens/state isolated from the Flui CLI.
3. **⭐ vops WILL become a separate repo (`flui-cloud/vops`).** Start in-repo per the plan, but **design every boundary for a clean later extraction.** This is now a first-class constraint (see §8.1).

### 8.1 Separate-repo boundary strategy (consequence of decision #3)

vops v0 lives in the Flui repo, but must be **liftable to `flui-cloud/vops` with a mechanical move**, not a rewrite. Design rules:

- **`InfraCoreModule` is the extraction seam.** It is the one artifact both sides share. Plan for it to eventually be published from Flui as a versioned package (e.g. `@flui-cloud/infra-core`) that the separate vops repo depends on. So keep it **self-contained**: it may depend on `providers/*` types/services and `ConfigModule`/`CommonModule`, but must **not** pull backend-only concerns (TypeORM entities as runtime deps, cluster/DNS-sync/observability). Anything InfraCore exports becomes a **public contract**.
- **All vops-specific code in one isolable subtree.** Put every net-new vops file under a single root — `src/modules/vops/**` for the runtime and a clearly-scoped set of `cli/src/commands/{providers,servers,compare,ui,doctor}` + `cli/src/vops/**` for CLI/UI — so a future `git filter-repo`/move produces the new repo cleanly. **No vops file may import a backend feature module** (applications, catalog, infrastructure/clusters, dns/services, mcp, …); its only inward dependency is `InfraCoreModule` + local runtime.
- **Contracts are the real API now.** Because the JSON output, `vops.plan.v1`, local-API endpoints, SQLite schema, and credential-storage format will outlive the in-repo phase and become the separate product's surface, freeze them behind vops-owned DTOs from day one. Never leak internal Flui entity/DTO shapes (already a plan rule — now doubly binding).
- **Dependency direction is one-way:** vops → InfraCore → providers. Nothing in `providers/*` or the backend may import from `src/modules/vops/**`.
- **Post-split shape (target):** `flui-cloud/vops` repo depends on `@flui-cloud/infra-core` (published from flui-core) + `@flui-cloud/vops-*` local packages; the in-repo `VopsModule`/commands move over largely unchanged. Until the split, everything runs in-process via the same Nest DI.

*Implication for Phase 1:* when building `InfraCoreModule`, treat its `index.ts` exports as the future package API — minimal, typed, no backend leakage — and audit that no `src/modules/vops/**` import reaches outside InfraCore + local runtime.

### 8.2 More decisions locked

4. **vops lives in a dedicated `vops/` package** (own `package.json` + oclif bin), importing shared code via `InfraCoreModule`. Isolated subtree → clean `git`-move to `flui-cloud/vops` later. Not folded into the existing `cli/` package.
5. **Local storage = libSQL embedded** (`@libsql/client`, local file mode). Runs on the dev Node 22.13 with no experimental flag, ships prebuilds (no `node-gyp`), and writes a **standard SQLite file** — the same file a future Go port reads via `modernc.org/sqlite` (pure-Go, no cgo). Secrets stay in the AES-GCM config store, **not** in the DB.

### 8.3 Go-portability & language-neutral contracts (consequence of "future Go port")

The reused Flui **TypeScript provider services will not survive a Go rewrite** (Go re-implements them via `hcloud`/`scaleway-sdk-go`). The durable assets are the **data layer + contracts**, so those are designed language-neutral from day one:

- **Storage engine = SQLite file** (via libSQL now) — one `.db`, readable by Node today and Go later. This is why PGlite/DuckDB/LMDB were rejected: their formats aren't cleanly embeddable in a pure-Go binary.
- **Schema is raw SQL, ORM-neutral.** A checked-in `.sql` file with explicit `CREATE TABLE` is the source of truth, applied identically by TS and Go. Any ORM (e.g. Drizzle) is a TS-only query convenience, never the schema owner.
- **Neutral column types:** `TEXT`/`INTEGER`/`REAL`; dates as **ISO-8601 strings**; nested JSON stored as `TEXT` with a documented shape (Go unmarshals with `encoding/json`).
- **Versioning via `PRAGMA user_version`** (or a trivial `schema_migrations` table), not an ORM migration table.
- **Thin `LocalStore` repository over raw SQLite**, not TypeORM entities — keeps the layer decoupled from the backend and 1:1 re-writable in Go.
- **Contracts are the product API:** `--json` output, `vops.plan.v1`, local-API endpoints, and the **secrets file crypto layout** (AES-256-GCM, explicit `iv | authTag | ciphertext`) are specified in a language-neutral doc so a Go port reads/decrypts the same artifacts. Never leak internal Flui entity/DTO shapes.

---

*End of Phase 0. Decisions #1–#5 locked.*

---

## 9. Implementation log

### Phase 1 — shared `InfraCoreModule` (DONE, verified)

**Delivered:**
- `src/modules/infra-core/infra-core.module.ts` — `InfraCoreModule.forRoot({ credentialProvider })` dynamic, `global: true`. Imports `ProviderCoreModule` + `HetznerProviderModule` + `ScalewayProviderModule`; binds `'ICredentialProvider'` from the supplied class; provides + exports `ProviderFactory`, `FirewallProviderFactory`, `DnsProviderFactory`, `CapabilitiesProviderFactory` (Hetzner + Scaleway). Same `useFactory` wiring the CLI used → exact parity.
- `src/modules/infra-core/index.ts` — public surface (future `@flui-cloud/infra-core` API): factories, enums, `ICredentialProvider`, `NodeSizeDto`, `PricingDto`.
- `cli/src/cli-providers.module.ts` — refactored to delegate the provider substrate to `InfraCoreModule.forRoot({ credentialProvider: CliCredentialProviderService })`; keeps only CLI-local extras (ApiClient, IpDetection, file repos, bootstrap seeders); re-exports InfraCore so all `flui` commands keep the same symbols. **Net: the duplicated factory wiring now lives once.**

**Verified (measurable, via CLI + build):**
- `pnpm run build` (backend `nest build`) → **success** — backend parity preserved (no backend file touched).
- `cli` `pnpm run build` (`tsc && tsc-alias`) → **success**.
- `flui server-types list --provider hetzner --json` → live Hetzner node sizes through the new InfraCore `ProviderFactory` (hourly/bareMetal/prices intact).
- `flui server-types list --provider scaleway --json` → live Scaleway (DEV1-S, fr-par/nl-ams/pl-waw) through InfraCore.
- `eslint` (incl. `sonarjs`) on `src/modules/infra-core/*` → clean.

**Deliberately deferred (not needed for vops, avoids backend risk):** migrating the **backend** `ProvidersModule` onto `InfraCoreModule.forRoot` (it carries Contabo/BYOS, nftables, object-storage, volume-export, seeders, controllers, TypeORM). Backend keeps its current wiring, unchanged and green. Full backend consolidation is an optional later step, not a vops blocker. `CapabilitiesProviderFactory` is now additionally available in the CLI/vops runtime (was absent before) — needed for `vops providers list/capabilities`.

### Phase 2 (start) — dedicated `vops/` package + first read commands (DONE, verified)

**Delivered** (all under `vops/`, own `package.json` `@flui-cloud/vops`, bin `vops`, oclif; mirrors the CLI's tsconfig/`src/*`→`../src/*` + `module-alias` setup):
- `vops/src/lib/config/local-config-store.ts` — AES-256-GCM secrets under `~/.config/vops/profiles/<p>/` (documented `iv:authTag:ciphertext` layout for the Go port).
- `vops/src/lib/credentials/local-credential-provider.ts` — file-backed `ICredentialProvider` (Hetzner token / Scaleway key pair).
- `vops/src/safety/write-gate.ts` — centralized `computeWriteGate` (hourly-only policy, single source of truth).
- `vops/src/dto/provider.dto.ts` — stable vops response DTOs (no internal Flui shapes leaked).
- `vops/src/providers/vops-providers.service.ts` — read-only research surface over the shared capabilities services (static caps, no creds).
- `vops/src/vops.module.ts` — **light** wiring: reuses the real `HetznerCapabilitiesService`/`ScalewayCapabilitiesService` + `CapabilitiesProviderFactory` classes directly, **avoiding the heavy per-provider Nest modules** (they drag `@aws-sdk/*` via object-storage and `@kubernetes/client-node` — irrelevant to vops).
- `vops/src/commands/providers/{list,capabilities}.ts` + `lib/{nest,output}.ts` — oclif commands with `--json`, clean `this.error` handling.

**Architecture note (important):** the object-storage/Kubernetes transitive weight means vops does **not** import `InfraCoreModule.forRoot` (the full seam, used by CLI/backend). It reuses the shared **service/factory/DTO classes** with light vops-local wiring — same code paths, minimal deps. Converging the two (splitting object-storage out of the provider modules so InfraCore itself is light) is a future refactor, not a v0 blocker.

**Verified (measurable, via the new `vops` binary):**
- `pnpm install` + `pnpm run build` (`tsc && tsc-alias`) → success; `vops` linked globally.
- `vops providers list` → table (Hetzner/Scaleway, `hourly`, create=yes via write-gate, feature flags).
- `vops providers capabilities hetzner` → static capabilities (billing, credential type, firewall backend…).
- `vops providers list --json` → stable JSON contract.
- `vops providers capabilities aws` → clean `Error: Unknown provider…`, exit 1.
- `vops providers --help` → topic + commands registered.
- Backend + `flui` CLI untouched (no `src/` change in Phase 2).

### Phase 3 — live research reads + compare (core DONE, verified)

**Delivered** (all under `vops/`):
- `vops.module.ts` extended (still light): added `ProviderCoreModule` (mappers/LabelService) + `HetznerProviderService`, `ScalewayProviderService` (+ 4 Scaleway adapters) + `ProviderFactory`. Confirmed none of these pull `@aws-sdk`/`@kubernetes`/`typeorm`.
- `catalog/vops-catalog.service.ts` — live `getNodeSizes(true)`→ plans / availability / cross-provider compare, cheapest-price extraction, plan-level write-gate (`hourly && !bareMetal`).
- Commands: `providers plans|prices|availability|locations`, top-level `compare`, plus `config set|list` (the local encrypted credential entry point).
- Shared `lib/providers.ts` (resolve/display), `dto/plan.dto.ts`, `output.money`.

**Verified live** (vops store seeded from the local flui store via a no-secret bridge; `vops config list` → hetzner, scaleway):
- `vops providers plans hetzner` → live specs + €/h·€/mo + CREATE gate (cx23 2c/4G €0.0088/h).
- `vops providers prices scaleway` → cheapest-first (DEV1-S €0.0090/h).
- `vops providers locations hetzner` → live regions (fsn1/nbg1/hel1, DE/FI).
- `vops compare --cpu 2 --ram 4gb --hourly-only` → cross-provider, price-sorted, gate applied — the headline flow.
- `--json` stable on all; unknown provider → clean error, exit 1.

**Honest caveats / follow-ups:**
- `vops providers availability` reads faithfully but the underlying **shared** `getNodeSizes(true)` currently returns `available:false` across EU DCs for the cx line. This comes from `HetznerProviderService.getDatacenterAvailability` (the same code the backend uses), **not** from vops — to investigate in the shared layer, not a vops blocker.
- **`LocalCacheService` (libSQL) not yet built** — live commands work without it; caching price/availability snapshots is the next Phase 3 sub-step (schema in raw SQL + `PRAGMA user_version` per §8.3).
- **Full Sonar scan pending:** SonarQube is up (`localhost:9000`, http 200) but no `SONAR_TOKEN` in `.env.local`, so `pnpm sonar:scan` can't authenticate. `tsc` is clean across backend/CLI/vops. Run the scan once a token is configured.

### Phase 3 close — libSQL cache (DONE, verified)

- `lib/store/local-store.ts` — libSQL-backed SQLite at `~/.config/vops/profiles/<p>/vops.db`; raw SQL schema + `PRAGMA user_version` (Go-portable per §8.3). `cache` table (TTL) wired into `VopsCatalogService.nodeSizes` (1h TTL, `--refresh` bypass on all catalog commands).
- Verified: run1 `--refresh` 1.4s (live) vs run2 0.36s (cache); `vops.db` row + expiry present.

### Phase 4 — safe provisioning (DONE, verified — no real resource created)

**Delivered** (all `vops/`):
- `safety/vops-write-gate.service.ts` — the single provisioning authority: allow only `billingCycle==='hourly'` AND `supportsHourlyBilling && !bareMetal`; `evaluate()` + `assert()`.
- `dto/plan-file.dto.ts` — `vops.plan.v1` contract (billingGate + estimatedCost + sshKey). `lib/plan-io.ts` read/write + version guard + default image.
- `servers/vops-servers.service.ts` — `plan|create|list|show|delete`; create **re-validates the gate live** (never trusts the file), asserts, then dry-run / `--yes`. Audit via `LocalStore.appendAudit` (`audit` table, schema v2).
- Commands `servers plan|create|list|show|delete`.

**Verified via live CLI (writes exercised only up to the safety boundary):**
- `servers plan hetzner cx23 fsn1` → allowed, cost €0.0088/h, writes `vops.plan.v1`.
- `servers create --from-plan --dry-run` → "would create… Nothing changed" (no API create).
- `servers plan scaleway EM-A116X-SSD` (bare metal) → gate **blocked**; `create --yes` on it → **refused** (bare-metal blocked even with `--yes`).
- `servers create` without `--yes` (no dry-run) → refused.
- `servers list hetzner` → live account servers (read-only). `delete` requires `--yes`.
- Audit rows recorded; `vops --help` shows config/providers/servers topics + compare.

**Tests (jest + ts-jest, `pnpm test` → 7/7 green):** write-gate allows hourly/non-bm, blocks bare-metal, blocks monthly providers, blocks non-hourly plans, `assert()` throws; plan-schema rejects wrong version / accepts v1. Covers the plan's safety-test list (write gate, hourly-only, monthly blocked, bare-metal blocked, plan schema, invalid-plan rejected). Dry-run-no-API + JSON-shape covered by live CLI checks.

### Phase 5 — local API (DONE, verified)

- `local-api/` — `LocalApiModule` imports `VopsModule` (services exported); `ProvidersController` + `OpsController` are thin delegations (no logic); `SessionGuard` (`APP_GUARD`) requires the one-time token on `/api/*`, passes the UI shell. `bootstrap.ts` binds **`127.0.0.1` only**, random port (or `VOPS_PORT`), mints/echoes a session token. `commands/ui.ts` = `vops ui`.
- Verified: `/api/providers` with token → 200 (same data as CLI); **without token → 403**; `?session=` query → 200; `lsof` confirms **bind `127.0.0.1` only** (never 0.0.0.0); startup prints URL with token.

### Phase 6 — local UI (DONE, verified)

- `ui/app.html` — self-contained single-page UI (no external assets/CSP issues), copied to `lib/` in postbuild, served by `RootController` via `renderUi()`. Tabs: **Providers** (capability matrix), **Compare** (cpu/ram/region/provider/hourly-only → price-sorted table with per-row *plan* action → plan panel + *dry-run create*), **Servers** (list by provider). Reads the session token from the URL, calls the local API with `x-vops-session`.
- Verified: root serves the full UI; `POST /api/compare` (106 rows, cheapest Hetzner cx23 €0.0088) and `POST /api/servers/plan` (gate allowed, est cost) drive the UI flows. Sonar inline (spread/includes) fixed.

### v0 status

The full local-first product works end-to-end — **CLI + local API + web UI**, one set of services, tokens never leave the machine, `127.0.0.1`-only, hourly-only write gate enforced (unit-tested). `pnpm test` 7/7; backend + `flui` CLI untouched.

### Phase 7 — read-only doctor (DONE, verified)

- `doctor/` — **stdlib-only**, no Nest boot, no credentials, no cluster, no writes. `probes.ts` (`node:dns` resolve4/6/cname, `node:tls` handshake + `getPeerCertificate`, `node:net` TCP probe); `doctor.service.ts` (dns / tls / exposure checks + `run()` that branches on IP-vs-domain); `report.ts` (Finding/severity/worst); `render.ts`.
- Commands: `vops doctor <target>`, `vops doctor dns|tls|exposure`. `--json` + exit 1 on any `fail`.
- Verified live: `tls example.com` → all ok (expiry 54d, SAN covers, trusted); `tls expired.badssl.com` → **expiry FAIL** + chain `CERT_HAS_EXPIRED`; `tls self-signed.badssl.com` → chain `DEPTH_ZERO_SELF_SIGNED_CERT`; full `doctor example.com` → dns+tls+exposure (80/443 open, 22/6443 timeout); exit 1 on fail; JSON clean.
- Tests: +4 (`buildReport` worst/counts, `parsePorts`). **`pnpm test` → 11/11 green.**

### v0 + doctor complete

All planned phases (1–7) delivered and verified. `vops` provides, local-first from one dedicated package: **research → compare → plan → safe create (hourly-gated) → list/show/delete → doctor**, over CLI + `127.0.0.1` API + web UI, reusing real Flui provider code, tokens never leaving the machine. Backend + `flui` CLI untouched throughout.

### Remaining (optional / follow-ups)

- **`vops config set` UX** — interactive masked prompt (currently flag/env only).
- **Availability** shared-layer investigation (Phase 3 caveat: `getDatacenterAvailability` returns all-false for cx).
- **Full Sonar scan** — needs `SONAR_TOKEN` in `.env.local` (SonarQube is up); inline sonarjs warnings fixed as they appeared.
- **Browser auto-open** on `vops ui`; **backend `InfraCoreModule` adoption** (deferred, optional).

## 10. Phase 8 — Firewall + VNet CRUD and the control dashboard (2026-07-06)

Scope decision: **full CRUD server + firewall + vnet** and a **rich Tailwind + Alpine dashboard** (compiled/vendored, self-contained, offline) — a Docker-Desktop-style control plane that reads *and acts* on providers, idempotent with the CLI.

**Wiring.** `vops.module.ts` gains `HetznerFirewallService` + `ScalewayFirewallService` + `FirewallProviderFactory` (same light-wiring `useFactory` pattern; deps already satisfied — `LabelService` via `ProviderCoreModule` `@Global`, Scaleway adapters already present). VNet needed **zero** new wiring: it lives on `ICloudProvider` (optional methods) and flows through the existing `ProviderFactory`. `VopsWriteGateService` gains a provider-level authority (`evaluateProvider`/`assertProviderWritable`) — non-server writes (firewalls, networks) are allowed only on hourly-billed providers.

**Services + contracts.** `src/firewall/vops-firewall.service.ts` (list/show/create/updateRules/delete/apply/remove; create+delete take `{dryRun,yes}`, all writes audited + provider-gated). `src/vnet/vops-vnet.service.ts` (list/show/create/delete/attach/detach/add+deleteSubnet/add+deleteRoute; optional-method guard). DTOs in `src/dto/{firewall,vnet}.dto.ts`.

**CLI (parity).** `commands/firewall/{list,show,create,delete,apply,rules}.ts` and `commands/vnet/{list,show,create,delete,attach,subnet,route}.ts`; new package.json topics. Verified live: Hetzner + Scaleway firewall list, Hetzner vnet list, dry-run, confirmation-refusal.

**Local API.** `local-api/{firewall,vnet,doctor}.controller.ts` registered in `LocalApiModule`; Doctor exposed via a dependency-free `new DoctorService()` at `/api/doctor?target=`.

**UI build.** Tailwind v3 CLI + Alpine `cdn.min.js` are build inputs (devDeps). `scripts/build-ui.js` (postbuild) compiles the purged CSS and copies the vendored Alpine into `lib/vops/src/ui/`; `renderUi()` inlines both into `<!--TAILWIND-->`/`<!--ALPINE-->` placeholders → one self-contained offline HTML (~95 KB). `tailwind.config.js` (dark, ink/brand palette) + `src/ui/tailwind.css` (`@layer` component classes).

**Dashboard.** `src/ui/app.html` — single Alpine root `dashboard()`: sidebar (Providers/Compare/Servers/Firewalls/Networks/Doctor), topbar provider switch + refresh, slide-over drawer (firewall rules editor + apply/remove + delete; vnet subnets/routes/attach/detach/delete), modal (create forms + server provision preview + confirm-delete) with **Dry-run + Create**, toast. Idempotent by construction: UI → local API → the *same* `Vops*Services` the CLI uses.

**Verified end-to-end** (`VOPS_PORT=7799`): root inlines TW+Alpine; `/api/firewalls`, `/api/vnets`, `/api/doctor` live; session guard 403s; firewall + vnet create dry-run is a no-op; create without `yes` refused (400). `tsc` clean, build clean, **13/13** jest (added 2 provider-gate tests). Backend + `flui` CLI still untouched. Everything uncommitted.

Follow-up: a11y label-for warnings in `app.html` deferred (local single-user tool).

## 11. Phase 9 — Home = interactive Europe map + unified region pricing (2026-07-06)

Reframed the home from a grid of buttons into a map-first overview, mirroring `flui.landing`.

**Legal check (requested).** Showing cheapest-per-region across providers is low-risk when: prices are treated as facts; only the minimum needed is taken (EU database-right substantiality); data comes from official pricing APIs (not HTML scraping) within each provider's API ToS on redistribution; provider names used nominatively, no logos; an "indicative, source: provider" disclaimer is shown. The per-user local tool (user's own credentials) has essentially no exposure — the question only bites for a future Flui-hosted shared cached API, where the two things to confirm per provider are (a) API ToS on redistribution and (b) DB-right substantiality. Not formal legal advice.

**Map pipeline (zero new runtime deps).** `d3-geo` + `topojson-client` + `world-atlas` are devDeps. `scripts/build-map.js` bakes `src/ui/europe.geo.json` — Europe country outlines and region pins **projected with the identical geoMercator** so pins land on the geography (uses `countries-110m`, 34 KB). Coordinates live once in `src/lib/region-geo.json`. The JSON is inlined into the served HTML at `<!--GEO-->` and parsed by Alpine.

**Unified pricing.** `VopsCatalogService.regionPrices()` computes the cheapest hourly/monthly per location; `VopsRegionsService.regions()` joins geography × price into a provider-agnostic list. Sourcing: `VOPS_PRICING_URL` (future Flui cached API) → each provider live (the user's own credentials, libSQL-cached) → a **bundled seed snapshot** (`src/lib/pricing-snapshot.json`) so the map stays populated with zero credentials. Endpoint `GET /api/providers/regions`; CLI `vops providers regions`.

**Home UI.** A hero map (SVG countries + pulsing per-provider pins, hover tooltip with city/country and "from €X/mo"), a legend with a live/indicative badge, a unified **All regions** table (including non-EU regions), and the provider capability cards demoted below. Verified live (fsn1 €5.49/mo, fr-par €6.55, Ashburn €17.49, Singapore €9.99) and in the no-credentials path (seed snapshot). Build clean, 9/9 tests, uncommitted.
