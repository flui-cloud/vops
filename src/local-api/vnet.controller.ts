import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { VopsVnetService } from '../vnet/vops-vnet.service';
import { VopsVnetCreateInput } from '../dto/vnet.dto';

/** Private-network lifecycle endpoints — same service the CLI uses. */
@Controller('api/vnets')
export class VnetController {
  constructor(private readonly vnets: VopsVnetService) {}

  @Get()
  list(@Query('provider') provider: string) {
    return this.vnets.list(provider);
  }

  @Get(':id')
  show(@Param('id') id: string, @Query('provider') provider: string) {
    return this.vnets.show(provider, id);
  }

  @Post()
  create(@Body() body: VopsVnetCreateInput & { dryRun?: boolean; yes?: boolean }) {
    return this.vnets.create(body, { dryRun: body.dryRun, yes: body.yes });
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query('provider') provider: string,
    @Query('dryRun') dryRun?: string,
    @Query('yes') yes?: string,
  ) {
    return this.vnets.delete(provider, id, {
      dryRun: dryRun === 'true',
      yes: yes === 'true',
    });
  }

  @Post(':id/attach')
  attach(
    @Param('id') id: string,
    @Body() body: { provider: string; serverId: string; detach?: boolean },
  ) {
    return body.detach
      ? this.vnets.detach(body.provider, id, body.serverId)
      : this.vnets.attach(body.provider, id, body.serverId);
  }

  @Post(':id/subnet')
  subnet(
    @Param('id') id: string,
    @Body()
    body: { provider: string; ipRange: string; networkZone?: string; remove?: boolean },
  ) {
    return body.remove
      ? this.vnets.deleteSubnet(body.provider, id, body.ipRange)
      : this.vnets.addSubnet(body.provider, id, body.networkZone ?? '', body.ipRange);
  }

  @Post(':id/route')
  route(
    @Param('id') id: string,
    @Body()
    body: { provider: string; destination: string; gateway: string; remove?: boolean },
  ) {
    return body.remove
      ? this.vnets.deleteRoute(body.provider, id, body.destination, body.gateway)
      : this.vnets.addRoute(body.provider, id, body.destination, body.gateway);
  }
}
