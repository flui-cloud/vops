import { AppHealthPlan } from './app.model';

/** Not the Quadlet dir: its generator only reads `.container`/`.pod`/`.volume`/`.network`, and
 * systemd does not search that dir at all — a timer left there would simply never exist. */
export const SYSTEM_UNIT_DIR = '/etc/systemd/system';

const DEFAULT_INTERVAL = '30s';
const DURATION = /^\d+(ms|s|m|h)$/;

export function healthTimerUnit(container: string): string {
  return `${container}-health.timer`;
}

export function healthServiceUnit(container: string): string {
  return `${container}-health.service`;
}

/** podman drives a container's `HealthCmd` from a transient systemd timer it creates itself —
 * but only when the binary was compiled with the `systemd` build tag. The `podman-static` build
 * vops installs is not (`libpod/healthcheck_nosystemd_linux.go` stubs `createTimer`/`startTimer`
 * to no-ops, the same tag that makes its journald log driver unavailable), so the probe is
 * rendered, accepted, and never run: every container stays `starting` forever. These two units
 * are that missing timer, written persistently — the same `podman healthcheck run <ctr>` podman
 * would have scheduled, bound to the container's own unit so it starts and stops with it. */
export function renderHealthUnits(container: string, health?: AppHealthPlan): Record<string, string> {
  const interval = duration(health?.interval) ?? DEFAULT_INTERVAL;
  const first = duration(health?.initialDelay) ?? interval;
  const service = [
    '[Unit]',
    `Description=vops health probe ${container}`,
    '',
    '[Service]',
    'Type=oneshot',
    // `-`: an unhealthy container is a podman state, not a broken systemd unit — without it
    // every failing probe would park a unit in `systemctl --failed`.
    `ExecStart=-/bin/sh -c "exec podman healthcheck run ${container}"`,
    '',
  ].join('\n');
  const timer = [
    '[Unit]',
    `Description=vops health timer ${container}`,
    `BindsTo=${container}.service`,
    `After=${container}.service`,
    '',
    '[Timer]',
    `OnActiveSec=${first}`,
    `OnUnitInactiveSec=${interval}`,
    'AccuracySec=1s',
    '',
    '[Install]',
    `WantedBy=${container}.service`,
    '',
  ].join('\n');
  return { [healthServiceUnit(container)]: service, [healthTimerUnit(container)]: timer };
}

/** A manifest duration systemd would reject (`30`, `1 minute`, `PT30S`) must not produce a unit
 * file that fails to load — fall back rather than lose the probe entirely. */
function duration(v?: string): string | undefined {
  const t = v?.trim();
  return t && DURATION.test(t) ? t : undefined;
}
