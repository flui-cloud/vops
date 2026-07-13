import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { LocalApiModule } from './local-api.module';
import { AllExceptionsFilter } from './all-exceptions.filter';

export interface LocalApiHandle {
  url: string;
  port: number;
  token: string;
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

  const desiredPort = Number(process.env.VOPS_PORT ?? 0);
  await app.listen(desiredPort, '127.0.0.1');

  const address = app.getHttpServer().address() as AddressInfo;
  const port = address?.port ?? desiredPort;
  return { url: `http://127.0.0.1:${port}/?session=${token}`, port, token };
}
