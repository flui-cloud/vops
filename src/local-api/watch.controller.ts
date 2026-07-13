import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { VopsWatchService } from '../watch/vops-watch.service';

/** Surface a thrown error as a 400 carrying its message (unreachable endpoint,
 * not connected, landing 4xx…) so the UI can show it instead of a bare 500. */
async function asBadRequest<T>(op: Promise<T>): Promise<T> {
  try {
    return await op;
  } catch (err) {
    throw new BadRequestException(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Proxy to the vops-landing notification API. The browser never sees the client
 * token — it stays in the local encrypted store and is attached server-side.
 */
@Controller('api/watch')
export class WatchController {
  constructor(private readonly watch: VopsWatchService) {}

  @Get('status')
  status() {
    return this.watch.status();
  }

  @Post('connect')
  connect(@Body() body: { apiUrl: string }) {
    return asBadRequest(this.watch.connect(body.apiUrl));
  }

  @Post('notify')
  notify(@Body() body: { provider: string; serverType: string; location?: string }) {
    return asBadRequest(this.watch.notify(body));
  }

  @Post('ntfy')
  ntfy(
    @Body()
    body: { provider: string; serverType: string; location?: string; topic: string; server?: string },
  ) {
    return asBadRequest(this.watch.ntfy(body));
  }
}
