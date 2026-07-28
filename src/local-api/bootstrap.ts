import { NestFactory } from '@nestjs/core';
import { AddressInfo, createServer } from 'node:net';
import { LocalApiModule } from './local-api.module';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { sessionToken } from './session-token';
import { disablePrompting } from '../lib/keyring/unlock';

export interface LocalApiHandle {
  url: string;
  port: number;
  token: string;
  /** False when the default port was taken and the OS picked another one. */
  onDefaultPort: boolean;
}

/**
 * A stable default port keeps the browser origin stable across restarts. The
 * dashboard's per-origin state (theme, watch toggles) lives in localStorage,
 * which a fresh random port silently discards on every launch.
 *
 * The installed (PWA) app raises the stakes: a PWA's identity *is* its origin,
 * port included, so a run on a fallback port is a different app to the browser —
 * it won't reuse the installed window and can't be installed a second time under
 * the same identity. Falling back stays the behaviour (hard-failing would block
 * a second instance for no good reason), but `onDefaultPort` lets the caller say
 * so out loud instead of leaving the user to wonder why their app icon is dead.
 */
export const DEFAULT_UI_PORT = 7788;

/** The preferred port if it is free, otherwise 0 (let the OS pick). */
async function preferredPort(port: number): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(0));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
  });
}

/**
 * Start the local API bound to 127.0.0.1 only, guarded by the profile's session
 * token. Never binds 0.0.0.0; tokens/secrets never leave the machine.
 */
export async function startLocalApi(): Promise<LocalApiHandle> {
  const token = sessionToken();
  process.env.VOPS_SESSION = token;

  const app = await NestFactory.create(LocalApiModule, {
    logger: ['error', 'warn'],
  });
  app.enableCors({ origin: false });
  app.useGlobalFilters(new AllExceptionsFilter());

  // An explicit VOPS_PORT is honoured as-is (and fails loudly if taken); the
  // default only falls back to an ephemeral port when 7788 is busy.
  const explicit = process.env.VOPS_PORT?.trim();
  const desiredPort = explicit ? Number(explicit) : await preferredPort(DEFAULT_UI_PORT);
  await app.listen(desiredPort, '127.0.0.1');

  // From here on this process serves HTTP; a passphrase prompt would land in a
  // terminal nobody is watching while the browser hangs. The vault is unlocked
  // (or not) before this point, by whoever started the server.
  disablePrompting();

  const address = app.getHttpServer().address() as AddressInfo;
  const port = address?.port ?? desiredPort;
  return {
    url: `http://127.0.0.1:${port}/?session=${token}`,
    port,
    token,
    onDefaultPort: port === DEFAULT_UI_PORT,
  };
}
