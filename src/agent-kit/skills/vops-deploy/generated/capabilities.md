# Generated capability registry

Schema version: 1. Generated from `src/agent-control/capabilities.json`.

| Capability | Risk | Access | State | Summary |
|---|---|---|---|---|
| `repository.inspect` | read_only | read | available | Inspect safe repository metadata without reading credentials or files outside the repository. |
| `flui_spec.read` | read_only | read | available | Read a flui.yaml manifest inside the session repository. |
| `flui_spec.generate` | low | local_write | available | Generate a deterministic base flui.yaml from a bundled framework template. |
| `flui_spec.validate` | read_only | read | available | Validate a flui.yaml manifest against the installed flui specification. |
| `catalog.list` | read_only | read | available | List packaged applications and reusable building blocks. |
| `catalog.describe` | read_only | read | available | Describe one packaged catalog application and its required inputs. |
| `catalog.install` | medium | remote_write | available | Install one bundled catalog application on a registered target. |
| `provider.list` | read_only | read | available | List supported VPS providers and their static capability summary. |
| `provider.prices.compare` | read_only | read | available | Compare live provider plans and prices as a planning aid. |
| `target.list` | read_only | read | available | List locally registered vOps host targets. |
| `target.inspect` | read_only | read | available | Inspect one registered target and run bounded read-only health probes. |
| `server.list` | read_only | read | available | List servers from one configured provider. |
| `server.inspect` | read_only | read | available | Inspect one server from a configured provider. |
| `server.harden` | high | remote_write | available | Apply the bounded idempotent vOps host-hardening workflow to one target. |
| `application.plan_deploy` | low | local_write | available | Render and persist an immutable deployment plan without changing the target. |
| `application.deploy` | medium | remote_write | available | Apply a previously rendered immutable deployment plan to one target. |
| `application.status` | read_only | read | available | Read live systemd and container status for one installed application. |
| `application.restart` | medium | remote_write | available | Restart one installed application and return its resulting state. |
| `logs.read_recent` | read_only | read | available | Read a bounded number of recent application log lines. |
| `healthcheck.run` | read_only | read | available | Run the configured post-deployment verification for an application. |
| `firewall.inspect` | read_only | read | available | Inspect effective vOps-managed or detected firewall state for one target. |
| `firewall.open_port` | high | remote_write | available | Add one validated inbound service to the target firewall without removing existing services. |
| `firewall.close_port` | high | remote_write | available | Remove one validated inbound service while preserving all other target firewall services. |
| `server.provision` | high | provider_write | available | Provision an hourly-billed server from a vOps plan file. |
| `server.destroy` | destructive | provider_write | available | Destroy one vOps-managed provider server. |
| `application.rollback` | high | remote_write | unavailable | Restore a captured previous application revision when one is available. |

Input schemas are in `capability-schemas/<capability>.json`.
