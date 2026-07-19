import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { VopsHost } from '../hosts/host.model';
import { profileDir } from './profile';

/** ops or user key resolved by the caller. */
export interface SshTarget {
  host: VopsHost;
  keyPath: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The one shared SSH primitive for every rung-1/2/3 host operation. No new
 * dependency: it wraps the local `ssh`/`scp` binaries (as `commands/ssh.ts`
 * already does), never an SSH library, and never puts secrets or file contents
 * in argv — contents go over stdin. known_hosts is kept under the profile dir so
 * vops never pollutes the user's ~/.ssh/known_hosts.
 */
export interface SshExec {
  /** Run one command; BatchMode, ConnectTimeout, no pty. Never throws on non-zero exit. */
  run(t: SshTarget, command: string, opts?: { timeoutMs?: number; connectTimeoutSec?: number }): Promise<ExecResult>;
  /** Run a script remotely via `ssh … bash -s` (piped over stdin). `sudo` runs it as one root shell. */
  runScript(t: SshTarget, scriptBody: string, opts?: { timeoutMs?: number; sudo?: boolean }): Promise<ExecResult>;
  /** Write content to a remote path atomically (temp + mv), with mode. Uses stdin, not argv. */
  putFile(t: SshTarget, remotePath: string, content: string, mode: string): Promise<void>;
  /** scp a local binary to the host (backup only). */
  putBinary(t: SshTarget, localPath: string, remotePath: string): Promise<void>;
}

/** Injectable seam: real spawn by default, a fake in unit tests. */
export type ProcessRunner = (
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number },
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT = 30_000;

function realRunner(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? DEFAULT_TIMEOUT);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 255, stdout, stderr: (stderr + '\n' + e.message).trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 255, stdout, stderr });
    });
    if (opts.input != null) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

@Injectable()
export class RealSshExec implements SshExec {
  constructor(private readonly runner: ProcessRunner = realRunner) {}

  run(
    t: SshTarget,
    command: string,
    opts: { timeoutMs?: number; connectTimeoutSec?: number } = {},
  ): Promise<ExecResult> {
    return this.runner('ssh', [...this.sshArgs(t, opts.connectTimeoutSec), command], {
      timeoutMs: opts.timeoutMs,
    });
  }

  runScript(
    t: SshTarget,
    scriptBody: string,
    opts: { timeoutMs?: number; sudo?: boolean } = {},
  ): Promise<ExecResult> {
    // `sudo` runs the WHOLE script as one root shell (one sudo ticket) — so a
    // multi-step write→validate→revert sequence can't half-apply if a per-command
    // sudo ticket expired mid-script. No-op when the login user is already root.
    const interpreter = opts.sudo && t.host.user !== 'root' ? 'sudo -n bash -s' : 'bash -s';
    return this.runner('ssh', [...this.sshArgs(t), interpreter], {
      input: scriptBody,
      timeoutMs: opts.timeoutMs,
    });
  }

  async putFile(t: SshTarget, remotePath: string, content: string, mode: string): Promise<void> {
    // Atomic: write a sibling temp file, chmod, then mv over the target.
    const cmd =
      `set -e; d=$(dirname '${remotePath}'); mkdir -p "$d"; ` +
      `tmp=$(mktemp "$d/.vops.XXXXXX"); cat > "$tmp"; chmod ${mode} "$tmp"; ` +
      `mv "$tmp" '${remotePath}'`;
    const res = await this.runner('ssh', [...this.sshArgs(t), cmd], { input: content });
    if (res.code !== 0) {
      throw new Error(`putFile ${remotePath} failed (code ${res.code}): ${res.stderr.trim()}`);
    }
  }

  async putBinary(t: SshTarget, localPath: string, remotePath: string): Promise<void> {
    const staged = `/tmp/.vops-bin.${t.host.name}`;
    const scpRes = await this.runner(
      'scp',
      [...this.scpArgs(t), localPath, `${t.host.user}@${t.host.address}:${staged}`],
      {},
    );
    if (scpRes.code !== 0) {
      throw new Error(`scp ${remotePath} failed (code ${scpRes.code}): ${scpRes.stderr.trim()}`);
    }
    const mv = await this.run(
      t,
      `set -e; chmod 0755 '${staged}'; mv '${staged}' '${remotePath}'`,
    );
    if (mv.code !== 0) {
      throw new Error(`install ${remotePath} failed (code ${mv.code}): ${mv.stderr.trim()}`);
    }
  }

  private commonOpts(connectTimeoutSec = 10): string[] {
    return [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${connectTimeoutSec}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      // Verification must exercise ONLY the -i key: no agent keys, no multiplexed
      // master (a shared connection would "verify" a new key over the old session).
      '-o', 'IdentitiesOnly=yes',
      '-o', 'ControlPath=none',
      '-o', `UserKnownHostsFile=${this.knownHostsFile()}`,
    ];
  }

  private sshArgs(t: SshTarget, connectTimeoutSec?: number): string[] {
    return [
      '-i', t.keyPath,
      '-p', String(t.host.port || 22),
      ...this.commonOpts(connectTimeoutSec),
      `${t.host.user}@${t.host.address}`,
    ];
  }

  private scpArgs(t: SshTarget): string[] {
    return ['-i', t.keyPath, '-P', String(t.host.port || 22), ...this.commonOpts()];
  }

  private knownHostsFile(): string {
    const dir = profileDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, 'known_hosts');
  }
}
