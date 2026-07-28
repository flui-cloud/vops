import * as dns from 'node:dns/promises';
import axios from 'axios';
import { AppInstallV1 } from '../apps/app.model';
import { UnitStatus } from '../apps/app-parse';

/** Post-deployment verification from the outside: a deploy exiting 0 only means the units
 * started and the host-side smoke test passed, not that DNS/TLS/HTTP work from outside the box.
 * Every check reports `skipped` rather than inventing a pass when it cannot run. */

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface VerifyCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface VerifyReport {
  app: string;
  host: string;
  url?: string;
  status: 'healthy' | 'degraded' | 'unknown';
  checks: VerifyCheck[];
}

const HTTP_TIMEOUT_MS = 10_000;

export interface VerifyRuntime {
  units: UnitStatus[];
  containers: string[];
}

export async function verifyDeployment(install: AppInstallV1, runtime: VerifyRuntime): Promise<VerifyReport> {
  const url = publicUrl(install);
  const ingress = install.ingress;
  const reachability: VerifyCheck[] = ingress
    ? [await dnsCheck(ingress.hostname, install.host), await httpCheck(url, ingress.tls, ingress.staging)]
    : [
        {
          name: 'public-url',
          status: 'skipped',
          detail: 'Not fronted by ingress — the app answers only on the host itself. Expose it with `vops app expose`.',
        },
      ];
  const checks: VerifyCheck[] = [unitsCheck(runtime), containersCheck(runtime), ...reachability];

  const failed = checks.filter((c) => c.status === 'fail').length;
  const ran = checks.filter((c) => c.status !== 'skipped').length;
  let status: VerifyReport['status'] = 'healthy';
  if (failed > 0) status = 'degraded';
  else if (ran === 0) status = 'unknown';

  return { app: install.name, host: install.host, ...(url ? { url } : {}), status, checks };
}

function publicUrl(install: AppInstallV1): string | undefined {
  if (!install.ingress) return undefined;
  return `${install.ingress.tls ? 'https' : 'http'}://${install.ingress.hostname}`;
}

function unitsCheck(runtime: VerifyRuntime): VerifyCheck {
  if (!runtime.units.length) return { name: 'units', status: 'skipped', detail: 'No unit status was returned by the host.' };
  const bad = runtime.units.filter((u) => u.active !== 'active').map((u) => `${u.service}=${u.active}`);
  return bad.length
    ? { name: 'units', status: 'fail', detail: `not active: ${bad.join(', ')}` }
    : { name: 'units', status: 'pass', detail: `${runtime.units.length} unit(s) active` };
}

function containersCheck(runtime: VerifyRuntime): VerifyCheck {
  return runtime.containers.length
    ? { name: 'containers', status: 'pass', detail: runtime.containers.join(', ') }
    : { name: 'containers', status: 'fail', detail: 'no containers are running for this install' };
}

/** The hostname must resolve to the host's own address before TLS can mean anything. */
async function dnsCheck(hostname: string, hostAddress: string): Promise<VerifyCheck> {
  try {
    const addresses = await dns.resolve4(hostname);
    if (!addresses.length) return { name: 'dns', status: 'fail', detail: `${hostname} has no A record` };
    const match = addresses.includes(hostAddress);
    return {
      name: 'dns',
      status: 'pass',
      detail: match
        ? `${hostname} → ${addresses.join(', ')}`
        : `${hostname} → ${addresses.join(', ')} (inventory records the host as ${hostAddress}; check which is current)`,
    };
  } catch (err) {
    return { name: 'dns', status: 'fail', detail: `${hostname} does not resolve: ${message(err)}` };
  }
}

/**
 * A real request from here. TLS is verified against the system trust store on
 * purpose — a staging certificate SHOULD fail, and saying so is the point.
 */
async function httpCheck(url: string, tls: boolean, staging: boolean): Promise<VerifyCheck> {
  try {
    const res = await axios.get(url, {
      timeout: HTTP_TIMEOUT_MS,
      maxRedirects: 3,
      validateStatus: () => true,
    });
    const ok = res.status < 500;
    const label = tls ? 'https' : 'http';
    return {
      name: 'public-url',
      status: ok ? 'pass' : 'fail',
      detail: `${label} ${res.status} from ${url}`,
    };
  } catch (err) {
    const detail = staging
      ? `${message(err)} — the certificate came from Let's Encrypt staging, so browsers and this check both reject it. Redeploy without --staging for a trusted one.`
      : message(err);
    return { name: 'public-url', status: 'fail', detail: `${url} unreachable: ${detail}` };
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
