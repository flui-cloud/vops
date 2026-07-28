import { getCatalogEntry } from '../src/apps/catalog';
import { normalizeManifest, refreshAccessValues } from '../src/apps/spec-normalize';
import { accessView, applyOverrides } from '../src/apps/app-deploy-support';
import { AppEndpoint } from '../src/apps/app.model';

function plan(id: string) {
  const e = getCatalogEntry(id);
  if (!e) throw new Error(`missing catalog app ${id}`);
  return normalizeManifest(e.manifest, id);
}

describe('app access resolution', () => {
  it('resolves a user-set credential to a secret NAME, never a DB secret', () => {
    const p = plan('nextcloud');
    expect(p.access?.mode).toBe('credentials');
    // username is a plain env with a default → a shown value
    expect(p.access?.username).toEqual(expect.objectContaining({ kind: 'value', value: 'admin' }));
    // password is a sensitive userInput → a secret we read back, not a stored value
    expect(p.access?.password?.kind).toBe('userSet');
    expect(p.access?.password?.value).toBeUndefined();
    const pwSecret = p.access?.password?.secret;
    expect(pwSecret).toContain('admin-password');
    // the referenced secret must NOT be a database/internal secret
    const dbSecrets = p.components.flatMap((c) => c.secrets).filter((s) => /mysql|redis|db/i.test(s.target));
    expect(dbSecrets.map((s) => s.name)).not.toContain(pwSecret);
  });

  it('resolves a generated user-facing credential (vaultwarden ADMIN_TOKEN)', () => {
    const p = plan('vaultwarden');
    expect(p.access?.mode).toBe('credentials');
    expect(p.access?.path).toBe('/admin');
    expect(p.access?.username).toBeUndefined();
    expect(p.access?.password?.kind).toBe('generated');
    expect(p.access?.password?.secret).toContain('admin-token');
  });

  it('marks installer-claim apps as firstVisit (no credential at deploy)', () => {
    for (const id of ['wordpress-composed', 'immich', 'homarr', 'uptime-kuma']) {
      const p = plan(id);
      expect(p.access?.mode).toBe('firstVisit');
      expect(p.access?.username).toBeUndefined();
      expect(p.access?.password).toBeUndefined();
    }
  });

  it('leaves apps with no credentials without an access block', () => {
    expect(plan('it-tools').access).toBeUndefined();
  });

  it('refreshes a plain-env username after a --set override', () => {
    const p = plan('nextcloud');
    applyOverrides(p, { NEXTCLOUD_ADMIN_USER: 'dawit' });
    refreshAccessValues(p);
    expect(p.access?.username?.value).toBe('dawit');
    // the secret-backed password is untouched by refresh (no value ever held)
    expect(p.access?.password?.value).toBeUndefined();
  });

  it('composes the login URL from the endpoint + access.path', () => {
    const p = plan('pocketbase');
    const endpoints: AppEndpoint[] = [{ component: 'app', port: 8090, url: 'http://1.2.3.4:8090' }];
    const view = accessView(p.access, endpoints, p.primary);
    expect(view?.url).toBe('http://1.2.3.4:8090/_/');
  });

  it('uses the ingress host (https) for the URL when fronted by a domain', () => {
    const p = plan('nextcloud');
    const view = accessView(p.access, [], p.primary, { hostname: 'nc.example.com', tls: true });
    expect(view?.url).toBe('https://nc.example.com');
  });
});
