import { ForbiddenException } from '@nestjs/common';

/**
 * Ownership guard: vops only performs destructive actions (delete, detach, rule
 * changes) on resources IT created. Everything vops provisions is named with the
 * `vops-` prefix and tagged with the managed marker; anything else — a server you
 * made in the provider console, someone else's control host — is off-limits, so a
 * stray delete can never take down a resource vops didn't create.
 */
export const MANAGED_PREFIX = 'vops-';
export const MANAGED_LABEL = { key: 'managed-by', value: 'vops' };
export const MANAGED_METADATA_KEY = 'vops-managed';

export interface OwnableResource {
  name?: string;
  labels?: { key: string; value: string }[];
}

export function isVopsManaged(res: OwnableResource): boolean {
  if (res.name?.startsWith(MANAGED_PREFIX)) return true;
  return (res.labels ?? []).some(
    (l) => l.key === MANAGED_LABEL.key && l.value === MANAGED_LABEL.value,
  );
}

export function assertVopsManaged(kind: string, res: OwnableResource): void {
  if (isVopsManaged(res)) return;
  throw new ForbiddenException(
    `Refusing to modify/delete ${kind} '${res.name ?? '?'}': it was not created by vops. ` +
      `Destructive actions are limited to vops-managed resources (name starts with '${MANAGED_PREFIX}').`,
  );
}
