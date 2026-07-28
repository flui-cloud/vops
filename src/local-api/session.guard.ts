import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { tokenMatches } from './session-token';

/** Name of the cookie minted when the UI shell is served. */
export const SESSION_COOKIE = 'vops_session';

/** Guards the local API: only requests carrying the profile's session token may reach /api.
 * Cookie is HttpOnly + SameSite=Strict (for the installed PWA, whose frozen `start_url` can't
 * carry a token) and persisted per profile, so an already-open dashboard survives a restart. */
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
    return tokenMatches(provided, expected);
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
