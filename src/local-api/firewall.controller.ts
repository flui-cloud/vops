import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { VopsFirewallService } from '../firewall/vops-firewall.service';
import { VopsFirewallCreateInput, VopsFirewallRule } from '../dto/firewall.dto';

/** Firewall lifecycle endpoints — same service the CLI uses (idempotent surface). */
@Controller('api/firewalls')
export class FirewallController {
  constructor(private readonly firewalls: VopsFirewallService) {}

  @Get()
  list(@Query('provider') provider: string) {
    return this.firewalls.list(provider);
  }

  @Get(':id')
  show(@Param('id') id: string, @Query('provider') provider: string) {
    return this.firewalls.show(provider, id);
  }

  @Post()
  create(@Body() body: VopsFirewallCreateInput & { dryRun?: boolean; yes?: boolean }) {
    return this.firewalls.create(body, { dryRun: body.dryRun, yes: body.yes });
  }

  @Put(':id/rules')
  updateRules(
    @Param('id') id: string,
    @Body() body: { provider: string; rules: VopsFirewallRule[] },
  ) {
    return this.firewalls.updateRules(body.provider, id, body.rules);
  }

  @Post(':id/apply')
  apply(
    @Param('id') id: string,
    @Body() body: { provider: string; serverIds: string[]; remove?: boolean },
  ) {
    return body.remove
      ? this.firewalls.remove(body.provider, id, body.serverIds)
      : this.firewalls.apply(body.provider, id, body.serverIds);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('provider') provider: string,
    @Query('dryRun') dryRun?: string,
    @Query('yes') yes?: string,
  ) {
    return this.firewalls.delete(provider, id, {
      dryRun: dryRun === 'true',
      yes: yes === 'true',
    });
  }
}
