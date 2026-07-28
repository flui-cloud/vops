import { loadCatalog, getCatalogEntry, estimateInstallSeconds } from '../src/apps/catalog';
import { checkInstallable, normalizeManifest } from '../src/apps/spec-normalize';

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

  it('OpenClaw offers any one LLM provider key (grouped), Telegram optional', () => {
    const oc = getCatalogEntry('openclaw')!;
    const llm = oc.inputs.filter((i) => i.group === 'llm').map((i) => i.name);
    expect(llm).toEqual(expect.arrayContaining(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']));
    expect(oc.inputs.find((i) => i.name === 'TELEGRAM_BOT_TOKEN')?.required).toBe(false);
  });
});
