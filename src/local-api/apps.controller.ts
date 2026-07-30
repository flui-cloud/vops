import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { VopsAppsService } from '../apps/vops-apps.service';
import { VopsAppShellService } from '../apps/app-shell.service';
import { IngressAuthIntent } from '../apps/ingress-auth';
import { loadCatalog } from '../apps/catalog';

interface IngressBody {
  domain?: string;
  email?: string;
  tls?: boolean;
  staging?: boolean;
  exposeDirect?: boolean;
  auth?: IngressAuthIntent;
}
interface DeployBody {
  catalog?: string;
  file?: string;
  host: string;
  name?: string;
  set?: Record<string, string>;
  ingress?: IngressBody;
  /** Opt into a public 0.0.0.0 bind; omitted/false keeps the safe loopback default. */
  public?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

/** Apps surface for the local UI — catalog, installs, and deploy/remove. Thin. */
@Controller('api/apps')
export class AppsController {
  constructor(
    private readonly apps: VopsAppsService,
    private readonly shell: VopsAppShellService,
  ) {}

  @Get()
  list(@Query('host') host?: string) {
    return this.apps.list(host);
  }

  @Get('catalog')
  catalog() {
    return loadCatalog().map(({ manifest, ...meta }) => meta);
  }

  @Get(':name')
  show(@Param('name') name: string, @Query('host') host?: string) {
    return this.apps.show(name, host);
  }

  @Get(':name/status')
  status(@Param('name') name: string, @Query('host') host?: string) {
    return this.apps.status(name, host);
  }

  @Post(':name/restart')
  restart(@Param('name') name: string, @Query('host') host?: string) {
    return this.apps.restart(name, host);
  }

  @Get(':name/logs')
  async logs(@Param('name') name: string, @Query('lines') lines?: string, @Query('host') host?: string) {
    return { logs: await this.apps.logs(name, lines ? Number.parseInt(lines, 10) : 200, host) };
  }

  /** Resolved container-shell session: the ssh command, never a session itself. */
  @Get(':name/shell')
  shellAccess(@Param('name') name: string, @Query('component') component?: string, @Query('host') host?: string) {
    return this.shell.access(name, { component }, host);
  }

  /** Hand that session to the user's own terminal app (same machine — 127.0.0.1 only). */
  @Post(':name/shell')
  shellLaunch(@Param('name') name: string, @Body() body: { component?: string; host?: string }) {
    return this.shell.launch(name, { component: body?.component }, body?.host);
  }

  /** Login block for an install; with `?secret=` reads that one back from the host. */
  @Get(':name/credentials')
  credentials(@Param('name') name: string, @Query('secret') secret?: string, @Query('host') host?: string) {
    return secret ? this.apps.revealCredential(name, secret, host) : this.apps.credentials(name, host);
  }

  @Post('preflight')
  preflight(@Body() body: { host: string }) {
    if (!body?.host) throw new BadRequestException('host is required.');
    return this.apps.preflight(body.host);
  }

  @Post('deploy')
  deploy(@Body() body: DeployBody) {
    if (!body?.host) throw new BadRequestException('host is required.');
    const source = body.catalog ? { catalog: body.catalog } : { file: body.file };
    const ingress = body.ingress && (body.ingress.domain || body.ingress.auth) ? body.ingress : undefined;
    return this.apps.deploy(source, body.host, { name: body.name, set: body.set, ingress, public: body.public, dryRun: !body.yes });
  }

  @Post(':name/expose')
  expose(@Param('name') name: string, @Body() body: IngressBody & { yes?: boolean; host?: string }) {
    if (body?.yes !== true) throw new BadRequestException('Confirmation required: pass yes=true.');
    return this.apps.expose(name, { domain: body.domain, email: body.email, tls: body.tls, staging: body.staging, exposeDirect: body.exposeDirect, auth: body.auth }, body.host);
  }

  @Post(':name/unexpose')
  unexpose(@Param('name') name: string, @Body() body: { yes?: boolean; host?: string }) {
    if (body?.yes !== true) throw new BadRequestException('Confirmation required: pass yes=true.');
    return this.apps.unexpose(name, body.host);
  }

  @Post(':name/remove')
  remove(@Param('name') name: string, @Body() body: { purge?: boolean; yes?: boolean; host?: string }) {
    if (body?.yes !== true) throw new BadRequestException('Confirmation required: pass yes=true.');
    return this.apps.remove(name, { purge: body.purge }, body.host);
  }
}
