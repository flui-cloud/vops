import { INestApplicationContext, Type } from '@nestjs/common';
import { closeVopsApp, getVopsApp } from '../lib/nest';

/** Same contract as `withService` for a command that needs more than one service. */
export async function withApp<T>(fn: (app: INestApplicationContext) => Promise<T> | T): Promise<T> {
  try {
    return await fn(await getVopsApp());
  } finally {
    await closeVopsApp();
  }
}

/** Resolve one service, run against it, and always close the DI context — the `finally` is the
 * part that gets forgotten, leaving the process hanging on a throw instead of exiting cleanly. */
export async function withService<S, T>(token: Type<S>, fn: (svc: S) => Promise<T> | T): Promise<T> {
  try {
    return await fn((await getVopsApp()).get(token));
  } finally {
    await closeVopsApp();
  }
}
