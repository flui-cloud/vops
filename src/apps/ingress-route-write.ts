/** Outcome of a route-write script run: the one place that decides whether the proxy
 * actually took the route. A write whose result is unknown counts as a failure — the
 * fragment is on disk either way, so "no marker" means the reload may never have run. */
import { splitSections } from '../host-ops/status-battery';

export type RouteWriteKind = 'wrote' | 'rejected' | 'reload-failed' | 'unknown';

export interface RouteWriteOutcome {
  ok: boolean;
  kind: RouteWriteKind;
  /** What the proxy said on a failing marker (empty when it said nothing). */
  detail: string;
}

export function parseRouteWrite(stdout: string): RouteWriteOutcome {
  const s = splitSections(stdout);
  if (s.wrote !== undefined) return { ok: true, kind: 'wrote', detail: '' };
  if (s.invalid !== undefined) return { ok: false, kind: 'rejected', detail: s.invalid };
  if (s.failed !== undefined) return { ok: false, kind: 'reload-failed', detail: s.failed };
  return { ok: false, kind: 'unknown', detail: '' };
}

export function routeWriteMessage(
  app: string,
  proxy: string,
  failure: { kind: RouteWriteKind; detail: string },
  stderr = '',
): string {
  const rerun = `Rerun \`vops app expose ${app} --yes\` once the cause is fixed.`;
  const raw = (failure.detail || stderr).trim();
  const why = raw ? ` ${proxy} said: ${raw.split('\n').slice(-5).join(' / ')}.` : '';
  if (failure.kind === 'rejected') {
    return `${proxy} refused the ingress config for '${app}': the route fragment was removed, so '${app}' is NOT publicly routed.${why} ${rerun}`;
  }
  if (failure.kind === 'reload-failed') {
    return `${proxy} validated the ingress config for '${app}' but the reload failed, so '${app}' may not be publicly routed.${why} ${rerun}`;
  }
  return `The ingress route write for '${app}' reported no result — it timed out or the connection died, so the ${proxy} reload may never have run and '${app}' may not be publicly routed.${why} ${rerun}`;
}
