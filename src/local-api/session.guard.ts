import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

/**
 * Guards the local API: only requests carrying the one-time session token
 * (minted at `vops ui` start) may reach /api. Non-API paths (the UI shell) pass.
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
      (req.query.session as string);
    return provided === expected;
  }
}
