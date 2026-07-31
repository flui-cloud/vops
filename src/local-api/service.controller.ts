import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import * as path from 'node:path';
import { profileDir } from '../lib/profile';
import { pickBackend, resolveContext, serviceStatus } from '../service/index';
import { appRemovalGuide } from '../service/uninstall-guide';
import { purgePlan, purgeProfile } from '../service/purge';

/** Long enough for the response to reach the browser before the server goes away. */
const SHUTDOWN_DELAY_MS = 400;

/**
 * Managing this machine's vops install from the dashboard.
 *
 * Removing the app is three separate things — the browser-installed icon, this
 * background service, and the data on disk — and only one of them can be removed
 * from a browser tab. Rather than hide that, the endpoints do what they can and
 * hand back the exact steps for what they can't.
 */
@Controller('api/service')
export class ServiceController {
  private context() {
    return resolveContext({ binRun: path.join(__dirname, '..', '..', 'bin', 'run') });
  }

  @Get()
  status() {
    const ctx = this.context();
    return {
      service: serviceStatus(ctx),
      port: ctx.port,
      profile: ctx.profile,
      profileDir: profileDir(),
      appRemoval: appRemovalGuide(),
      data: purgePlan().items.filter((i) => i.exists).map(({ label, path: p, irreplaceable }) => ({ label, path: p, irreplaceable })),
    };
  }

  /** Stops the service and removes it from login. Reversible: `vops service install`. */
  @Post('uninstall')
  uninstall() {
    const ctx = this.context();
    const backend = pickBackend();
    const removed = backend ? backend.uninstall(ctx).removed : false;
    return { removed, appRemoval: appRemovalGuide(), profileDir: profileDir() };
  }

  /**
   * Uninstall AND delete this profile's data, then exit.
   *
   * Guarded by typing the profile name, not just a click. The session token lives
   * in a 0600 file, so anything that can call this already runs as the user — but
   * a stray fetch from a page that got hold of the token should not be able to
   * destroy a credential vault and a set of SSH private keys by accident.
   */
  @Post('purge')
  purge(@Body() body: { confirm?: string }) {
    const plan = purgePlan();
    if ((body?.confirm ?? '').trim() !== plan.profile) {
      throw new BadRequestException(`Type the profile name (${plan.profile}) to confirm.`);
    }

    const ctx = this.context();
    pickBackend()?.uninstall(ctx);
    const result = purgeProfile();

    // The store this process is holding open has just been deleted; staying up
    // would serve a dashboard backed by nothing.
    setTimeout(() => process.exit(0), SHUTDOWN_DELAY_MS).unref();
    return { removed: result.removed.length, failed: result.failed, appRemoval: appRemovalGuide(), stopping: true };
  }
}
