/** The install ledger around a deploy. The row is written BEFORE the host is touched and
 * confirmed on success, so a run that never returns — Ctrl-C on a slow pull, a dropped
 * connection, a kill — still leaves something `app list` shows and `app remove` can act on.
 * Pure store bookkeeping: no SSH, no decisions about the host itself. */
import { LocalStore } from '../lib/store/local-store';
import { AppInstallV1 } from './app.model';
import { AppLeftRunningError } from './app-rollback';

/** Only a confirmed install is a redeploy baseline. A row left by an interrupted attempt
 * describes units that never came up, so a retry must probe the host and roll back the way a
 * first install does — restoring those units would put the failed attempt back instead. */
export function redeployBaseline(prev: AppInstallV1 | null): AppInstallV1 | null {
  return prev?.status === 'deployed' ? prev : null;
}

/** Claim the install in the ledger before the first host mutation. */
export async function beginInstall(store: LocalStore, install: AppInstallV1): Promise<void> {
  await store.saveInstall({ ...install, status: 'installing' });
}

/** A failure that put the host back must put the ledger back too: to the row that was there
 * before on a redeploy, to nothing on a first install — a row for an app that is no longer on
 * the host is its own defect (`app status` would answer for something that is gone). */
export async function revertInstall(store: LocalStore, install: AppInstallV1, prev: AppInstallV1 | null): Promise<void> {
  if (prev) await store.saveInstall(prev);
  else await store.deleteInstall(install.host, install.name);
}

/** Run the host-mutating half of a deploy under the ledger claim. The one failure that keeps the
 * claim is the debug escape hatch, which leaves the app running: there the row is the only thing
 * that can find it again. */
export async function withLedgerRevert<T>(
  store: LocalStore,
  install: AppInstallV1,
  prev: AppInstallV1 | null,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof AppLeftRunningError)) await revertInstall(store, install, prev);
    throw e;
  }
}
