import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// dashboard() composes the factories with Object.assign, which INVOKES a source
// object's getters and copies the resulting value. A getter in any factory other
// than the Object.assign target is therefore frozen at composition time (with a
// `this` that has no state yet) and never re-evaluates — the Compare table stayed
// permanently empty this way. Sub-factories must expose methods instead.
describe('dashboard factory composition', () => {
  const uiDir = join(__dirname, '..', 'src', 'ui');
  const appJs = readFileSync(join(uiDir, 'app.js'), 'utf8');

  const target = /Object\.assign\(\s*([A-Za-z0-9_]+)\(/.exec(appJs)?.[1];

  it('assigns onto a single known target factory', () => {
    expect(target).toBe('dashboardCore');
  });

  it('has no getters in the factories used as Object.assign sources', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(join(uiDir, 'dashboard')).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(join(uiDir, 'dashboard', file), 'utf8');
      if (new RegExp(`function\\s+${target}\\s*\\(`).test(src)) continue;
      for (const [i, line] of src.split('\n').entries())
        if (/^\s{2,}get\s+[A-Za-z0-9_$]+\s*\(\s*\)\s*\{/.test(line))
          offenders.push(`${file}:${i + 1} ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
  });
});
