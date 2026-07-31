import { NestFactory } from '@nestjs/core';
import { AddressInfo, createServer } from 'node:net';
import { LocalApiModule } from './local-api.module';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { sessionToken } from './session-token';
import { probeInstance } from './instance-probe';
import { profileFingerprint, setRuntimeInfo } from './runtime-info';
import { decidePort } from './port-decision';
import { disablePrompting } from '../lib/keyring/unlock';

export interface LocalApiHandle {
  url: string;
  port: number;
  token: string;
  /** False when the default port was taken and the OS picked another one. */
  onDefaultPort: boolean;
  /** True when this call started nothing: a vops for this profile was already
   * serving the default port, so the caller should just open the browser. */
  adopted: boolean;
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

/** True when the port can be bound right now. */
async function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** How often a standing-by service re-checks whether the port has come free. */
const STAND_BY_POLL_MS = 5_000;

export interface StartOptions {
  /**
   * What to do when another vops for this profile already holds the port. A
   * terminal wants to hand over and get out of the way; a supervised service
   * must stay alive and take the port the moment it frees — exiting would leave
   * launchd/systemd respawning it in a loop forever.
   */
  standBy?: boolean;
  /** Called once when standing by, so the caller can say so. */
  onStandBy?: (port: number) => void;
}

/**
 * Start the local API bound to 127.0.0.1 only, guarded by the profile's session
 * token. Never binds 0.0.0.0; tokens/secrets never leave the machine.
 */
export async function startLocalApi(opts: StartOptions = {}): Promise<LocalApiHandle> {
  const token = sessionToken();
  process.env.VOPS_SESSION = token;

  const explicit = process.env.VOPS_PORT?.trim();
  const desired = explicit ? Number(explicit) : DEFAULT_UI_PORT;
  const free = await isFree(desired);
  // The probe runs whether or not the port was pinned — see port-decision.ts for
  // why that distinction used to matter and what it broke.
  const mine = free ? false : (await probeInstance(desired))?.profile === profileFingerprint();
  const decision = decidePort({ desired, explicit: !!explicit, free, mine, standBy: !!opts.standBy });

  if (decision.kind === 'adopt') {
    // A second server would give the installed app a different origin AND double
    // every background SSH probe. Open the one that's already there.
    return {
      url: `http://127.0.0.1:${decision.port}/?session=${token}`,
      port: decision.port,
      token,
      onDefaultPort: decision.port === DEFAULT_UI_PORT,
      adopted: true,
    };
  }
  if (decision.kind === 'conflict') {
    throw new Error(
      `Port ${decision.port} is taken by something that isn't vops. Free it, or set VOPS_PORT to another port.`,
    );
  }
  if (decision.kind === 'standby') {
    opts.onStandBy?.(decision.port);
    await waitForPort(decision.port);
  }
  const freePort = decision.kind === 'fallback' ? 0 : desired;

  const app = await NestFactory.create(LocalApiModule, {
    logger: ['error', 'warn'],
  });
  app.enableCors({ origin: false });
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.listen(freePort, '127.0.0.1');

  // From here on this process serves HTTP; a passphrase prompt would land in a
  // terminal nobody is watching while the browser hangs. The vault is unlocked
  // (or not) before this point, by whoever started the server.
  disablePrompting();

  const address = app.getHttpServer().address() as AddressInfo;
  const port = address?.port ?? freePort;
  setRuntimeInfo(port);
  return {
    url: `http://127.0.0.1:${port}/?session=${token}`,
    port,
    token,
    onDefaultPort: port === DEFAULT_UI_PORT,
    adopted: false,
  };
}

/** Block until the port frees. Used only by a supervised service, which has
 * nothing better to do than wait for the instance that beat it to finish. */
async function waitForPort(port: number): Promise<void> {
  while (!(await isFree(port))) {
    await new Promise((resolve) => setTimeout(resolve, STAND_BY_POLL_MS));
  }
}
