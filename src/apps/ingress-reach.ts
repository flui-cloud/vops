/** How long to wait for the LE preflight to come true, and what to say when it does not.
 * Pure: the polling loop lives in `vops-ingress.service.ts`. */
import { AuthResolve, HttpProbe } from './ingress-probe';
import { DnsEnsureAction } from './ingress-dns';

/** Where the hostname's A record comes from. `external` = a zone vops cannot write, so the
 * user owns the record (or there is none) and nothing is propagating on our account. */
export type DnsOrigin = DnsEnsureAction | 'external';

export interface ReachBudget {
  /** Sleeps between authoritative-DNS attempts (length = attempts - 1). */
  dnsSleepsMs: number[];
  /** Sleeps between :80 attempts — always short: the probe hits the host IP directly, so
   * DNS propagation cannot be what is missing. An unanswered :80 is a filter or a dead proxy. */
  httpSleepsMs: number[];
}

const SHORT = [3_000, 3_000, 3_000, 3_000, 3_000];
/** ~112s: a record created seconds ago at a provider's own nameservers converges in that
 * window; the deploy that precedes this usually absorbs most of it already. */
const PROPAGATING = [3_000, 3_000, 5_000, 8_000, 13_000, 20_000, 20_000, 20_000, 20_000];

export function reachBudget(origin: DnsOrigin): ReachBudget {
  const propagating = origin === 'created' || origin === 'repointed';
  return { dnsSleepsMs: propagating ? PROPAGATING : SHORT, httpSleepsMs: SHORT };
}

/** The name answers, just not with our address — more waiting cannot fix that. */
export function pointsElsewhere(dns: AuthResolve): boolean {
  return !dns.resolved && (dns.addrs?.length ?? 0) > 0;
}

/** The "left on plain HTTP" note. The four origins fail for different reasons and need
 * different next steps — one shared sentence would send three of them the wrong way. */
export function notReadyNote(
  hostname: string,
  ip: string,
  appName: string,
  origin: DnsOrigin,
  dns: AuthResolve,
  http: HttpProbe,
): string {
  const reasons = [
    ...(dns.resolved ? [] : [dnsReason(hostname, ip, origin, dns)]),
    ...(http.reachable ? [] : [`:80 is unreachable at ${ip} (${http.error ?? 'no response'}) — the certificate check needs inbound :80,443`]),
  ];
  // The retry has to be runnable verbatim — agents act on these strings as instructions.
  return `Not ready for TLS, left on plain HTTP: ${reasons.join('; ')}. Retry with \`vops app expose ${appName} --yes\` once fixed.`;
}

function dnsReason(hostname: string, ip: string, origin: DnsOrigin, dns: AuthResolve): string {
  if (pointsElsewhere(dns)) {
    return `${hostname} resolves to ${dns.addrs?.join(', ')} at its authoritative nameservers, not ${ip}`;
  }
  const why = dns.reason ? ` (${dns.reason})` : '';
  if (origin === 'external') {
    return `${hostname} is in no DNS zone vops can write to and does not resolve yet${why} — publish an A record ${hostname} → ${ip} yourself`;
  }
  return `the A record vops wrote for ${hostname} has not converged at its authoritative nameservers yet${why}`;
}

/** Repointing a name only moves its authoritative value: Let's Encrypt validates through its
 * own recursive resolvers, which may still hold the previous address until that TTL expires. */
export function repointCaveat(origin: DnsOrigin): string {
  return origin === 'repointed'
    ? ' The name was repointed in this run — validators caching its previous address will need that record’s old TTL to expire.'
    : '';
}
