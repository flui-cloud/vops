# vops doctor — Read-Only Diagnostics Extraction Analysis

> **Status:** Analysis only. No implementation. Companion to [`vops-extraction-analysis.md`](./vops-extraction-analysis.md).
> **Date:** 2026-07-06
> **Scope:** A **read-only** `vops doctor` that runs entirely from a laptop against a public domain/IP + provider API token — no writes, no reconciliation, nothing installed on the target VPS, no cluster/kubeconfig/SSH access required.
> **Checks in scope:** exposure check · DNS check · certificate check · firewall read/inspection · domain-to-IP readiness · TLS expiry/chain/SAN validation · CAA / ACME readiness.

---

## 1. Executive summary

**A local, read-only `vops doctor` is very feasible — but it is mostly a *build*, not an *extract*.** The single most important finding is a clean split:

- **The provider-token-only, laptop-capable half already exists and is reusable** — firewall reads (`HetznerFirewallService.getFirewall/listFirewalls`), the expected-firewall baseline + pure validator (`firewall-rules.template.ts`), public-egress-IP detection (`IpDetectionService`), the nip.io hostname utilities, and one live DNS primitive (`verifyDnsResolution`). All of this is already exercised by the CLI with **no DB, no cluster, no SSH** — the `flui env update-firewall` command is a near-exact "family (a)" precedent.

- **The certificate/TLS/CAA/ACME half essentially does not exist as reusable local code.** Flui has **zero laptop-side TLS inspection**: no `X509Certificate` parsing, no `acme-client`, no `node-forge`, no CAA lookup, no SAN/chain/expiry validation. Its entire "cert diagnostics" surface is a **read-through of cert-manager CRD status via an in-cluster kubeconfig** — unavailable to a laptop and irrelevant to vops. The only reusable scrap is the `getPeerCertificate()` handshake scaffold in `cli-control-cluster.service.ts` (which today reads *only* `issuer.O`).

**Consequence:** vops doctor's cert/DNS-deep checks are **net-new code — but trivially so**, because everything needed is in Node's standard library (`node:tls`, `node:crypto.X509Certificate`, `node:dns/promises`, `node:net`). No third-party TLS/ACME dependency is required for v0. The reuse value from Flui is: (a) the **firewall read + baseline-compare engine** (real reuse), (b) a set of **portable ~15-line probe primitives** to lift (TCP connect, HTTP 2xx, DNS resolve), and (c) **output/report conventions** and **DTO shapes** to mirror.

**Bottom line:** `vops doctor` is a self-contained, read-only CLI command that composes existing DB-free firewall reads with new-but-tiny stdlib probes. It belongs to the same local-first, provider-token-only execution model as the rest of vops (see companion doc §7).

---

## 2. Per-check analysis: what exists, what's reusable, what's net-new

Legend — **Reuse:** ✅ lift as-is · ♻️ lift a primitive/helper · 🧩 mirror shape/pattern only · ✳️ net-new (stdlib). **Local?** whether it runs from a laptop with no cluster.

### 2.1 Firewall read / inspection — **strongest reuse**
| Piece | Source | Local? | Reuse |
|---|---|---|---|
| Live firewall read (`getFirewall`, `listFirewalls` → `FirewallDetails`) | `providers/services/hetzner-firewall.service.ts` | ✅ (token only) | ✅ |
| `FirewallRule` / `FirewallDetails` / `FirewallFilters` shapes | `providers/interfaces/firewall-provider.interface.ts` | ✅ | ✅ |
| Expected baseline per cluster type (`getFirewallRulesForClusterType`) | `infrastructure/firewalls/templates/firewall-rules.template.ts` | ✅ (pure) | ✅ |
| Pure rule validator (`validateFirewallRules` → `{valid, errors[]}`) | same | ✅ (pure) | ✅ |
| Canonicalize + sha256 drift helper (`canonicalizeRules`, `calculateHash`) | `infrastructure/firewalls/services/firewall-desired-state.service.ts` | ✅ (helpers only) | ♻️ |
| Reconciliation services / entities / drift *persistence* | `firewall-reconciliation.service.ts`, `ClusterFirewallEntity` | ❌ (DB/cluster) | exclude |

**What a doctor can do read-only:** resolve the firewall provider via `FirewallProviderFactory` (bound to the CLI file-credential provider) → `listFirewalls({ labelSelector })` → for each `FirewallDetails.rules`, flag: **inbound `22` with `sourceIps` ⊇ `0.0.0.0/0`/`::/0` → FAIL/WARN**; **`6443` open to world → INFO** (the codebase itself notes 6443 is client-cert mTLS — "grants nothing without the kubeconfig cert", so it is not a hard finding); **missing `80`/`443` → WARN**. `validateFirewallRules` supplies the lockout/outbound checks for free. **This is the highest-reuse part of the whole doctor.**

### 2.2 Exposure check (host:port reachable from laptop) — **portable primitives, not packaged**
| Piece | Source | Local? | Reuse |
|---|---|---|---|
| TCP connect-with-timeout probe (`net.Socket` connect/error/timeout) | `infrastructure/clusters/services/cluster-node-scaling.service.ts` `waitForTcpOpen` (~L548-588) | ✅ in principle | ♻️ (copy ~25 ln) |
| HTTP 2xx probe (`fetch` + `AbortController`, `status 200–299`) | `demo/services/demo-prober.service.ts` `probe()` (L131-148) | ✅ in principle | ♻️ (copy ~15 ln) |
| Public egress IP (`getPublicIp()` via ipify/ifconfig chain) | `cli/src/lib/utils/ip-detection.ts` | ✅ | ✅ |
| CIDR helpers (`validateCidr`, `toCidr`, `parseCidrList`) | same | ✅ | ✅ |

**Gap it fills:** Flui has **no laptop→public-IP reachability check today** — every existing probe runs server-side or over SSH. But both low-level primitives are pure stdlib and trivially relocate. Doctor turns "poll until open" into a **single-shot per port** (22/80/443/6443) against the target IP, distinguishing `ECONNREFUSED` (closed/filtered-reset) vs timeout (dropped). Cross-check with firewall reads: *"firewall says 22 is open to 0.0.0.0/0 **and** it's reachable from your current IP."*

### 2.3 Domain-to-IP readiness — **one reusable primitive**
| Piece | Source | Local? | Reuse |
|---|---|---|---|
| Live A-lookup + expected-IP compare (`resolve4` + `.includes(expectedIp)`) | `dns/services/dns-zone.service.ts` `verifyDnsResolution` (L115-133) | ✅ (`node:dns/promises` only) | ♻️ (lift ~18 ln) |
| `DnsLookupResponseDto` `{ hostname, expectedIp, resolvedAddresses, matches }` | `dns/dto/dns-lookup-response.dto.ts` | ✅ | 🧩 |
| nip.io hostname build (`buildAppNipHostname`, dash-encoded IP) | `dns/utils/nip-hostname.util.ts` | ✅ (no imports) | ✅ |
| nip.io token gen/validate | `dns/utils/nip-token.util.ts` | ✅ (`node:crypto`) | ✅ |
| Zone-relative record name (`resolveRecordName`) | `dns/utils/resolve-record-name.util.ts` | ✅ (pure) | ✅ |
| Expected-FQDN computation (`hostnameMode`, `certChallenge`) | `dns/services/endpoint-mode-resolver.service.ts` | ✅ (pure given inputs) | 🧩 |

**Key fact:** the domain-sync services (`api/web/auth-domain-sync.service.ts`) **never verify DNS** — they read the FQDN from Postgres and patch ConfigMaps assuming DNS is already correct. So domain-to-IP readiness is exactly the decoupled, manual step vops doctor should own. `expectedIp` is simply the target VPS IP (passed as input; in Flui it's `ClusterEntity.masterIpAddress`).

### 2.4 DNS check (records, TXT, CNAME, CAA) — **mostly net-new (stdlib)**
Flui does **only** IPv4 `resolve4`. There is **no** `resolveTxt`, `resolveCname`, `resolveCaa`, `resolve6`, no multi-resolver/propagation polling anywhere in first-party code. So:
- ✳️ **Net-new (all stdlib `node:dns/promises`):** `resolve6` (AAAA), `resolveCname` (chain), `resolveTxt` (`_acme-challenge` readiness), `resolveCaa` (CAA readiness), and multi-resolver comparison (e.g. `1.1.1.1` vs `8.8.8.8` via `new Resolver()`) for propagation. Each is a few lines.

### 2.5 Certificate / TLS expiry / chain / SAN — **net-new (stdlib), near-zero reuse**
| Piece | Source | Local? | Reuse |
|---|---|---|---|
| Live handshake + peer cert (`getPeerCertificate()`, reads only `issuer.O`) | `cli/src/services/cli-control-cluster.service.ts` `waitForValidTls`/`waitForOidcReady` | ✅ | ♻️ scaffold only |
| `CertificateInfo { domain, issuer, status, notBefore?, notAfter?, serialNumber? }` + `CertificateStatus` enum | `providers/interfaces/certificate-provider.interface.ts` | ✅ (types) | 🧩 output model |
| `CertDiagnosticsResponseDto` tree (Certificate→Request→Order→Challenge) | `dns/dto/cert-diagnostics-response.dto.ts` | 🧩 report template; **data source = cert-manager CRDs, not local** | 🧩 |
| `getCertDiagnostics()` (reads cert-manager CRDs via kubeconfig) | `dns/services/cluster-dns-zone.service.ts` | ❌ (kube + DB) | exclude |
| Known ACME server URLs; dns-01 webhook config | `providers/services/acme-certificate.service.ts` | ✅ (constants) | ♻️ constants only |
| `resolveScope(fqdn, rootZone)`; FQDN regex; `cert-challenge` enum | `dns/services/wildcard-certificate.service.ts`; `create-san-certificate.dto.ts`; `dns/enums/cert-challenge.enum.ts` | ✅ (pure) | ✅ small helpers |

**The real work is net-new but small:** `tls.connect({ host, servername, port: 443 })` → `socket.getPeerCertificate(true)` gives `valid_from`/`valid_to` (**expiry**), `subjectaltname` (**SAN match** vs requested host), and `issuerCertificate` (**walk the chain** to root). `node:crypto.X509Certificate` parses a PEM for the same fields offline. Set `rejectUnauthorized: false` to *inspect* an untrusted/self-signed cert and *report* the problem rather than throw (a doctor reports; it does not gate). None of this exists in Flui — but it is ~1 file of stdlib.

### 2.6 CAA / ACME readiness — **net-new (stdlib)**
- **CAA:** ✳️ `dns.resolveCaa(domain)` walking up the label tree; report whether an ACME CA (e.g. `letsencrypt.org`) is permitted by any `issue`/`issuewild` tag. Zero Flui code exists.
- **ACME readiness:** Flui's only "ACME readiness" is **reflected cert-manager Order/Challenge status** (needs the cluster). For a laptop doctor, ACME readiness = ✳️ (a) **http-01 reachability** — the `.well-known/acme-challenge/` path is reachable on `:80` (reuse the HTTP probe primitive), and (b) **dns-01 readiness** — `_acme-challenge.<domain>` TXT is resolvable + CAA permits the CA. Both net-new, both stdlib. The `CertChallenge` enum (`http-01`/`dns-01`) and the ACME endpoint URLs from `acme-certificate.service.ts` are the only reusable constants.

---

## 3. Reuse vs coupling — consolidated table

| Capability | Reusable Flui asset | Local-capable | Verdict | Effort |
|---|---|---|---|---|
| Firewall read | `HetznerFirewallService.get/listFirewalls`, `IFirewallProvider` shapes | ✅ token-only | **Reuse as-is** | L |
| Firewall baseline + validate | `firewall-rules.template.ts` (`getFirewallRulesForClusterType`, `validateFirewallRules`) | ✅ pure | **Reuse as-is** | L |
| Firewall drift hash | `firewall-desired-state.service.ts` (`canonicalizeRules`, sha256) | ✅ helpers | **Lift helpers** | L |
| Public egress IP + CIDR | `cli/src/lib/utils/ip-detection.ts` | ✅ | **Reuse as-is** | L |
| TCP port probe | `cluster-node-scaling.service.ts` `waitForTcpOpen` | ✅ | **Lift ~25 ln → single-shot** | L |
| HTTP 2xx probe | `demo-prober.service.ts` `probe()` | ✅ | **Lift ~15 ln** | L |
| Domain→IP (A) readiness | `dns-zone.service.ts` `verifyDnsResolution` | ✅ | **Lift ~18 ln** | L |
| nip.io hostname/token/record utils | `dns/utils/*` | ✅ | **Reuse as-is** | L |
| Expected-FQDN logic | `endpoint-mode-resolver.service.ts` | ✅ pure | **Mirror** | M |
| Cert output model | `certificate-provider.interface.ts` `CertificateInfo`/`CertificateStatus`; `cert-diagnostics-response.dto.ts` | 🧩 | **Mirror shape** | L |
| TLS handshake scaffold | `cli-control-cluster.service.ts` `getPeerCertificate` | ✅ | **Scaffold only; extend** | M |
| ACME endpoint URLs, `cert-challenge` enum, FQDN regex, `resolveScope` | `acme-certificate.service.ts`, `cert-challenge.enum.ts`, `create-san-certificate.dto.ts`, `wildcard-certificate.service.ts` | ✅ | **Reuse small pieces** | L |
| TLS expiry/chain/SAN inspection | *(none)* | ✅ stdlib | **Net-new** `tls`/`X509Certificate` | M |
| AAAA/CNAME/TXT/CAA lookup, multi-resolver | *(none)* | ✅ stdlib | **Net-new** `node:dns` | L |
| ACME http-01/dns-01 readiness | *(none — cluster-only today)* | ✅ stdlib | **Net-new** | M |
| **cert-manager CRD cert diagnostics** | `getCertDiagnostics()` | ❌ kube+DB | **Exclude** | — |
| **domain-sync / app-endpoint / SAN-wildcard reconcile** | `*-domain-sync.service.ts`, `app-endpoint.service.ts`, `san-/wildcard-certificate.service.ts` | ❌ kube+DB+queue | **Exclude** | — |
| **firewall reconciliation + entities** | `firewall-reconciliation.service.ts`, `ClusterFirewallEntity` | ❌ DB+cluster | **Exclude** | — |

**What is coupled to Flui backend/DB/cluster (and therefore excluded):** anything that reads **cert-manager CRDs** or **K8s TLS Secrets** (needs kubeconfig), anything that reads/writes **TypeORM entities** (`ClusterFirewallEntity`, `SanCertificate`, `WildcardCertificate`, `AppEndpoint`, `DnsZone`), and all **reconciliation/sync** services (they patch ConfigMaps/Secrets and restart deployments). None of these are needed — a doctor observes from outside.

---

## 4. Proposed `vops doctor` module

### 4.1 Design principles
1. **Observation-only.** Every check is a pure read: a DNS query, a TLS handshake, a TCP/HTTP probe, or a provider API GET. No provider write, no reconciliation, no cert issuance, no host mutation. This is enforced structurally — the module imports only read clients and stdlib.
2. **Local-first, no cluster.** Runs from a laptop. Needs at most (a) a target FQDN/IP and (b) optionally a locally-stored provider token (for firewall reads). With no token it still does DNS/TLS/exposure/CAA — degrading gracefully.
3. **Report, don't gate.** TLS inspection uses `rejectUnauthorized: false` so a broken cert is *reported*, not thrown. Findings carry severity, never side effects.
4. **Composable checks.** A registry of independent `Check` units; the runner executes selected ones and aggregates `Finding`s into a report renderable as human text or `--json`.

### 4.2 Check registry (v0 set)
| id | Question | Primitive | Needs token? |
|---|---|---|---|
| `dns.a` | Does `<fqdn>` resolve to `<expectedIp>`? | `resolve4` (lift) | no |
| `dns.aaaa` | AAAA present/consistent? | `resolve6` (new) | no |
| `dns.cname` | CNAME chain sane, no loops? | `resolveCname` (new) | no |
| `dns.propagation` | Consistent across public resolvers (1.1.1.1/8.8.8.8)? | `new Resolver()` (new) | no |
| `exposure.ports` | 22/80/443/6443 reachable from here? | `net.Socket` single-shot (lift) | no |
| `exposure.egressIp` | Is *your* IP inside the SSH allowlist? | `getPublicIp` (reuse) + firewall read | optional |
| `tls.handshake` | Does `:443` complete a TLS handshake? | `tls.connect` (new) | no |
| `tls.expiry` | Days until `notAfter`; already expired? | `getPeerCertificate(true)` (new) | no |
| `tls.san` | Does `subjectaltname` cover `<fqdn>`? | cert `subjectaltname` (new) | no |
| `tls.chain` | Chain builds to a trusted root; not self-signed? | `issuerCertificate` walk (new) | no |
| `caa.readiness` | Does CAA permit the intended ACME CA? | `resolveCaa` (new) | no |
| `acme.http01` | Is `:80` reachable for http-01? | HTTP probe (lift) | no |
| `acme.dns01` | Is `_acme-challenge.<fqdn>` TXT resolvable? | `resolveTxt` (new) | no |
| `firewall.rules` | Any risky inbound rule (22 world-open, missing 80/443)? | `listFirewalls` + `validateFirewallRules` (reuse) | yes |
| `firewall.drift` | Actual rules vs recommended baseline? | `canonicalizeRules`+sha256 (lift) | yes |

### 4.3 Proposed TypeScript (framework-free)
```ts
export type Severity = 'ok' | 'info' | 'warn' | 'fail' | 'skipped';

export interface Finding {
  checkId: string;              // 'tls.expiry'
  title: string;                // 'Certificate expiry'
  severity: Severity;
  summary: string;              // 'Expires in 12 days (2026-07-18)'
  detail?: Record<string, unknown>;  // machine-readable evidence (e.g. { notAfter, daysLeft })
  remediation?: string;         // human hint; NEVER an auto-fix
}

export interface CheckContext {
  fqdn?: string;
  ip?: string;                  // expected target IP (VPS public IP)
  ports: number[];              // default [22, 80, 443, 6443]
  provider?: string;            // enables firewall.* checks when a token is present
  resolvers?: string[];         // public resolvers for propagation check
  timeoutMs: number;
  now: Date;                    // injectable clock (deterministic tests)
}

export interface Check {
  id: string;
  title: string;
  /** True when the check can run given available inputs (fqdn/ip/token). */
  applicable(ctx: CheckContext): boolean;
  /** Pure observation. MUST NOT mutate anything. Returns one or more findings. */
  run(ctx: CheckContext): Promise<Finding[]>;
}

export interface DoctorReport {
  target: { fqdn?: string; ip?: string };
  startedAt: string;
  findings: Finding[];
  summary: Record<Severity, number>;   // counts
  /** Highest severity present → drives exit code. */
  worst: Severity;
}
```

Exit-code convention: `ok/info` → 0, `warn` → 0 (or `--strict` → non-zero), `fail` → non-zero. `--json` prints `DoctorReport` and suppresses all decoration (mirroring the 23 existing CLI commands that do this).

### 4.4 Placement (in the vops architecture from the companion doc)
```
packages/
  doctor/                 # NEW — the read-only diagnostic engine
    src/
      checks/             # one file per Check (dns/tls/exposure/caa/acme/firewall)
      probes/             # lifted stdlib primitives: tcp.ts, http.ts, dns.ts, tls.ts
      baseline/           # firewall-rules template + validateFirewallRules (lifted)
      report.ts           # Finding/DoctorReport model + severity aggregation
      runner.ts           # applicable() → run() → aggregate
  core/                   # provider read clients (firewall read reused here)
  config/                 # supplies provider token to firewall.* checks
  output/                 # table + JSON renderers (shared)
  cli/                    # `vops doctor` command wires runner → output
```
`doctor/` depends only on stdlib + `core/` read clients + `config/`. It never imports a write path.

---

## 5. Command surface

```
vops doctor <fqdn|ip> [--ip <expected>] [--provider <p>] [--ports 22,80,443,6443] \
                      [--checks dns,tls,exposure,caa,acme,firewall] [--json] [--strict] [--timeout 5s]

# focused subcommands (thin wrappers over the same runner):
vops doctor dns       <fqdn> [--ip <expected>] [--resolvers 1.1.1.1,8.8.8.8]
vops doctor tls       <fqdn> [--port 443]          # expiry + SAN + chain
vops doctor cert      <fqdn>                        # alias of tls
vops doctor caa       <fqdn> [--ca letsencrypt.org]
vops doctor acme      <fqdn>                        # http-01 + dns-01 readiness
vops doctor exposure  <ip> [--ports ...]
vops doctor firewall  --provider <p> [--server <id>]   # read + risky-rule + drift
```

**Reporting style** (mirror `env/diag-ca.ts` + `dns/replica/verify.ts`): numbered sections, per-line `✓ ok / ⚠ warn / ✗ fail / ○ skipped`, a remediation summary, and a `--json` short-circuit from day one. No spinners in `--json` mode.

**Conventions:** `--provider/-p` only required for `firewall.*`; everything else runs with just a hostname. Secrets never in argv (token from local store/env). `--offline` disables any network check and only validates inputs.

---

## 6. What must stay out of vops doctor (Flui-coupled)

| Excluded | Why | Where it stays |
|---|---|---|
| cert-manager CRD diagnostics (`getCertDiagnostics`) | needs kubeconfig + in-cluster cert-manager | `dns/services/cluster-dns-zone.service.ts` |
| K8s TLS Secret inspection | needs kube; only checks key presence anyway | `san-certificate.service.ts` |
| DNS/domain **sync** + app-endpoint reconcile | writes ConfigMaps/Secrets, restarts deploys | `*-domain-sync.service.ts`, `app-endpoint.service.ts` |
| SAN/wildcard cert **issuance** | ACME order via cert-manager, DB + queue | `san-/wildcard-certificate.service.ts` |
| Firewall **reconciliation** + drift persistence | writes provider rules, TypeORM state | `firewall-reconciliation.service.ts`, `ClusterFirewallEntity` |
| `_acme-challenge` TXT **cleanup** | write op against provider DNS API | `wildcard-certificate.service.ts` |
| Anything over SSH (`env inspect`, `diag-ca` checks 2–4, observability health) | needs SSH + running cluster | `cli/src/commands/env/*`, `cli-control-cluster.service.ts` |

The principle from the companion doc holds: exclude anything needing the **backend/DB**, a **running cluster/kubeconfig**, or **mutating** the target. A doctor only observes.

---

## 7. Safety & threat notes (read-only guarantees)

- **No writes, structurally.** `doctor/` imports read clients and stdlib only; there is no provider write method or reconciler in its dependency graph. This is the enforceable version of "read-only."
- **Inspect-don't-trust TLS.** `rejectUnauthorized: false` is used *to inspect and report* a bad cert, not to accept it for a real connection. The doctor never sends credentials over the inspected connection — it handshakes, reads the cert, and disconnects.
- **Probing is low-impact but not zero.** A TCP/HTTP probe to 22/80/443/6443 is a single connection per port. Document it; keep it single-shot (not a scan); honor `--timeout`. Never probe hosts other than the explicit target.
- **No token exfiltration.** Firewall reads use the local credential store (companion doc §7); redact tokens in all output/errors (reuse Hetzner's header-stripping `describeError` idea). `--json` emits findings/evidence only, never the token.
- **CAA/ACME readiness is advisory.** Report "CAA does not list Let's Encrypt" as `warn` with the exact records seen — never modify CAA or attempt issuance.

---

## 8. Roadmap

**Phase D0 — probes + report engine (S).** Lift `net.Socket` TCP probe, `fetch` HTTP probe, `resolve4`; build `Finding`/`DoctorReport`/`runner`. Add `resolve6/resolveCname/resolveTxt/resolveCaa` and multi-resolver (all stdlib). Test with an injectable clock + a local fixture server. **No token needed.** *Ships: `vops doctor dns|exposure|caa|acme`.*

**Phase D1 — TLS inspection (M).** New `tls.connect` + `getPeerCertificate(true)` + `X509Certificate` for expiry/SAN/chain, using the `cli-control-cluster.service.ts` handshake as scaffold and `CertificateInfo`/`cert-diagnostics-response.dto` as the output model. **No token.** *Ships: `vops doctor tls|cert`.*

**Phase D2 — firewall read + baseline compare (M).** Wire `FirewallProviderFactory` + `HetznerFirewallService` reads through the CLI file-credential provider; reuse `getFirewallRulesForClusterType` + `validateFirewallRules`; lift `canonicalizeRules`+sha256 for stateless drift. Add risky-rule checks (22 world-open FAIL, 6443 world-open INFO, missing 80/443 WARN) and the egress-IP-in-allowlist cross-check. **Token required for these checks only.** *Ships: `vops doctor firewall` + `firewall.*` in the aggregate run.*

**Phase D3 — aggregate `vops doctor` + polish (S).** The top-level command runs all applicable checks against a single `<fqdn|ip>`, cross-references (firewall-says-open ∧ actually-reachable ∧ DNS-points-here), `--json`/`--strict`/exit codes, remediation summary. *Ships: the headline `vops doctor <fqdn>` one-shot.*

---

## 9. Final read

- **Is a read-only `vops doctor` worth building from Flui?** Yes — the firewall read + baseline-compare engine is genuine, DB-free reuse, and the rest is small stdlib code. The companion extraction (local credential store, provider read clients, oclif skeleton) already provides the substrate.
- **Smallest useful v0:** `vops doctor <fqdn> --ip <target>` running DNS (A/AAAA/CNAME/propagation), TLS (handshake/expiry/SAN/chain), exposure (22/80/443/6443), and CAA/ACME-readiness — **all with no token, no cluster, no writes**. Add `firewall.*` the moment a provider token is present. That is a compelling, safe, standalone first release: *"point vops doctor at your domain and see, from your laptop, exactly why TLS/DNS/exposure isn't ready — nothing installed, nothing changed."*
- **Immediately reusable:** firewall reads + `firewall-rules.template.ts` validator, `IpDetectionService`, the nip.io utils, `verifyDnsResolution`, and the probe primitives.
- **Net-new but trivial (stdlib):** TLS expiry/SAN/chain, CAA, AAAA/CNAME/TXT/multi-resolver, http-01/dns-01 readiness. No third-party TLS/ACME dependency needed for v0.
- **Absolutely excluded from v0:** cert-manager CRD diagnostics, all sync/reconcile/issuance services, K8s/SSH/DB access — none are needed to observe a domain from outside.
