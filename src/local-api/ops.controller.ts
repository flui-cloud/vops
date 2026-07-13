import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { VopsCatalogService } from '../catalog/vops-catalog.service';
import { VopsServersService } from '../servers/vops-servers.service';
import { VopsPlanFile } from '../dto/plan-file.dto';

/** Compare + server lifecycle endpoints — same services the CLI uses. */
@Controller('api')
export class OpsController {
  constructor(
    private readonly catalog: VopsCatalogService,
    private readonly servers: VopsServersService,
  ) {}

  @Post('compare')
  compare(
    @Body()
    body: {
      cpu?: number;
      ramGb?: number;
      region?: string;
      provider?: string;
      hourlyOnly?: boolean;
      refresh?: boolean;
      includeDeprecated?: boolean;
    },
  ) {
    return this.catalog.compare(body);
  }

  @Post('servers/plan')
  plan(
    @Body()
    body: {
      provider: string;
      plan: string;
      location: string;
      image?: string;
      name?: string;
      sshKey?: string;
    },
  ) {
    return this.servers.plan(body);
  }

  @Post('servers/create')
  create(
    @Body() body: { plan: VopsPlanFile; dryRun?: boolean; yes?: boolean },
  ) {
    return this.servers.create(body.plan, {
      dryRun: !!body.dryRun,
      yes: !!body.yes,
    });
  }

  @Get('servers')
  listServers(@Query('provider') provider: string) {
    return this.servers.list(provider);
  }

  @Get('servers/:id')
  showServer(@Param('id') id: string, @Query('provider') provider: string) {
    return this.servers.show(provider, id);
  }

  @Delete('servers/:id')
  deleteServer(
    @Param('id') id: string,
    @Query('provider') provider: string,
    @Query('force') force?: string,
  ) {
    return this.servers.delete(provider, id, force === 'true');
  }
}
