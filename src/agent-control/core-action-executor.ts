import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { listCatalog, describeCatalog } from '../apps/catalog-view';
import { VopsAgentApiService } from '../agent-api/vops-agent-api.service';
import { VopsAppsService } from '../apps/vops-apps.service';
import { VopsCatalogService } from '../catalog/vops-catalog.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHostStatusService } from '../host-ops/vops-host-status.service';
import { readPlanFile } from '../lib/plan-io';
import { VopsProvidersService } from '../providers/vops-providers.service';
import { VopsServersService } from '../servers/vops-servers.service';
import { VopsSpecService } from '../spec/vops-spec.service';
import { AgentPlan, AgentSession } from './agent-model';
import { AgentControlError } from './agent-control-error';
import { AgentSessionManager } from './agent-session-manager';
import { VopsHostHardenService } from '../host-ops/vops-host-harden.service';
import { VopsServerFirewallService } from '../firewall/vops-server-firewall.service';
import { parseServiceSpec } from '../firewall/firewall-services';

export interface CoreExecutionContext {
  session: AgentSession;
  plan: AgentPlan;
  operationId: string;
}

@Injectable()
export class CoreActionExecutor {
  constructor(
    private readonly providers: VopsProvidersService,
    private readonly catalog: VopsCatalogService,
    private readonly hosts: VopsHostsService,
    private readonly hostStatus: VopsHostStatusService,
    private readonly servers: VopsServersService,
    private readonly apps: VopsAppsService,
    private readonly agentApi: VopsAgentApiService,
    private readonly spec: VopsSpecService,
    private readonly harden: VopsHostHardenService,
    private readonly firewall: VopsServerFirewallService,
    private readonly sessions: AgentSessionManager,
  ) {}

  async execute(
    capability: string,
    input: Record<string, unknown>,
    context: CoreExecutionContext,
  ): Promise<unknown> {
    switch (capability) {
      case 'repository.inspect':
        return inspectRepository(assertRepository(input.repository, context.session));
      case 'flui_spec.read':
        return readSpec(input, context.session);
      case 'flui_spec.generate':
        return this.generateSpec(input, context.session);
      case 'flui_spec.validate':
        return this.spec.validate(assertRepoFile(context.session, String(input.file)));
      case 'catalog.list':
        return listCatalogByKind(String(input.kind ?? 'all'));
      case 'catalog.describe':
        return describeCatalog(String(input.id));
      case 'catalog.install':
        return this.apps.deploy(
          { catalog: String(input.catalog) },
          String(input.host),
          {
            name: input.name ? String(input.name) : undefined,
            public: input.public === undefined ? undefined : Boolean(input.public),
            dryRun: false,
          },
        );
      case 'provider.list':
        return this.providers.list();
      case 'provider.prices.compare':
        return this.compareProviders(input);
      case 'target.list':
        return withinScope(this.hosts.list(), context.session);
      case 'target.inspect':
        return this.inspectTarget(String(input.target));
      case 'server.list':
        return this.servers.list(String(input.provider));
      case 'server.inspect':
        return this.servers.show(String(input.provider), String(input.id));
      case 'server.provision':
        return this.provision(input, context);
      case 'server.destroy':
        await this.servers.delete(String(input.provider), String(input.id));
        return { destroyed: true, provider: input.provider, id: input.id };
      case 'server.harden':
        return this.harden.harden(String(input.target), {
          user: input.user ? String(input.user) : undefined,
          steps: Array.isArray(input.steps) ? input.steps.map(String) : undefined,
          dryRun: false,
        });
      case 'application.plan_deploy':
        return this.agentApi.plan({
          projectDir: assertRepository(input.projectDir, context.session),
          spec: assertRepoFile(context.session, String(input.spec)),
          host: String(input.host),
          ...(input.image ? { image: String(input.image) } : {}),
          ...(input.name ? { name: String(input.name) } : {}),
          ...(input.domain ? { domain: String(input.domain) } : {}),
          ...(input.tls === undefined ? {} : { tls: Boolean(input.tls) }),
          ...(input.staging === undefined ? {} : { staging: Boolean(input.staging) }),
          ...(input.auth ? { auth: String(input.auth) } : {}),
          ...(input.public === undefined ? {} : { public: Boolean(input.public) }),
        });
      case 'application.deploy':
        return this.agentApi.apply(
          assertRepository(input.projectDir, context.session),
          String(input.planId),
          true,
        );
      case 'application.status':
        return this.apps.status(...appRef(input));
      case 'application.restart':
        return this.apps.restart(...appRef(input));
      case 'logs.read_recent':
        return this.readRecentLogs(input);
      case 'healthcheck.run':
        return this.agentApi.verify(...appRef(input));
      case 'firewall.inspect':
        return this.firewall.get(String(input.target));
      case 'firewall.open_port':
        return this.openFirewallPort(input);
      case 'firewall.close_port':
        return this.closeFirewallPort(input);
      default:
        throw new AgentControlError(
          'VOPS_AGENT_UNSUPPORTED',
          `Capability '${capability}' has no executor.`,
          'failed',
        );
    }
  }

  private async readRecentLogs(input: Record<string, unknown>): Promise<unknown> {
    const [name, host] = appRef(input);
    const text = await this.apps.logs(name, Number(input.lines ?? 200), host);
    return { name, ...(host ? { host } : {}), lines: text.split('\n') };
  }

  private generateSpec(input: Record<string, unknown>, session: AgentSession): unknown {
    const repository = assertRepository(input.repository, session);
    const output = assertPathInside(repository, path.resolve(repository, String(input.outputFile ?? 'flui.yaml')));
    return this.spec.generate(
      String(input.template),
      { name: String(input.name) },
      { outputFile: output, force: Boolean(input.force) },
    );
  }

  private async compareProviders(input: Record<string, unknown>): Promise<unknown[]> {
    const rows = await this.catalog.compare({
      cpu: numberOrUndefined(input.minVcpu),
      ramGb: numberOrUndefined(input.minMemoryGiB),
      refresh: Boolean(input.refresh),
    });
    const providers = Array.isArray(input.providers) ? new Set(input.providers.map(String)) : null;
    return providers ? rows.filter((row) => providers.has(row.provider)) : rows;
  }

  private async inspectTarget(target: string): Promise<unknown> {
    const host = this.hosts.show(target);
    const status = await this.hostStatus.status(target);
    return { host, status };
  }

  /** The budget is booked before the provider call, not after: a create that succeeds but
   * whose response is lost still spent the money, so the session must already own the debit. */
  private async provision(input: Record<string, unknown>, context: CoreExecutionContext): Promise<unknown> {
    const plan = readPlanFile(assertRepoFile(context.session, String(input.planFile)));
    const monthly = plan.estimatedCost.monthly ?? ((plan.estimatedCost.hourly ?? 0) * 730);
    await this.sessions.commitProviderSpend(context.session.id, monthly);
    return this.servers.create(plan, { dryRun: false, yes: true });
  }

  private async openFirewallPort(input: Record<string, unknown>): Promise<unknown> {
    const target = String(input.target);
    const current = await this.firewall.get(target);
    const service = parseServiceSpec(String(input.service));
    const retained = current.services.filter((entry) => entry.id !== service.id);
    return this.firewall.set(target, [...retained, service]);
  }

  private async closeFirewallPort(input: Record<string, unknown>): Promise<unknown> {
    const target = String(input.target);
    const current = await this.firewall.get(target);
    const service = parseServiceSpec(String(input.service));
    return this.firewall.set(
      target,
      current.services.filter((entry) => !(entry.protocol === service.protocol && entry.port === service.port)),
    );
  }
}

function inspectRepository(repository: string): unknown {
  const names = fs.readdirSync(repository, { withFileTypes: true });
  const files = names.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const directories = names.filter((entry) => entry.isDirectory() && entry.name !== '.git').map((entry) => entry.name).sort();
  return {
    repository,
    name: path.basename(repository),
    files,
    directories,
    hasFluiSpec: files.includes('flui.yaml') || files.includes('flui.yml'),
    hasPackageJson: files.includes('package.json'),
  };
}

function readSpec(input: Record<string, unknown>, session: AgentSession): unknown {
  const repository = assertRepository(input.repository, session);
  const file = assertPathInside(repository, path.resolve(repository, String(input.file ?? 'flui.yaml')));
  const yaml = fs.readFileSync(file, 'utf8');
  return {
    file,
    sha256: crypto.createHash('sha256').update(yaml).digest('hex'),
    yaml,
  };
}

function assertRepository(input: unknown, session: AgentSession): string {
  const requested = fs.realpathSync(path.resolve(String(input)));
  if (requested !== session.repository.path) {
    throw new AgentControlError(
      'VOPS_AGENT_SCOPE_DENIED',
      `Repository '${requested}' is outside this session.`,
      'denied',
    );
  }
  return requested;
}

function assertRepoFile(session: AgentSession, file: string): string {
  return assertPathInside(session.repository.path, path.resolve(session.repository.path, file));
}

function assertPathInside(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AgentControlError('VOPS_AGENT_SCOPE_DENIED', `Path '${candidate}' is outside the session repository.`, 'denied');
  }
  return candidate;
}

/** The (application, host) pair a host-scoped capability acts on. The host is what the
 * policy engine scope-checked, so it has to reach the install lookup unchanged. */
function appRef(input: Record<string, unknown>): [string, string | undefined] {
  const host = typeof input.host === 'string' && input.host ? input.host : undefined;
  if (typeof input.name !== 'string' || !input.name) {
    throw new AgentControlError('VOPS_AGENT_PLAN_INVALID', 'An application name is required.', 'failed');
  }
  return [input.name, host];
}

/** An agent scoped to named targets is shown those targets only — the rest of the
 * inventory is not its to enumerate. */
function withinScope<T extends { name: string }>(hosts: T[], session: AgentSession): T[] {
  if (!session.scope.targets.length) return hosts;
  return hosts.filter((host) => session.scope.targets.includes(host.name));
}

function listCatalogByKind(kind: string): unknown[] {
  if (kind === 'products') return listCatalog('product');
  if (kind === 'blocks') return listCatalog('block');
  return listCatalog();
}

function numberOrUndefined(value: unknown): number | undefined {
  return value === undefined ? undefined : Number(value);
}
