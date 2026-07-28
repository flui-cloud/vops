import * as os from 'node:os';
import * as path from 'node:path';
import { SKILL_TARGETS, resolveTargetDir, skillInstructions } from '../src/agent-api/skill-install';

/**
 * These assert the documented paths, not the implementation. A skill written to the
 * wrong directory is silently inert — the agent simply never loads it — so a typo
 * here has no runtime symptom at all. Each expectation below is the location that
 * agent's own documentation names.
 */
describe('skill install targets', () => {
  const home = os.homedir();

  it('installs into each agent’s documented global directory', () => {
    const expected: Record<string, string> = {
      'claude-code': path.join(home, '.claude/skills/vops-deploy'),
      codex: path.join(home, '.agents/skills/vops-deploy'),
      antigravity: path.join(home, '.gemini/config/skills/vops-deploy'),
      opencode: path.join(home, '.claude/skills/vops-deploy'),
    };
    for (const [id, dir] of Object.entries(expected)) {
      expect({ id, dir: resolveTargetDir({ target: id as never }).dir }).toEqual({ id, dir });
    }
  });

  it('uses the project-scoped directory when --project is given', () => {
    expect(resolveTargetDir({ target: 'claude-code', project: '/repo' }).dir).toBe('/repo/.claude/skills/vops-deploy');
    expect(resolveTargetDir({ target: 'codex', project: '/repo' }).dir).toBe('/repo/.agents/skills/vops-deploy');
    expect(resolveTargetDir({ target: 'antigravity', project: '/repo' }).dir).toBe('/repo/.agents/skills/vops-deploy');
  });

  it('falls back to the home directory for an agent with no project scope', () => {
    // OpenCode reads Claude Code's skills and has no project-local convention of
    // its own, so --project must not invent one.
    expect(resolveTargetDir({ target: 'opencode', project: '/repo' }).dir).toBe(path.join(home, '.claude/skills/vops-deploy'));
  });

  it('refuses an agent whose layout has not been verified', () => {
    expect(() => resolveTargetDir({ target: 'cursor' as never })).toThrow(/--output-dir/);
  });

  it('honours an explicit output directory over everything else', () => {
    expect(resolveTargetDir({ target: 'codex', outputDir: '/tmp/out' }).dir).toBe('/tmp/out/vops-deploy');
  });

  it('records where every path was documented, so it can be re-checked', () => {
    for (const t of SKILL_TARGETS) expect(t.docs).toMatch(/^https:\/\//);
  });

  it('surfaces that OpenCode has no directory of its own', () => {
    const oc = skillInstructions().find((t) => t.id === 'opencode')!;
    expect(oc.note).toMatch(/reads Claude Code/i);
    expect(oc.projectCommand).toBeUndefined();
  });

  it('gives each agent a copy-pasteable command and path', () => {
    for (const t of skillInstructions()) {
      expect(t.command).toBe(`vops agent skill install ${t.id}`);
      expect(t.homePath).toMatch(/^~\/.+\/vops-deploy\/$/);
    }
  });
});
