import { KEY_DOMAIN, KeyDomain } from './derive';

/** Which derived keys a companion tool may ask for through the CLI. `vault` and
 * `session` are deliberately absent: a command that printed them would hand vops's
 * own secrets to anything running as this user, no passphrase needed. A Map, not an
 * object, so an inherited property name can never resolve to a domain. */
const COMPANIONS = new Map<string, KeyDomain>([['dymmi', KEY_DOMAIN.dymmi]]);

export const COMPANION_NAMES: string[] = [...COMPANIONS.keys()];

export function companionDomain(name: string): KeyDomain {
  const domain = COMPANIONS.get(name);
  if (!domain) {
    throw new Error(`Unknown companion '${name}'. Known: ${COMPANION_NAMES.join(', ')}.`);
  }
  return domain;
}
