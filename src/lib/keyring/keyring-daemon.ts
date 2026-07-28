import * as fs from 'node:fs';
import * as net from 'node:net';
import { KeyringServer } from './keyring-server';
import { SocketLocation } from './socket-path';
import { decodeRequest, encodeResponse, errorResponse } from './protocol';

/** Binds a `KeyringServer` to a local socket. Node's `net` API is uniform across
 * platforms, so the only branch here is the POSIX-only dir setup (skipped on Windows). */
export interface DaemonHandle {
  socketPath: string;
  close: () => Promise<void>;
}

const CONNECTION_TIMEOUT_MS = 10_000;

export async function listenKeyring(server: KeyringServer, location: SocketLocation): Promise<DaemonHandle> {
  if (location.dir) {
    // The 0700 directory IS the POSIX access control: macOS's own ssh-agent
    // leaves its socket world-writable and relies on the enclosing directory,
    // because socket-file modes are not reliably enforced on BSD-derived kernels.
    fs.mkdirSync(location.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(location.dir, 0o700);
    await clearStaleSocket(location.socketPath);
  }

  const listener = net.createServer((conn) => handleConnection(server, conn));
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(location.socketPath, () => {
      listener.removeListener('error', reject);
      resolve();
    });
  });

  return {
    socketPath: location.socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        listener.close(() => resolve());
      }),
  };
}

function handleConnection(server: KeyringServer, conn: net.Socket): void {
  conn.setTimeout(CONNECTION_TIMEOUT_MS, () => conn.destroy());
  let buf = '';
  conn.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    buf = '';
    const decoded = decodeRequest(line);
    const response =
      'error' in decoded ? errorResponse('bad-request', decoded.error) : server.handle(decoded);
    conn.end(encodeResponse(response));
  });
  // A client that dies mid-request must not take the daemon with it.
  conn.on('error', () => conn.destroy());
}

/** Probe before unlinking: a stale socket file survives an unclean shutdown, but if
 * something still answers, unlinking it would hijack a live keyring instead. */
async function clearStaleSocket(socketPath: string): Promise<void> {
  if (!fs.existsSync(socketPath)) return;
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
  if (alive) throw new Error(`A keyring is already listening on ${socketPath}.`);
  fs.rmSync(socketPath, { force: true });
}
