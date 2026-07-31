import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { CodingAgentProviderId } from './remote-agent.types';
import { profileDir } from '../lib/profile';

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TERMINATE_GRACE_MS = 1_500;

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function findExecutable(
  provider: CodingAgentProviderId,
  names: string[],
): string | null {
  const configured = process.env[`VOPS_${provider.replaceAll('-', '_').toUpperCase()}_BIN`];
  if (configured && executableFile(configured)) return configured;
  for (const name of names) {
    for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(entry, name);
      if (executableFile(candidate)) return candidate;
    }
  }
  return null;
}

export async function probeCommand(
  executable: string,
  args: string[],
  timeoutMs = 3_000,
): Promise<ProcessResult> {
  return runBoundedProcess(executable, args, {
    cwd: os.tmpdir(),
    input: '',
    timeoutMs,
    env: safeProcessEnv(),
  });
}

export function runBoundedProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    input: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onStdoutLine?(line: string): void | Promise<void>;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? safeProcessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let bytes = 0;
    let settled = false;
    let lineWork: Promise<void> = Promise.resolve();
    let lineError: Error | undefined;
    const abort = () => terminate(child);
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => terminate(child), options.timeoutMs);
    timer.unref();

    const consume = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT_BYTES) {
        terminate(child);
        return;
      }
      if (target === 'stderr') {
        stderr += chunk.toString('utf8');
        return;
      }
      const text = chunk.toString('utf8');
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) enqueueLine(line);
    };
    child.stdout.on('data', (chunk: Buffer) => consume('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => consume('stderr', chunk));
    child.once('error', finishError);
    child.once('exit', async (code, signal) => {
      if (stdoutBuffer) enqueueLine(stdoutBuffer);
      await lineWork;
      if (lineError) {
        finishError(lineError);
        return;
      }
      finish({ stdout, stderr, code, signal });
    });
    child.stdin.end(options.input);

    function finish(result: ProcessResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (bytes > MAX_OUTPUT_BYTES) {
        reject(new Error('Coding-agent output exceeded the configured limit.'));
      } else if (options.signal?.aborted) {
        reject(abortError());
      } else if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
        reject(new Error('Coding-agent turn timed out.'));
      } else {
        resolve(result);
      }
    }

    function finishError(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    }

    function enqueueLine(line: string) {
      if (!options.onStdoutLine || lineError) return;
      lineWork = lineWork
        .then(() => options.onStdoutLine!(line))
        .then(() => undefined)
        .catch((error) => {
          lineError = error instanceof Error ? error : new Error(String(error));
          terminate(child);
        });
    }
  });
}

export function safeProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: os.homedir(),
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    NO_COLOR: '1',
    TERM: 'dumb',
    CI: '1',
    DISABLE_AUTOUPDATER: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    ...selectedEnvironment([
      'USER',
      'LOGNAME',
      'TMPDIR',
      'SSH_AUTH_SOCK',
      'XPC_FLAGS',
      'XPC_SERVICE_NAME',
      '__CF_USER_TEXT_ENCODING',
      'DBUS_SESSION_BUS_ADDRESS',
      'XDG_RUNTIME_DIR',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'AWS_REGION',
    ]),
    ...extra,
  };
}

export function remoteRuntimeWorkspace(): string {
  const configured = process.env.VOPS_REMOTE_AGENT_WORKSPACE;
  const workspace = configured ?? path.join(profileDir(), 'remote-agent-workspace');
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  return workspace;
}

export function safeProcessFailure(provider: string, result: ProcessResult): Error {
  const category = /auth|login|sign.?in|credential/i.test(result.stderr)
    ? ' is not authenticated'
    : ' failed';
  return new Error(`${provider}${category}; inspect it locally with the provider CLI.`);
}

function executableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function selectedEnvironment(keys: string[]): NodeJS.ProcessEnv {
  return Object.fromEntries(
    keys
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]!]),
  );
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, TERMINATE_GRACE_MS);
  timer.unref();
}

function abortError(): Error {
  const error = new Error('Remote agent turn was cancelled.');
  error.name = 'AbortError';
  return error;
}
