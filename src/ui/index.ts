import * as fs from 'node:fs';
import * as path from 'node:path';

const INLINED = ['app.html', 'app.css', 'app.js', 'alpine.js'];

let cached: { key: string; html: string } | null = null;

/** Composes the local UI shell by inlining CSS/app.js/Alpine into their placeholders, in that
 * order (dashboard() must exist before Alpine boots). Cached by source mtime, so a UI rebuild shows up on reload with no `vops ui` restart. */
export function renderUi(): string {
  const dir = __dirname;
  const key = INLINED.map((f) => mtime(path.join(dir, f))).join(':');
  if (cached?.key === key) return cached.html;
  let html = fs.readFileSync(path.join(dir, 'app.html'), 'utf8');
  html = html.replace(
    '<!--TAILWIND-->',
    () => `<style>${readOptional(dir, 'app.css')}</style>`,
  );
  html = html.replace(
    '<!--APP-->',
    () => `<script>${readOptional(dir, 'app.js')}</script>`,
  );
  html = html.replace(
    '<!--ALPINE-->',
    () => `<script>${readOptional(dir, 'alpine.js')}</script>`,
  );
  cached = { key, html };
  return html;
}

function mtime(p: string): number {
  return fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
}

function readOptional(dir: string, file: string): string {
  const p = path.join(dir, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
