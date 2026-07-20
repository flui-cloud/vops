import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

/** Name of the cookie minted when the UI shell is served. */
export const SESSION_COOKIE = 'vops_session';

/**
 * Guards the local API: only requests carrying the one-time session token
 * (minted at `vops ui` start) may reach /api. Non-API paths (the UI shell) pass.
 *
 * The cookie exists for the installed (PWA) app. A manifest freezes `start_url`
 * at install time, so it cannot carry the token, which is regenerated per run.
 * Serving the shell sets the cookie instead, so it is refreshed on every launch
 * and can never go stale. It is HttpOnly + SameSite=Strict, so a hostile page
 * that reaches 127.0.0.1 can neither read it nor ride on it.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.path.startsWith('/api')) return true;

    const expected = process.env.VOPS_SESSION;
    if (!expected) return false;
    const provided =
      (req.headers['x-vops-session'] as string) ||
      (req.query.session as string) ||
      readCookie(req.headers.cookie, SESSION_COOKIE);
    return provided === expected;
  }
}

/**
 * Minimal cookie reader — the local API mints exactly one cookie, so pulling in
 * cookie-parser (a dependency shipped to every user) isn't worth it.
 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}
