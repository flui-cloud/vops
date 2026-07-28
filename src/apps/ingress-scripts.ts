/** Pure shell-script builders for the vops ingress, run over `ssh + sudo -n bash -s`. The install
 * script is idempotent — it never clobbers existing acme.json certificates — and gates on Traefik's loopback `ping`. */
import { shq } from './app-scripts';
import {
  INGRESS_ACME_FILE,
  INGRESS_ACME_STAGING_FILE,
  INGRESS_CONF_DIR,
  INGRESS_CONTAINER,
  INGRESS_DYNAMIC_DIR,
  INGRESS_PING_PORT,
  INGRESS_PROXY_MARKER,
  INGRESS_SERVICE,
  INGRESS_STATIC_FILE,
  INGRESS_UNIT_DIR,
  ingressRouteFile,
} from './ingress-render';

/** Create the ingress basic-auth password as a Podman secret (idempotent, never replaced/mounted).
 * `printf` is a bash builtin so the plaintext never lands in a process argv or command line. */
export function buildIngressAuthSecretScript(name: string, plaintext: string): string {
  return [
    'set +e',
    `if ! podman secret inspect ${shq(name)} >/dev/null 2>&1; then`,
    `  printf %s ${shq(plaintext)} | podman secret create ${shq(name)} - >/dev/null 2>&1`,
    'fi',
    "echo '@@auth'",
    `podman secret inspect ${shq(name)} >/dev/null 2>&1 && echo ok || echo fail`,
  ].join('\n');
}

/** ACME ground truth for one hostname: is a cert stored, and did lego log a hard
 * failure (rate-limit/CAA/validation)? Traefik keeps retrying silently, so this is
 * what lets vops distinguish "still issuing" from "will never issue". */
export function buildCertProbeScript(hostname: string): string {
  const needle = `"main":"${hostname}"`;
  return [
    'set +e',
    "echo '@@acme'",
    `grep -oF ${shq(needle)} ${shq(INGRESS_ACME_FILE)} ${shq(INGRESS_ACME_STAGING_FILE)} 2>/dev/null | head -1`,
    "echo '@@log'",
    `podman logs --tail 150 ${shq(INGRESS_CONTAINER)} 2>&1 | grep -iE 'acme|certificate|rate limit|unable to obtain|caa|urn:ietf:params:acme' | tail -25`,
    "echo '@@done'",
  ].join('\n');
}

/** Read-only precheck: is ingress already ours, who holds :80/:443, podman/arch. */
export function buildIngressPrecheckScript(): string {
  const unitFile = `${INGRESS_UNIT_DIR}/${INGRESS_CONTAINER}.container`;
  return [
    'set +e',
    "echo '@@active'",
    `systemctl is-active ${shq(INGRESS_SERVICE)} 2>/dev/null || echo inactive`,
    "echo '@@unit'",
    `test -e ${shq(unitFile)} && echo present || echo absent`,
    "echo '@@listen'",
    String.raw`ss -ltnpH 2>/dev/null | awk '{print $4"\t"$6}' || netstat -ltnp 2>/dev/null | awk 'NR>2{print $4"\t"$7}'`,
    "echo '@@podman'",
    'command -v podman >/dev/null 2>&1 && podman --version 2>/dev/null || echo MISSING',
    "echo '@@arch'",
    'uname -m',
    "echo '@@selinux'",
    'if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then echo yes; else echo no; fi',
    "echo '@@done'",
  ].join('\n');
}

export interface IngressInstallInput {
  staticConfig: string;
  unit: string;
  image: string;
  /** Optional test-CA bundle (Pebble) → written next to the config, referenced by env. */
  caBundle?: { path: string; content: string };
}

/** Write config + unit, pre-create acme files, pull image, restart, health-gate. */
export function buildIngressInstallScript(i: IngressInstallInput): string {
  return [
    'set -e',
    `mkdir -p ${shq(INGRESS_DYNAMIC_DIR)} ${shq(INGRESS_UNIT_DIR)}`,
    heredoc(INGRESS_STATIC_FILE, i.staticConfig),
    heredoc(`${INGRESS_UNIT_DIR}/${INGRESS_CONTAINER}.container`, i.unit),
    ...(i.caBundle ? [heredoc(i.caBundle.path, i.caBundle.content)] : []),
    // Pre-create acme storage 0600 — Traefik refuses a group/world-readable file.
    // Never truncate an existing one (it holds issued certs → LE duplicate limit).
    ...[INGRESS_ACME_FILE, INGRESS_ACME_STAGING_FILE].flatMap((f) => [
      `test -e ${shq(f)} || install -m 600 /dev/null ${shq(f)}`,
      `chmod 600 ${shq(f)}`,
    ]),
    `echo traefik > ${shq(INGRESS_PROXY_MARKER)}`,
    // Pull explicitly so the first systemd start isn't racing a slow registry pull
    // under TimeoutStartSec.
    "echo '@@pull'",
    `podman pull ${shq(i.image)} >/dev/null 2>&1 && echo ok || echo failed`,
    'systemctl daemon-reload',
    'set +e',
    `systemctl reset-failed ${shq(INGRESS_SERVICE)} 2>/dev/null`,
    `systemctl restart ${shq(INGRESS_SERVICE)} >/dev/null 2>&1`,
    "echo '@@active'",
    `systemctl is-active ${shq(INGRESS_SERVICE)} 2>/dev/null || echo inactive`,
    "echo '@@health'",
    // Loopback ping entrypoint — retry while Traefik boots + pulls plugins.
    `for i in $(seq 1 20); do`,
    `  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:${INGRESS_PING_PORT}/ping 2>/dev/null)`,
    '  if [ "$code" = 200 ]; then echo ok; break; fi',
    '  sleep 2',
    'done',
    '[ "$code" = 200 ] || echo fail',
    "echo '@@diag'",
    `if [ "$(systemctl is-active ${shq(INGRESS_SERVICE)} 2>/dev/null)" != active ]; then journalctl -u ${shq(INGRESS_SERVICE)} -n 20 --no-pager 2>&1 | tail -20; fi`,
    "echo '@@done'",
  ].join('\n');
}

/** Atomically write one app's dynamic route file (Traefik hot-reloads it). */
export function buildRouteWriteScript(app: string, content: string): string {
  const f = ingressRouteFile(app);
  return [
    'set -e',
    `mkdir -p ${shq(INGRESS_DYNAMIC_DIR)}`,
    heredoc(f, content),
    "echo '@@wrote'",
    shq(f),
  ].join('\n');
}

/** Remove one app's route file (detach). Traefik drops the router on reload. */
export function buildRouteRemoveScript(app: string): string {
  return [
    'set +e',
    `rm -f ${shq(ingressRouteFile(app))}`,
    "echo '@@removed'",
  ].join('\n');
}

/** Status: ingress service state, container, ping, and the live route files. */
export function buildIngressStatusScript(): string {
  return [
    'set +e',
    "echo '@@active'",
    `systemctl is-active ${shq(INGRESS_SERVICE)} 2>/dev/null || echo inactive`,
    "echo '@@container'",
    `podman ps -a --filter name=${shq(INGRESS_CONTAINER)} --format '{{.Names}}|{{.Status}}|{{.Image}}' 2>/dev/null`,
    "echo '@@health'",
    // Trailing \n is load-bearing: curl -w prints the code with no newline, so
    // without it the next `@@routes` marker glues onto the code and never parses.
    String.raw`curl -s -o /dev/null -w '%{http_code}\n' --max-time 3 http://127.0.0.1:${INGRESS_PING_PORT}/ping 2>/dev/null || echo 000`,
    "echo '@@routes'",
    String.raw`ls -1 ${shq(INGRESS_DYNAMIC_DIR)} 2>/dev/null | sed 's/\.yml$//'`,
    "echo '@@done'",
  ].join('\n');
}

/** Tear down the ingress. Keeps issued certs unless `purge` (they are rate-limited). */
export function buildIngressDownScript(purge: boolean): string {
  return [
    'set +e',
    `systemctl stop ${shq(INGRESS_SERVICE)} >/dev/null 2>&1`,
    `systemctl reset-failed ${shq(INGRESS_SERVICE)} 2>/dev/null`,
    `rm -rf ${shq(INGRESS_UNIT_DIR)}`,
    'systemctl daemon-reload',
    `podman rm -f ${shq(INGRESS_CONTAINER)} >/dev/null 2>&1`,
    ...(purge ? [`rm -rf ${shq(INGRESS_CONF_DIR)}`] : []),
    "echo '@@down'",
    purge ? 'echo purged' : 'echo kept-certs',
  ].join('\n');
}

/** Read the proxy-backend marker (`traefik`/`caddy`), or empty when the host has no ingress yet. */
export function buildProxyReadScript(): string {
  return ['set +e', "echo '@@proxy'", `cat ${shq(INGRESS_PROXY_MARKER)} 2>/dev/null`, "echo '@@done'"].join('\n');
}

/** Single-quote heredoc: writes arbitrary content verbatim, no shell interpolation. */
export function heredoc(path: string, content: string): string {
  const tag = `VOPS_ING_EOF_${hashTag(path)}`;
  return `cat > ${shq(path)} <<'${tag}'\n${content}\n${tag}`;
}

/** Stable per-path tag suffix so multiple heredocs in one script never collide. */
function hashTag(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + (s.codePointAt(i) ?? 0)) & 0xffff;
  return h.toString(16);
}
