import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import { AddressInfo, createServer } from 'node:net';
import { LocalApiModule } from './local-api.module';
import { AllExceptionsFilter } from './all-exceptions.filter';

export interface LocalApiHandle {
  url: string;
  port: number;
  token: string;
}

/**
 * A stable default port keeps the browser origin stable across restarts. The
 * dashboard's per-origin state (theme, watch toggles) lives in localStorage,
 * which a fresh random port silently discards on every launch.
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
 * Start the local API bound to 127.0.0.1 only, guarded by a one-time session
 * token. Never binds 0.0.0.0; tokens/secrets never leave the machine.
 */
export async function startLocalApi(): Promise<LocalApiHandle> {
  const token = process.env.VOPS_SESSION || randomBytes(24).toString('hex');
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

  const address = app.getHttpServer().address() as AddressInfo;
  const port = address?.port ?? desiredPort;
  return { url: `http://127.0.0.1:${port}/?session=${token}`, port, token };
}
