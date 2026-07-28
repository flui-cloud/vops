import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderUi } from '../ui/index';
import { SESSION_COOKIE } from './session.guard';

/** Serves the local UI shell + its static map data (same-origin, no session). */
@Controller()
export class RootController {
  /**
   * Serving the shell also (re)mints the session cookie, which is how the
   * installed app authenticates: its `start_url` is frozen at install time and
   * cannot carry the per-run token. Refreshing it here means the cookie always
   * matches the running server, across restarts and new tokens alike.
   */
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  root(@Res({ passthrough: true }) res: Response): string {
    const token = process.env.VOPS_SESSION;
    if (token) {
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      });
    }
    return renderUi();
  }

  @Get('manifest.webmanifest')
  @Header('Content-Type', 'application/manifest+json; charset=utf-8')
  manifest(): string {
    return readUiFile('manifest.webmanifest', '{}');
  }

  /**
   * Served from the root so its scope covers the whole app — a worker under
   * /assets could not control navigations to /.
   */
  @Get('sw.js')
  @Header('Content-Type', 'text/javascript; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  serviceWorker(): string {
    return readUiFile('sw.js', '');
  }

  @Get('world.geo.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=86400')
  geo(): string {
    return readUiFile('world.geo.json', '{"countries":[],"pins":[],"views":{}}');
  }

  /**
   * Brand icons (logo + favicon). basename-only lookup — no path traversal.
   * Writes the raw Express response so the PNG bytes aren't JSON-serialized.
   */
  @Get('assets/:file')
  asset(@Param('file') file: string, @Res() res: Response): void {
    const name = path.basename(file);
    const p = path.join(__dirname, '..', 'ui', 'assets', name);
    if (!name.endsWith('.png') || !fs.existsSync(p)) {
      res.status(404).end();
      return;
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(fs.readFileSync(p));
  }

  /**
   * Vendored catalog app logos, served offline at /assets/app-icons/<id>.svg.
   * basename-only lookup — no path traversal. SVGs in an <img> can't run script.
   */
  @Get('assets/app-icons/:file')
  appIcon(@Param('file') file: string, @Res() res: Response): void {
    sendSvg(res, path.join(__dirname, '..', 'ui', 'assets', 'app-icons', path.basename(file)));
  }

  /** Coding-agent marks for the "Deploy your own code" picker, same rules. */
  @Get('assets/agent-icons/:file')
  agentIcon(@Param('file') file: string, @Res() res: Response): void {
    sendSvg(res, path.join(__dirname, '..', 'ui', 'assets', 'agent-icons', path.basename(file)));
  }
}

/** Serve a vendored SVG, or 404. The caller has already reduced the request to a basename. */
function sendSvg(res: Response, p: string): void {
  if (!p.endsWith('.svg') || !fs.existsSync(p)) {
    res.status(404).end();
    return;
  }
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.end(fs.readFileSync(p));
}

/** Reads a build-time asset from lib/ui, falling back if the build skipped it. */
function readUiFile(name: string, fallback: string): string {
  const p = path.join(__dirname, '..', 'ui', name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fallback;
}
