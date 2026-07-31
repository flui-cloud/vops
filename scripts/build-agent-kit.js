/* Generates mechanical agent documentation from the authoritative capability
 * registry. Authored workflows stay in src/agent-kit; schemas and tables do not
 * drift because this script is run for every package build. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'src/agent-control/capabilities.json'), 'utf8'));
const generated = path.join(root, 'src/agent-kit/skills/vops-deploy/generated');
const schemas = path.join(generated, 'capability-schemas');
fs.rmSync(generated, { recursive: true, force: true });
fs.mkdirSync(schemas, { recursive: true });

const rows = registry.capabilities.map(capability =>
  `| \`${capability.id}\` | ${capability.risk} | ${capability.access} | ` +
  `${capability.enabled === false ? 'unavailable' : 'available'} | ${capability.summary.replaceAll('|', '\\|')} |`,
);
const markdown = [
  '# Generated capability registry',
  '',
  `Schema version: ${registry.schemaVersion}. Generated from \`src/agent-control/capabilities.json\`.`,
  '',
  '| Capability | Risk | Access | State | Summary |',
  '|---|---|---|---|---|',
  ...rows,
  '',
  'Input schemas are in `capability-schemas/<capability>.json`.',
  '',
].join('\n');
fs.writeFileSync(path.join(generated, 'capabilities.md'), markdown);

for (const capability of registry.capabilities) {
  fs.writeFileSync(
    path.join(schemas, `${capability.id}.json`),
    `${JSON.stringify(capability.inputSchema, null, 2)}\n`,
  );
}

const controlDir = path.join(root, 'src/agent-control');
const errorSource = [
  controlDir,
  path.join(root, 'src/commands/agent'),
  path.join(root, 'src/commands/knowledge'),
]
  .flatMap(dir => fs.readdirSync(dir)
    .filter(file => file.endsWith('.ts'))
    .map(file => fs.readFileSync(path.join(dir, file), 'utf8')))
  .join('\n');
const errorCodes = [...new Set(errorSource.match(/VOPS_AGENT_[A-Z0-9_]+/g) || [])].sort();
fs.writeFileSync(path.join(generated, 'errors.md'), [
  '# Generated agent error codes',
  '',
  ...errorCodes.map(code => `- \`${code}\``),
  '',
].join('\n'));

const executor = fs.readFileSync(path.join(controlDir, 'core-action-executor.ts'), 'utf8');
const implemented = new Set([...executor.matchAll(/case '([^']+)'/g)].map(match => match[1]));
fs.writeFileSync(path.join(generated, 'capability-command-map.md'), [
  '# Generated capability execution map',
  '',
  '| Capability | Core executor | Human CLI remains available |',
  '|---|---|---|',
  ...registry.capabilities.map(capability =>
    `| \`${capability.id}\` | ${implemented.has(capability.id) ? 'implemented' : 'unavailable'} | yes |`,
  ),
  '',
].join('\n'));
