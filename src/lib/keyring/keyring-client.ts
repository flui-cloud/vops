import * as net from 'node:net';
import { KeyringRequest, KeyringResponse, decodeResponse, encodeRequest } from './protocol';

/** A missing/refused socket is reported as `unavailable` rather than thrown, so
 * callers can spawn the daemon and retry instead of handling raw errno strings. */
const REQUEST_TIMEOUT_MS = 5_000;

export class KeyringUnavailableError extends Error {
  constructor(socketPath: string) {
    super(`No keyring is listening on ${socketPath}.`);
    this.name = 'KeyringUnavailableError';
  }
}

export function keyringRequest(socketPath: string, req: KeyringRequest): Promise<KeyringResponse> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    let buf = '';
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(err);
    };

    conn.setTimeout(REQUEST_TIMEOUT_MS, () => fail(new Error('Keyring request timed out.')));
    conn.on('error', () => fail(new KeyringUnavailableError(socketPath)));
    conn.on('connect', () => conn.write(encodeRequest(req)));
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    conn.on('close', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(decodeResponse(buf.trim()));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}
