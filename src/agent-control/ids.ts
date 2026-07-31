import * as crypto from 'node:crypto';

export function localId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function sessionTokenValue(): string {
  return `vops_st_${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
