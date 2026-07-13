# vops Day-2 Operations — Implementation Spec

> **Status:** Specification, ready to implement.
> **Date:** 2026-07-12
> **Scope:** everything that happens *after* a server exists — health checks over SSH, hardening, updates, backups, uptime watching and a dead-man's-switch monitor — plus the **dual SSH key model** (vops operations key vs user keys) that underpins all of it.
> **Companions:** [`vops-doctor-analysis.md`](./vops-doctor-analysis.md) (the *external*, read-only `vops doctor` — DNS/TLS/exposure/firewall from the laptop, no SSH). This spec is the *SSH-plane* counterpart. The two do not overlap: `doctor` observes from outside; `host` operates from inside over SSH.

---

## 1. Positioning & philosophy

vops today covers day-0/day-1 (compare → provision → firewall/vnet/keys). This spec adds day-2: *"is my server okay, is it hardened, is it updated, is it backed up, will I know when it suffers?"* — the layer that turns vops from a provisioning wrapper into the Swiss-army knife for people who manage servers directly.

**The agentless ladder.** Every feature must sit on the lowest possible rung:

| Rung | Mechanism | Touches the server? | Used by |
|---|---|---|---|
| 0 | External probes from the hosted relay | No | `watch uptime` |
| 1 | One-shot SSH session (run commands, parse, disconnect) | Read-mostly, nothing persists | `host status`, `host update` |
| 2 | Files vops writes over SSH: a shell script + a crontab line + config | Yes, but **transparent text, no daemon, no opaque binary**, removable with one command | `host harden`, `host monitor` |
| 3 | One pinned, checksum-verified static binary (restic) + a cron line | Yes — the *only* binary exception, opt-in | `backup` |

**Hard rules (enforced by design, not convention):**

1. **No resident daemon, ever.** Anything continuous is cron-driven or relay-driven.
2. **Everything written to a server is readable text** (except restic, rung 3), lives under `/etc/vops/` or in clearly-marked crontab blocks, and is fully removed by the corresponding `remove` command.
3. **Dry-run first-class:** every mutating command supports `--dry-run` printing the *exact* commands/files it would apply.
4. **Lockout safety:** no command may ever remove the last working SSH access path (see §3.5).
5. **Secrets never in argv**; SSH via the local `ssh`/`scp` binaries (as `commands/ssh.ts` and `vops-ssh-keys.service.ts` already do), never an SSH library.
6. **Report, don't gate** (same as doctor): findings carry severity; only explicit commands mutate.

---

## 2. Host inventory — `vops host` topic

Provider-plane (`servers`) and SSH-plane are different worlds: users have machines vops did not create. A **host** is anything reachable over SSH; a provider server *may* be linked to a host, but a host needs no provider.

### 2.1 Data model

Stored in the existing `LocalStore` (profile-scoped, alongside credentials), file `hosts.json`:

```ts
export interface VopsHost {
  name: string;                    // unique handle, same charset rule as key names
  address: string;                 // IP or FQDN
  user: string;                    // login user for USER sessions (default root)
  port: number;                    // default 22
  userKeyName?: string;            // local key (ssh-key store) for interactive ssh
  opsKeyInstalled: boolean;        // whether the profile ops key is authorized (see §3)
  provider?: string;               // set when imported from a provider server
  providerServerId?: string;
  os?: { family: 'debian' | 'rhel' | 'alpine' | 'unknown'; pretty: string }; // detected, cached
  tags: string[];
  addedAt: string;
}
```

### 2.2 Commands

```
vops host add <name> --address <ip|fqdn> [--user root] [--port 22] [--key <userKeyName>] [--tag t]...
vops host import <provider> <serverIdOrName>     # create a host from an existing provider server
vops host list [--json]
vops host show <name> [--json]
vops host remove <name>                          # local inventory only; never touches the server
```

- `host add` performs a connectivity probe (`ssh -o BatchMode=yes … true`) and OS detection (`cat /etc/os-release`), caches `os`, warns (not fails) when unreachable.
- `host import` resolves the server via the provider (reuse `connectInfo()` resolution logic in `vops-ssh-keys.service.ts`), fills `address`/`provider`/`providerServerId`.
- Every `host`-mutating server operation elsewhere in this spec (`harden`, `monitor setup`, `backup setup`, key installs) appends to the audit log via `LocalStore.appendAudit` with the host name — same pattern as `sshkey.register`.
- Fleet selection: commands that operate on many hosts accept `--host <name>` (repeatable) or `--tag <t>`; no flag = error listing available hosts (never "all by default" for mutations; `status` may default to all).

---

## 3. Dual SSH key model — operations key vs user keys

**Problem.** Today one key does everything. Mixing "the human's door key" with "the tool's automation key" means: revoking vops access kills personal access, `harden`/`monitor`/`backup` sessions are indistinguishable from human logins in `auth.log`, and rotation is all-or-nothing.

**Model.** Two roles, one keystore (extend the existing `keys/` dir + `VopsSshKeysService`):

| | **User key(s)** | **Ops key** |
|---|---|---|
| Purpose | Interactive `vops ssh`, the human's own access | Everything automated: `host status/harden/update`, `backup`, `monitor` |
| Cardinality | Any number (existing create/import flow, unchanged) | **Exactly one per profile**, name reserved: `vops-ops` |
| Creation | Explicit (`ssh-key create/import`) | Lazy: auto-generated (ed25519, no passphrase) on first command that needs it |
| authorized_keys entry | Plain, whatever the user has | Tagged + restricted (see below) |
| Revocation | User's business | `vops host key revoke-ops <name>` removes exactly the tagged line |

### 3.1 The ops key on the server

Installed as a single `authorized_keys` line with restrictive options and a recognizable comment:

```
no-agent-forwarding,no-X11-forwarding,no-user-rc ssh-ed25519 AAAA… vops-ops:<profileId>
```

- `profileId`: a short random id minted per profile on first use, stored in `LocalStore` — lets vops find *its own* line without parsing key material, and distinguishes two vops installs sharing a server.
- No `command=` restriction: day-2 ops legitimately run arbitrary diagnostics; the restriction set blocks the lateral-movement extras instead. Optional `--from <cidr>` on install adds a `from=""` source restriction.
- The ops key logs in as the same user as the host's `user` (root by default). Per-op sudo is out of scope for v1 (documented limitation).

### 3.2 Keystore changes

- `VopsSshKey` gains `role: 'user' | 'ops'`. The `vops-ops` name is reserved: `create`/`import`/`delete` reject it (managed lifecycle only).
- New service methods: `ensureOpsKey(): VopsSshKey` (generate if missing), `opsAuthorizedKeysLine(): string`.
- `ssh-key list` shows the role column so the ops key is visible, not magic.

### 3.3 Commands

```
vops host key install-ops <name> [--from <cidr>] [--dry-run]   # append tagged line (idempotent)
vops host key revoke-ops <name> [--dry-run]                    # remove exactly the vops-ops:<profileId> line
vops host key status <name> [--json]                           # which vops-known keys are authorized (ops + user)
vops ssh-key rotate-ops [--dry-run]                            # rotate across ALL hosts, §3.4
```

`install-ops` connects with the **user key** (that's the bootstrap path), appends the line idempotently (grep for `vops-ops:<profileId>` first), then **verifies** by opening a second session authenticated with the new ops key before reporting success. Sets `opsKeyInstalled: true`.

### 3.4 Rotation (never break the ladder you stand on)

`rotate-ops` must follow install-new → verify-new → remove-old, per host:

1. Generate the replacement keypair locally (`vops-ops.next`).
2. For each host with `opsKeyInstalled`: append the new tagged line (old key authenticates the session).
3. Verify a fresh session with the **new** key.
4. Only then remove the old tagged line and, after all hosts succeed (or with `--force` past failures, which reports the stragglers), promote `vops-ops.next` → `vops-ops` locally.
5. Hosts that failed remain on the old key and are listed for retry; the old local key is kept as `vops-ops.prev` until the next rotation.

### 3.5 Lockout-safety invariants (apply to every feature in this spec)

- Never edit `authorized_keys` in place blind: read, transform lines, write to a temp file on the host, validate non-empty and containing ≥1 non-vops key *or* a verified user key, then atomically `mv`.
- `revoke-ops` refuses if the ops session is the only working access and no user key verifies (override: `--force`).
- `harden`'s `PasswordAuthentication no` step (§6) runs only after a key-based session has been *verified in this run*.

---

## 4. SSH execution engine — `src/lib/ssh-exec.ts` (new)

One shared primitive under `lib/`, used by every rung-1/2/3 feature. No new dependency: wrap the local `ssh`/`scp` binaries with `execFile` (async), mirroring the existing `spawnSync('ssh', …)` style.

```ts
export interface SshTarget { host: VopsHost; keyPath: string }   // ops or user key resolved by caller

export interface ExecResult { code: number; stdout: string; stderr: string }

export interface SshExec {
  /** Run one command; BatchMode=yes, ConnectTimeout, no pty. Never throws on non-zero exit. */
  run(t: SshTarget, command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** Run a local script remotely via `ssh … 'bash -s' < script` — nothing persisted. */
  runScript(t: SshTarget, scriptBody: string): Promise<ExecResult>;
  /** Write content to a remote path atomically (temp + mv), with mode. Uses stdin, not argv. */
  putFile(t: SshTarget, remotePath: string, content: string, mode: string): Promise<void>;
  /** scp a local binary (backup only). */
  putBinary(t: SshTarget, localPath: string, remotePath: string): Promise<void>;
}
```

Conventions: `-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new`; known-hosts stored under the profile dir (`profiles/<p>/known_hosts`) so vops never pollutes the user's `~/.ssh/known_hosts`; commands passed as a single argv element; file contents piped via stdin (`putFile` = `ssh … 'cat > tmp && chmod … && mv tmp path'`).

**Write-gate extension.** Add to `safety/` a host analogue of the provider gate: `assertHostWritable(host)` — refuses mutation when the env var `VOPS_READONLY=1` is set, and requires the host to exist in the inventory (no ad-hoc mutations of arbitrary addresses). All rung-2/3 writes go through it + audit.

---

## 5. `vops host status` — the SSH health check (highest priority)

*The daily-use command.* One SSH session, a fixed battery of read-only probes, a findings report in ~5s.

```
vops host status [<name>] [--tag t] [--json] [--strict]     # no arg = all hosts, summary table
```

### 5.1 Checks (v1 battery — all standard commands, parsed locally)

| id | Question | Source command |
|---|---|---|
| `sys.disk` | Any filesystem > 85% (warn) / > 95% (fail)? | `df -P -x tmpfs -x devtmpfs` |
| `sys.memory` | Available memory < 10%? swap thrashing? | `free -b` |
| `sys.load` | load1 > 2× cores? | `uptime` + `nproc` |
| `sys.uptime` | Rebooted very recently (info)? | `uptime -s` |
| `svc.failed` | Failed systemd units? | `systemctl --failed --no-legend` |
| `svc.oom` | OOM kills since boot? | `journalctl -k --no-pager -g 'Out of memory' -q` (best-effort) |
| `pkg.updates` | Pending security updates? | debian: `apt-get -s upgrade` parse; rhel: `dnf check-update -q --security` |
| `pkg.reboot` | Reboot required? | debian: `/run/reboot-required`; rhel: `dnf needs-restarting -r` |
| `net.listen` | What is listening on 0.0.0.0/::? | `ss -tlnpH` |
| `sec.sshcfg` | Root password login / PasswordAuthentication enabled? | `sshd -T` (fallback: parse `/etc/ssh/sshd_config`) |
| `sec.logins` | Failed-login burst in last 24h (warn)? | `journalctl -u ssh -u sshd --since -24h -g 'Failed password' -q | wc -l` (best-effort) |
| `vops.footprint` | Which vops-managed pieces are present (monitor/backup/ops-key)? | `ls /etc/vops/`, crontab markers, authorized_keys tag |

Reuse the report model from the doctor analysis §4.3 **verbatim** (`Severity`, `Finding`, report with `worst` + exit-code convention: fail→non-zero, warn→0 unless `--strict`). Put the shared types in `src/lib/report.ts` so external doctor (when built) and `host status` render identically.

Cross-plane bonus when the host has `provider` set and a token is present: cross-check `net.listen` against provider firewall rules — *"listening on 5432 AND firewall exposes 5432 to 0.0.0.0/0"* escalates to fail. This is the "same story as Flui's port-exposure map" check.

All probes go in one `runScript` round-trip (a single generated shell script that echoes section markers), not 12 SSH sessions.

### 5.2 Fleet output

No-arg `host status` runs hosts concurrently (limit ~5) and prints one row per host (`name`, `worst`, top finding, latency), with `--json` emitting the full per-host reports.

---

## 6. `vops host harden` — the first 15 minutes

```
vops host harden <name> [--user <newAdminUser>] [--steps s1,s2,…] [--dry-run] [--json]
```

Idempotent steps, each check-then-apply, each reported as a Finding (`ok` = already compliant, `info` = applied, `fail` = could not apply). Default step set:

| id | Action |
|---|---|
| `admin-user` | Create sudo user `--user` (skip if absent flag), install the host's user key for them |
| `ssh-keys` | Ensure ops key installed (§3.3) — prerequisite for the lockdown steps |
| `ssh-no-root-pw` | `PermitRootLogin prohibit-password` |
| `ssh-no-password` | `PasswordAuthentication no` — **only after in-run key-session verification (§3.5)**; drop-in file `/etc/ssh/sshd_config.d/50-vops.conf`, `sshd -t` validate before reload, reload not restart |
| `unattended-upgrades` | debian: install+enable `unattended-upgrades`; rhel: `dnf-automatic` security-only |
| `time-sync` | Ensure systemd-timesyncd (or chrony) active |
| `ssh-ratelimit` | nftables rate-limit rule for :22 — **reuse `host-firewall/nftables.ts`**: extend the existing renderer with a rate-limit option rather than writing new nftables code |

`--dry-run` prints every file diff and command. All changes are text under `/etc/ssh/sshd_config.d/` + `/etc/vops/`, reversible by hand; `harden` never edits distro-owned files in place.

---

## 7. `vops host update` — fleet updates

```
vops host update <name>|--tag t [--security-only] [--reboot] [--dry-run] [--json]
```

- debian: `apt-get update && apt-get -y upgrade` (`--security-only`: unattended-upgrade -v one-shot); rhel: `dnf -y upgrade [--security]`.
- Always ends with the `pkg.reboot` probe; `--reboot` reboots when required, then waits for SSH to return (bounded, report timeout as fail).
- Fleet mode is sequential by default (`--parallel <n>` opt-in) — updates are the one op where blast-radius ordering matters.
- Non-interactive frontends enforced (`DEBIAN_FRONTEND=noninteractive`, `-o Dpkg::Options::=--force-confdef --force-confold`).

---

## 8. `vops backup` — restic over SSH (the rung-3 exception)

The one deliberate binary: **restic**, a single static executable, pinned version + SHA-256 verified locally before upload. No daemon — a cron line runs it.

```
vops backup setup <host> --paths /a,/b --to <s3-url> [--schedule "0 3 * * *"] [--keep 7d4w6m] [--dry-run]
vops backup status <host> [--json]        # last run, snapshot count, repo size (runs restic over SSH)
vops backup run <host>                    # trigger one backup now
vops backup snapshots <host> [--json]
vops backup restore <host> --snapshot <id> --target /restore/path [--dry-run]
vops backup remove <host> [--purge-repo]  # remove binary+cron+env; repo untouched unless --purge-repo
```

**`setup` writes exactly four things** (all shown by `--dry-run`, all removed by `remove`):

1. `/usr/local/bin/vops-restic` — the verified binary (version + sha256 pinned in a `backup/restic-manifest.ts`, per-arch: amd64/arm64 detected via `uname -m`).
2. `/etc/vops/backup.env` (0600, root) — `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, S3 credentials. The repo password is generated locally and stored in the profile `LocalStore` **as well** — losing the server must not mean losing the ability to restore. Print a loud one-time notice telling the user to export it.
3. `/etc/vops/backup.sh` — readable wrapper: source env → `restic backup` → `restic forget --prune` per `--keep` policy → on failure, ping the monitor endpoint if configured (§10).
4. A crontab block delimited by `# vops:backup:start` / `# vops:backup:end`.

`setup` finishes with `restic init` (if repo empty) + an immediate `restic backup --dry-run` sanity pass. Restore is always explicit and targets a directory (never in-place overwrite without `--target`).

S3 target: any S3-compatible endpoint. Natural pairing with Flui object storage, but no coupling — the flag takes a generic URL.

---

## 9. `vops watch uptime` — external black-box monitoring (rung 0)

Extends the existing `watch` topic and relay (`cloud-client.ts`). Zero server touch; the relay probes from outside and alerts on the already-existing channels (ntfy/webhook/telegram/feed).

```
vops watch uptime add <name> --target <host|url> [--check tcp:443|http:https://…|ping] [--interval 60] [--expect-status 200-399]
vops watch uptime list | remove <id>
```

Checks: `tcp:<port>` connect, `http(s)` status-range + optional latency threshold, `ping`, and **cert expiry** (warn ≤ 14 days — free during the TLS check).

**Cross-repo dependency:** the relay lives in the vops-landing API. New endpoints, same TOFU-token auth as watches:

```
POST   /api/uptime            { name, target, check, interval, expectStatus? }
GET    /api/uptime            → { monitors: [...] }
DELETE /api/uptime/:id
```

Alert transitions (`up→down`, `down→up`, `cert-expiring`) flow into the existing feed/channel pipeline (`EventKind` gains `'uptime'`). CLI-side, `CloudClient` gains the three matching methods; keep the verify-before-set and redaction conventions.

---

## 10. `vops host monitor` — dead-man's switch for internal suffering (rung 2)

Detects what rung 0 can't see: disk filling, OOM, failed units — via **cron + curl + a readable shell script**, with the *absence* of heartbeats alerting on the relay side (healthchecks.io model). No binary, no daemon.

```
vops host monitor setup <name> [--interval 5] [--disk-warn 85] [--disk-crit 95] [--load-crit 2.0] [--dry-run]
vops host monitor status <name> [--json]      # relay-side: last heartbeat, open alerts
vops host monitor test <name>                 # force one immediate run over SSH
vops host monitor remove <name>
```

**`setup` writes** (all text, all in `--dry-run`, all removed by `remove`):

1. `/etc/vops/monitor.sh` — POSIX sh, ~60 lines, fully readable: collect disk/mem/load/failed-units/reboot-required → compare to thresholds baked in at render time → `curl -fsS -m 10` POST to the relay. Sends a heartbeat when healthy, the same call with `alerts[]` populated when not. Exits 0 always (cron noise-free).
2. `/etc/vops/monitor.env` (0600) — relay URL + per-host monitor token.
3. Crontab block `# vops:monitor:start` / `*/5 * * * * /etc/vops/monitor.sh` / `# vops:monitor:end`.

**Relay contract** (vops-landing, same auth family):

```
POST /api/monitor/hosts                 → { hostId, ingestToken }        # CLI registers the host
POST /api/monitor/ingest                Bearer <ingestToken>
     { hostId, at, status: 'ok'|'alert', alerts?: [{id, severity, summary, value}] }
GET  /api/monitor/hosts/:id             → { lastSeen, state, openAlerts }
DELETE /api/monitor/hosts/:id
```

Relay-side dead-man logic: no heartbeat for `3 × interval` → `host-silent` alert on the user's channels; recovery event when heartbeats resume; threshold alerts de-duplicated (alert once per state transition, not per tick). The `ingestToken` is per-host and write-only (can only post heartbeats — a compromised server cannot read the account's watches or other hosts).

**Funnel note (product, not code):** the relay's alert message for sustained suffering is the natural, non-spammy place for the single "Flui does this automatically" line.

---

## 11. Module & command layout

Follow the existing pattern exactly: one topic dir under `src/commands/<topic>/` per command file, one NestJS service per domain under `src/<domain>/vops-<domain>.service.ts`, wired in `vops.module.ts`, thin oclif commands that `getVopsApp().get(Service)` and support `--json`.

```
src/
  hosts/vops-hosts.service.ts            # inventory (§2)
  host-ops/
    ssh-exec.ts → lives in lib/          # §4 engine (lib/ssh-exec.ts)
    vops-host-status.service.ts          # §5
    vops-host-harden.service.ts          # §6
    vops-host-update.service.ts          # §7
    scripts/                             # rendered shell templates (status battery, monitor.sh, backup.sh)
  backup/vops-backup.service.ts + restic-manifest.ts        # §8
  monitor/vops-monitor.service.ts        # §10 (CLI side)
  lib/report.ts                          # shared Severity/Finding/Report (§5, doctor doc §4.3)
  commands/
    host/  add.ts import.ts list.ts show.ts remove.ts status.ts harden.ts update.ts
           key/ install-ops.ts revoke-ops.ts status.ts
           monitor/ setup.ts status.ts test.ts remove.ts
    backup/ setup.ts status.ts run.ts snapshots.ts restore.ts remove.ts
    ssh-key/ rotate-ops.ts               # (+ role column in existing list.ts)
    watch/ uptime/ add.ts list.ts remove.ts
```

Existing code to touch, nothing more: `vops-ssh-keys.service.ts` (role field, `ensureOpsKey`, reserved name), `commands/ssh.ts` (resolve key through the host inventory when a host name is given), `lib/cloud-client.ts` (uptime + monitor endpoints), `host-firewall/nftables.ts` (rate-limit option for §6), `safety/` (host write-gate), `vops.module.ts`.

## 12. Testing requirements

- Unit: authorized_keys line transforms (§3.3/3.4/3.5 invariants — these are the highest-risk code in the spec; test every lockout guard), status-battery parser against fixture outputs (debian + rhel variants), crontab block add/remove idempotency, restic manifest checksum verify, monitor.sh rendering with thresholds.
- The ssh-exec engine gets a fake transport (inject `execFile`) so every service is testable without a server; keep `run`/`putFile` as the only seam.
- One opt-in integration script under `dev/` (mirroring the byos-local harness style) that exercises status/harden/monitor against a disposable VM — not part of `npm test`.

## 13. Phasing

| Phase | Ships | Size |
|---|---|---|
| **H0** | `lib/ssh-exec.ts` + `lib/report.ts` + `host` inventory (§2, §4) | M |
| **H1** | Dual keys: role field, `ensureOpsKey`, `host key install-ops/revoke-ops/status`, `rotate-ops` (§3) | M |
| **H2** | `host status` single + fleet (§5) — *the headline* | M |
| **H3** | `host harden` + nftables rate-limit reuse (§6); `host update` (§7) | M |
| **H4** | `watch uptime` CLI + relay endpoints (§9) — needs vops-landing work | M (split repos) |
| **H5** | `host monitor` CLI + relay dead-man (§10) — needs vops-landing work | L (split repos) |
| **H6** | `backup` (§8) | L |

H0–H3 are fully local (this repo only) and independently shippable. H4/H5 require coordinated vops-landing API changes — implement the CLI side behind the existing "Not connected. Run: vops watch login" guard so it degrades cleanly.

## 14. Out of scope (deliberate)

- Continuous metrics history / dashboards (needs an agent or SaaS storage — betrays positioning; `monitor` alerts on state transitions only).
- Docker/app management (Flui's territory, per README).
- DNS record management (capability flag only, unchanged).
- Per-operation sudo elevation for the ops key (v1 assumes the host `user` has the needed privileges; revisit if demand appears).
- Windows hosts.
