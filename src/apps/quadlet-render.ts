import { AppComponentPlan, AppPlan, AppSecretPlan, PublishedPort } from './app.model';

/** Pure Quadlet renderer (Podman 5+). Standalone apps → one `.container`; composed apps → a
 * `.pod` + one `.container` per component with `Pod=`, sharing the pod's netns (127.0.0.1, no
 * bridge/aardvark-dns/static-IP hack). Everything namespaced `vops-<app>-*` to avoid k3s collisions. */
export interface RenderContext {
  /** SELinux enabled on the host → add `:Z` relabeling to volume mounts. */
  selinux: boolean;
  /** Resolved published ports per logical component name. */
  ports: Record<string, PublishedPort[]>;
}

export interface RenderedDeploy {
  /** Unit filename → content (all live in the app's unit dir). */
  units: Record<string, string>;
  /** Podman secrets to ensure on the host before daemon-reload. */
  secrets: AppSecretPlan[];
  /** Pod name, when the app is composed. */
  pod?: string;
}

export function renderDeploy(plan: AppPlan, ctx: RenderContext): RenderedDeploy {
  const units: Record<string, string> = {};

  if (plan.pod) units[`${plan.pod}.pod`] = renderPod(plan, ctx);
  for (const comp of plan.components) {
    for (const vol of comp.volumes) units[`${vol.volume}.volume`] = renderVolume(vol.volume);
    units[`${comp.container}.container`] = renderContainer(plan, comp, ctx);
  }

  return { units, secrets: dedupeSecrets(plan), pod: plan.pod };
}

/** The pod owns the published ports (containers inside publish nothing individually). */
function renderPod(plan: AppPlan, ctx: RenderContext): string {
  const publishes = plan.components.flatMap((c) => (ctx.ports[c.name] ?? []).map(publish));
  return section('Unit', [`Description=vops pod ${plan.pod}`])
    .concat(section('Pod', [`PodName=${plan.pod}`, ...publishes]))
    .concat(section('Install', ['WantedBy=default.target']))
    .join('\n');
}

function renderVolume(name: string): string {
  return section('Unit', [`Description=vops volume ${name}`])
    .concat(section('Volume', [`VolumeName=${name}`]))
    .join('\n');
}

function renderContainer(plan: AppPlan, comp: AppComponentPlan, ctx: RenderContext): string {
  const inPod = !!plan.pod;
  const unitLines = [`Description=vops app ${plan.name} / ${comp.name}`, ...afterDeps(plan, comp)];

  const container: string[] = [
    `ContainerName=${comp.container}`,
    `Image=${comp.image}`,
    // In a pod the network (and published ports) belong to the pod; standalone
    // publishes directly.
    ...(inPod ? [`Pod=${plan.pod}.pod`] : (ctx.ports[comp.name] ?? []).map(publish)),
    ...comp.env.map((e) => `Environment=${e.name}=${e.value}`),
    ...comp.secrets.map((s) => `Secret=source=${s.name},type=env,target=${s.target}`),
    ...comp.volumes.map((v) => `Volume=${v.volume}.volume:${v.mountPath}${ctx.selinux ? ':Z' : ''}`),
    ...(comp.command ? execLines(comp.command) : []),
    ...healthLines(comp),
    ...podmanArgs(comp),
  ];

  const service = ['Restart=always', 'RestartSec=5', 'TimeoutStartSec=300'];
  const install = ['WantedBy=default.target'];

  return section('Unit', unitLines)
    .concat(section('Container', container))
    .concat(section('Service', service))
    .concat(section('Install', install))
    .join('\n');
}

/** Ordering only (not Requires): start after depended-on components' services. */
function afterDeps(plan: AppPlan, comp: AppComponentPlan): string[] {
  return comp.dependsOn
    .map((dep) => {
      const target = plan.components.find((c) => c.name === dep);
      return target ? `After=${target.container}.service` : '';
    })
    .filter(Boolean);
}

function publish(p: PublishedPort): string {
  return `PublishPort=${p.bind}:${p.host}:${p.container}`;
}

/** Render `['sh','-c','<script>']` as Quadlet `Entrypoint=`/`Exec=` — the image's own ENTRYPOINT
 * must be OVERRIDDEN (e.g. pgweb's is `pgweb`, so bare `Exec=sh -c …` fails) so `sh` becomes the
 * Entrypoint. Each arg with metacharacters is single-quoted to survive as one unit-file line. */
function execLines(command: string[]): string[] {
  const [entry, ...args] = command;
  const quoted = args.map((arg) =>
    /^[\w./:=@-]+$/.test(arg) ? arg : `'${arg.replaceAll(/\s+/g, ' ').trim()}'`,
  );
  return [`Entrypoint=${entry}`, ...(quoted.length ? [`Exec=${quoted.join(' ')}`] : [])];
}

// Only render a container healthcheck when the manifest gives an explicit command
// (exec type). For http/tcp the real deploy gate is the host-side smoke test —
// a curl/wget HealthCmd would false-fail on images that ship neither tool.
function healthLines(comp: AppComponentPlan): string[] {
  const h = comp.health;
  if (h?.type !== 'exec' || !h.command?.length) return [];
  return [
    `HealthCmd=${h.command.join(' ')}`,
    ...(h.interval ? [`HealthInterval=${h.interval}`] : []),
    ...(h.timeout ? [`HealthTimeout=${h.timeout}`] : []),
    ...(h.retries ? [`HealthRetries=${h.retries}`] : []),
  ];
}

function podmanArgs(comp: AppComponentPlan): string[] {
  const args = [
    ...(comp.memory ? [`--memory=${comp.memory}`] : []),
    ...(comp.cpu ? [`--cpus=${comp.cpu}`] : []),
  ];
  return args.length ? [`PodmanArgs=${args.join(' ')}`] : [];
}

/**
 * A cross-injected secret appears on every component that consumes it, but must be
 * CREATED once. Dedupe by name, keeping the entry that owns the material.
 */
function dedupeSecrets(plan: AppPlan): AppSecretPlan[] {
  const byName = new Map<string, AppSecretPlan>();
  for (const s of plan.components.flatMap((c) => c.secrets)) {
    const existing = byName.get(s.name);
    if (!existing || (!existing.generate && existing.value === undefined)) byName.set(s.name, s);
  }
  return [...byName.values()];
}

function section(name: string, lines: string[]): string[] {
  return [`[${name}]`, ...lines, ''];
}
