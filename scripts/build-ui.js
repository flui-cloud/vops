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

// HTML shell assembled from per-section partials via `<!--include-->` directives, resolved
// recursively so a fragment shared across views (e.g. the domain picker) lives in one file, not copies that drift.
const resolveIncludes = (html, depth = 0) => {
  if (depth > 4) throw new Error('<!--include--> nested more than 4 deep — cycle?');
  return html.replace(/<!--\s*include:\s*([\w./-]+)\s*-->/g, (_, rel) =>
    resolveIncludes(fs.readFileSync(path.join(src, rel), 'utf8').trimEnd(), depth + 1),
  );
};
fs.writeFileSync(
  path.join(out, 'app.html'),
  resolveIncludes(fs.readFileSync(path.join(src, 'app.html'), 'utf8')),
);

// Brand icons (logo + favicon) — served same-origin at /assets/*, never inlined.
const assetsSrc = path.join(src, 'assets');
if (fs.existsSync(assetsSrc)) {
  const assetsOut = path.join(out, 'assets');
  fs.mkdirSync(assetsOut, { recursive: true });
  for (const f of fs.readdirSync(assetsSrc)) {
    if (f.endsWith('.png')) fs.copyFileSync(path.join(assetsSrc, f), path.join(assetsOut, f));
  }
  // Vendored catalog/agent icons (offline), served at /assets/{app,agent}-icons/<id>.svg;
  // clear stale svgs first so a removed/denylisted icon doesn't linger.
  for (const dir of ['app-icons', 'agent-icons']) {
    const iconsSrc = path.join(assetsSrc, dir);
    if (!fs.existsSync(iconsSrc)) continue;
    const iconsOut = path.join(assetsOut, dir);
    fs.rmSync(iconsOut, { recursive: true, force: true });
    fs.mkdirSync(iconsOut, { recursive: true });
    for (const f of fs.readdirSync(iconsSrc)) {
      if (f.endsWith('.svg')) fs.copyFileSync(path.join(iconsSrc, f), path.join(iconsOut, f));
    }
  }
}

// Runtime data (region geo + seed pricing snapshot) read via fs at runtime.
const libSrc = path.join(__dirname, '..', 'src', 'lib');
const libOut = path.join(__dirname, '..', 'lib', 'lib');
fs.mkdirSync(libOut, { recursive: true });
for (const f of fs.readdirSync(libSrc)) {
  if (f.endsWith('.json')) fs.copyFileSync(path.join(libSrc, f), path.join(libOut, f));
}

// Canonical coding-agent skill (copied to a user's agent directory by
// `vops agent skill install`, so it has to ship inside the package).
const skillSrc = path.join(__dirname, '..', 'src', 'agent-api', 'skill');
const skillOut = path.join(__dirname, '..', 'lib', 'agent-api', 'skill');
if (fs.existsSync(skillSrc)) {
  fs.rmSync(skillOut, { recursive: true, force: true });
  fs.cpSync(skillSrc, skillOut, { recursive: true });
}

// Bundled flui.yaml catalog (read via fs at runtime by the apps subsystem).
// Clear stale manifests first so a removed app doesn't linger in the bundle.
const catSrc = path.join(__dirname, '..', 'src', 'apps', 'catalog');
const catOut = path.join(__dirname, '..', 'lib', 'apps', 'catalog');
if (fs.existsSync(catSrc)) {
  fs.mkdirSync(catOut, { recursive: true });
  for (const f of fs.readdirSync(catOut)) {
    if (f.endsWith('.flui.yaml')) fs.rmSync(path.join(catOut, f));
  }
  for (const f of fs.readdirSync(catSrc)) {
    if (f.endsWith('.flui.yaml')) fs.copyFileSync(path.join(catSrc, f), path.join(catOut, f));
  }
}
