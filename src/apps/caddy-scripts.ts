/** Pure shell-script builders for the Caddy ingress backend (mirrors ingress-scripts/Traefik).
 * Caddy has no directory-watch, so route writes validate-then-reload instead. */
import { shq } from './app-scripts';
import { INGRESS_CONTAINER, INGRESS_PROXY_MARKER, INGRESS_SERVICE, INGRESS_UNIT_DIR } from './ingress-render';
import { heredoc } from './ingress-scripts';
import {
  CADDY_ADMIN_PORT,
  CADDY_CONFIG_FILE,
  CADDY_DATA_DIR,
  CADDY_DYNAMIC_DIR,
  caddyRouteFile,
} from './caddy-render';

export interface CaddyInstallInput {
  staticConfig: string;
  unit: string;
  image: string;
  /** Optional test-CA bundle (Pebble) written next to the config, trusted via acme_ca_root. */
  caBundle?: { path: string; content: string };
}

/** Write Caddyfile + unit + persistent data dir, record the marker, pull, restart,
 * then gate on the admin API (`/config/` → 200). */
export function buildCaddyInstallScript(i: CaddyInstallInput): string {
  const unitFile = `${INGRESS_UNIT_DIR}/${INGRESS_CONTAINER}.container`;
  return [
    'set -e',
    `mkdir -p ${shq(CADDY_DYNAMIC_DIR)} ${shq(CADDY_DATA_DIR)} ${shq(INGRESS_UNIT_DIR)}`,
    heredoc(CADDY_CONFIG_FILE, i.staticConfig),
    heredoc(unitFile, i.unit),
    ...(i.caBundle ? [heredoc(i.caBundle.path, i.caBundle.content)] : []),
    `echo caddy > ${shq(INGRESS_PROXY_MARKER)}`,
    "echo '@@pull'",
    `podman pull ${shq(i.image)} >/dev/null 2>&1 && echo ok || echo failed`,
    'systemctl daemon-reload',
    'set +e',
    `systemctl reset-failed ${shq(INGRESS_SERVICE)} 2>/dev/null`,
    `systemctl restart ${shq(INGRESS_SERVICE)} >/dev/null 2>&1`,
    "echo '@@active'",
    `systemctl is-active ${shq(INGRESS_SERVICE)} 2>/dev/null || echo inactive`,
    "echo '@@health'",
    'for i in $(seq 1 20); do',
    `  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${CADDY_ADMIN_PORT}/config/ 2>/dev/null)`,
    '  if [ "$code" = 200 ]; then echo ok; break; fi',
    '  sleep 2',
    'done',
    '[ "$code" = 200 ] || echo fail',
    "echo '@@diag'",
    `if [ "$(systemctl is-active ${shq(INGRESS_SERVICE)} 2>/dev/null)" != active ]; then journalctl -u ${shq(INGRESS_SERVICE)} -n 20 --no-pager 2>&1 | tail -20; fi`,
    "echo '@@done'",
  ].join('\n');
}

/** Write one app's fragment, then validate the whole config and hot-reload (Caddy has
 * no dir-watch). On a validation failure the fragment is removed so it can't wedge the
 * next reload — the app is simply left unrouted. */
export function buildCaddyRouteWriteScript(app: string, content: string): string {
  const f = caddyRouteFile(app);
  return [
    'set -e',
    `mkdir -p ${shq(CADDY_DYNAMIC_DIR)}`,
    heredoc(f, content),
    `if podman exec ${shq(INGRESS_CONTAINER)} caddy validate --config ${shq(CADDY_CONFIG_FILE)} --adapter caddyfile >/dev/null 2>&1; then`,
    `  podman exec ${shq(INGRESS_CONTAINER)} caddy reload --config ${shq(CADDY_CONFIG_FILE)} --adapter caddyfile >/dev/null 2>&1`,
    "  echo '@@wrote'",
    'else',
    `  rm -f ${shq(f)}`,
    "  echo '@@invalid'",
    'fi',
    shq(f),
  ].join('\n');
}

/** Remove one app's fragment and reload. */
export function buildCaddyRouteRemoveScript(app: string): string {
  return [
    'set +e',
    `rm -f ${shq(caddyRouteFile(app))}`,
    `podman exec ${shq(INGRESS_CONTAINER)} caddy reload --config ${shq(CADDY_CONFIG_FILE)} --adapter caddyfile >/dev/null 2>&1`,
    "echo '@@removed'",
  ].join('\n');
}

/** Status: service state, container, admin health (200), and the live fragments. */
export function buildCaddyStatusScript(): string {
  return [
    'set +e',
    "echo '@@active'",
    `systemctl is-active ${shq(INGRESS_SERVICE)} 2>/dev/null || echo inactive`,
    "echo '@@container'",
    `podman ps -a --filter name=${shq(INGRESS_CONTAINER)} --format '{{.Names}}|{{.Status}}|{{.Image}}' 2>/dev/null`,
    "echo '@@health'",
    String.raw`curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:${CADDY_ADMIN_PORT}/config/ 2>/dev/null || echo 000`,
    "echo '@@routes'",
    String.raw`ls -1 ${shq(CADDY_DYNAMIC_DIR)} 2>/dev/null | sed 's/\.caddy$//'`,
    "echo '@@done'",
  ].join('\n');
}

/** ACME ground truth for one hostname: is a cert stored on disk, and did Caddy log a
 * hard failure (rate-limit/CAA/validation)? */
export function buildCaddyCertProbeScript(hostname: string): string {
  const crt = `${hostname}.crt`;
  const certDir = `${CADDY_DATA_DIR}/caddy/certificates`;
  return [
    'set +e',
    "echo '@@acme'",
    `find ${shq(certDir)} -name ${shq(crt)} 2>/dev/null | head -1`,
    "echo '@@log'",
    `podman logs --tail 150 ${shq(INGRESS_CONTAINER)} 2>&1 | grep -iE 'certificate|acme|rate limit|unable to obtain|obtaining|urn:ietf:params:acme' | tail -25`,
    "echo '@@done'",
  ].join('\n');
}
