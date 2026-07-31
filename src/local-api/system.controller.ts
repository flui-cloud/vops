import { Controller, Get } from '@nestjs/common';
import * as path from 'node:path';
import { resolveContext, serviceStatus } from '../service/index';

/** Local-app metadata the dashboard needs about its own host process. */
@Controller('api')
export class SystemController {
  /**
   * Whether the background service is set up, so the installed PWA can nudge
   * toward `vops service install` instead of opening onto a dead server.
   *
   * `bin/run` is only ever used to *render* a unit; a status read doesn't need
   * it, but the context type does, and this process is running that entrypoint.
   */
  @Get('ui-service')
  uiService() {
    const binRun = path.join(__dirname, '..', '..', 'bin', 'run');
    return serviceStatus(resolveContext({ binRun }));
  }
}
