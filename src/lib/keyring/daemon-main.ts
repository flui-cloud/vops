import { profileDir as defaultProfileDir } from '../profile';
import { KEY_DOMAIN, deriveKey } from './derive';
import { DEFAULT_TTL_MS, KeyringServer } from './keyring-server';
import { DaemonHandle, listenKeyring } from './keyring-daemon';
import { keyringCookie } from './keyring-cookie';
import { keyringSocket } from './socket-path';
import { readHeader, readWith } from './vault-store';

/** Long-lived process holding the vault key in memory (vops CLI itself is short-lived
 * processes, so "unlocked for 12h" can't mean a key on disk). Locks itself out on TTL/idle. */
const IDLE_CHECK_MS = 30_000;
const STARTUP_GRACE_MS = 2 * 60_000;
/** Long enough for the in-flight `lock` reply to reach the client. */
const FLUSH_MS = 250;

export async function runKeyringDaemon(dir: string, ttlMs = DEFAULT_TTL_MS): Promise<DaemonHandle> {
  let handle: DaemonHandle | null = null;
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    setTimeout(() => void shutdown(handle), FLUSH_MS);
  };

  const server = new KeyringServer({
    cookie: keyringCookie(dir),
    ttlMs,
    readHeader: () => {
      const header = readHeader(dir);
      return { salt: Buffer.from(header.salt, 'hex'), kdf: header.kdf };
    },
    // Prove the passphrase against the real vault before accepting it: an
    // unlock that "succeeds" on a typo would surface as a decryption failure
    // much later, somewhere that cannot explain what went wrong.
    verify: (master) => {
      const salt = Buffer.from(readHeader(dir).salt, 'hex');
      const key = deriveKey(master, KEY_DOMAIN.vault, salt);
      try {
        readWith(dir, key);
      } finally {
        key.fill(0);
      }
    },
    // Driven by the event, not by a poll: a 30s sample can sit between an unlock
    // and a lock and conclude the key was never held, leaving the process alive
    // long after it stopped being useful.
    onLock: stop,
  });

  handle = await listenKeyring(server, keyringSocket(dir));
  watchForIdle(server, stop);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
  return handle;
}

/** Polls for what the lock event can't report: a TTL that expired unasked, or a
 * daemon spawned for a passphrase the user never finished typing. */
function watchForIdle(server: KeyringServer, stop: () => void): void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (server.unlocked) return;
    if (Date.now() - startedAt < STARTUP_GRACE_MS) return;
    clearInterval(timer);
    stop();
  }, IDLE_CHECK_MS);
}

async function shutdown(handle: DaemonHandle | null): Promise<void> {
  await handle?.close();
  process.exit(0);
}

if (require.main === module) {
  runKeyringDaemon(process.argv[2] ?? defaultProfileDir()).catch(() => process.exit(1));
}
