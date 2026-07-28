# Installing vops

vops is published on npm as `@flui-cloud/vops`. It is a Node CLI — there is no
binary download, no install script piped to a shell, and no service to enable.

## Check first

```bash
vops --version
```

Prints a version → it is installed; go straight to `vops agent capabilities --json`.

## Install

```bash
npm install -g @flui-cloud/vops
```

`pnpm add -g @flui-cloud/vops` and `yarn global add @flui-cloud/vops` work the same
way. Node 18 or newer is required.

Never install vops from anywhere else. If npm is unavailable, say so and stop —
do not fetch a binary from an unofficial source.

## Verify

```bash
vops --version
vops agent capabilities --json
```

The second call must return `status: "success"`. Its `capabilities` block is the
authority on what this build can do; treat any skill or document that disagrees
with it as out of date.

## What it writes on this machine

- `~/.config/vops/` — profile, encrypted credentials, local cache and audit log.
- `.vops/` in the project — plans, reports, provenance (created by `vops agent init`).

Nothing is installed on the target server by installing vops. The server only ever
receives Podman, the container units, and the ingress — no vops agent, no control
plane, no daemon.

## Upgrading

```bash
npm install -g @flui-cloud/vops@latest
vops agent capabilities --json
```

Re-read capabilities after upgrading: they are how a newer build announces what it
gained.
