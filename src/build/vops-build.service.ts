import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { AgentFailure, ExitCode, agentError } from '../agent-api/agent-envelope';
import { BuildRecord, readProject, specPath, updateProject } from '../agent-api/agent-project';
import { readManifest } from '../apps/app-source';
import { LocalConfigStore } from '../lib/config/local-config-store';
import { ensureVaultUnlocked } from '../lib/keyring/unlock';
import { GitHubClient, WorkflowRun } from './github-client';
import { MANAGED_MARKER, WORKFLOW_PATH, imageName, imageTagForSha, parseRepoSlug, renderWorkflow } from './github-workflow';

/** Builds the user's application image on GitHub-hosted runners and hands back an image reference
 * to deploy. vops writes the workflow and stops — committing/pushing is the user's action, so an
 * agent can never make a repository build behind their back. */

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const GITHUB_TOKEN_KEY = 'github';

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

export interface SetupOptions {
  projectDir: string;
  specFile: string;
  repo?: string;
  branch?: string;
  force?: boolean;
}

export interface SetupResult {
  workflowFile: string;
  image: string;
  repo: RepoRef;
  written: boolean;
  /** Present when an existing file was left alone. */
  skippedReason?: string;
}

export interface RunOptions {
  projectDir: string;
  token?: string;
  branch?: string;
  repo?: string;
  wait: boolean;
  timeoutMs?: number;
}

export interface BuildRunResult {
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: WorkflowRun['conclusion'];
  runId: number;
  runUrl: string;
  commitSha: string;
  /** Only set once the run has completed successfully. */
  imageRef?: string;
  repoPrivate: boolean;
}

@Injectable()
export class VopsBuildService {
  /** Render the workflow into the working tree, driven by the manifest's build block. */
  setup(opts: SetupOptions): SetupResult {
    const repo = this.resolveRepo(opts.projectDir, opts.repo, opts.branch);
    const build = this.readBuild(specPath(opts.projectDir, opts.specFile));
    const yaml = renderWorkflow({
      owner: repo.owner,
      repo: repo.repo,
      branch: repo.branch,
      dockerfile: build.dockerfile,
      context: build.context,
      buildArgs: build.args,
    });

    const target = path.join(path.resolve(opts.projectDir), WORKFLOW_PATH);
    const image = imageName(repo.owner, repo.repo);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (existing !== null && !existing.startsWith(MANAGED_MARKER) && !opts.force) {
      return {
        workflowFile: WORKFLOW_PATH,
        image,
        repo,
        written: false,
        skippedReason: `${WORKFLOW_PATH} exists and was not written by vops — inspect it, then re-run with --force to replace it.`,
      };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, yaml, 'utf8');
    return { workflowFile: WORKFLOW_PATH, image, repo, written: true };
  }

  /** Trigger the workflow and (optionally) wait for the image to exist. */
  async run(opts: RunOptions): Promise<BuildRunResult> {
    const repo = this.resolveRepo(opts.projectDir, opts.repo, opts.branch);
    const client = new GitHubClient(await this.token(opts.token));
    const info = await client.repo(repo.owner, repo.repo);

    const before = await client.runs(repo.owner, repo.repo, path.basename(WORKFLOW_PATH));
    await client.dispatch(repo.owner, repo.repo, path.basename(WORKFLOW_PATH), repo.branch);
    const run = await this.awaitNewRun(client, repo, new Set(before.map((r) => r.id)));

    if (!opts.wait) return this.toResult(run, repo, info.private);
    const done = await this.poll(client, repo, run.id, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const result = this.toResult(done, repo, info.private);
    if (result.imageRef) this.record(opts.projectDir, result);
    return result;
  }

  /** The most recent run of the vops workflow, without triggering anything. */
  async status(opts: { projectDir: string; token?: string; repo?: string; branch?: string }): Promise<BuildRunResult | null> {
    const repo = this.resolveRepo(opts.projectDir, opts.repo, opts.branch);
    const client = new GitHubClient(await this.token(opts.token));
    const info = await client.repo(repo.owner, repo.repo);
    const [latest] = await client.runs(repo.owner, repo.repo, path.basename(WORKFLOW_PATH), 1);
    return latest ? this.toResult(latest, repo, info.private) : null;
  }

  /** The image the last successful build produced, if this project has one. */
  lastImage(projectDir: string): string | null {
    return readProject(projectDir)?.lastBuild?.imageRef ?? null;
  }

  private toResult(run: WorkflowRun, repo: RepoRef, isPrivate: boolean): BuildRunResult {
    const succeeded = run.status === 'completed' && run.conclusion === 'success';
    return {
      status: run.status,
      conclusion: run.conclusion,
      runId: run.id,
      runUrl: run.url,
      commitSha: run.headSha,
      ...(succeeded ? { imageRef: `${imageName(repo.owner, repo.repo)}:${imageTagForSha(run.headSha)}` } : {}),
      repoPrivate: isPrivate,
    };
  }

  private record(projectDir: string, result: BuildRunResult): void {
    const build: BuildRecord = {
      imageRef: result.imageRef,
      commitSha: result.commitSha,
      runId: result.runId,
      runUrl: result.runUrl,
      completedAt: new Date().toISOString(),
    };
    updateProject(projectDir, { lastBuild: build }, this.projectDefaults(projectDir));
  }

  private projectDefaults(projectDir: string) {
    return {
      name: path.basename(path.resolve(projectDir)),
      spec: 'flui.yaml',
      vopsVersion: vopsVersion(),
      now: new Date().toISOString(),
    };
  }

  /** GitHub dispatch is async — the run appears a moment after the call returns. */
  private async awaitNewRun(client: GitHubClient, repo: RepoRef, known: Set<number>): Promise<WorkflowRun> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(2_500);
      const runs = await client.runs(repo.owner, repo.repo, path.basename(WORKFLOW_PATH));
      const fresh = runs.find((r) => !known.has(r.id));
      if (fresh) return fresh;
    }
    throw new AgentFailure(
      agentError('VOPS_BUILD_NOT_STARTED', 'operational', 'GitHub accepted the dispatch but no run appeared.', {
        suggestedAction: `Check that ${WORKFLOW_PATH} is committed on ${repo.branch} and that Actions is enabled for the repository.`,
      }),
      ExitCode.FAILURE,
    );
  }

  private async poll(client: GitHubClient, repo: RepoRef, runId: number, timeoutMs: number): Promise<WorkflowRun> {
    const deadline = Date.now() + timeoutMs;
    let run = await client.run(repo.owner, repo.repo, runId);
    while (run.status !== 'completed') {
      if (Date.now() > deadline) {
        throw new AgentFailure(
          agentError('VOPS_BUILD_TIMEOUT', 'operational', `The build did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`, {
            suggestedAction: `Watch it at ${run.url}, then deploy with --image once it is green.`,
          }),
          ExitCode.PARTIAL,
        );
      }
      await sleep(POLL_INTERVAL_MS);
      run = await client.run(repo.owner, repo.repo, runId);
    }
    if (run.conclusion !== 'success') {
      throw new AgentFailure(
        agentError('VOPS_BUILD_FAILED', 'operational', `The build finished as '${run.conclusion}'.`, {
          suggestedAction: `Read the failing step at ${run.url} and fix the Dockerfile or the build, then re-run \`vops build run\`.`,
        }),
        ExitCode.FAILURE,
      );
    }
    return run;
  }

  /** `build.dockerfile` / `build.context` / `build.args` from the manifest. */
  private readBuild(specFile: string): { dockerfile: string; context: string; args?: Record<string, string> } {
    const manifest = readManifest(specFile);
    if (manifest.kind !== 'Application') {
      throw new AgentFailure(
        agentError('VOPS_BUILD_NOT_APPLICABLE', 'input', `${specFile} is kind: ${manifest.kind} — only an Application is built from source.`, {
          suggestedAction: 'A CatalogApp already references a published image: deploy it with `vops app install <id>`.',
        }),
        ExitCode.INVALID_INPUT,
      );
    }
    const build = manifest.build ?? {};
    return { dockerfile: build.dockerfile ?? './Dockerfile', context: build.context ?? '.', args: build.args };
  }

  private resolveRepo(projectDir: string, slug: string | undefined, branch: string | undefined): RepoRef {
    const stored = readProject(projectDir)?.repo;
    const storedSlug = stored ? { owner: stored.owner, repo: stored.repo } : null;
    const parsed = slug ? parseSlug(slug) : (originSlug(projectDir) ?? storedSlug);
    if (!parsed) {
      throw new AgentFailure(
        agentError('VOPS_REPO_UNKNOWN', 'input', 'Could not determine the GitHub repository.', {
          suggestedAction: 'Pass --repo <owner>/<name>, or run this inside a clone whose origin points at GitHub.',
        }),
        ExitCode.INVALID_INPUT,
      );
    }
    return { ...parsed, branch: branch ?? stored?.branch ?? currentBranch(projectDir) ?? 'main' };
  }

  private async token(explicit?: string): Promise<string> {
    if (explicit?.trim()) return explicit.trim();
    const fromEnv = process.env.VOPS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
    if (fromEnv?.trim()) return fromEnv.trim();
    await ensureVaultUnlocked();
    return new LocalConfigStore().getToken(GITHUB_TOKEN_KEY) ?? '';
  }
}

function parseSlug(slug: string): { owner: string; repo: string } | null {
  const direct = /^([\w.-]+)\/([\w.-]+)$/.exec(slug.trim());
  if (direct) return { owner: direct[1], repo: direct[2] };
  return parseRepoSlug(slug);
}

function originSlug(dir: string): { owner: string; repo: string } | null {
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  return remote ? parseRepoSlug(remote) : null;
}

function currentBranch(dir: string): string | null {
  return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: path.resolve(dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function vopsVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
