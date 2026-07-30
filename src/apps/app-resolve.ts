import { ExitCode, agentError } from '../agent-api/agent-envelope';
import { AgentBadRequest, notFound } from '../agent-api/agent-http-errors';
import { LocalStore } from '../lib/store/local-store';
import { AppInstallV1 } from './app.model';

/** Installs are keyed by `(host, name)`, so a bare name can match more than one host.
 * Commands that take only a name resolve through here: exactly one match is used, several
 * are refused unless `--host` says which. Picking one would act on a host the user did not
 * name — the wrong container restarted, the wrong volumes purged. */
export async function resolveInstall(store: LocalStore, name: string, host?: string): Promise<AppInstallV1> {
  return pickInstall(name, host, await store.findInstalls(name));
}

/** The resolution itself, over the ledger rows that carry this name. `host` is matched against
 * the install's RECORDED host, not the inventory, so an install whose server is gone can still
 * be named (and, by `app remove`, forgotten) — without that, the dead end just moves. */
export function pickInstall(name: string, host: string | undefined, matches: AppInstallV1[]): AppInstallV1 {
  if (!matches.length) {
    throw notFound('VOPS_APP_NOT_FOUND', `No app install named '${name}'.`, 'List what is deployed with `vops app list --json`.');
  }
  if (!host) {
    if (matches.length > 1) throw ambiguousInstall(name, matches);
    return matches[0];
  }
  const onHost = matches.find((i) => i.host === host);
  if (!onHost) throw wrongHost(name, host, matches);
  return onHost;
}

function hostList(matches: AppInstallV1[]): string {
  return matches.map((i) => i.host).join(', ');
}

function ambiguousInstall(name: string, matches: AppInstallV1[]): AgentBadRequest {
  return new AgentBadRequest(
    agentError(
      'VOPS_APP_AMBIGUOUS',
      'input',
      `'${name}' is installed on ${matches.length} hosts (${hostList(matches)}) — vops will not guess which one you mean.`,
      {
        recoverable: true,
        suggestedAction: `Re-run the same command with \`--host <host>\` (one of: ${hostList(matches)}) to act on that install — it also reaches an install whose host is gone.`,
      },
    ),
    ExitCode.INVALID_INPUT,
  );
}

function wrongHost(name: string, host: string, matches: AppInstallV1[]): AgentBadRequest {
  return notFound(
    'VOPS_APP_NOT_FOUND',
    `No app install named '${name}' on host '${host}'.`,
    `It is installed on ${hostList(matches)} — re-run with \`--host <one of those>\`.`,
  );
}
