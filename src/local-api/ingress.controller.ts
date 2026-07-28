import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { VopsIngressService } from '../apps/vops-ingress.service';
import { ProxyKind, isProxyKind } from '../apps/ingress-proxy';

/** Ingress surface for the local UI — status + lifecycle. Drives the same service as the CLI. */
@Controller('api/ingress')
export class IngressController {
  constructor(private readonly ingress: VopsIngressService) {}

  @Get(':host')
  status(@Param('host') host: string) {
    return this.ingress.status(host);
  }

  /** Hostnames this install could use, ranked — so the UI can offer instead of ask. */
  @Get(':host/domain-options/:name')
  domainOptions(@Param('host') host: string, @Param('name') name: string) {
    return this.ingress.domainOptions(host, name);
  }

  @Post(':host/up')
  up(@Param('host') host: string, @Body() body: { email?: string; proxy?: string }) {
    const proxy = body?.proxy;
    if (proxy !== undefined && !isProxyKind(proxy)) throw new BadRequestException("proxy must be 'traefik' or 'caddy'.");
    return this.ingress.up(host, { email: body?.email, proxy: proxy as ProxyKind | undefined });
  }

  @Post(':host/down')
  down(@Param('host') host: string, @Body() body: { force?: boolean; purge?: boolean; yes?: boolean }) {
    if (body?.yes !== true) throw new BadRequestException('Confirmation required: pass yes=true.');
    return this.ingress.down(host, { force: body.force, purge: body.purge });
  }
}
