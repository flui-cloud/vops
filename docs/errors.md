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

### VOPS_SPEC_INVALID_TYPE / VOPS_SPEC_INVALID_VALUE
Wrong type, or a value outside the allowed set, at `path`.

### VOPS_SPEC_REFERENCE_NOT_FOUND
The manifest points at a name that does not exist — a component, a building block, a
dependency. Define it, or point the reference somewhere real.

### VOPS_SPEC_INVALID
A schema violation that does not fall into any of the categories above. Read `message`
and `path`, correct the manifest, and re-run `vops spec validate`.

### VOPS_SPEC_FILE_NOT_FOUND / VOPS_SPEC_FILE_EXISTS
`validate` was given a path that is not there, or `generate` would overwrite a manifest.
Prefer editing in place: `--force` discards the contextualisation already done.

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

### VOPS_GITHUB_UNAUTHORIZED / VOPS_GITHUB_FORBIDDEN
The token was rejected, or lacks scope. It needs repository contents read plus Actions
read/write — on that repository only.

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

### VOPS_SKILL_TARGET_MISSING / VOPS_SKILL_INSTALL_FAILED
`vops agent skill install` needs an agent name or `--output-dir`. Only agents whose
skill directory layout is known are offered by name — for anything else, write the
bundle with `--output-dir` and place it where that agent reads skills from.

## Fleet

### VOPS_HOST_NOT_FOUND
Exit 2. No host by that name in the inventory. `vops host list --json` shows what there
is; an existing machine can be adopted with `vops host import`.

### VOPS_APP_NOT_FOUND
Exit 2. Nothing deployed under that install name. `vops app list --json` shows what is.

### VOPS_SERVER_NOT_FOUND
Exit 2. The provider account has no server with that id.
`vops servers list --provider <p> --json` shows what it does have.

### VOPS_NOT_VOPS_MANAGED
Exit 2, not recoverable. vops only performs destructive actions on resources it created
— named `vops-*` or carrying the `managed-by=vops` label. Do not retry and do not look
for a flag to override it: tell the user, and let them act through their provider.
`vops servers list --json` marks each machine `vopsManaged` so you can see this coming.

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
| `VOPS_SPEC_NEEDS_REVIEW` | A generated manifest carries a template default you have not confirmed against the repository |
| `VOPS_SPEC_PLANNED_FIELD` | The spec accepts the field but nothing applies it here (`deploy.scaling`, `resources.profile`) |
| `VOPS_SPEC_APPLIED_LOCALLY` | flui-spec calls it "planned" for the hosted platform, but vops does apply it on a single host |
| `VOPS_BUILD_WORKFLOW_KEPT` | `build setup` found a workflow file it did not write and left it alone — inspect it, then `--force` |
| `VOPS_IMAGE_MAY_BE_PRIVATE` | The repository is private, so the package likely is too; the host will need pull credentials. Scope that token to reading packages — whoever gets the server gets the token |
| `VOPS_PLAN_ADVISORY` | Something in the plan a single host cannot honour, reported rather than dropped silently |
| `VOPS_DEPLOY_ADVISORY` | The deploy succeeded with a caveat (a `--set` that hit an existing secret, a public bind kept) |
| `VOPS_VERIFY_FAILED` | A post-deploy check failed. The deployment is degraded — do not report success |
| `VOPS_VERIFY_SKIPPED` | A check could not run. Not a pass: say which check was skipped |
| `HOST_<CHECK_ID>` | A non-ok finding from `vops host status` (e.g. `HOST_SVC_FAILED`). In `--json` the command still exits 0 — the probe succeeded, the finding is the answer |
| `APP_UNIT_NOT_ACTIVE` | A systemd unit backing the app is not active. The install exists; it is not running |
| `HOST_NOT_READY` | `vops app preflight` found something missing before apps can run (no Podman, no Quadlet generator) |
| `INGRESS_UNHEALTHY` | The proxy is installed but inactive, or active and not answering its health endpoint |
| `BACKUP_NO_SNAPSHOTS` | A repository exists but has never been written to — backups are configured, not proven |
