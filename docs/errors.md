# vops error codes

Every agent-facing command (`vops agent|spec|catalog|build|deploy`) returns failures
in one shape:

```json
{
  "code": "VOPS_SPEC_MISSING_FIELD",
  "category": "validation",
  "message": "must have required property 'port'",
  "path": "/deploy/port",
  "recoverable": true,
  "suggestedAction": "Add /deploy/port. See: vops spec schema --kind Application",
  "documentation": "https://github.com/flui-cloud/vops/blob/main/docs/errors.md#vops_spec_missing_field"
}
```

`recoverable: true` means editing your own inputs can fix it. `recoverable: false`
means a human has to act — supply a credential, approve a plan, choose a host.

## Exit codes

Branch on these before parsing anything.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | The operation ran and failed (SSH error, build failure, unreachable host) |
| `2` | Invalid input (bad flag, unknown id, missing argument) |
| `3` | A manifest or plan did not validate |
| `4` | A prerequisite is missing (no Podman, no catalog, no token) |
| `5` | A persistent change was requested without approval |
| `6` | This build of vops does not implement the capability |
| `7` | Credentials missing, wrong, or too narrow |
| `8` | Partial success — the result needs reading |

## Spec

### VOPS_SPEC_PARSE_ERROR
The YAML does not parse. Check indentation and quoting — a value containing `: ` has
to be quoted, or it reads as a nested mapping.

### VOPS_SPEC_UNSUPPORTED_KIND
`kind` is neither `Application` nor `CatalogApp`. `Application` is your own repository
(built elsewhere, deployed by vops); `CatalogApp` is a packaged product with a
published image.

### VOPS_SPEC_MISSING_FIELD
A required field is absent, at the reported `path`. `vops spec schema --kind Application`
prints the authoritative shape.

### VOPS_SPEC_UNKNOWN_FIELD
A field the schema does not define. The schema is closed (`additionalProperties: false`),
so an unrecognised key is an error rather than a passthrough. Remove it.

### VOPS_SPEC_INVALID_TYPE
The value at `path` is the wrong type — a string where a number belongs, a scalar where a list
does. Correct the type; the schema will not coerce it for you.

### VOPS_SPEC_INVALID_VALUE
The type is right but the value is outside the set the schema allows at `path`. `message`
carries the accepted values.

### VOPS_SPEC_REFERENCE_NOT_FOUND
The manifest points at a name that does not exist — a component, a building block, a
dependency. Define it, or point the reference somewhere real.

### VOPS_SPEC_INVALID
A schema violation that does not fall into any of the categories above. Read `message`
and `path`, correct the manifest, and re-run `vops spec validate`.

### VOPS_SPEC_FILE_NOT_FOUND
`validate` was given a path that is not there. Nothing was read — correct the path and re-run.

### VOPS_SPEC_FILE_EXISTS
`generate` would overwrite a manifest that already exists. Prefer editing it in place: `--force`
discards the contextualisation already done.

### VOPS_SPEC_GENERATE_INVALID_PARAM
A generation flag was rejected — most often `--name`, which must be lowercase letters,
digits and dashes.

### VOPS_TEMPLATE_NOT_FOUND
No such framework template. `vops spec templates --json` lists them.

## Build

vops never builds an image: not on your machine, not on the target VPS. These codes
come from driving the GitHub Actions build.

### VOPS_GITHUB_TOKEN_MISSING
No PAT available. `vops config set github --token <PAT>` stores one encrypted, or set
`GITHUB_TOKEN` / `VOPS_GITHUB_TOKEN` in the environment.

### VOPS_GITHUB_UNAUTHORIZED
Exit 7. GitHub rejected the token itself (HTTP 401) — wrong, revoked or expired. Re-issue the
PAT and store it with `vops config set github --token <PAT>`.

### VOPS_GITHUB_FORBIDDEN
Exit 7. The token is accepted but not allowed to do this (HTTP 403). It needs repository
contents read plus Actions read/write — on that repository only.

### VOPS_GITHUB_NOT_FOUND
The repository or the workflow file is not there. `.github/workflows/vops-build.yml`
has to be committed and pushed before it can be dispatched.

### VOPS_BUILD_NOT_APPLICABLE
The manifest is a `CatalogApp`, which already references a published image. Install it
with `vops app install <id>`.

### VOPS_BUILD_NOT_STARTED
GitHub accepted the dispatch but no run appeared. Usually the workflow is not on that
branch yet, or Actions is disabled for the repository.

### VOPS_BUILD_FAILED
The run finished red. The failing step is at `runUrl` — it is a problem in the build,
not in vops.

### VOPS_BUILD_TIMEOUT
Still running at the deadline (exit 8, partial). Watch `runUrl`, then deploy with
`--image` once it is green.

### VOPS_GITHUB_REQUEST_FAILED
GitHub returned something unexpected, or the network did. `message` carries the status
and GitHub's own text. Retry; if it persists, check GitHub's status page.

### VOPS_REPO_UNKNOWN
vops could not work out the GitHub repository. Pass `--repo owner/name`, or run inside
a clone whose `origin` points at GitHub.

## Plan and deploy

### VOPS_APPROVAL_REQUIRED
Exit 5. A persistent change was requested without `--yes`. This is the approval gate
working, not a bug: show the user what changes, get a real answer, then re-run. Approval
does not carry forward from an earlier step.

The gate is enforced in the service layer, not per command, so every operation that can
alter a server passes through it. `message` names the operation and its target; when the
consequence is not obvious from the name, it is spelled out there too.

### VOPS_IMAGE_REQUIRED
Exit 2, recoverable. A `kind: Application` manifest was planned or deployed with no image.
The manifest is not at fault: an Application is built from your repository, so it carries no
image by design and the reference is a deploy-time input. Two remedies, both in
`suggestedAction`: pass `--image <ref>` if the image already exists, or build it first with
`vops build run` and pass the reference it reports. `kind: CatalogApp` never raises this —
its image ships with the manifest.

### VOPS_PLAN_STALE
Exit 3. The manifest, the image or the host no longer produces the plan that was
approved. The old approval is void — re-plan, and ask again.

### VOPS_PLAN_NOT_FOUND
No plan with that id under `.vops/plans/`. Create one with `vops deploy plan`.

## Catalog, workflow and skill

### VOPS_CATALOG_NOT_FOUND
Unknown catalog id. `vops catalog products --json` and `vops catalog blocks --json`
list what is bundled.

### VOPS_WORKFLOW_NOT_FOUND
Unknown workflow id. `vops agent workflow --json` lists them.

### VOPS_SKILL_TARGET_MISSING
Exit 2. `vops agent skill install` needs an agent name or `--output-dir`. Only agents whose
skill directory layout is known are offered by name — for anything else, write the bundle with
`--output-dir` and place it where that agent reads skills from.

### VOPS_SKILL_INSTALL_FAILED
Exit 2. The bundle could not be written where it was aimed; `message` carries the filesystem
error. Usually the directory does not exist or is not writable — check it, or aim elsewhere
with `--output-dir`.

## Agent control plane

### VOPS_AGENT_AUTH_REQUIRED
Exit 7. The MCP request did not include a session token. Create a scoped advisory session with
`vops agent session create`, then pass its token only to the local vOps MCP server.

### VOPS_AGENT_TOKEN_INVALID
Exit 7. The session token does not match an active local session. Do not retry the same value;
ask the user to create a session or provide the intended current token.

### VOPS_AGENT_SESSION_EXPIRED
Exit 7. The session reached its configured expiry. Its permissions do not carry forward: the
user must create a new scoped session.

### VOPS_AGENT_SESSION_INACTIVE
Exit 7. The session is paused, revoked or otherwise inactive. A paused session can be resumed
by the user; a revoked session must be replaced.

### VOPS_AGENT_SCOPE_DENIED
Exit 7. The requested capability, target, environment or operation count is outside the session
grant. Do not bypass the control plane; ask the user for a deliberate scope expansion.

### VOPS_AGENT_APPROVAL_REQUIRED
Exit 5. The immutable plan needs local approval before execution. Present its effects and risk,
then wait for the user to approve the reported request id.

### VOPS_AGENT_PLAN_INVALID
Exit 3. The proposed plan or one of its capability inputs violates the registry, policy or
session scope. Correct the reported input and create or validate the plan again.

### VOPS_AGENT_PLAN_STALE
Exit 3. The persisted plan no longer matches its immutable hash or current inputs. Never execute
it; create a replacement plan and obtain a new approval if required.

### VOPS_AGENT_NOT_FOUND
Exit 2. A requested session, plan, approval, operation, capability or knowledge resource does
not exist locally. List the corresponding resources and use an id from that result.

### VOPS_AGENT_UNSUPPORTED
Exit 6. The requested control-plane mode or capability is declared but not implemented by this
vOps build. Use an available advisory capability; do not replace it with raw shell or SSH.

### VOPS_AGENT_OPERATION_FAILED
Exit 1. An approved operation started but failed. Inspect its operation record and verification
output before deciding whether retry or rollback is safe.

### VOPS_AGENT_APPROVAL_ID_MISSING
Exit 2. `agent approvals approve|deny` needs the approval id returned by the pending approval
list or MCP response.

### VOPS_AGENT_CAPABILITY_ID_MISSING
Exit 2. `agent capability describe` needs a capability id. Obtain one with
`vops agent capability list --json`.

### VOPS_AGENT_CLIENT_MISSING
Exit 2. `agent setup` or `agent uninstall` needs one supported client name: `codex`,
`claude-code`, `opencode` or `antigravity`.

### VOPS_AGENT_KNOWLEDGE_VALUE_MISSING
Exit 2. `agent knowledge search|read` needs a query or published resource path. List the
knowledge index first when the path is unknown.

### VOPS_AGENT_OPERATION_ID_MISSING
Exit 2. `agent operations show|cancel` needs an operation id returned by the operation list or
MCP execution response.

### VOPS_AGENT_SESSION_ID_MISSING
Exit 2. `agent session show|pause|resume|revoke` needs a session id returned by
`vops agent session list --json`.

### VOPS_AGENT_SESSION_OBJECTIVE_MISSING
Exit 2. `agent session create` needs `--objective`; state the bounded task the agent is allowed
to pursue.

## Fleet

### VOPS_HOST_NOT_FOUND
Exit 2. No host by that name in the inventory. `vops host list --json` shows what there
is; an existing machine can be adopted with `vops host import`.

### VOPS_APP_NOT_FOUND
Exit 2. Nothing deployed under that install name. `vops app list --json` shows what is.

### VOPS_APP_AMBIGUOUS
Exit 2, recoverable. Installs are keyed by `(host, name)`, so the same app name can live
on two hosts. A command that takes only a name cannot say which one is meant, and vops
refuses rather than acting on the wrong host. `vops app list --json` shows both; add
`--host <host>` to name the one you mean. It matches the host recorded on the install,
so it also reaches an install whose host has left the inventory — `vops app remove <name>
--host <gone-host> --yes` then drops the local record.

### VOPS_APP_EXPOSURE_UNGATED
Exit 2, recoverable. A `--domain` was asked for an app that has no reachable login of its own —
either its manifest declares `auth.mode: none`, or its first visitor becomes its admin — and no
`--auth` choice was made. Certificate transparency publishes the hostname within seconds of the
certificate being issued, so an ungated admin surface is found by scanners, not by luck; which risk
to take is the operator's call, not vops's. Re-run with `--auth basic` (vops generates the password
and shows it once, `vops app credentials --show` reveals it later), or `--auth none` to expose it
with no login on purpose, or drop `--domain` to keep it on the host. A redeploy of an app that
already carries a gate inherits it and needs no flag.

### VOPS_SERVER_NOT_FOUND
Exit 2. The provider account has no server with that id.
`vops servers list --provider <p> --json` shows what it does have.

### VOPS_SSH_KEY_NOT_REGISTERED
Exit 2. `servers plan --ssh-key <name>` named a key the *provider* does not have. Local key
names and provider key names are separate namespaces: a key made with `vops ssh-key create`
lives on your disk until its public half is pushed. Planning with an unregistered key would
produce a machine nobody can log into, so vops refuses at plan time rather than at create time,
after the user has approved the spend. Push it first —
`vops ssh-key register <name> --provider <p>` — then re-plan. When the provider cannot be asked
(no credential, or an API that will not list keys) this is *not* raised: the plan records the
key as `unverified` and says so.

### VOPS_SSH_KEY_NOT_FOUND
Exit 2. A *local* key name that is not in this profile's key store — most often from
`vops host key set <host> <key>`, which pins the key vops logs in with. Pinning a name that
does not exist would leave the host unreachable with nothing to explain why, so it is refused
at assignment. `vops ssh-key list --json` shows the names; `vops ssh-key import` adopts a key
you already use elsewhere, by reference, without copying the private half. Not the same as
`VOPS_SSH_KEY_NOT_REGISTERED`, which is about the provider's copy of the public half.

### VOPS_SSH_KEY_MATERIAL_MISSING
Exit 2. `vops ssh-key import <name>` was called with no key material: no `--from`, no `--pub`, no
`--public-key`, or one of them present and empty. Pass exactly one — `--from <private-key-path>`
records the path and derives the public half locally (the secret is never copied), `--pub <file>`
takes a `.pub` file, `--public-key "ssh-ed25519 AAAA…"` takes the line itself. Nothing is stored.

### VOPS_SSH_KEY_FILE_MISSING
Exit 2. The path given to `--from` or `--pub` does not exist. Check it and pass one that does.
Nothing is stored. Not the same as `VOPS_SSH_KEY_NOT_FOUND`, which is about a *local key name*
that is not in this profile's key store.

### VOPS_SSH_KEY_MATERIAL_PRIVATE
Exit 2, not recoverable by an agent. What was handed to `--public-key` or `--pub` is a PRIVATE key
(`-----BEGIN … PRIVATE KEY-----`). Do not retry with the same value: vops never stores private
material, so there is no form of this command that accepts it. Import the key by reference instead
— `vops ssh-key import <name> --from <path-to-private-key>` — or pass the matching `.pub`. Nothing
is stored, and the message never echoes the material. If the private key was pasted on a command
line it is in a shell history and should be treated as exposed.

### VOPS_SSH_KEY_MATERIAL_INVALID
Exit 2. The material is not a usable OpenSSH public key, and the message says which check failed:
an unsupported algorithm field, a body that is not valid base64, a truncated blob, a blob whose own
algorithm name disagrees with the label in front of it, the wrong number of fields for that
algorithm, or an ed25519 key that is not 32 bytes. Also raised when `--from` names a file
`ssh-keygen -y` cannot read (not a key, or encrypted with a passphrase nobody supplied). vops
decodes the blob rather than pattern-matching the prefix, because a label-only check accepted
`ssh-ed25519 <garbage>`, stored it, and left a key in the store with an empty `fingerprint` that
authorized nothing. Nothing is stored: no `.pub`, no `.path` reference sidecar, no key-store
directory. Take the whole single line of a `.pub` file, or point `--from` at the private key and let
vops derive it.

### VOPS_SSH_HARDEN_REFUSED
Exit 4, not recoverable by an agent. `vops host ssh-harden <host>` previewed disabling SSH
password login and refuses: at least one lock-out precondition does not hold. It is *not* an
approval refusal — passing `--yes` runs into the same blockers, so do not reach for it. Read
`data.refusals[]`, which names each blocker with its own code:
`not-ready` (vops cannot reach the host over SSH), `no-sudo` (no passwordless root, so a bad
change could not be rolled back), `sshd-unreadable` (the effective `sshd -T` config cannot be
read), `no-user-key` (no personal key is pinned to the host), `user-key-unverified` (the pinned
key did not authenticate) and `password-logins` (other accounts logged in with a password
recently and would lose access). Fix what it names — `nextActions` carries the read-only
commands that diagnose it — then run the preview again. Only `password-logins` can be waived,
and only by the user: `--override --yes` accepts locking those accounts out. A preview that
finds nothing to refuse exits 0 with `status: success`, and a host already hardened is not a
refusal. `--yes` reports the same code with the same exit when the blockers refuse the apply, so
the preview and the apply never disagree about why hardening cannot happen.

### VOPS_SSH_HARDEN_NOT_APPLIED
Exit 1. `vops host ssh-harden <host> --yes` passed every precondition, ran, and the change did not
take: the drop-in was not written, or `sshd` rejected the config and the validated reload never
happened. **Nothing changed** — the dead-man auto-revert was cancelled and password login is still
on, exactly as before. There is nothing to undo. The message carries what the apply reported
(`sshd -t` output, or the exit status); fix that on the host, then preview again. Not the same as
`VOPS_SSH_HARDEN_ROLLED_BACK`, where the change *did* take effect before being reverted.

### VOPS_SSH_HARDEN_ROLLED_BACK
Exit 8 (partial — the result needs reading). `vops host ssh-harden <host> --yes` applied the change,
and the post-apply check then failed — the operator's own key no longer logged in, or the effective
`sshd -T` did not match the target — so vops reverted immediately; the armed dead-man would have
reverted it anyway. Password login is **back on** and the net state is the state before the run, but
sshd was reconfigured and reloaded twice on a live machine, which is why this is not exit 1 and not
the same outcome as `VOPS_SSH_HARDEN_NOT_APPLIED`. Do not retry unchanged: read what failed the
check (it is in the message), confirm the host with `vops host status <host> --json` and a fresh
`vops host ssh-harden <host> --json` preview, and tell the user before trying again.

### VOPS_AGENT_NOT_INSTALLED
Exit 4, not recoverable by an agent on its own. `vops host agent status <host>` tried to run the
in-guest metrics agent and the host has no such binary. The agent is opt-in, so this is the
ordinary state of a host nobody installed it on — not a broken host, not a broken SSH connection,
and not worth retrying. Installing it puts a binary on the user's machine, so ask them first, then
`vops host agent install <host>` and repeat the call. `vops host status <host> --json` works
without it; only the `agent.cpu`/`agent.mem`/`agent.disk` findings are absent.

### VOPS_RESTIC_DECOMPRESS_UNAVAILABLE
Exit 4, not recoverable by an agent on its own. `vops backup setup` downloads restic as a
`.bz2` archive and unpacks it on the host. The install script tries `bunzip2`, `bzip2`,
`python3` and `busybox` in that order and, failing all four, installs `bzip2` with the host
package manager — this code means even that did not work (no usable package manager, no
network to the mirrors, or the install was refused). Install bzip2 by hand
(`apt-get install -y bzip2`, `dnf install -y bzip2`, `apk add bzip2`) and re-run. The
downloaded archive is always checksum-verified *before* this step, so reaching it means the
bytes were correct and only the unpacking was impossible.

### VOPS_NOT_VOPS_MANAGED
Exit 2, not recoverable. vops only performs destructive actions on resources it created
— named `vops-*` or carrying the `managed-by=vops` label. Do not retry and do not look
for a flag to override it: tell the user, and let them act through their provider.
`vops servers list --json` marks each machine `vopsManaged` so you can see this coming.

## Watch relay

`vops watch` is the one part of vops that talks to something off your machine: a hosted relay
that forwards an alert to your phone while the laptop that noticed is asleep. Nothing else needs
it, and these two codes only ever come from `vops watch`.

### VOPS_RELAY_NOT_CONNECTED
Exit 4. No relay is configured for this profile, so there is nowhere to deliver to. Connect once
with `vops watch login` — the token is generated locally, there is no signup and no email. Every
other command works with the relay unconnected; only `watch` refuses.

### VOPS_RELAY_UNREACHABLE
Exit 1. A relay *is* configured but did not answer; `message` names the endpoint it tried and
the underlying network error. This is operational, not input — the request reached nothing, so
retrying is reasonable. If it persists, check the endpoint is up, or point vops at another one
with `vops watch login --api-url <url>`.

## Credentials

### VOPS_CREDENTIALS_MISSING
No credential is configured for the provider the command had to call, so it never
authenticated and there is no result at all — not an empty one. Exit `7`. The message
names the provider and the command that fixes it (`vops config set <provider>`, or the
`OS_*` environment for OVH). Do not retry until the user has supplied it: a list that
comes back empty because nothing was configured is indistinguishable from an account
with nothing in it, which is exactly what this code exists to prevent.

### VOPS_CREDENTIALS_INVALID
A credential *is* configured and the provider refused it — HTTP 401: revoked, mistyped, or
issued for a different account. Exit `7`, the same as a missing one, because the remedy is
the same shape (get a working credential from the user); the code differs because "you have
none" and "the one you have is dead" are different things to tell them. `message` carries
the provider's own wording. Do not retry with the same credential, and never read the
empty result that provoked it as an empty account.

A permission or quota refusal (HTTP 403) is deliberately *not* this code: providers answer
403 for a resource limit as well as for a scope, so it stays operational rather than
claiming the credential is wrong.

## Generic

### VOPS_OPERATION_FAILED
An unclassified failure. `message` carries what actually went wrong; treat it as
operational (exit 1) and read the text.

Note what this does *not* mean. vops raises a plain `BadRequestException` for bad input,
missing prerequisites, unconfirmed writes and unreachable hosts alike, and those all
land here — so the code says "read the message", not "the infrastructure broke". Codes
are added as each condition gets an unambiguous category; an unknown id already has one.

## Warnings

Warnings never change the exit code. They are how vops says "this worked, and here is
what you should know about it" — several of them are the difference between a
deployment that works and one that only appears to.

| Code | Meaning |
|---|---|
| `VOPS_PROVIDER_SKIPPED` | `vops compare` left a provider out of the comparison — it prices only through its authenticated API and no credential is configured for it. The rows are real but the comparison is partial: configure that provider (`vops config set <provider>`) before calling anything "cheapest" |
| `VOPS_PROVIDER_VAULT_SEALED` | Same partial comparison, different remedy: the credential exists but the vault is sealed, and `compare` never prompts for a passphrase. Unlock it (`vops keyring unlock`, or `VOPS_PASSPHRASE`) and run again to price that provider |
| `VOPS_SPEC_NEEDS_REVIEW` | A generated manifest carries a template default you have not confirmed against the repository |
| `VOPS_SPEC_PLANNED_FIELD` | The spec accepts the field but nothing applies it here (`deploy.scaling`, `resources.profile`) |
| `VOPS_SPEC_APPLIED_LOCALLY` | flui-spec calls it "planned" for the hosted platform, but vops does apply it on a single host |
| `VOPS_BUILD_WORKFLOW_KEPT` | `build setup` found a workflow file it did not write and left it alone — inspect it, then `--force` |
| `VOPS_IMAGE_MAY_BE_PRIVATE` | The repository is private, so the package likely is too; the host will need pull credentials. Scope that token to reading packages — whoever gets the server gets the token |
| `VOPS_PLAN_ADVISORY` | Something in the plan a single host cannot honour, reported rather than dropped silently |
| `VOPS_DEPLOY_ADVISORY` | The deploy succeeded with a caveat (a `--set` that hit an existing secret, a public bind kept, a manifest declaring `exposure: internal` given a domain anyway — that declaration is advisory, vops does not enforce it) |
| `VOPS_INGRESS_ADVISORY` | The app is exposed, with something about *how* worth reading — an sslip.io demo domain instead of one of yours, a `dns-01` challenge downgraded to `http-01`, a shared Let's Encrypt rate-limit bucket. The route works; its TLS may be best-effort |
| `VOPS_HOST_UNREACHABLE` | `vops host import` recorded the machine but SSH did not answer, so nothing was probed. The inventory entry is real; its health is unknown until `vops host status <name>` succeeds |
| `VOPS_LOCAL_CLEANUP_INCOMPLETE` | `vops servers delete` destroyed the server but could not finish forgetting it locally (inventory entry, stale host key). The server is gone — do not retry the delete; drop the leftovers with `vops host remove <name>` |
| `VOPS_PODMAN_GENERATOR_CONFLICT` | `vops app setup` found a distro Quadlet generator in `/usr/lib` beside the one it manages — units risk being processed twice. Remove the apt/dnf `podman` package |
| `VOPS_VERIFY_FAILED` | A post-deploy check failed. The deployment is degraded — do not report success |
| `VOPS_VERIFY_SKIPPED` | A check could not run. Not a pass: say which check was skipped |
| `HOST_<CHECK_ID>` | A non-ok finding from `vops host status` (e.g. `HOST_SVC_FAILED`). In `--json` the command still exits 0 — the probe succeeded, the finding is the answer |
| `APP_UNIT_NOT_ACTIVE` | A systemd unit backing the app is not active. The install exists; it is not running |
| `HOST_NOT_READY` | `vops app preflight` found something missing before apps can run (no Podman, no Quadlet generator) |
| `INGRESS_UNHEALTHY` | The proxy is installed but inactive, or active and not answering its health endpoint |
| `BACKUP_NO_SNAPSHOTS` | A repository exists but has never been written to — backups are configured, not proven |
