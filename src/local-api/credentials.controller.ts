import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { VopsCredentialsService } from '../credentials/vops-credentials.service';

/**
 * Provider credential management for the UI. Values flow in over the
 * 127.0.0.1-only, session-guarded API and land in the encrypted store; only
 * field metadata and a "configured" flag ever come back out.
 */
@Controller('api/credentials')
export class CredentialsController {
  constructor(private readonly credentials: VopsCredentialsService) {}

  @Get()
  list() {
    return this.credentials.list();
  }

  @Post(':provider')
  save(
    @Param('provider') provider: string,
    @Body() body: { values?: Record<string, string> },
  ) {
    return this.credentials.save(provider, body?.values);
  }

  @Delete(':provider')
  remove(@Param('provider') provider: string) {
    return this.credentials.remove(provider);
  }
}
