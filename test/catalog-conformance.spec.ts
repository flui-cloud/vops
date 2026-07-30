import { ApplicationKind } from '@flui-cloud/spec';
import { loadCatalog, getCatalogEntry, estimateInstallSeconds } from '../src/apps/catalog';
import { checkInstallable, normalizeManifest } from '../src/apps/spec-normalize';
import { loadAppPlan } from '../src/apps/app-source';
import { renderDeploy } from '../src/apps/quadlet-render';
import { resolveDeployGate } from '../src/apps/ingress-auth';
import { routedPorts } from '../src/apps/ingress-hostname';
import { planHostDeploy } from '../src/apps/app-plan';
import { HostFacts } from '../src/apps/app-parse';
import { IngressBinding } from '../src/apps/app.model';

function conformanceFacts(): HostFacts {
  return {
    podmanVersion: '5.8.4',
    quadletGenerator: '/usr/local/lib/systemd/system-generators/podman-system-generator',
    k3s: false,
    selinux: false,
    arch: 'x86_64',
    listeningPorts: new Set([22]),
    freeKb: 10_000_000,
    networks: ['podman'],
  };
}

// The gate that keeps the full bundled catalog deployable: every manifest must
// either normalize to a plan or return a TYPED install reason. A raw throw on any
// catalog entry fails CI, so a new manifest using an unsupported construct can't
// land silently.
describe('catalog conformance', () => {
  const entries = loadCatalog();

  it('bundles the full flui catalog', () => {
    expect(entries.length).toBeGreaterThanOrEqual(20);
  });

  it('every manifest yields a plan or a typed install reason — never a raw throw', () => {
    const failures: string[] = [];
    let installable = 0;
    let flagged = 0;
    for (const e of entries) {
      const check = checkInstallable(e.manifest);
      if (!check.ok) {
        expect(check.reason).toBeTruthy();
        flagged += 1;
        continue;
      }
      try {
        const plan = normalizeManifest(e.manifest, e.id);
        expect(plan.components.length).toBeGreaterThan(0);
        expect(plan.primary).toBeTruthy();
        for (const c of plan.components) expect(c.image).toMatch(/.+\/.+:.+/);
        installable += 1;
      } catch (err) {
        failures.push(`${e.id}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    expect(installable).toBeGreaterThanOrEqual(19);
    expect(flagged).toBeGreaterThanOrEqual(1);
  });

  it('installs a building block as a standalone service, resolving {{app.id}}/{{env.X}}', () => {
    const pg = normalizeManifest(getCatalogEntry('postgresql')!.manifest, 'pg');
    expect(pg.components).toHaveLength(1);
    // {{app.id}} → the install name
    expect(pg.components[0].env.find((e) => e.name === 'POSTGRES_DB')?.value).toBe('pg');
    // {{env.POSTGRES_USER}} inside the healthcheck resolves (no leftover template)
    expect((pg.components[0].health?.command ?? []).join(' ')).not.toContain('{{');
  });

  it('routes a whole-value {{env.X}} self-reference to the same generated secret', () => {
    const valkey = normalizeManifest(getCatalogEntry('valkey')!.manifest, 'valkey');
    expect(valkey.components[0].secrets.some((s) => s.target === 'REDISCLI_AUTH')).toBe(true);
  });

  it('flags an app that needs an un-provisioned dependency instead of crashing', () => {
    const ferret = checkInstallable(getCatalogEntry('ferretdb')!.manifest);
    expect(ferret.ok).toBe(false);
    expect(ferret.reason).toContain('postgresql');
  });

  // A `linkedBuildingBlocks` app has no resolver: nothing provisions the backend and nothing
  // injects its env mapping, so it must be refused by name before any container is started
  // rather than started standalone and left to fail the smoke test on HTTP 000.
  it.each([
    ['mongo-express', 'ferretdb', 'MONGO_HOST'],
    ['redis-commander', 'valkey', 'REDIS_HOST'],
    ['phpmyadmin', 'mariadb', 'PMA_HOST'],
    ['pgweb', 'postgresql', 'PGHOST'],
  ])('flags %s: needs a linked %s that vops cannot wire yet', (id, ref, envName) => {
    const check = checkInstallable(getCatalogEntry(id)!.manifest);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain(ref);
    expect(check.reason).toContain(envName);
  });

  it('refuses to plan a linked-building-block app instead of returning a broken plan', () => {
    expect(() => loadAppPlan({ catalog: 'mongo-express' }, getCatalogEntry)).toThrow(/ferretdb/);
  });

  // authentik's server and worker both migrate on startup; run concurrently they leave an
  // inconsistent Django migration history and the server crash-loops. Quadlet `dependsOn` only
  // orders start, so the gate lives in the worker's own command — and must survive rendering as
  // ONE systemd argument (a split, or a `$` systemd would expand, silently breaks the gate).
  it('gates the authentik worker on the server port before exec-ing the worker', () => {
    const plan = normalizeManifest(getCatalogEntry('authentik')!.manifest, 'authentik');
    const worker = plan.components.find((c) => c.name === 'worker')!;
    const server = plan.components.find((c) => c.name === 'server')!;
    const script = (worker.command ?? []).join(' ');
    expect(script).toContain(`127.0.0.1/${server.ports[0].container}`);
    expect(script.indexOf('ak worker')).toBeGreaterThan(script.indexOf('until'));

    const units = renderDeploy(plan, { selinux: false, ports: {} }).units;
    const exec = units['vops-authentik-worker.container'].split('\n').find((l) => l.startsWith('Exec='));
    expect(exec).toMatch(/^Exec=-c '.*until .*; exec ak worker'$/);
    expect(exec).not.toContain('$');
  });

  // The catalog meta drives the deploy funnel's pre-install sign-in preview and
  // the optimistic progress bar — both read only from `access`/`estSeconds`.
  it('exposes a bounded install estimate on every entry', () => {
    for (const e of entries) {
      expect(e.estSeconds).toBeGreaterThanOrEqual(30);
      expect(e.estSeconds).toBeLessThanOrEqual(300);
    }
    // A 4-container stack should never be estimated faster than a single app.
    expect(estimateInstallSeconds(getCatalogEntry('authentik')!.manifest))
      .toBeGreaterThan(estimateInstallSeconds(getCatalogEntry('bookstack')!.manifest));
  });

  it('summarizes a firstVisit app for the pre-install preview', () => {
    const ghost = getCatalogEntry('ghost')!.access;
    expect(ghost?.mode).toBe('firstVisit');
    expect(ghost?.note).toBeTruthy();
  });

  it('previews known default credentials as literal values', () => {
    const bs = getCatalogEntry('bookstack')!.access;
    expect(bs?.mode).toBe('credentials');
    expect(bs?.username).toEqual({ kind: 'value', value: 'admin@admin.com' });
    expect(bs?.password).toEqual({ kind: 'value', value: 'password' });
  });

  it('previews a host-generated password as generated, never as a value', () => {
    const ak = getCatalogEntry('authentik')!.access;
    expect(ak?.mode).toBe('credentials');
    expect(ak?.password?.kind).toBe('generated');
    expect(ak?.password?.value).toBeUndefined();
  });

  // A userInput `group` ("at least one of") is meaningless with one member and a
  // typo'd id (`llm` vs `Llm`) silently splits a group into singletons — catch both.
  it('never ships a userInput group with fewer than 2 members', () => {
    const singletons: string[] = [];
    for (const e of entries) {
      const sizes = new Map<string, number>();
      for (const inp of e.inputs) if (inp.group) sizes.set(inp.group, (sizes.get(inp.group) ?? 0) + 1);
      for (const [id, n] of sizes) if (n < 2) singletons.push(`${e.id}: group "${id}" has ${n} member`);
    }
    expect(singletons).toEqual([]);
  });

  // An env that carries the app's PUBLIC identity must resolve to the deploy hostname.
  // Pinned to loopback it passes the 127.0.0.1 smoke test and then breaks on the real
  // domain (baserow 404s, wallabag stores localhost links) — the one failure mode no
  // signal vops emits can catch. `*EXTRA*` vars are additional-host allow-lists, not
  // the app's identity, so a loopback entry there is correct.
  const PUBLIC_URL_ENV = /(^|_)(PUBLIC_URL|DOMAIN_NAME|APP_URL|SITE_URL|BASE_URL|ROOT_URL|EXTERNAL_URL|DOMAIN)$/;
  it('resolves every public-URL env to {{app.domain}}, never to loopback', () => {
    const offenders: string[] = [];
    for (const e of entries) {
      if (!checkInstallable(e.manifest).ok) continue;
      const plan = normalizeManifest(e.manifest, e.id);
      for (const c of plan.components) {
        for (const env of c.env) {
          if (!PUBLIC_URL_ENV.test(env.name) || env.name.includes('EXTRA')) continue;
          if (!env.value.includes('{{app.domain}}')) offenders.push(`${e.id}: ${env.name}=${env.value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Baserow 404s any Host it was not told about, so templating its public URL alone
  // would move the breakage onto the loopback smoke and roll every deploy back.
  it('keeps baserow answering on the smoke host while its public URL follows the domain', () => {
    const baserow = normalizeManifest(getCatalogEntry('baserow')!.manifest, 'baserow');
    const env = baserow.components[0].env;
    expect(baserow.needsAppDomain).toBe(true);
    expect(env.find((e) => e.name === 'BASEROW_PUBLIC_URL')?.value).toBe('https://{{app.domain}}');
    expect(env.find((e) => e.name === 'BASEROW_EXTRA_PUBLIC_URLS')?.value).toContain('127.0.0.1');
  });

  // The scheme is a deploy-time decision (`--tls` / `--no-tls`), not manifest text. Five
  // manifests write `https://{{app.domain}}`; behind `--no-tls` nothing serves TLS on that
  // hostname, so a resolved env claiming https makes the app build every link and redirect
  // against an origin that does not answer. Swept over the whole catalog because the next
  // manifest to write `https://` in front of the token must not reintroduce it.
  const NO_TLS_HOST = 'no-tls.example.com';
  const bindingFor = (plan: ReturnType<typeof normalizeManifest>, tls: boolean): IngressBinding => ({
    hostname: NO_TLS_HOST,
    tls,
    exposeDirect: false,
    routes: routedPorts(plan).map((rp) => ({ component: rp.component, containerPort: rp.containerPort, path: rp.path, stripPrefix: rp.stripPrefix })),
  });
  const resolvedEnv = (id: string, tls: boolean): { name: string; value: string }[] => {
    const plan = normalizeManifest(getCatalogEntry(id)!.manifest, id);
    if (!routedPorts(plan).length) return [];
    planHostDeploy(plan, conformanceFacts(), '203.0.113.9', bindingFor(plan, tls));
    return plan.components.flatMap((c) => c.env);
  };

  it('never resolves an env to https:// on a --no-tls deploy', () => {
    const offenders: string[] = [];
    for (const e of entries) {
      if (!checkInstallable(e.manifest).ok) continue;
      for (const env of resolvedEnv(e.id, false)) {
        if (env.value.includes(`https://${NO_TLS_HOST}`)) offenders.push(`${e.id}: ${env.name}=${env.value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still resolves those same envs to https:// when the deploy has TLS', () => {
    const offenders: string[] = [];
    for (const e of entries) {
      if (!checkInstallable(e.manifest).ok) continue;
      for (const env of resolvedEnv(e.id, true)) {
        if (env.value.includes(`http://${NO_TLS_HOST}`)) offenders.push(`${e.id}: ${env.name}=${env.value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // A Host-header allow-list is a DNS-rebinding guard, so a manifest may not ship it
  // wide open (`*`) — the value has to follow the deploy host. `{{app.domain}}` is that value:
  // the routed hostname behind an ingress, the loopback host:port of a bare install.
  const HOST_ALLOWLIST_ENV = /(^|_)(ALLOWED_HOSTS?|TRUSTED_DOMAINS?|ALLOWED_ORIGINS?|CORS_ORIGINS?)$/;
  it('never ships a host allow-list as a wildcard — it follows {{app.domain}}', () => {
    const offenders: string[] = [];
    for (const e of entries) {
      if (!checkInstallable(e.manifest).ok) continue;
      for (const c of normalizeManifest(e.manifest, e.id).components) {
        for (const env of c.env) {
          if (!HOST_ALLOWLIST_ENV.test(env.name)) continue;
          if (!env.value.includes('{{app.domain}}')) offenders.push(`${e.id}: ${env.name}=${env.value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // A manifest that turns the app's own login OFF must not also declare `auth.mode: native`:
  // that declaration is what vops reads to decide whether a public domain leaves the app naked
  // (dbgate shipped SKIP_ALL_AUTH=true behind `native` and was exposed silently).
  const AUTH_OFF_SWITCH = /(^|_)(SKIP|NO|DISABLE)_?[A-Z_]*AUTH/;
  const AUTH_TOGGLE = /(AUTH|LOGIN)$|AUTH[A-Z]*$/;
  const FALSY = new Set(['false', '0', 'no', 'off']);
  const TRUTHY = new Set(['true', '1', 'yes', 'on']);
  it('never declares native auth while an env switches that auth off', () => {
    const offenders: string[] = [];
    for (const e of entries) {
      if (!checkInstallable(e.manifest).ok) continue;
      const plan = normalizeManifest(e.manifest, e.id);
      for (const c of plan.components) {
        for (const env of c.env) {
          const v = env.value.trim().toLowerCase();
          const off = AUTH_OFF_SWITCH.test(env.name) ? TRUTHY.has(v) : AUTH_TOGGLE.test(env.name) && FALSY.has(v);
          if (off && plan.authMode === 'native') offenders.push(`${e.id}: ${env.name}=${env.value} with auth.mode native`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The manifest's absent login reaches the deploy gate, and there it REFUSES an
  // ungated domain instead of warning past it.
  it('carries dbgate\'s absent login into the deploy gate as a refusal', () => {
    const plan = normalizeManifest(getCatalogEntry('dbgate')!.manifest, 'dbgate');
    expect(plan.authMode).toBe('none');
    const gate = { hasIngress: true, accessMode: plan.access?.mode, authMode: plan.authMode };
    expect(() => resolveDeployGate(plan.name, gate)).toThrow(/no login of its own/i);
    expect(resolveDeployGate(plan.name, { ...gate, intent: { mode: 'none' as const } })).toBeNull();
  });

  // A domain can only be attached to an app that offers an ingress route, and the only
  // thing that produces one is a port with `expose: true, protocol: http`. An entry whose
  // appKind promises a user-facing surface while every port is blocked cannot be installed
  // the way the catalog describes it (meilisearch and minio both shipped that way).
  const USER_FACING = new Set<string>([ApplicationKind.APPLICATION, ApplicationKind.TOOL]);
  it('gives every user-facing appKind a routable HTTP port', () => {
    const offenders: string[] = [];
    for (const e of entries) {
      if (!USER_FACING.has(String(e.appKind)) || !checkInstallable(e.manifest).ok) continue;
      const plan = normalizeManifest(e.manifest, e.id);
      if (!routedPorts(plan).length) offenders.push(`${e.id}: appKind ${e.appKind} routes nothing`);
    }
    expect(offenders).toEqual([]);
  });

  // The inverse: a headless kind must not be the thing a user is told to open in a browser.
  it('keeps meilisearch headless and routes minio through its console only', () => {
    const meili = getCatalogEntry('meilisearch')!;
    expect(meili.appKind).toBe(ApplicationKind.DATABASE);
    expect(meili.description ?? '').not.toMatch(/dashboard/i);
    expect(routedPorts(normalizeManifest(meili.manifest, 'meilisearch'))).toEqual([]);

    const minio = normalizeManifest(getCatalogEntry('minio')!.manifest, 'minio');
    expect(routedPorts(minio).map((r) => r.containerPort)).toEqual([9001]);
    // The S3 port carries MinIO's admin API — it stays off the host, and off `--public`.
    expect(minio.components[0].ports.find((p) => p.container === 9000)?.expose).toBe(false);
    expect(minio.authMode).toBe('native');
  });

  // Wallabag's image provisions its own database — schema plus the default
  // wallabag/wallabag login — inside one branch of its entrypoint, gated on BOTH being handed
  // the MariaDB root password AND the database still being absent. Satisfy neither (no
  // MYSQL_ROOT_PASSWORD on the app, MARIADB_DATABASE pre-creating the schema) and every install
  // comes up serving HTTP 500 on a schema-less database.
  it('hands wallabag the MariaDB root password and leaves the database for it to create', () => {
    const plan = normalizeManifest(getCatalogEntry('wallabag')!.manifest, 'wallabag');
    const db = plan.components.find((c) => c.name === 'db')!;
    const app = plan.components.find((c) => c.name === 'app')!;

    const root = db.secrets.find((s) => s.target === 'MARIADB_ROOT_PASSWORD')!;
    expect(root.generate).toBeDefined();
    // The SAME podman secret, injected under the name the entrypoint reads.
    expect(app.secrets.find((s) => s.target === 'MYSQL_ROOT_PASSWORD')?.name).toBe(root.name);

    // Pre-creating db/user makes the entrypoint print "already configured" and skip the install.
    expect(db.env.map((e) => e.name)).not.toContain('MARIADB_DATABASE');
    expect(db.env.map((e) => e.name)).not.toContain('MARIADB_USER');
    expect(app.env.find((e) => e.name === 'SYMFONY__ENV__DATABASE_NAME')?.value).toBe('wallabag');
    expect(app.secrets.some((s) => s.target === 'SYMFONY__ENV__DATABASE_PASSWORD')).toBe(true);

    const unit = renderDeploy(plan, { selinux: false, ports: {} }).units['vops-wallabag-app.container'];
    expect(unit).toContain(`Secret=source=${root.name},type=env,target=MYSQL_ROOT_PASSWORD`);
  });

  it('OpenClaw offers any one LLM provider key (grouped), Telegram optional', () => {
    const oc = getCatalogEntry('openclaw')!;
    const llm = oc.inputs.filter((i) => i.group === 'llm').map((i) => i.name);
    expect(llm).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']));
    expect(oc.inputs.find((i) => i.name === 'TELEGRAM_BOT_TOKEN')?.required).toBe(false);
  });
});
