import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every error code carries a `documentation` URL built from the code itself
 * (`docs/errors.md#<lowercased code>`), so the link is always well-formed and says nothing
 * about whether anything is behind it. Six codes shipped pointing at nothing, and four more
 * shared a heading — `### A / B` anchors as `#a--b`, so neither `#a` nor `#b` resolves.
 *
 * Anchors are compared the way GitHub builds them, since that is where the URL lands.
 */
describe('every error code is documented', () => {
  const root = path.join(__dirname, '..');
  const doc = fs.readFileSync(path.join(root, 'docs', 'errors.md'), 'utf8');

  const sources = (): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) out.push(p);
      }
    };
    walk(path.join(root, 'src'));
    return out;
  };

  const collect = (): { errors: string[]; warnings: string[] } => {
    const errors = new Set<string>();
    const warnings = new Set<string>();
    for (const f of sources()) {
      const s = fs.readFileSync(f, 'utf8');
      // Structured failures: `agentError('CODE'`, `notFound('CODE'`, and the SPEC_ERROR map.
      for (const m of s.matchAll(/\b(?:agentError|notFound)\(\s*'([A-Z][A-Z0-9_]+)'/g)) errors.add(m[1]);
      for (const m of s.matchAll(/\b[A-Z][A-Z0-9_]*:\s*'(VOPS_[A-Z0-9_]+)'/g)) errors.add(m[1]);
      // Warnings are object literals, plain or ternary: `code: cond ? 'A' : 'B'`.
      for (const m of s.matchAll(/\bcode:\s*(.*)/g)) {
        for (const q of m[1].matchAll(/'([A-Z][A-Z0-9_]+)'/g)) warnings.add(q[1]);
      }
    }
    return { errors: [...errors].sort(), warnings: [...warnings].filter((c) => !errors.has(c)).sort() };
  };

  const { errors, warnings } = collect();

  /** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens (`_` survives). */
  const anchors = new Set(
    [...doc.matchAll(/^###\s+(.+)$/gm)].map((m) =>
      m[1].toLowerCase().replaceAll(/[^a-z0-9 _-]/g, '').trim().replaceAll(' ', '-'),
    ),
  );

  it('finds the codes to check', () => {
    expect(errors.length).toBeGreaterThan(30);
    expect(errors).toContain('VOPS_SSH_KEY_NOT_REGISTERED');
    expect(warnings).toContain('VOPS_HOST_UNREACHABLE');
  });

  it.each(errors)('%s has an anchor the documentation link resolves to', (code) => {
    expect({ code, anchor: anchors.has(code.toLowerCase()) }).toEqual({ code, anchor: true });
  });

  it.each(warnings)('%s is listed in docs/errors.md', (code) => {
    expect({ code, documented: doc.includes(code) }).toEqual({ code, documented: true });
  });
});
