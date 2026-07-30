/** Pure shell-script builders for `vops app`, run over `ssh + sudo -n bash -s` (rootful);
 * every file/command here is exactly what `--dry-run` prints and `remove` tears down. */
import { SYSTEM_UNIT_DIR, healthServiceUnit, healthTimerUnit } from './health-timer';
import { START_TIMEOUT_SEC } from './quadlet-render';

export const APPS_UNIT_ROOT = '/etc/containers/systemd/vops';

export function appUnitDir(app: string): string {
  return `${APPS_UNIT_ROOT}/${app}`;
}

/** Read-only host probe: podman/quadlet presence, k3s coexistence, ports, selinux. */
export function buildPreflightScript(): string {
  return [
    'set +e',
    "echo '@@podman'",
    'command -v podman >/dev/null 2>&1 && podman --version 2>/dev/null || echo MISSING',
    "echo '@@quadlet'",
    // Prefer the podman-static generator in /usr/local (a bootstrapped host) over a
    // distro one in /usr/lib, so a `.pod` isn't dry-run by an older distro podman.
    'for g in /usr/local/lib/systemd/system-generators/podman-system-generator /usr/lib/systemd/system-generators/podman-system-generator /usr/local/libexec/podman/quadlet /usr/libexec/podman/quadlet; do test -x "$g" && { echo "$g"; break; }; done; true',
    "echo '@@k3s'",
    'systemctl is-active k3s 2>/dev/null || systemctl is-active k3s-server 2>/dev/null || echo inactive',
    "echo '@@selinux'",
    'if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then echo yes; else echo no; fi',
    "echo '@@arch'",
    'uname -m',
    "echo '@@ports'",
    "ss -ltnH 2>/dev/null | awk '{print $4}' || netstat -ltn 2>/dev/null | awk 'NR>2{print $4}'",
    "echo '@@diskkb'",
    "df -Pk /var 2>/dev/null | awk 'NR==2{print $4}'",
    "echo '@@networks'",
    "podman network ls --format '{{.Name}}' 2>/dev/null",
    "echo '@@done'",
  ].join('\n');
}

export interface SecretMaterial {
  name: string;
  generate?: { length: number; format: 'base64url' | 'hex' };
  value?: string;
}

export interface DeployScriptInput {
  unitDir: string;
  units: Record<string, string>;
  /** Health timer/service pairs for `SYSTEM_UNIT_DIR` — see `renderHealthUnits`. */
  healthUnits?: Record<string, string>;
  secrets: SecretMaterial[];
  /** Container service names in dependency order (start order). */
  services: string[];
  /** Network/volume services started BEFORE the containers (quadlet's implicit
   * dependency is unreliable on older podman, so vops orders them explicitly). */
  prereqServices: string[];
  quadletGenerator: string;
  /** Pull credentials for a private image registry (a private GHCR package). */
  registry?: RegistryLogin;
}

/** Credentials podman uses to PULL the image (written to root's auth.json via `podman login`) —
 * scope the token to read-only package access, since a host compromise hands it over. */
export interface RegistryLogin {
  /** Registry host, e.g. `ghcr.io`. */
  host: string;
  user: string;
  token: string;
}

/** Quadlet service names started before the containers: volumes, then the pod. */
export function prereqServiceNames(pod: string | undefined, volumes: string[]): string[] {
  return [
    ...volumes.map((v) => `${v}-volume.service`),
    ...(pod ? [`${pod}-pod.service`] : []),
  ];
}

/** Write units + ensure secrets + quadlet dry-run gate + daemon-reload + start. */
export function buildDeployScript(input: DeployScriptInput): string {
  const files = Object.entries(input.units).map(([name, content], i) =>
    heredoc(`${input.unitDir}/${name}`, content, i),
  );
  const health = Object.entries(input.healthUnits ?? {});
  const healthFiles = health.map(([name, content], i) =>
    heredoc(`${SYSTEM_UNIT_DIR}/${name}`, content, files.length + i),
  );
  const timers = health.map(([name]) => name).filter((n) => n.endsWith('.timer'));
  const gen = shq(input.quadletGenerator);
  const dir = shq(input.unitDir);
  return [
    'set -e',
    `mkdir -p ${dir}`,
    ...files,
    ...healthFiles,
    ...registryLogin(input.registry),
    'set +e',
    ...input.secrets.map(ensureSecret),
    'set -e',
    `DRY=$(QUADLET_UNIT_DIRS=${dir} ${gen} --dryrun 2>&1) || { echo '@@error'; echo "quadlet dry-run failed"; echo "$DRY"; exit 3; }`,
    ...input.services.map(
      (s) => `echo "$DRY" | grep -q ${shq(s)} || { echo '@@error'; echo "quadlet skipped ${s} (bad unit)"; echo "$DRY"; exit 4; }`,
    ),
    'systemctl daemon-reload',
    'set +e',
    // `restart` (not `start`): a oneshot network/volume unit left `active (exited)`
    // from a prior run would make `start` a no-op, so the network is never created.
    // `podman network/volume create` is idempotent (--ignore), so re-running is safe.
    ...input.prereqServices.map((p) => `systemctl reset-failed ${shq(p)} 2>/dev/null; systemctl restart ${shq(p)} >/dev/null 2>&1`),
    "echo '@@started'",
    // `restart` (not `start`) here too, and this is the one that bites: `start` on an
    // already-active unit is a no-op, so a redeploy would keep the OLD container — old
    // image, old published ports — while `is-active` still reported success.
    // `reset-failed` first clears the start-limit block Restart=always can trip.
    ...input.services.map(
      (s) =>
        `systemctl reset-failed ${shq(s)} 2>/dev/null; systemctl restart ${shq(s)} >/dev/null 2>&1; ` +
        `echo "${s}=$(systemctl is-active ${shq(s)} 2>/dev/null)"`,
    ),
    // podman-static schedules no health timer of its own, so vops's own pair is enabled here —
    // after the container unit exists, or `enable` has nothing to hang the .wants symlink on.
    ...timers.map((t) => `systemctl enable ${shq(t)} >/dev/null 2>&1; systemctl restart ${shq(t)} >/dev/null 2>&1`),
    "echo '@@diag'",
    ...[...input.prereqServices, ...input.services].map((s) => diagLine(s)),
    "echo '@@ok'",
  ].join('\n');
}

/** Wall-clock ceiling for the whole pull phase, so a stalled registry cannot hang a deploy
 * indefinitely: `PULL_SECONDS_PER_IMAGE` each, capped — the script always returns inside it. */
export const PULL_SECONDS_PER_IMAGE = 600;
export const PULL_SECONDS_MAX = 2400;

export function pullBudgetSeconds(imageCount: number): number {
  return Math.min(PULL_SECONDS_MAX, PULL_SECONDS_PER_IMAGE * Math.max(1, imageCount));
}

export interface PullScriptInput {
  images: string[];
  registry?: RegistryLogin;
}

/** Pull every image BEFORE any unit starts. A Quadlet unit's `ExecStart` is `podman run`, which
 * pulls on the spot — and that download is charged to `TimeoutStartSec`. On the first install of
 * an image-heavy app systemd SIGTERMs the pull the moment the budget expires, `Restart=always`
 * starts it again from zero, and the unit can never come up: a deploy that loops until the SSH
 * call gives up, with "services not active" as its only explanation. Pulling here takes the
 * download out of the start budget entirely and names the image when the download is what failed.
 * `image exists` first keeps the existing `--pull=missing` semantics (no surprise upgrades) and
 * lets a locally-built image deploy without a registry to pull it from. */
export function buildPullScript(input: PullScriptInput): string {
  const images = [...new Set(input.images)];
  return [
    'set +e',
    ...registryLogin(input.registry),
    `deadline=$(( $(date +%s) + ${pullBudgetSeconds(images.length)} ))`,
    'TMO=; command -v timeout >/dev/null 2>&1 && TMO=1',
    'vops_pull() {',
    '  if podman image exists "$1"; then echo "local $1"; return; fi',
    '  left=$(( deadline - $(date +%s) ))',
    '  [ "$left" -lt 5 ] && left=5',
    '  if [ -n "$TMO" ]; then timeout "$left" podman pull -q "$1" >/dev/null 2>&1;',
    '  else podman pull -q "$1" >/dev/null 2>&1; fi',
    '  if [ $? -eq 0 ]; then echo "pulled $1"; else echo "failed $1"; fi',
    '}',
    "echo '@@pull'",
    ...images.map((img) => `vops_pull ${shq(img)}`),
    "echo '@@done'",
  ].join('\n');
}

/** Diagnostics for a unit that did not come up. `Result=timeout` is called out by name: it is the
 * one failure whose journal says nothing useful ("start operation timed out") and whose cause —
 * the unit never signalled readiness inside its budget — is otherwise invisible. */
function diagLine(s: string): string {
  const q = shq(s);
  return (
    `if [ "$(systemctl is-active ${q} 2>/dev/null)" != active ]; then ` +
    `R=$(systemctl show -p Result --value ${q} 2>/dev/null); echo "### ${s} (result=\${R:-unknown})"; ` +
    `[ "$R" = timeout ] && echo "${s} never signalled readiness within TimeoutStartSec=${START_TIMEOUT_SEC}s"; ` +
    `journalctl -u ${q} -n 12 --no-pager 2>&1 | tail -12; fi`
  );
}

/** `podman login` via stdin — the token never reaches the process list or a file
 * vops writes. Failure aborts the deploy: a pull that would 401 later is worse
 * than stopping here with the registry named. */
function registryLogin(r?: RegistryLogin): string[] {
  if (!r) return [];
  return [
    `printf %s ${shq(r.token)} | podman login ${shq(r.host)} -u ${shq(r.user)} --password-stdin >/dev/null 2>&1 || ` +
      `{ echo '@@error'; echo "podman login ${r.host} failed (check the token scope: it needs read access to packages)"; exit 5; }`,
  ];
}

function ensureSecret(s: SecretMaterial): string {
  const name = shq(s.name);
  const charClass = s.generate?.format === 'hex' ? 'a-f0-9' : 'a-zA-Z0-9';
  const create = s.generate
    ? `LC_ALL=C tr -dc '${charClass}' </dev/urandom | head -c ${s.generate.length} | podman secret create ${name} - >/dev/null 2>&1`
    : `printf %s ${shq(s.value ?? '')} | podman secret create ${name} - >/dev/null 2>&1`;
  // Reuse an existing secret (never --replace): a regenerated value would no longer
  // match what was baked into the volume at first init.
  return `podman secret inspect ${name} >/dev/null 2>&1 || { ${create}; }`;
}

export interface RemoveScriptInput {
  unitDir: string;
  services: string[];
  /** Volume/pod services — stopped so they don't linger `active (exited)`. */
  prereqServices: string[];
  containers: string[];
  pod?: string;
  secrets: string[];
  volumes: string[];
  purge: boolean;
}

/** Caps the graceful stop then SIGKILLs the cgroup, so a SIGTERM-ignoring container can't hold
 * remove hostage for `TimeoutStopSec` (~90s); `systemctl stop` first so Restart=always won't revive it. */
function boundedStop(s: string): string {
  const q = shq(s);
  return (
    `if command -v timeout >/dev/null 2>&1; then timeout 12 systemctl stop ${q}; else systemctl stop ${q}; fi >/dev/null 2>&1; ` +
    `systemctl kill -s SIGKILL ${q} >/dev/null 2>&1; systemctl reset-failed ${q} 2>/dev/null`
  );
}

function healthTeardown(container: string): string[] {
  const timer = healthTimerUnit(container);
  const paths = [timer, healthServiceUnit(container)].map((u) => shq(SYSTEM_UNIT_DIR + '/' + u));
  return [`systemctl disable --now ${shq(timer)} >/dev/null 2>&1`, `rm -f ${paths.join(' ')}`];
}

export function buildRemoveScript(i: RemoveScriptInput): string {
  const stopAll = [...[...i.services].reverse(), ...i.prereqServices];
  const lines = [
    'set +e',
    ...stopAll.map((s) => boundedStop(s)),
    // Attempted for every container, health probe or not: `disable` is a no-op on a unit that
    // was never written, and leaving a timer behind would keep probing a container that is gone.
    ...i.containers.flatMap((c) => healthTeardown(c)),
    `rm -rf ${shq(i.unitDir)}`,
    'systemctl daemon-reload',
    ...(i.pod ? [`podman pod rm -f ${shq(i.pod)} >/dev/null 2>&1`] : []),
    ...i.containers.map((c) => `podman rm -f ${shq(c)} >/dev/null 2>&1`),
    ...(i.purge ? i.secrets.map((s) => `podman secret rm ${shq(s)} >/dev/null 2>&1`) : []),
    ...(i.purge ? i.volumes.map((v) => `podman volume rm ${shq(v)} >/dev/null 2>&1`) : []),
    "echo '@@removed'",
    i.purge ? 'echo purged' : 'echo kept-data',
  ];
  return lines.join('\n');
}

function statusTrailerLines(app: string, services: string[]): string[] {
  return [
    "echo '@@units'",
    ...services.map(
      (s) => `echo "${s}|$(systemctl is-active ${shq(s)} 2>/dev/null)|$(systemctl show -p SubState --value ${shq(s)} 2>/dev/null)"`,
    ),
    "echo '@@containers'",
    `podman ps -a --filter name=vops-${app}- --format '{{.Names}}|{{.Status}}|{{.Image}}' 2>/dev/null`,
  ];
}

export function buildStatusScript(app: string, services: string[]): string {
  return ['set +e', ...statusTrailerLines(app, services)].join('\n');
}

/** Restart the app's own component units, then report back in the same
 * `@@units`/`@@containers` shape `buildStatusScript` does — a restart's result
 * IS a status check, so the caller parses both with `parseStatusOutput`. */
export function buildRestartScript(app: string, services: string[]): string {
  return [
    'set +e',
    ...services.map((s) => `systemctl restart ${shq(s)} >/dev/null 2>&1`),
    'sleep 1',
    ...statusTrailerLines(app, services),
  ].join('\n');
}

export function buildSmokeHttpScript(port: number, path: string, expect: number, budgetSeconds: number, sleepS = 5): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return [
    'set +e',
    "echo '@@http'",
    ...deadlineLoopHead(budgetSeconds),
    `  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}${p} 2>/dev/null)`,
    // Healthy = the manifest's expected status OR any 2xx/3xx (a fresh app that
    // redirects to its installer is up); 000/4xx/5xx keep retrying then report.
    `  case "$code" in ${expect}|2??|3??) echo "$code"; exit 0;; esac`,
    ...deadlineLoopTail(sleepS),
    'echo "${code:-000}"',
  ].join('\n');
}

export function buildSmokeTcpScript(port: number, budgetSeconds: number, sleepS = 5): string {
  return [
    'set +e',
    "echo '@@tcp'",
    ...deadlineLoopHead(budgetSeconds),
    `  if timeout 3 bash -c "echo > /dev/tcp/127.0.0.1/${port}" 2>/dev/null; then echo open; exit 0; fi`,
    ...deadlineLoopTail(sleepS),
    'echo closed',
  ].join('\n');
}

/** The first-start budget is WALL CLOCK, not an attempt count: `curl` returns instantly on
 * connection-refused but takes seconds once the app is listening, so N attempts bought an
 * unknown amount of time — and it is time (`smokeTest.timeoutSeconds`) that a manifest declares. */
function deadlineLoopHead(budgetSeconds: number): string[] {
  return [`deadline=$(( $(date +%s) + ${Math.max(1, Math.round(budgetSeconds))} ))`, 'while :; do'];
}

function deadlineLoopTail(sleepS: number): string[] {
  return [`  [ "$(date +%s)" -ge "$deadline" ] && break`, `  sleep ${sleepS}`, 'done'];
}

// `podman logs` (not journalctl): driver-agnostic, so it works with the systemd-less
// podman-static build where the journald log driver is unavailable.
export function buildLogsScript(container: string, lines: number): string {
  return `podman logs --tail ${Math.max(1, Math.min(2000, lines))} ${shq(container)} 2>&1 || true`;
}

/** Failure diagnostics: container states + the primary component's recent logs. */
export function buildDiagScript(app: string, primaryContainer: string): string {
  return [
    'set +e',
    "echo '@@ps'",
    `podman ps -a --filter name=vops-${app}- --format '{{.Names}} | {{.Status}} | {{.Ports}}' 2>&1`,
    "echo '@@log'",
    `podman logs --tail 25 ${shq(primaryContainer)} 2>&1 | tail -25`,
  ].join('\n');
}

/** Single-quote for POSIX sh, safe for arbitrary content. */
const SQ_ESCAPE = String.raw`'\''`;
export function shq(v: string): string {
  return `'${String(v).replaceAll("'", SQ_ESCAPE)}'`;
}

function heredoc(path: string, content: string, i: number): string {
  const tag = `VOPS_UNIT_EOF_${i}`;
  return `cat > ${shq(path)} <<'${tag}'\n${content}\n${tag}`;
}
