import { Controller, Get } from '@nestjs/common';
import { uiServiceStatus } from './ui-service';

/** Local-app metadata the dashboard needs about its own host process. */
@Controller('api')
export class SystemController {
  /** Whether the background service is set up, so the installed PWA can nudge toward `vops ui --install`. */
  @Get('ui-service')
  uiService() {
    return uiServiceStatus();
  }
}
