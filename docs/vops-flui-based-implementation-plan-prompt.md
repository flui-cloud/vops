# vops — Flui-based implementation plan prompt

Use this prompt with Claude Code / Codex.

---

# Task: Implement vops as a Flui-based local-first mode using shared Flui modules

You are working inside the existing Flui repository.

The goal is to implement the first version of `vops` as a Flui-based local-first tool.

Important: this is **not** a Go rewrite, **not** a separate architecture, and **not** a copy of Flui modules.

The goal is to reuse the real Flui provider/infrastructure modules as much as possible, with minimum refactor.

## Product thesis

`vops` is a real-time VPS provider comparator and safe provisioning tool.

It uses live provider APIs to:

1. research providers
2. compare live prices, regions, plans and availability
3. inspect provider capabilities and billing model
4. generate a safe creation plan
5. create only hourly-billed VPS resources
6. list/show/delete resources immediately
7. optionally run local read-only diagnostics after creation

Core public positioning:

```text
Real-time VPS comparison and safe provisioning using provider APIs.
```

Do not position `vops` as a mini-PaaS or a mini-Flui.

```text
Flui = application platform
vops = local-first VPS/provider comparison and operations tool
```

## Architectural decision

For now, `vops` must be implemented inside the Flui repo.

Do not create a separate npm package yet.

Do not create a monorepo.

Do not rewrite the provider layer.

Do not copy provider modules.

Create one shared internal module inside the Flui repo that both Flui and vops can use.

Suggested name:

```text
InfraCoreModule
```

or:

```text
ProviderInfraModule
```

The exact name can be adjusted based on the existing codebase, but the concept is fixed:

```text
one shared internal module inside Flui
used by:
- Flui backend
- vops CLI
- vops local API / UI
```

## Key constraint

`vops` must reuse the real Flui modules:

- provider services
- provider adapters
- provider capabilities
- pricing models
- availability logic
- generated OpenAPI clients
- DNS provider wrappers where reusable
- firewall provider wrappers where reusable
- DTOs / mappers / interfaces
- credential provider abstraction

The goal is not “similar modules”.

The goal is the same code paths wherever possible.

## What may be adapted

You may add local implementations for runtime concerns:

- `LocalCredentialProvider`
- `LocalConfigStore`
- `LocalSQLiteStore`
- `LocalCacheService`
- `LocalAuditLog`
- `LocalPlanStore`
- `LocalApiModule`
- `VopsCliModule`
- `VopsUiModule`

These are allowed because `vops` runs locally, while Flui runs as a backend platform.

## What must not be included in vops v0

Do not include:

- k3s bootstrap
- cluster provisioning
- workload/app deployment
- managed databases
- marketplace
- app logs/metrics runtime
- observability stack installation
- Kubernetes services
- cert-manager CRD diagnostics
- DNS/certificate reconciliation loops
- MCP
- AI assistant
- Flui dashboard backend state
- anything that installs software on the VPS
- BYOS as a core provider

BYOS may be considered later only as an external target for doctor/access checks, not as part of v0 provider comparison/provisioning.

## vops v0 scope

v0 should support the following.

### Research / comparison

```bash
vops providers list
vops providers capabilities hetzner
vops providers locations hetzner
vops providers plans hetzner
vops providers prices hetzner
vops providers availability hetzner --family cx
vops compare --cpu 2 --ram 4gb --region eu
```

### Safe provisioning

```bash
vops servers plan --provider hetzner --plan cx22 --location fsn1 --image ubuntu-24.04
vops servers create --from-plan ./vops-plan.json
vops servers list --provider hetzner
vops servers show <id> --provider hetzner
vops servers delete <id> --provider hetzner
```

### Local UI

```bash
vops ui
```

`vops ui` should start a local API bound to `127.0.0.1` and serve the UI locally.

The first UI can be simple, but it must exist in v0.

It should focus on:

- provider comparison
- availability
- prices
- capabilities
- plan creation
- server inventory
- safe create/delete
- optional doctor section if easy

### Optional read-only doctor

If feasible without delaying the core:

```bash
vops doctor <domain-or-ip>
vops doctor dns <domain>
vops doctor tls <domain>
vops doctor exposure <ip>
```

Doctor must be read-only.

No writes, no reconciliation, no SSH, no cluster.

## Main flow

The ideal vops experience is:

```text
compare → inspect → plan → create → list/show → delete/cleanup → doctor
```

Not:

```text
create VPS directly
```

Provisioning must be research-driven.

## Safety model

Write operations are allowed early, but must be safe-by-default.

Rules:

1. Allow create only on providers with hourly billing.
2. Allow create only on plans that support hourly billing.
3. Refuse bare metal or monthly commitment plans.
4. Always generate a plan before creation.
5. Creation from direct flags may internally generate a plan, but the plan must be visible before execution.
6. `create` must require explicit confirmation or `--yes`.
7. `--dry-run` must be supported.
8. Estimated cost must be shown before creation.
9. `list`, `show`, and `delete` must be available in v0.
10. Delete must require confirmation or `--yes`.

The write gate should be centralized in one service, for example:

```text
VopsWriteGateService
```

or:

```text
ProvisioningSafetyService
```

Do not spread billing safety checks across commands.

## Shared module design

Create or reorganize a single shared internal module.

Suggested structure:

```text
src/modules/infra-core/
  infra-core.module.ts
  providers/
  capabilities/
  pricing/
  availability/
  servers/
  dns/
  firewalls/
  types/
  mappers/
  safety/
```

But do not move files unnecessarily if a lighter wrapper module is enough.

Minimum-refactor approach is preferred:

- keep existing provider services where they are if moving them is risky
- create a shared module that imports/exports them
- add clean provider tokens/interfaces where needed
- avoid breaking Flui backend

The module should expose services usable by both:

```text
Flui backend
vops CLI
vops local API
```

## Dependency inversion

Where current services depend on backend-only implementations, introduce local-compatible abstractions.

Important seams:

### Credentials

Keep/use `ICredentialProvider`.

Flui backend implementation:

```text
DbCredentialProvider
```

vops implementation:

```text
LocalCredentialProvider
```

### Config

Flui backend can use existing `ConfigService`.

vops should use a local config provider.

### Cache

Flui backend may use Redis or the existing cache.

vops should use local file/SQLite cache.

### Storage

Flui backend may use Postgres/TypeORM.

vops should use local SQLite for operational state.

## Local storage

Use a hybrid local storage model.

Suggested location:

```text
~/.config/vops/
  profiles/
    default/
      vops.db
      secrets.json.enc
      .key
      plans/
      logs/
```

Use encrypted file storage for secrets:

- provider tokens
- access keys
- secret keys

Use SQLite for local operational state:

- provider cache
- price snapshots
- availability snapshots
- server inventory snapshots
- plans
- doctor reports
- local audit log
- UI state

Do not make the UI read files or SQLite directly.

The UI must only call the local API.

## Local API

Implement a local API used by the UI.

It must run only on localhost.

Default bind:

```text
127.0.0.1
```

Do not bind to `0.0.0.0` by default.

Use a random or configurable local port.

Use a local session token when opening the browser.

Example:

```text
http://127.0.0.1:8787/?session=<one-time-token>
```

The UI must call local API endpoints with that token.

Suggested endpoints:

```text
GET  /api/providers
GET  /api/providers/:provider/capabilities
GET  /api/providers/:provider/locations
GET  /api/providers/:provider/plans
GET  /api/providers/:provider/prices
GET  /api/providers/:provider/availability

POST /api/compare

POST /api/servers/plan
POST /api/servers/create
GET  /api/servers
GET  /api/servers/:id
DELETE /api/servers/:id

POST /api/doctor/run
```

The API should call the same services used by the CLI.

Do not duplicate business logic in the UI or controllers.

## CLI design

Use the existing Flui CLI patterns where possible.

Commands should be thin:

```text
parse args → call service → render output
```

All important commands must support:

```bash
--json
--profile
--dry-run
--yes
```

where applicable.

The `--json` output must be stable and treated as a public contract.

## Stable contracts

Even though this is Flui-based, design stable contracts so the implementation can evolve later.

Stabilize:

1. CLI commands
2. JSON output
3. plan file schema
4. local API endpoints
5. SQLite schema versioning
6. credential storage format

Do not expose internal Flui entity shapes directly in vops JSON output.

Map internal DTO/entities to vops-specific response DTOs.

## Plan file

Create a portable plan file format.

Example:

```json
{
  "version": "vops.plan.v1",
  "action": "server.create",
  "provider": "hetzner",
  "plan": "cx22",
  "location": "fsn1",
  "image": "ubuntu-24.04",
  "sshKey": {
    "mode": "existing",
    "id": "default"
  },
  "billingGate": {
    "providerBilling": "hourly",
    "planSupportsHourly": true,
    "bareMetal": false,
    "allowed": true,
    "reason": null
  },
  "estimatedCost": {
    "hourly": 0.0,
    "monthly": 0.0,
    "currency": "EUR"
  },
  "createdAt": "ISO_DATE"
}
```

The plan must be generated before creation.

`create --from-plan` must validate the plan again before executing.

## Provider support for v0

Start with providers already supported well by Flui.

Required:

- Hetzner
- Scaleway, if the existing adapter is stable enough

Optional before launch:

- one additional provider only if it has real API support and strengthens the live comparison story

Do not add providers just to increase the number.

Providers with monthly-only or unclear billing should be read-only.

For each provider, expose:

```text
comparison support
availability support
pricing support
create support
delete support
firewall support
DNS support
reason if unsupported
```

## BYOS

Do not include BYOS as a core provider in v0.

Reason: BYOS does not fit the core vops thesis:

```text
live provider API comparison + safe provisioning
```

BYOS has no live pricing, no provider availability, no provider-side create/delete.

If needed later, model it as:

```text
external target
```

Example future commands:

```bash
vops targets add my-server --host 1.2.3.4 --user root
vops doctor my-server
```

Do not implement this in v0 unless extremely cheap.

## UI v0

The UI should be simple but real.

Suggested pages:

### 1. Providers

Capability matrix:

```text
Provider | Pricing | Availability | Create | Firewall | DNS | Billing | Status
```

### 2. Compare

Input:

```text
CPU
RAM
Region
Hourly only
Provider filter
```

Output table:

```text
Provider | Plan | CPU | RAM | Region | Available | Hourly | Estimated monthly | Action
```

Action:

```text
Plan
```

### 3. Plan

Show generated plan:

- provider
- plan
- location
- image
- estimated cost
- billing gate
- safety warnings
- create command equivalent

### 4. Servers

Show inventory:

- provider
- id
- name
- public IP
- plan
- location
- status
- estimated cost
- actions: show/delete

### 5. Doctor

Optional v0 if feasible:

- domain/IP input
- DNS/TLS/exposure findings
- read-only report

## Security

Local-first guarantees:

- no hosted backend
- no telemetry by default
- tokens stay local
- secrets never sent to any Flui server
- local API binds to `127.0.0.1`
- UI never receives raw tokens unless strictly necessary, preferably never
- logs redact tokens
- `--json` output never includes secrets

## Implementation phases

### Phase 0 — codebase inspection

Before changing code, inspect:

- provider modules
- credential provider interface
- Flui CLI local storage
- generated clients
- DNS/firewall provider services
- existing CLI command structure
- existing config/profile structure

Produce a short implementation note:

```text
docs/vops-flui-based-implementation-plan.md
```

This document should confirm:

1. which modules will be reused directly
2. which module will become the shared internal module
3. what local implementations are needed
4. what commands will be implemented in v0
5. what UI/API endpoints will be implemented in v0
6. known risks

### Phase 1 — shared internal module

Create the shared internal module without breaking Flui.

Goal:

```text
Flui backend still works
vops can import the same provider services
```

Do not move large folders unless necessary.

Prefer wrapper/export module first.

### Phase 2 — local runtime

Implement:

- `LocalCredentialProvider`
- local config/profile loading
- local secret store
- SQLite local store
- local cache
- local audit log

Goal:

```text
provider services can run locally without Postgres/Redis
```

### Phase 3 — CLI research commands

Implement:

```bash
vops providers list
vops providers capabilities <provider>
vops providers locations <provider>
vops providers plans <provider>
vops providers prices <provider>
vops providers availability <provider>
vops compare --cpu 2 --ram 4gb --region eu
```

All with `--json`.

### Phase 4 — plan/create/list/show/delete

Implement:

```bash
vops servers plan
vops servers create --from-plan
vops servers list
vops servers show
vops servers delete
```

Include:

- centralized write gate
- hourly-only policy
- plan validation
- dry-run
- confirmation
- estimated cost
- local audit log

### Phase 5 — local API

Implement local API using the same services as CLI.

Bind to `127.0.0.1`.

Add session token.

Implement minimum endpoints for UI.

### Phase 6 — UI v0

Implement simple local UI.

Focus on:

- provider comparison
- plan
- servers
- basic status
- optional doctor

Do not spend time on heavy design polish.

Prioritize clear demo value.

### Phase 7 — optional doctor

If time allows, implement read-only doctor:

```bash
vops doctor <domain-or-ip>
vops doctor dns <domain>
vops doctor tls <domain>
vops doctor exposure <ip>
```

Use only local checks and provider read APIs.

No writes.

## Tests

Add tests for:

- write gate
- hourly-only policy
- monthly provider blocked
- bare metal blocked
- plan schema validation
- create from invalid plan rejected
- dry-run does not call provider API
- JSON output shape
- local API auth/session
- token redaction

## Deliverables

At the end, produce:

1. `docs/vops-flui-based-implementation-plan.md`
2. shared internal infra module
3. local runtime providers
4. vops CLI commands
5. local API
6. simple local UI
7. tests for safety gates and plan validation

## Final acceptance criteria

The implementation is acceptable if:

1. vops uses real Flui provider modules, not copied/similar versions.
2. Flui backend still works.
3. vops can compare live provider prices/availability/capabilities.
4. vops can generate a server creation plan.
5. vops can create only hourly-billed VPS resources.
6. vops can list/show/delete created resources.
7. UI uses local API, not direct file access.
8. Local API binds only to localhost.
9. Tokens stay local and are redacted.
10. No app deployment, k3s, managed runtime, or Flui platform features leak into vops.

## First execution instruction

Start with **Phase 0 only**.

Do not implement yet.

Produce the plan and list the exact files/modules you would touch.
