/*
 * Vendors a snapshot of the @flui-cloud/catalog package (../flui-catalog — the
 * source of truth) into vops: manifests → src/apps/catalog, logos →
 * src/ui/assets/app-icons. vops is offline-first, so it bundles a pinned snapshot
 * rather than fetching at runtime. Re-run after the upstream catalog changes.
 */
const fs = require('node:fs');
const path = require('node:path');

const src = path.resolve(__dirname, '..', '..', 'flui-catalog');
if (!fs.existsSync(src)) {
  console.error(`flui-catalog not found at ${src}`);
  process.exit(1);
}

const manOut = path.join(__dirname, '..', 'src', 'apps', 'catalog');
const iconOut = path.join(__dirname, '..', 'src', 'ui', 'assets', 'app-icons');
fs.mkdirSync(manOut, { recursive: true });
fs.mkdirSync(iconOut, { recursive: true });

function resync(fromDir, toDir, ext) {
  for (const f of fs.readdirSync(toDir)) {
    if (f.endsWith(ext)) fs.rmSync(path.join(toDir, f));
  }
  const names = fs.readdirSync(fromDir).filter((f) => f.endsWith(ext));
  for (const f of names) fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f));
  return names.length;
}

const manifests = resync(path.join(src, 'manifests'), manOut, '.flui.yaml');
const icons = resync(path.join(src, 'assets', 'icons'), iconOut, '.svg');
console.log(`synced ${manifests} manifests, ${icons} icons from flui-catalog`);
