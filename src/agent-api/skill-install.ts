import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalSkillDir } from '../agent-kit/agent-kit-paths';

/** Ships the canonical `vops-deploy` skill into a coding agent's skill directory. Every path is
 * taken from that agent's own documentation, never inferred from a directory that happens to
 * exist — a skill in the wrong place is silently inert, with no runtime symptom to catch it, so
 * an unverified layout is refused in favour of `--output-dir`. */

export const SKILL_NAME = 'vops-deploy';

export type SkillTarget = 'claude-code' | 'codex' | 'antigravity' | 'opencode';

export interface SkillTargetInfo {
  id: SkillTarget;
  label: string;
  /** Project-scoped destination, relative to the project root. */
  projectDir?: string;
  /** User-scoped destination, relative to the home directory. */
  homeDir: string;
  /** Where this layout is documented — so a future change can be re-checked. */
  docs: string;
  /** Anything the user has to know beyond "the files are there". */
  note?: string;
}

export const SKILL_TARGETS: SkillTargetInfo[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    projectDir: '.claude/skills',
    homeDir: '.claude/skills',
    docs: 'https://docs.claude.com/en/docs/claude-code/skills',
  },
  {
    id: 'codex',
    label: 'Codex',
    projectDir: '.agents/skills',
    homeDir: '.agents/skills',
    docs: 'https://learn.chatgpt.com/docs/build-skills',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    projectDir: '.agents/skills',
    homeDir: '.gemini/config/skills',
    docs: 'https://antigravity.google/docs/skills',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    projectDir: '.opencode/skills',
    homeDir: '.config/opencode/skills',
    docs: 'https://opencode.ai/docs/skills/',
  },
];

export interface InstallSkillOptions {
  target?: SkillTarget;
  /** Write the bundle here instead of a known agent directory. */
  outputDir?: string;
  /** Install into the project rather than the home directory, when supported. */
  project?: string;
  force?: boolean;
}

export interface InstallSkillResult {
  target: string;
  dir: string;
  files: string[];
  overwritten: boolean;
  note?: string;
}

/** Where the skill would land for one agent, without writing anything — what the dashboard shows
 * for anyone who'd rather not let a CLI write into another tool's config. */
export interface SkillInstructions extends SkillTargetInfo {
  command: string;
  projectCommand?: string;
  homePath: string;
  projectPath?: string;
}

export function skillInstructions(): SkillInstructions[] {
  return SKILL_TARGETS.map((t) => ({
    ...t,
    command: `vops agent skill install ${t.id}`,
    ...(t.projectDir ? { projectCommand: `vops agent skill install ${t.id} --project .` } : {}),
    homePath: `~/${t.homeDir}/${SKILL_NAME}/`,
    ...(t.projectDir ? { projectPath: `${t.projectDir}/${SKILL_NAME}/` } : {}),
  }));
}

/** The bundled canonical skill source in development and packaged builds. */
export function skillSourceDir(): string {
  return canonicalSkillDir();
}

export function resolveTargetDir(opts: InstallSkillOptions): { label: string; dir: string } {
  if (opts.outputDir) return { label: 'custom', dir: path.resolve(opts.outputDir, SKILL_NAME) };

  const info = SKILL_TARGETS.find((t) => t.id === opts.target);
  if (!info) {
    throw new Error(
      `Unknown target '${opts.target}'. Known: ${SKILL_TARGETS.map((t) => t.id).join(', ')}. ` +
        'For any other agent, pass --output-dir <dir> and place the bundle where that agent reads skills from.',
    );
  }
  const base = opts.project && info.projectDir ? path.resolve(opts.project, info.projectDir) : path.join(os.homedir(), info.homeDir);
  return { label: info.label, dir: path.join(base, SKILL_NAME) };
}

export function installSkill(opts: InstallSkillOptions): InstallSkillResult {
  const source = skillSourceDir();
  if (!fs.existsSync(source)) {
    throw new Error(`The skill bundle is missing from this install (${source}). Reinstall @flui-cloud/vops.`);
  }
  const { label, dir } = resolveTargetDir(opts);
  const overwritten = fs.existsSync(dir);
  if (overwritten && !opts.force) {
    throw new Error(`${dir} already exists. Re-run with --force to replace it.`);
  }

  const files = copyTree(source, dir);
  const note = SKILL_TARGETS.find((t) => t.id === opts.target)?.note;
  return { target: label, dir, files, overwritten, ...(note ? { note } : {}) };
}

function copyTree(from: string, to: string, prefix = ''): string[] {
  fs.mkdirSync(to, { recursive: true });
  return fs.readdirSync(from, { withFileTypes: true }).flatMap((entry) => {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return copyTree(src, dst, rel);
    fs.copyFileSync(src, dst);
    return [rel];
  });
}
