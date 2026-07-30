import * as fs from 'node:fs';
import * as path from 'node:path';

/** The project-local `.vops/` directory: deployment artifacts (template, approved plan, build
 * output) live next to the repo they describe, not in `~/.config/vops`, since they're facts about
 * *this* project. `project.json` holds no secrets; `plans/` does (the `--set` values `apply`
 * replays), so it is owner-only on disk and the generated `.gitignore` keeps it out of git. */

export const PROJECT_DIR = '.vops';
export const PROJECT_FILE = 'project.json';
export const PROJECT_SCHEMA_VERSION = 1 as const;

const GITIGNORE = `# Written by \`vops agent init\`. project.json is the only tracked artifact:
# plans and reports name servers and hostnames, and cache/ is machine-local.
plans/
reports/
cache/
`;

export interface BuildRecord {
  /** Fully-qualified image the last successful build produced. */
  imageRef: string;
  commitSha: string;
  runId: number;
  runUrl: string;
  completedAt: string;
}

export interface ProjectFile {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  name: string;
  /** Manifest path relative to the project root. */
  spec: string;
  vopsVersion: string;
  createdAt: string;
  repo?: { owner: string; repo: string; branch: string };
  /** Provenance of the generated spec (template id/version, spec + vops version). */
  template?: Record<string, string>;
  lastBuild?: BuildRecord;
}

export interface InitResult {
  root: string;
  created: string[];
  project: ProjectFile;
}

export function projectRoot(dir: string): string {
  return path.resolve(dir);
}

export function projectPath(dir: string, ...parts: string[]): string {
  return path.join(projectRoot(dir), PROJECT_DIR, ...parts);
}

/** A manifest path is recorded relative to the project root, not to the caller's working directory:
 * `--project` exists so an agent never has to `cd`, so `--spec` at its default must follow it. */
export function specPath(dir: string, spec: string): string {
  return path.isAbsolute(spec) ? spec : path.join(projectRoot(dir), spec);
}

/** Create `.vops/` if absent. Idempotent: an existing project keeps its file. */
export function initProject(dir: string, defaults: { name: string; spec: string; vopsVersion: string; now: string }): InitResult {
  const root = projectRoot(dir);
  const base = path.join(root, PROJECT_DIR);
  const created: string[] = [];

  for (const sub of ['', 'plans', 'reports', 'cache']) {
    const p = sub ? path.join(base, sub) : base;
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
      created.push(path.relative(root, p));
    }
  }

  const ignorePath = path.join(base, '.gitignore');
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, GITIGNORE, 'utf8');
    created.push(path.relative(root, ignorePath));
  }

  const existing = readProject(dir);
  if (existing) return { root, created, project: existing };

  const project: ProjectFile = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: defaults.name,
    spec: defaults.spec,
    vopsVersion: defaults.vopsVersion,
    createdAt: defaults.now,
  };
  writeProject(dir, project);
  created.push(path.join(PROJECT_DIR, PROJECT_FILE));
  return { root, created, project };
}

export function readProject(dir: string): ProjectFile | null {
  const file = projectPath(dir, PROJECT_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectFile;
  } catch {
    return null;
  }
}

export function writeProject(dir: string, project: ProjectFile): void {
  const file = projectPath(dir, PROJECT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

/** Merge a patch into project.json, creating the file when the project is new. */
export function updateProject(dir: string, patch: Partial<ProjectFile>, defaults: { name: string; spec: string; vopsVersion: string; now: string }): ProjectFile {
  const current = readProject(dir) ?? initProject(dir, defaults).project;
  const next = { ...current, ...patch };
  writeProject(dir, next);
  return next;
}
