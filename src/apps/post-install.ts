/** `spec.postInstall` reduced to what vops can honestly run: the manifest says what to run, this
 * decides *whether* it runs here. vops has no identity provider and never prompts for install-time
 * option toggles, so only the app's own login and manifest-default options are in scope — anything
 * gated on more is skipped, correctly, not as a limitation to work around. */
import type { CatalogAuth, CatalogAuthMode, CatalogOption, CatalogPostInstallStep } from '@flui-cloud/spec';
import { shq } from './app-scripts';
import { AppPostInstallStep } from './app.model';

export interface PostInstallContext {
  /** Logical name of the primary component — the default target of an exec. */
  primary: string;
  auth?: CatalogAuth;
  options?: CatalogOption[];
}

const FQDN = '{{install.resolvedFqdn}}';

/** The auth mode vops actually deploys — `oidc`/`proxy` need an IdP vops does not run, so a
 * manifest defaulting to one falls back to the app's own login. */
export function effectiveAuthMode(auth?: CatalogAuth): CatalogAuthMode {
  const declared = auth?.mode ?? auth?.default;
  if (declared && declared !== 'oidc' && declared !== 'proxy') return declared;
  return (auth?.modes ?? []).find((m) => m === 'native' || m === 'none') ?? 'none';
}

/** The steps to run, in manifest order. Only `exec` steps: the one `http` step in the catalog
 * today (immich's admin bootstrap) is gated to `oidc`, so the gate already excludes it. */
export function selectPostInstall(
  steps: CatalogPostInstallStep[] | undefined,
  ctx: PostInstallContext,
): AppPostInstallStep[] {
  const mode = effectiveAuthMode(ctx.auth);
  const enabled = new Set((ctx.options ?? []).filter((o) => o.default).map((o) => o.key));
  return (steps ?? []).flatMap((s) => {
    const exec = s.exec;
    if (!exec?.command?.length || !gateOpen(s.when, mode, enabled)) return [];
    return [
      {
        name: s.name,
        component: exec.container ?? ctx.primary,
        command: exec.command,
        needsFqdn: exec.command.some((a) => a.includes(FQDN)),
      },
    ];
  });
}

function gateOpen(
  when: CatalogPostInstallStep['when'],
  mode: CatalogAuthMode,
  enabled: ReadonlySet<string>,
): boolean {
  if (!when) return true;
  if (when.option && !enabled.has(when.option)) return false;
  if (!when.authMode) return true;
  const wanted = Array.isArray(when.authMode) ? when.authMode : [when.authMode];
  return wanted.includes(mode);
}

/** Substitute the deploy-time values — null when the step needs a domain there isn't. */
export function resolveCommand(step: AppPostInstallStep, vars: { fqdn?: string; name: string }): string[] | null {
  if (step.needsFqdn && !vars.fqdn) return null;
  return step.command.map((arg) =>
    arg.replaceAll(FQDN, vars.fqdn ?? '').replaceAll('{{install.name}}', vars.name),
  );
}

export interface PostInstallScriptInput {
  runs: Array<{ name: string; container: string; command: string[] }>;
  /** Restarted after the steps so a config file written here is actually read. */
  services: string[];
}

/** Run each step, then restart. The command is never echoed, output shown only on failure —
 * a postInstall command is the one place a manifest may legitimately carry a credential. */
export function buildPostInstallScript(input: PostInstallScriptInput): string {
  return [
    'set +e',
    'VOPS_PI_FAIL=$(mktemp)',
    "echo '@@steps'",
    ...input.runs.flatMap((r) => [
      `OUT=$(podman exec ${shq(r.container)} ${r.command.map(shq).join(' ')} 2>&1); RC=$?`,
      `echo "${r.name}=$RC"`,
      `[ "$RC" -eq 0 ] || { echo "### ${r.name}" >>"$VOPS_PI_FAIL"; echo "$OUT" | tail -6 >>"$VOPS_PI_FAIL"; }`,
    ]),
    "echo '@@restart'",
    ...input.services.map((s) => `systemctl restart ${shq(s)} >/dev/null 2>&1; echo "${s}=$(systemctl is-active ${shq(s)} 2>/dev/null)"`),
    "echo '@@diag'",
    'cat "$VOPS_PI_FAIL" 2>/dev/null; rm -f "$VOPS_PI_FAIL"',
    "echo '@@done'",
  ].join('\n');
}

export interface PostInstallOutcome {
  /** Step names that exited non-zero, with the tail of their output. */
  failed: Array<{ name: string; detail: string }>;
  /** Services that did not come back active after the restart. */
  notActive: string[];
}

export function parsePostInstallOutput(stdout: string): PostInstallOutcome {
  const [, steps = '', restart = '', diag = ''] = stdout.split(/^@@(?:steps|restart|diag|done)$/m);
  const details = new Map<string, string>();
  for (const chunk of diag.split('### ').slice(1)) {
    const nl = chunk.indexOf('\n');
    if (nl > 0) details.set(chunk.slice(0, nl).trim(), chunk.slice(nl + 1).trim());
  }
  return {
    failed: keyValues(steps)
      .filter(([, code]) => code !== '0')
      .map(([name]) => ({ name, detail: details.get(name) ?? '' })),
    notActive: keyValues(restart).filter(([, state]) => state !== 'active').map(([unit]) => unit),
  };
}

function keyValues(block: string): Array<[string, string]> {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('='))
    .map((l) => {
      const i = l.lastIndexOf('=');
      return [l.slice(0, i), l.slice(i + 1)] as [string, string];
    });
}
