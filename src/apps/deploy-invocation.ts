import { boolArg, flagArg, toggleArg } from '../agent-api/follow-up';
import type { AppSource } from './app-source';
import type { DeployFlags } from './deploy-flags';

/** Rebuilds the command an agent should re-run once the user approves, from the invocation that
 * was actually made rather than from a fixed template. A follow-up that quietly drops a flag the
 * caller supplied is worse than no follow-up: the agent runs it verbatim and it fails — `--image`
 * is mandatory for a `kind: Application` manifest, and a fixed template cannot supply it.
 *
 * Secret values are named but not echoed: a `nextActions` string lands in logs, in transcripts and
 * in anything that stores an envelope, so the reconstruction carries the flag plus an angle-bracket
 * placeholder the caller substitutes with the value it already holds. */

const VALUE_PLACEHOLDER = '<value>';

function setArgs(pairs?: string[]): string[] {
  return (pairs ?? []).flatMap((p) => {
    const eq = p.indexOf('=');
    const key = eq < 0 ? p : p.slice(0, eq);
    return ['--set', `${key}=${VALUE_PLACEHOLDER}`];
  });
}

/** True when `--registry-token` came from VOPS_REGISTRY_TOKEN, which the re-run reads by itself. */
function tokenFromEnv(token?: string): boolean {
  return token != null && process.env.VOPS_REGISTRY_TOKEN === token;
}

/** `--image`/`--registry-*` are declared by `app deploy` only — `app install` rejects them. */
function imageArgs(flags: DeployFlags): string[] {
  const token = flags['registry-token'];
  return [
    ...flagArg('image', flags.image),
    ...flagArg('registry-user', flags['registry-user']),
    ...(token == null || tokenFromEnv(token) ? [] : ['--registry-token', '<token>']),
  ];
}

function ingressArgs(flags: DeployFlags): string[] {
  return [
    ...flagArg('domain', flags.domain),
    ...flagArg('email', flags.email),
    ...(flags.tls ? [] : ['--no-tls']),
    ...boolArg('staging', flags.staging),
    ...boolArg('expose-direct', flags['expose-direct']),
    ...boolArg('force-dns', flags['force-dns']),
    ...toggleArg('public', flags.public),
    ...flagArg('auth', flags.auth),
    ...flagArg('auth-user', flags['auth-user']),
    ...(flags['auth-pass'] == null ? [] : ['--auth-pass', '<password>']),
  ];
}

/** The secret-bearing flags the reconstruction redacted, so the description can name them. */
export function redactedFlags(source: AppSource, flags: DeployFlags): string[] {
  const token = flags['registry-token'];
  const carriesToken = !source.catalog && token != null && !tokenFromEnv(token);
  return [
    ...(flags.set?.length ? ['--set'] : []),
    ...(carriesToken ? ['--registry-token'] : []),
    ...(flags['auth-pass'] == null ? [] : ['--auth-pass']),
  ];
}

/** The re-run command: every flag of the original invocation, `--dry-run` dropped, `--yes` added. */
export function deployInvocation(source: AppSource, flags: DeployFlags): string {
  const head = source.catalog
    ? ['vops', 'app', 'install', source.catalog]
    : ['vops', 'app', 'deploy', '-f', String(source.file)];
  return [
    ...head,
    '--host',
    flags.host,
    ...flagArg('name', flags.name),
    ...(source.catalog ? [] : imageArgs(flags)),
    ...setArgs(flags.set),
    ...ingressArgs(flags),
    '--yes',
    '--json',
  ].join(' ');
}
