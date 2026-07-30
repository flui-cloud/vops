import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest } from '../src/apps/spec-normalize';
import { resolveDeployGate } from '../src/apps/ingress-auth';

/**
 * Pgweb, redis-commander and phpmyadmin have no login vops can reach, so none of them may claim
 * `auth.mode: native` — the declaration vops reads to decide whether a public domain leaves an app
 * naked. Each manifest's exact image was run with each manifest's exact env:
 *   pgweb 0.16.2 + PGWEB_LOCK_SESSION=1 → `GET /` 200 (full SQL browser), `/api/info` 200
 *     unauthenticated JSON; the only login it has is --auth-user/--auth-pass, unset here.
 *   redis-commander 0.9.1 + PORT=8081 → `GET /` 200 (key browser), no WWW-Authenticate; the only
 *     login it has is --http-auth-username/--http-auth-password, unset here.
 *   phpmyadmin 5-apache → conditional: unlinked it serves a cookie login form, but with the
 *     linkedBuildingBlocks mapping applied (PMA_USER+PMA_PASSWORD) it writes auth_type = 'config'
 *     and auto-logs into the admin UI. The manifest exists for the linked state, so `none`.
 */
const NO_NATIVE_LOGIN = ['pgweb', 'redis-commander', 'phpmyadmin'];

const planOf = (id: string) => normalizeManifest(getCatalogEntry(id)!.manifest, id);

describe('DB-admin GUIs do not claim a login they do not have', () => {
  it.each(NO_NATIVE_LOGIN)('%s declares no authentication of its own', (id) => {
    expect(planOf(id).authMode).toBe('none');
  });

  it.each(NO_NATIVE_LOGIN)('%s: an ungated public domain is refused, not silently allowed', (id) => {
    const plan = planOf(id);
    const gate = { hasIngress: true, accessMode: plan.access?.mode, authMode: plan.authMode };
    expect(() => resolveDeployGate(id, gate)).toThrow(/no login of its own/i);
    // and the operator can still say which risk they mean
    expect(resolveDeployGate(id, { ...gate, intent: { mode: 'none' as const } })).toBeNull();
    expect(resolveDeployGate(id, { ...gate, intent: { mode: 'basic' as const } })!.state.mode).toBe('basic');
  });

  it.each(NO_NATIVE_LOGIN)('%s stays silent on a bare install — the refusal is about the domain', (id) => {
    expect(resolveDeployGate(id, { hasIngress: false, authMode: planOf(id).authMode })).toBeNull();
  });

  // Why phpmyadmin is not the exception it looks like: the mapping the manifest is written around
  // injects the two vars that switch the image out of cookie auth. If that mapping ever stops
  // carrying them, the app does have a login and `native` becomes the honest declaration again.
  it('phpmyadmin arranges the no-login state itself, via its linked mapping', () => {
    const spec = getCatalogEntry('phpmyadmin')!.manifest.spec as {
      linkedBuildingBlocks?: { envMapping: { name: string }[] }[];
    };
    const mapped = (spec.linkedBuildingBlocks ?? []).flatMap((b) => b.envMapping.map((m) => m.name));
    expect(mapped).toEqual(expect.arrayContaining(['PMA_USER', 'PMA_PASSWORD']));
  });
});
