/* Compiles the dashboard assets into lib/: Tailwind CSS (only used classes),
 * the vendored Alpine runtime, and the HTML shell. All inlined at serve time so
 * the UI stays a single self-contained, offline document. */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src', 'ui');
const out = path.join(__dirname, '..', 'lib', 'ui');
fs.mkdirSync(out, { recursive: true });

execSync(
  `node_modules/.bin/tailwindcss -i ${path.join(src, 'tailwind.css')} ` +
    `-o ${path.join(out, 'app.css')} --minify`,
  { cwd: path.join(__dirname, '..'), stdio: 'inherit' },
);

fs.copyFileSync(
  path.join(__dirname, '..', 'node_modules', 'alpinejs', 'dist', 'cdn.min.js'),
  path.join(out, 'alpine.js'),
);

for (const f of fs.readdirSync(src)) {
  if (f === 'world.geo.json') fs.copyFileSync(path.join(src, f), path.join(out, f));
}

// PWA files for the installed dashboard. The worker's cache key is stamped with
// the package version so upgrading the CLI retires the previous shell instead of
// serving it forever.
fs.copyFileSync(
  path.join(src, 'manifest.webmanifest'),
  path.join(out, 'manifest.webmanifest'),
);
const { version } = require('../package.json');
fs.writeFileSync(
  path.join(out, 'sw.js'),
  fs.readFileSync(path.join(src, 'sw.js'), 'utf8').replaceAll('__VOPS_VERSION__', version),
);

// app.js is assembled from src/ui/dashboard/*.js (one factory per concern,
// merged by the dashboard() composer in src/ui/app.js — see that file) plus
// the composer itself, concatenated in one script. Function declarations are
// hoisted, so concatenation order doesn't matter.
const dashboardDir = path.join(src, 'dashboard');
const dashboardJs = fs
  .readdirSync(dashboardDir)
  .filter(f => f.endsWith('.js'))
  .sort()
  .map(f => fs.readFileSync(path.join(dashboardDir, f), 'utf8'))
  .join('\n');
const appJs = dashboardJs + '\n' + fs.readFileSync(path.join(src, 'app.js'), 'utf8');
fs.writeFileSync(path.join(out, 'app.js'), appJs);

// The HTML shell is assembled from per-section partials (src/ui/sections/*.html)
// referenced by `<!--include: sections/x.html-->` directives — one file per view
// keeps each unit small. The runtime CSS/JS/Alpine placeholders stay for serve
// time (see ui/index.ts).
const assembled = fs
  .readFileSync(path.join(src, 'app.html'), 'utf8')
  .replace(/<!--\s*include:\s*([\w./-]+)\s*-->/g, (_, rel) =>
    fs.readFileSync(path.join(src, rel), 'utf8').trimEnd(),
  );
fs.writeFileSync(path.join(out, 'app.html'), assembled);

// Brand icons (logo + favicon) — served same-origin at /assets/*, never inlined.
const assetsSrc = path.join(src, 'assets');
if (fs.existsSync(assetsSrc)) {
  const assetsOut = path.join(out, 'assets');
  fs.mkdirSync(assetsOut, { recursive: true });
  for (const f of fs.readdirSync(assetsSrc)) {
    if (f.endsWith('.png')) fs.copyFileSync(path.join(assetsSrc, f), path.join(assetsOut, f));
  }
}

// Runtime data (region geo + seed pricing snapshot) read via fs at runtime.
const libSrc = path.join(__dirname, '..', 'src', 'lib');
const libOut = path.join(__dirname, '..', 'lib', 'lib');
fs.mkdirSync(libOut, { recursive: true });
for (const f of fs.readdirSync(libSrc)) {
  if (f.endsWith('.json')) fs.copyFileSync(path.join(libSrc, f), path.join(libOut, f));
}
