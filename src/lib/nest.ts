import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import { VopsModule } from '../vops.module';

let appInstance: INestApplicationContext | null = null;

/** Boot the vops DI container once (no HTTP server, no DB, no Redis). */
export async function getVopsApp(): Promise<INestApplicationContext> {
  if (!appInstance) {
    appInstance = await NestFactory.createApplicationContext(VopsModule, {
      // CLI stdout must stay clean for --json; warns/logs would pollute it.
      // Errors go to stderr. Commands surface failures via this.error themselves.
      logger: ['error'],
      abortOnError: true,
    });
  }
  return appInstance;
}

export async function closeVopsApp(): Promise<void> {
  if (appInstance) {
    await appInstance.close();
    appInstance = null;
  }
}
