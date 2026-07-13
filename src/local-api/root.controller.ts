import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderUi } from '../ui/index';

/** Serves the local UI shell + its static map data (same-origin, no session). */
@Controller()
export class RootController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  root(): string {
    return renderUi();
  }

  @Get('world.geo.json')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=86400')
  geo(): string {
    const p = path.join(__dirname, '..', 'ui', 'world.geo.json');
    return fs.existsSync(p)
      ? fs.readFileSync(p, 'utf8')
      : '{"countries":[],"pins":[],"views":{}}';
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
}
