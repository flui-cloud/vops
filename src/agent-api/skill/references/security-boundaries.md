# Security boundaries

## What needs approval

**Class A — no approval.** Discovery, catalog and template listing, spec generation
and validation, host inspection, plan generation. Local or read-only.

**Class B — tell the user first.** Anything that costs money or leaves a temporary
resource behind: a CI build run, a temporary DNS record.

**Class C — explicit approval, every time.** Creating or deleting a server, deploying,
replacing an existing deployment, changing firewall or SSH access, replacing a DNS
record, issuing or replacing a certificate, deleting a volume, any migration that can
lose data.

`vops deploy apply` exits 5 without `--yes`. That exit code is the gate working. Do
not pass `--yes` on the user's behalf because a previous step was approved — approval
does not carry forward.

## Where secrets live

| Secret | Where it belongs | Where it must never be |
|---|---|---|
| Provider API tokens | `vops config set <provider>` → encrypted under `~/.config/vops` | the repo, `flui.yaml`, environment files you write |
| GitHub PAT | `vops config set github --token` → same encrypted store | the repo, the workflow file, a commit |
| App secrets (DB passwords, API keys) | `--set KEY=value` at deploy → a Podman secret on the host | `flui.yaml`, `.env` you commit, the plan |
| Generated secrets | `valueFrom.generate` → created on the host, never leaves it | anywhere else |

`flui.yaml` is committed. It declares which variables exist; it never carries their
values. `vops spec validate` will not catch a leaked secret — you have to not write it.

## Token scopes

The GitHub PAT needs repository contents read and Actions read/write, on that
repository only. A classic `repo`-scoped token also works but grants far more than
this needs. Never use a token that can administer the account.

If the GHCR package is private, the host needs pull credentials, and `podman login`
writes them into root's `auth.json` on that server. Scope that token to reading
packages and nothing else: whoever gets the server gets the token. A public package
needs no credentials on the host at all, which is the safer default when the code is
not sensitive.

## What vops leaves on the server

Podman, systemd units under `/etc/containers/systemd/vops/`, the container images,
named volumes, and the ingress. No vops agent, no callback, no control plane. Removing
an app removes its units and containers; volumes survive unless `--purge` is passed.

## Blast radius to keep in mind

- Laptop compromised → provider tokens are encrypted at rest but readable once the
  vault is unlocked. That is why discovery commands never unlock it.
- Server compromised → whatever is on that server: app secrets, the registry pull
  token, and any key the app itself holds. Nothing on that box can reach the user's
  provider account unless someone put a provider token there.
- `--public` binds published ports on `0.0.0.0`, bypassing the host firewall.
  The default is loopback-only for a reason; reach the app through the ingress.
