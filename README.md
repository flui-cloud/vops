<h1 align="center">
  <img src="docs/assets/logo.png" width="64" alt=""><br>
  vops
</h1>

<p align="center">
  <strong>Local-first VPS operations.</strong>
</p>
<p align="center">
  <em>Compare cloud providers on real-time prices, then provision and manage them safely — entirely from your machine.</em>
</p>
<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <a href="https://www.npmjs.com/package/@flui-cloud/vops"><img alt="npm" src="https://img.shields.io/npm/v/@flui-cloud/vops.svg"></a>
  <img alt="Node >= 20" src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white">
</p>
<p align="center">
  <em>Part of the <a href="https://github.com/flui-cloud">Flui</a> ecosystem. Built on <a href="../flui-infra"><code>@flui-cloud/infra</code></a>.</em>
</p>

<p align="center">
  <img src="docs/assets/overview.png" alt="vops dashboard — fleet overview with the live provider map" width="100%">
</p>

`vops` is a command-line tool and a local web dashboard for working with cloud VPS providers. It compares providers side by side on **live pricing and capabilities**, then lets you plan, provision and manage servers, firewalls, private networks and SSH keys through one uniform interface — whether the provider is Hetzner, Scaleway, Contabo or OVH.

Everything runs on your own machine. Your provider tokens never leave it, there is no account to create, and nothing is sent anywhere — the local dashboard is served on `127.0.0.1` only. The one opt-in exception is `vops watch` (below): since your laptop can't push a notification to your phone while it's asleep, watch alerts are relayed through a small hosted service you connect to explicitly — no email, no signup, just a token generated on your machine.

## Who it's for

You run a handful of servers on Hetzner, Scaleway, Contabo or OVH — not a fleet of five hundred behind a managed platform. You're fine on the command line, you don't want another SaaS account, and you're not writing Terraform to spin up a box for the weekend. vops gives you real prices and safe provisioning across all four without any of that ceremony.

## Why vops

Every cloud provider has a different console, a different pricing page, a different API and a different idea of what a "firewall" or a "private network" is. Comparing them honestly is tedious, and provisioning across them means learning each one.

vops gives you a single vocabulary over all of them, with a bias toward **safety**:

- **Real prices, not brochure prices.** OVH pricing comes straight from the live public catalog; comparisons reflect what you'd actually pay.
- **It won't spend your money by accident.** Provisioning is gated to hourly-billed resources, and destructive actions only ever touch resources vops itself created (named `vops-*` or tagged `managed-by=vops`).
- **Provider-neutral where it counts.** A host-level firewall you can carry across providers that lack a usable native one.
- **Your secrets stay yours.** Tokens are read from local config; SSH private keys never leave your disk, even when you "import" an existing key.

## Quickstart

Requires Node.js 20+. No account, no Docker, no config beyond your provider tokens.

```bash
# 1. Install
npm install -g @flui-cloud/vops

# 2. Add a provider token (stored locally, never transmitted)
vops config set hetzner YOUR_HETZNER_TOKEN

# 3. Compare providers on live prices
vops compare

# 4. Open the local dashboard (interactive map, 127.0.0.1 only)
vops ui
```

No token is needed to explore OVH's real-time public pricing or to render a host firewall — those work offline out of the box.

## What you can do

```bash
# Research — no provisioning, safe to run anytime
vops providers list                    # supported providers + billing model
vops providers plans ovh               # live plans & prices for a provider
vops providers regions hetzner         # regions / locations
vops providers capabilities scaleway   # what the provider supports
vops compare                           # side-by-side comparison across providers

# Servers — plan first, then create (hourly-billed only)
vops servers plan --provider hetzner --plan cx22 --region nbg1
vops servers create <plan-file>        # provisions; monthly-commitment providers are refused
vops servers list
vops servers delete <id>               # only vops-created servers

# Firewall (provider-native, where supported)
vops firewall create / list / show / rules / apply / delete

# Host-level firewall (provider-independent, via cloud-init)
vops host-firewall render <plan>       # emit the nftables ruleset
vops host-firewall cloud-init <plan>   # emit #cloud-config user_data

# Private networks
vops vnet create / list / show / subnet / route / attach / delete

# SSH keys (private half never leaves your machine)
vops ssh-key create / list / import / register / delete
vops ssh <provider> <server>           # open an interactive session

# Watch — get pushed when a plan restocks or its price changes (opt-in, hosted relay)
vops watch login                                              # connect once (local token, no signup)
vops watch add hetzner cx53 --location fsn1 --ntfy-topic my-vops-alerts
vops watch list
vops watch feed --follow               # live feed of stock/price transitions
vops watch remove <id>

# Local dashboard
vops ui
```

## Highlights

- **Providers.** Hetzner and Scaleway (hourly, native firewalls); **Contabo** (monthly billing — vops *guides* you through creation but never commits you to a monthly plan); **OVH** via **OpenStack** (Keystone + Nova + Neutron + Glance, where a single credential spans every region through the service catalog).
- **Real-time pricing.** OVH's public catalog needs no credentials and drives an interactive **world map** home view with pan/zoom across every region.
- **Safe provisioning.** `plan → create → delete`. Creation is gated to hourly billing; deletes and destructive mutations are refused on anything vops didn't create.
- **Two firewalls, one model.** Use the provider's native firewall where it's good (Hetzner, Scaleway), or a **host-level nftables firewall** delivered through cloud-init for providers that lack one (Contabo, OVH). The host firewall is lock-out-safe — it keeps SSH reachable unless you've explicitly opened port 22 yourself.
- **Private networks.** Create networks and subnets and attach servers to them (OVH/Neutron today).
- **SSH by reference.** Manage local `ed25519` keys, or *import* a key you already use — vops records its path and never copies the secret — then register the public half with a provider.
- **Get pinged when a plan restocks.** `vops watch` alerts you the moment a sold-out plan comes back or its price moves, over ntfy, a webhook, or Telegram. It's the one feature that isn't purely local — see above for exactly what that means.

## The local dashboard

`vops ui` starts a NestJS/Express server bound to `127.0.0.1` and guarded by a one-time session token, then opens a single self-contained **Alpine.js + Tailwind** page (assets inlined, fully offline, no CDN). The dashboard calls the same services as the CLI, so both are always in sync — there is no second source of truth.

## Configuration

Credentials and local state live under `~/.config/vops/`:

- `~/.config/vops/.env` — provider credentials (also read from a `.env` in the current directory). `vops config set <provider> <token>` writes here.
- `~/.config/vops/profiles/<profile>/keys/` — your SSH keys (private halves stay here, never uploaded, never copied on import).
- A local libSQL cache and a plan/audit store.

Provider credential variables:

| Provider | Variables |
| --- | --- |
| Hetzner | `HETZNER_TOKEN` |
| Scaleway | `SCALEWAY_*` |
| OVH (OpenStack) | `OS_*` (Keystone auth — one credential, all regions) |
| Contabo | `CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`, `CONTABO_API_USER`, `CONTABO_API_PASSWORD` |

Secrets are read locally and are **never** printed to logs or `--json` output.

## Development

vops depends on **[`@flui-cloud/infra`](../flui-infra)** for all provider/cloud logic. In this repo it's linked from the sibling directory (`file:../flui-infra`); the provider layer is the single source of truth and evolves there, not here.

```bash
pnpm install                     # links ../flui-infra (which must be built)
npx tsc && npx tsc-alias         # compile src → lib/
node scripts/build-map.js        # bake the offline world map (d3-geo)
node scripts/build-ui.js         # Tailwind purge + inline Alpine → lib/ui, lib/lib
pnpm test                        # jest
node bin/run <command>           # run the built CLI without touching the global link
```

- **Full local loop:** `npx tsc && npx tsc-alias && pnpm test`. For UI/asset changes also run the two `build-*.js` scripts.
- If you change `@flui-cloud/infra`, rebuild it there (`npx tsc && npx tsc-alias`) and re-run `pnpm install` here **if files were added or removed** (pnpm hard-links `file:` deps at install time).
- The stack is TypeScript — [oclif](https://oclif.io) for the CLI, NestJS for dependency injection and the local API.

## License

vops is released under the [Apache License 2.0](LICENSE).

---

<p align="center">
  <em>Built and maintained by <a href="https://gojodigital.com/">Dawit</a>.</em>
</p>
