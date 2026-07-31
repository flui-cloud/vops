# Error codes

Every agent-facing command returns errors as `{ code, category, path, message,
recoverable, suggestedAction }`. Act on `suggestedAction`. These are the ones worth
knowing on sight.

## Spec

| Code | Meaning | Do |
|---|---|---|
| `VOPS_SPEC_PARSE_ERROR` | The YAML does not parse | Fix indentation and quoting; a value containing `:` needs quotes |
| `VOPS_SPEC_MISSING_FIELD` | A required field is absent | Add it at the reported `path`; `vops spec schema --kind Application` has the shape |
| `VOPS_SPEC_UNKNOWN_FIELD` | A field the spec does not define | Remove it — the schema is closed |
| `VOPS_SPEC_INVALID_TYPE` / `_VALUE` | Wrong type or a value outside the enum | Correct it at `path` |
| `VOPS_SPEC_UNSUPPORTED_KIND` | Not `Application` or `CatalogApp` | `Application` = your repo, `CatalogApp` = a packaged product |
| `VOPS_SPEC_FILE_EXISTS` | `generate` would clobber a manifest | Edit in place; `--force` only when you mean to discard the edits |

## Build

| Code | Meaning | Do |
|---|---|---|
| `VOPS_GITHUB_TOKEN_MISSING` | No PAT available | `vops config set github --token <PAT>`, or set `GITHUB_TOKEN` |
| `VOPS_GITHUB_FORBIDDEN` | Token lacks scope | Needs contents read + Actions read/write on that repo |
| `VOPS_GITHUB_NOT_FOUND` | Repo or workflow missing | Commit and push `.github/workflows/vops-build.yml` first |
| `VOPS_BUILD_NOT_STARTED` | Dispatch accepted, no run appeared | The workflow is not on that branch yet, or Actions is disabled |
| `VOPS_BUILD_FAILED` | The run finished red | Read the failing step at `runUrl`; it is a build problem, not a vops one |
| `VOPS_BUILD_TIMEOUT` | Still running at the deadline (exit 8) | Watch `runUrl`, then deploy with `--image` once green |

## Providers and credentials

| Code | Meaning | Do |
|---|---|---|
| `VOPS_CREDENTIALS_MISSING` (exit 7) | No credential for the provider the command had to call — nothing was listed because nothing was asked | Ask the user for it, then `vops config set <provider>` (OVH reads `OS_*` from the environment). Never read an empty list as "the account is empty" |
| `VOPS_CREDENTIALS_INVALID` (exit 7) | The credential is configured and the provider refused it (401) — revoked, mistyped, or another account's | Do not retry it. Ask the user for a working one, then `vops config set <provider>`. Never read the empty result as "the account is empty" |
| `VOPS_PROVIDER_SKIPPED` (warning) | `vops compare` left an uncredentialed provider out | The rows are real, the comparison is partial. Say so before calling anything cheapest |
| `VOPS_PROVIDER_VAULT_SEALED` (warning) | `vops compare` left a provider out because the vault is sealed, not because it is unconfigured | Same partial comparison, different remedy: offer to unlock (`vops keyring unlock`) and re-run, rather than asking for a credential the user already stored |

## Plan and deploy

| Code | Meaning | Do |
|---|---|---|
| `VOPS_APPROVAL_REQUIRED` (exit 5) | Applying without `--yes` | Show the plan, ask, then re-run. Do not self-approve |
| `VOPS_PLAN_STALE` (exit 3) | The manifest or host changed after approval | Re-plan and ask again — the old approval is void |
| `VOPS_PLAN_NOT_FOUND` | No such plan id | `vops deploy plan` first; ids live in `.vops/plans/` |

## Deploy failures on the host

A deploy that fails rolls back and leaves the host as it was: units, containers, and — on a
**first** install — the named volumes and podman secrets that run created, so the retry starts
on a clean datadir. Data that was already on the host is never deleted; when a failing install
inherited some, the error names the volume/secret and the command that removes it.

- **quadlet skipped `<unit>`** — the generated unit is invalid. Read the plan's `files`.
- **services not active** — the container exits at start. `vops app logs <name>` shows
  why; usually a missing env var or a wrong start command.
- **Smoke test failed** — the container runs but the health path does not answer.
  Check `deploy.healthcheck.path` against the app, and that it listens on `deploy.port`
  and on `0.0.0.0` rather than `127.0.0.1` inside the container.
- **Host not ready** — Podman 5 is missing. `vops app setup --host <host>`.

## Verification

`vops deploy verify` reporting `degraded`:

- **dns fail** — the record does not exist or points elsewhere. Propagation can lag.
- **public-url fail with a certificate error** — Let's Encrypt *staging* was used;
  those certificates are deliberately untrusted. Redeploy without `--staging`.
- **public-url skipped** — the app has no ingress. It answers only on the host itself;
  `vops app expose <name> --domain <host> --yes` publishes it.
