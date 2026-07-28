# flui.yaml on a single host

`vops spec schema --kind Application` prints the authoritative JSON Schema. This page
covers only what changes when the manifest runs on one VPS instead of the hosted Flui
platform.

## Applied by vops

- `metadata.name` — the install handle.
- `build.dockerfile` / `build.context` / `build.args` — read by `vops build setup` to
  render the GitHub Actions workflow. vops itself never builds.
- `deploy.port` — the container port.
- `deploy.exposure` — `internal` keeps the port off the public bind.
- `deploy.healthcheck` — becomes the container health check and the post-deploy smoke
  test. A wrong path here means the deploy rolls back.
- `deploy.env` — map form preferred. Literal values are injected as env vars;
  `valueFrom.generate` creates a Podman secret on the host and reuses it across
  redeploys; `valueFrom.userInput` with `sensitive: true` becomes a secret you supply
  with `--set`.
- `deploy.volumes` — Podman named volumes. `size` is informational: named volumes carry
  no quota.
- `deploy.resources.limits.cpu` / `.memory` — real Podman limits.
- `deploy.domain` — `tls`, `certChallenge: http-01`, `certificateProvider`. The hostname
  itself is a deploy-time input (`--domain`), so one manifest works on any host.
- `deploy.startCommand` — overrides the image entrypoint.

## Not applied, and why

- `deploy.scaling` — one host, one replica.
- `deploy.resources.profile` — set `resources.limits` instead.
- `deploy.resources.requests` — a scheduler hint with nothing to schedule.
- `environments{}` — vops deploys one environment per install. Use one manifest per
  environment, or override with `--set`.
- `valueFrom.service` — cross-app service references need a service registry vops does
  not have. Point at a concrete URL, or install the dependency as a building block.
- `certChallenge: dns-01` and wildcard certificates — only http-01 is implemented.

Each of these is reported as a warning at plan time rather than silently dropped.

## vops extension

`{{app.domain}}` inside an env value resolves to the hostname the app is exposed on.
Useful for `PUBLIC_URL`, `NEXTAUTH_URL`, `ALLOWED_HOSTS`. It is resolved at deploy
time, so it works without pinning a domain in the manifest.

## Building blocks

A database is a separate install, not a field in the manifest:

```bash
vops app install postgresql --host web1 --yes
vops app credentials postgresql --show
```

Then reference it from the app's env. vops does not auto-wire dependencies, and a
manifest that declares one is refused rather than deployed half-connected.
