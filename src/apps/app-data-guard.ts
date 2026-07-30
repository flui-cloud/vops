/** Which of an app's named volumes / podman secrets were already on the host BEFORE a deploy
 * touched it — the one fact a rollback needs to put the host back as it was without ever
 * deleting data it did not create. Pure: script text in, parsed sets out. */
import { shq } from './app-scripts';

export interface HostAppData {
  /** false when the probe did not complete (SSH trouble, old host): nothing may be deleted. */
  ran: boolean;
  volumes: string[];
  secrets: string[];
}

export const UNPROBED_DATA: HostAppData = { ran: false, volumes: [], secrets: [] };

/** Read-only: names the app's planned volumes/secrets that already exist. */
export function buildDataProbeScript(volumes: string[], secrets: string[]): string {
  return [
    'set +e',
    "echo '@@existing'",
    // `volume inspect`, not `volume exists`: same test, and it is present in every podman
    // that can run a Quadlet — a subcommand the host does not know would report "absent"
    // for a volume that is in fact there, and the rollback would then delete it.
    ...volumes.map((v) => String.raw`podman volume inspect ${shq(v)} >/dev/null 2>&1 && printf 'volume %s\n' ${shq(v)}`),
    ...secrets.map((s) => String.raw`podman secret inspect ${shq(s)} >/dev/null 2>&1 && printf 'secret %s\n' ${shq(s)}`),
    "echo '@@done'",
  ].join('\n');
}

export function parseDataProbe(stdout: string): HostAppData {
  const lines = probeSection(stdout);
  if (!lines) return UNPROBED_DATA;
  return {
    ran: true,
    volumes: named(lines, 'volume '),
    secrets: named(lines, 'secret '),
  };
}

/** The section only counts when the script reached its own end marker: a truncated run
 * must read as "unknown", never as "the host held nothing". */
function probeSection(stdout: string): string[] | null {
  const start = stdout.indexOf('@@existing');
  const end = stdout.indexOf('@@done', start + 1);
  if (start < 0 || end < 0) return null;
  return stdout
    .slice(stdout.indexOf('\n', start) + 1, end)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function named(lines: string[], prefix: string): string[] {
  return lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim());
}

/** Volumes/secrets THIS run brought into existence — the only ones a rollback may remove.
 * An unfinished probe yields nothing: not deleting is always the recoverable mistake. */
export function dataCreatedInRun(
  planned: { volumes: string[]; secrets: string[] },
  pre: HostAppData,
): { volumes: string[]; secrets: string[] } {
  if (!pre.ran) return { volumes: [], secrets: [] };
  return {
    volumes: planned.volumes.filter((v) => !pre.volumes.includes(v)),
    secrets: planned.secrets.filter((s) => !pre.secrets.includes(s)),
  };
}

/** Names the data a failing install inherited instead of creating. A datadir initialised with
 * another install's credentials makes a DB-backed app fail on every retry, and until this text
 * existed nothing in the failure said so — the volume was invisible to the operator reading it. */
export function reusedDataNote(pre: HostAppData): string {
  if (!pre.volumes.length && !pre.secrets.length) return '';
  const what = [
    ...pre.volumes.map((v) => `volume ${v}`),
    ...pre.secrets.map((s) => `secret ${s}`),
  ].join(', ');
  const commands = [
    ...(pre.volumes.length ? [`podman volume rm ${pre.volumes.join(' ')}`] : []),
    ...(pre.secrets.length ? [`podman secret rm ${pre.secrets.join(' ')}`] : []),
  ].join(' && ');
  return (
    `This install reused app data that was already on the host and was not created by it: ${what}. ` +
    `A datadir left by an earlier install carries that install's credentials, so the app can fail ` +
    `on every retry with no other sign of why. To start from a clean datadir, run on the host: ` +
    `sudo sh -c '${commands}' — that DELETES the data.`
  );
}
