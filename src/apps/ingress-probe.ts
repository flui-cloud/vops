/** Laptop-side reachability probes: verify the exact path LE's HTTP-01 validator will take
 * (public DNS → :80 → Traefik) BEFORE enabling ACME, turning most first-attempt failures into a caught
 * precondition instead of a burned rate-limit slot. DNS resolves against the zone's AUTHORITATIVE
 * nameservers (not the laptop's resolver, whose stale NXDOMAIN cache would false-negative). */
import * as http from 'node:http';
import * as https from 'node:https';
import * as dns from 'node:dns';

export interface HttpProbe {
  reachable: boolean;
  status?: number;
  error?: string;
}

export interface AuthResolve {
  resolved: boolean;
  addrs?: string[];
  reason?: string;
}

/** GET `http://<ip>/<path>` with a `Host: <fqdn>` header — connects to the address
 * vops holds in inventory, never resolving the name, so this reflects the server's
 * :80 rather than the laptop's DNS. Any HTTP response = :80 reachable and Traefik is
 * answering (a 404 for an unknown host is still a response). Refused/timeout = down. */
export function probeHttp(fqdn: string, ip: string, path = '/', timeoutMs = 5000): Promise<HttpProbe> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: ip, path, port: 80, timeout: timeoutMs, headers: { host: fqdn, 'user-agent': 'vops-ingress-probe' } },
      (res) => {
        res.resume();
        resolve({ reachable: true, status: res.statusCode });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, error: 'timeout' });
    });
    req.on('error', (e) => resolve({ reachable: false, error: e.message }));
  });
}

/** Resolve `fqdn`'s A record directly from its authoritative nameservers — exactly
 * what Let's Encrypt's validator resolves — bypassing every recursive resolver's
 * cache. `zoneHint` (the zone apex, known on the auto-DNS path) skips the NS walk. */
export async function resolvesAuthoritative(fqdn: string, ip: string, zoneHint?: string): Promise<AuthResolve> {
  try {
    const ns = await authoritativeNs(fqdn, zoneHint);
    if (!ns.length) return { resolved: false, reason: 'no authoritative nameserver found' };
    const nsIps = await nsAddresses(ns);
    if (!nsIps.length) return { resolved: false, reason: 'authoritative nameserver has no address' };
    const resolver = new dns.promises.Resolver();
    resolver.setServers(nsIps);
    const addrs = await resolver.resolve4(fqdn);
    return { resolved: addrs.includes(ip), addrs };
  } catch (e) {
    return { resolved: false, reason: (e as Error).message };
  }
}

/** HTTPS handshake to the host IP with SNI=fqdn, validating the presented chain
 * against the hostname — confirms a real (browser-trusted) cert was issued. */
export function probeHttps(fqdn: string, ip: string, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get(
      { host: ip, servername: fqdn, path: '/', port: 443, timeout: timeoutMs, rejectUnauthorized: true },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** Walk from `fqdn` up to the TLD, returning the NS set of the closest ancestor that
 * has one (the zone apex). `zoneHint` is tried first so the auto path never depends on
 * an NS lookup of the freshly-created name (which the recursive resolver may NXDOMAIN). */
async function authoritativeNs(fqdn: string, zoneHint?: string): Promise<string[]> {
  const bare = fqdn.replace(/\.$/, '');
  const labels = bare.split('.');
  const candidates = [
    ...(zoneHint ? [zoneHint.replace(/\.$/, '')] : []),
    ...labels.map((_, i) => labels.slice(i).join('.')).slice(0, -1),
  ];
  for (const name of new Set(candidates)) {
    try {
      const ns = await dns.promises.resolveNs(name);
      if (ns.length) return ns;
    } catch {
      // Not a zone apex (NXDOMAIN / no NS at this level) — walk up to the parent.
    }
  }
  return [];
}

/** Resolve every nameserver hostname to its A records (skipping any that don't resolve). */
async function nsAddresses(ns: string[]): Promise<string[]> {
  const lists = await Promise.all(
    ns.map(async (host) => {
      try {
        return await dns.promises.resolve4(host);
      } catch {
        return [];
      }
    }),
  );
  return [...new Set(lists.flat())];
}
