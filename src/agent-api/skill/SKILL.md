---
name: vops-deploy
description: Deploy and operate apps on a VPS with vops — deploy the current repository (template → flui.yaml → CI image → plan → approve → verify), install ready-made apps from the bundled catalog, and inspect a running fleet. Use when the user asks to deploy, ship, host, or put a project on a server, or asks what is running, whether it is healthy, or why an app is down.
---

# Deploy and operate with vops

You understand the repository. vops supplies the infrastructure: catalog, templates,
spec validation, servers, ingress, DNS, TLS, hardening, and a plan the user approves
before anything persistent happens.

Three things get asked of you. **Deploying this repository** is the long one — steps 1
to 11 below. **Installing something ready-made** (a wiki, a password manager, a
database) is one command against the bundled catalog — see *Install a packaged app*.
**Answering questions about what is running** needs no deploy at all — see *Read the
fleet*. Work out which one you were asked for before you start.

**vops never builds an image** — not locally, not on the target VPS. A 1 GB box is a
deployment target, not a build machine. The image comes from GitHub Actions or from a
registry reference the user already has.

## The boundary

| You | vops |
|---|---|
| Read the repo. Identify framework, ports, health endpoint, env, secrets, volumes, migrations. | Never reads the repo. |
| Choose the template and the building blocks. | Lists them. |
| Write and adapt `flui.yaml`. | Generates the deterministic base, validates it. |
| Summarise the plan and ask the user. | Produces the plan, refuses to apply it unapproved. |
| Interpret failures and logs. | Returns structured evidence. |

Never invent a domain, a credential, or a server. Never claim success before
`vops deploy verify` says so.

## Contract

Every command below takes `--json` and emits one envelope:

```json
{ "schemaVersion": "1", "command": "...", "status": "success|error",
  "data": {}, "warnings": [], "errors": [], "requiresApproval": false, "nextActions": [] }
```

Branch on the exit code before parsing:
`0` ok · `1` operation failed · `2` bad input · `3` invalid spec/plan ·
`4` missing prerequisite · `5` approval required · `6` unsupported · `7` auth · `8` partial.

Errors carry `code`, `path`, `recoverable` and `suggestedAction`. Act on
`suggestedAction`; never parse human output.

## Steps

### 1. Check vops exists and what it can do

```bash
vops --version || echo "not installed"
vops agent capabilities --json
```

Not installed → see `references/installation.md`. A capability reported `false` is not
available, whatever this file says. Read `vops agent workflow custom-app --json` for the
stage map from the installed build itself.

### 2. Initialise the project

```bash
vops agent init --json
```

Creates `.vops/` (plans, reports, provenance). Local only. Its `.gitignore` keeps plans
and reports out of git — they name servers.

### 3. Read the repository

Yours alone. Establish: framework and version, package manager, build and start command,
HTTP port, health endpoint, env vars, which of them are secrets, databases and caches,
persistent paths, migration command, whether a Dockerfile already exists.

Write the summary down for the user before choosing anything.

### 4. Choose a template and any building blocks

```bash
vops spec templates --json
vops spec templates describe <template-id> --json
vops catalog blocks --json
```

No template fits → `generic`. Read `limitations` in `describe` before committing:
static (nginx) templates cannot read server env at runtime, and Next.js bakes
`NEXT_PUBLIC_*` at build time.

A database or cache is a separate install:
`vops app install postgresql --host <host> --yes`, then point the app's `DATABASE_URL`
at it. vops does not auto-wire dependencies.

Check the catalog before writing anything by hand — if part of what the user described
is already packaged (`vops catalog products --json`), install it instead of rebuilding
it from a template.

### 5. Generate the base manifest

```bash
vops spec generate --template <template-id> --name <app> --output-file flui.yaml --json
```

Deterministic — the same flags produce the same bytes. Read the `warnings`: they are the
decisions still open.

### 6. Adapt it to the repository

Edit `flui.yaml` in place; prefer minimal edits over rewriting it, and keep the
provenance header. Set the real port, health path, start command, env declarations,
volumes and `resources.limits`.

**Secret values never go in `flui.yaml`.** Declare the variable and pass the value at
deploy with `--set KEY=value`, or let vops generate it (`valueFrom.generate`).

```bash
vops spec validate flui.yaml --json
```

Loop until valid. Exit 3 means the manifest is wrong; fix the reported `path`.

### 7. Get an image

Ask the user which path they want.

**Already have an image** — skip to step 8 and pass `--image <ref>`.

**Build on GitHub Actions:**

```bash
vops build setup --spec flui.yaml --json      # writes .github/workflows/vops-build.yml
```

vops writes the file and stops. Show the user the diff, then let them commit and push —
a build that publishes a package is their action, not yours.

```bash
vops build run --wait --json                  # dispatch + poll → data.imageRef
```

Needs a GitHub PAT: `vops config set github --token <PAT>` (stored encrypted), or
`GITHUB_TOKEN` in the environment. Scope: repo contents read + actions read/write.
Exit 7 means the token is missing, wrong, or too narrow.

The image lands at `ghcr.io/<owner>/<repo>:<short-sha>`. If the package is private the
host needs pull credentials — see `references/security-boundaries.md`.

### 8. Choose the server

```bash
vops host list --json
```

No host → the user picks one. `vops compare` shows real-time prices; creating a server
costs money and needs explicit approval. An existing box can be adopted with
`vops host import`. The host needs Podman 5: `vops app setup --host <host>`.

### 9. Plan, then get approval

```bash
vops deploy plan --spec flui.yaml --host <host> --image <ref> --domain app.example.com --json
```

Writes `.vops/plans/<id>.json` with a content hash. Summarise for the user: target host,
image, ports, volumes, DNS record, certificate, what is destructive, what it costs.

**Ask. Wait for a real answer.** Then:

```bash
vops deploy apply --plan <id> --yes --json
```

Exit 5 = you did not pass `--yes`; that is the approval gate, not a bug to work around.
Exit 3 = the manifest or the host changed since the plan — re-plan and ask again.

The deploy rolls back on a failed unit or a failed smoke test. A `--domain` provisions
the ingress, requests the certificate, and creates the A-record when the zone is on a
configured DNS provider.

### 10. Verify before you report

```bash
vops deploy verify --app <name> --json
vops app status <name> --json
vops app logs <name> --json
```

`verify` checks units, containers, DNS resolution, and a real HTTPS request from this
machine. A `skipped` check is not a pass — say so.

### 11. Report

Public URL · server and provider · app status · building blocks installed · DNS · TLS
(and whether staging was used — those certificates are untrusted) · warnings ·
checks that were skipped · how to read logs · how to redeploy.

## Read the fleet

Answering "what is running", "is it healthy", "why is it down" needs none of the steps
above. These are read-only, they change nothing, and they never prompt for a passphrase:

```bash
vops host list --json                 # the inventory
vops host status <host> --json        # one SSH session, a battery of read-only probes
vops app list --json                  # every install, its host, status and URL
vops app status <name> --json         # systemd units + containers, live
vops app logs <name> --json           # journald, as an array of lines
vops app preflight <host> --json      # can this host run flui.yaml apps at all
vops ingress status <host> --json     # proxy container, health, live routes
vops backup status <host> --json      # snapshot count + repository size
vops servers list --provider <p> --json
```

Read `warnings[]`, not just `data`. `host status` reports every non-ok finding there, and
`app status` warns for each unit that is not active. Two conventions differ on purpose:
in `--json` a sick host still exits `0` — the probe succeeded, the findings are the
answer — while the human output exits non-zero so shell scripts can gate on it.

`servers list` marks each machine `managed`. Anything false is off-limits to every
destructive command; do not propose deleting it.

## Install a packaged app

When the user wants software rather than their own code — Nextcloud, Vaultwarden, a
wiki, a database — do not write a manifest. It is probably already packaged:

```bash
vops catalog products --json          # ready-to-deploy applications
vops catalog blocks --json            # databases, caches, object storage
vops catalog describe <id> --json     # what it is, and what it will ask for at install
vops app install <id> --host <host> --domain app.example.com --yes
```

`describe` lists the inputs the install will require; collect them from the user before
running the install, never invent them. `--yes` is the approval gate — ask first.

## Safety rules

- Never put a secret value in `flui.yaml` or any committed file.
- Never invent credentials, domains, or server names.
- Never replace a DNS record that is not ours; `--force-dns` is the user's call.
- Never deploy, provision, or harden without explicit approval.
- Never change application logic to make a deploy pass. Report the mismatch instead.
- Never disable a health check without explaining what stops being checked.
- Never expose a database publicly.
- Never report success on exit code 0 alone.
- Stop if the working tree has unrelated uncommitted changes that make editing unsafe.

## References

- `references/installation.md` — install vops on a clean machine
- `references/security-boundaries.md` — what needs approval, what secrets go where
- `references/flui-spec.md` — the manifest fields vops applies on a single host
- `references/troubleshooting.md` — error codes and what to do about them
