import { Controller, Get, Param, Query } from '@nestjs/common';
import { VopsProvidersService } from '../providers/vops-providers.service';
import { VopsCatalogService } from '../catalog/vops-catalog.service';
import { VopsRegionsService } from '../regions/vops-regions.service';

/** Read-only research endpoints — thin delegations to the shared services. */
@Controller('api/providers')
export class ProvidersController {
  constructor(
    private readonly providers: VopsProvidersService,
    private readonly catalog: VopsCatalogService,
    private readonly regions: VopsRegionsService,
  ) {}

  @Get()
  list() {
    return this.providers.list();
  }

  /** Unified region catalogue + "from" prices (map + region list). */
  @Get('regions')
  allRegions(@Query('refresh') refresh?: string) {
    return this.regions.regions(refresh === 'true');
  }

  @Get(':provider/capabilities')
  capabilities(@Param('provider') provider: string) {
    return this.providers.capabilities(provider);
  }

  @Get(':provider/locations')
  locations(@Param('provider') provider: string) {
    return this.providers.locations(provider);
  }

  @Get(':provider/plans')
  plans(@Param('provider') provider: string) {
    return this.catalog.plans(provider);
  }

  @Get(':provider/prices')
  async prices(@Param('provider') provider: string) {
    const plans = await this.catalog.plans(provider);
    return plans.sort((a, b) => (a.hourly ?? Infinity) - (b.hourly ?? Infinity));
  }

  @Get(':provider/availability')
  availability(
    @Param('provider') provider: string,
    @Query('family') family?: string,
  ) {
    return this.catalog.availability(provider, family);
  }
}
