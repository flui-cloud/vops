import { Controller, Get, Header, Param, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderUi } from '../ui/index';
import { runtimeInfo } from './runtime-info';
import { tokenMatches } from './session-token';
import { providedToken, SESSION_COOKIE } from './session.guard';

/** Serves the local UI shell + its static map data (same-origin, no session). */
@Controller()
export class RootController {
  /**
   * Serving the shell (re)mints the session cookie only for a request that already
   * proves it holds the token — `?session=` on the printed URL, the header, or a
   * cookie from a previous run (the token is persisted per profile, so it survives
   * restarts, which is what the installed app relies on: its `start_url` is frozen
   * at install time and cannot carry a token). Minting for anyone would hand the
   * token to any local process that can GET `/`.
   */
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-cache')
  root(@Req() req: Request, @Res({ passthrough: true }) res: Response): string {
    const token = process.env.VOPS_SESSION;
    if (token && tokenMatches(providedToken(req), token)) {
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      });
    }
    return renderUi();
  }

  /**
   * Liveness + identity, deliberately outside `/api` so `SessionGuard` lets it
   * through (the guard bypasses any path that isn't /api — no @Public() hole to
   * punch in a global guard). Readable by any local process, so it carries
   * nothing but what a second vops needs to recognise the first one.
   */
  @Get('healthz')
  @Header('Cache-Control', 'no-store')
  healthz(): Record<string, unknown> {
    const info = runtimeInfo();
    if (!info) return { ok: true, service: 'vops' };
    return {
      ok: true,
      service: 'vops',
      version: info.version,
      port: info.port,
      profile: info.profile,
      startedAt: info.startedAt,
      uptimeSeconds: Math.floor((Date.now() - Date.parse(info.startedAt)) / 1000),
    };
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
