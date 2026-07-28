import { Type } from '@nestjs/common';
import { closeVopsApp, getVopsApp } from '../lib/nest';

/** Resolve one service, run against it, and always close the DI context — the `finally` is the
 * part that gets forgotten, leaving the process hanging on a throw instead of exiting cleanly. */
export async function withService<S, T>(token: Type<S>, fn: (svc: S) => Promise<T> | T): Promise<T> {
  try {
    return await fn((await getVopsApp()).get(token));
  } finally {
    await closeVopsApp();
  }
}
