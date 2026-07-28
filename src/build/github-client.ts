import axios, { AxiosInstance } from 'axios';
import { ExitCode, AgentFailure, agentError } from '../agent-api/agent-envelope';

/** The slice of the GitHub REST API vops needs to drive a build: read the repo, trigger the
 * workflow, watch the run. Nothing writes to the repository — committing the workflow file is the
 * user's own action, reviewable in a diff first. The PAT is held for the call, never logged. */

const API = 'https://api.github.com';
const UA = 'vops';

export interface WorkflowRun {
  id: number;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | null;
  headSha: string;
  url: string;
  createdAt: string;
}

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export class GitHubClient {
  private readonly http: AxiosInstance;

  constructor(token: string) {
    if (!token?.trim()) {
      throw new AgentFailure(
        agentError('VOPS_GITHUB_TOKEN_MISSING', 'auth', 'No GitHub token available.', {
          suggestedAction: 'Store one with `vops config set github --token <PAT>`, or pass --token. It needs repo read + actions.',
        }),
        ExitCode.AUTH,
      );
    }
    this.http = axios.create({
      baseURL: API,
      timeout: 30_000,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': UA,
      },
    });
  }

  async repo(owner: string, repo: string): Promise<RepoInfo> {
    const data = await this.get<{ full_name: string; default_branch: string; private: boolean }>(`/repos/${owner}/${repo}`);
    return { fullName: data.full_name, defaultBranch: data.default_branch, private: data.private };
  }

  /** Trigger `workflow_dispatch` on the vops workflow for a branch. */
  async dispatch(owner: string, repo: string, workflowFile: string, ref: string): Promise<void> {
    await this.request('post', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, { ref });
  }

  /** Most recent runs of the vops workflow, newest first. */
  async runs(owner: string, repo: string, workflowFile: string, limit = 10): Promise<WorkflowRun[]> {
    const data = await this.get<{ workflow_runs: RawRun[] }>(
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${limit}`,
    );
    return (data.workflow_runs ?? []).map(toRun);
  }

  async run(owner: string, repo: string, id: number): Promise<WorkflowRun> {
    return toRun(await this.get<RawRun>(`/repos/${owner}/${repo}/actions/runs/${id}`));
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('get', path);
  }

  private async request<T>(method: 'get' | 'post', path: string, body?: unknown): Promise<T> {
    try {
      const res = await this.http.request<T>({ method, url: path, data: body });
      return res.data;
    } catch (err) {
      throw toGitHubFailure(err, path);
    }
  }
}

interface RawRun {
  id: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url: string;
  created_at: string;
}

function toRun(r: RawRun): WorkflowRun {
  return {
    id: r.id,
    status: r.status as WorkflowRun['status'],
    conclusion: r.conclusion as WorkflowRun['conclusion'],
    headSha: r.head_sha,
    url: r.html_url,
    createdAt: r.created_at,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : JSON.stringify(err);
}

/** GitHub's status codes carry meaning an agent should branch on, so they map to
 * distinct exit codes rather than a generic failure. */
function toGitHubFailure(err: unknown, path: string): AgentFailure {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined;
  const detail = axios.isAxiosError(err)
    ? (err.response?.data as { message?: string })?.message ?? err.message
    : errorMessage(err);

  if (status === 401) {
    return new AgentFailure(
      agentError('VOPS_GITHUB_UNAUTHORIZED', 'auth', `GitHub rejected the token: ${detail}`, {
        suggestedAction: 'Re-issue the PAT and store it with `vops config set github --token <PAT>`.',
      }),
      ExitCode.AUTH,
    );
  }
  if (status === 403) {
    return new AgentFailure(
      agentError('VOPS_GITHUB_FORBIDDEN', 'auth', `GitHub refused the request: ${detail}`, {
        suggestedAction: 'The token needs `repo` (or fine-grained: Contents read + Actions read/write) on this repository.',
      }),
      ExitCode.AUTH,
    );
  }
  if (status === 404) {
    return new AgentFailure(
      agentError('VOPS_GITHUB_NOT_FOUND', 'input', `Not found on GitHub: ${path}`, {
        suggestedAction: 'Check the owner/repo, and that the workflow file has been committed and pushed.',
      }),
      ExitCode.INVALID_INPUT,
    );
  }
  return new AgentFailure(
    agentError('VOPS_GITHUB_REQUEST_FAILED', 'operational', `GitHub request failed (${status ?? 'network'}): ${detail}`),
    ExitCode.FAILURE,
  );
}
