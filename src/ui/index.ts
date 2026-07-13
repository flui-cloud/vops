import * as fs from 'node:fs';
import * as path from 'node:path';

let cached: string | null = null;

/**
 * Local UI shell — a single self-contained, offline HTML document. The compiled
 * Tailwind CSS, the app logic and the vendored Alpine runtime are inlined into
 * the `<!--TAILWIND-->`, `<!--APP-->` and `<!--ALPINE-->` placeholders (in that
 * order — the dashboard() factory must exist before Alpine boots), so no request
 * ever leaves this machine. Data comes from the local API with the URL token.
 */
export function renderUi(): string {
  if (cached) return cached;
  const dir = __dirname;
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
  cached = html;
  return cached;
}

function readOptional(dir: string, file: string): string {
  const p = path.join(dir, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
