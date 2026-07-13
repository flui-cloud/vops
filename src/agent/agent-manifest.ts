import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Loader for the metrics-agent build manifest (produced by `agent/build.sh`).
 * Same trust-anchor shape as the restic manifest: per-arch sha256 verified on the
 * host before the binary runs. The binaries are build artifacts (gitignored), so
 * this resolves the local `agent/dist` — run `sh agent/build.sh` first.
 */
export type AgentArch = 'amd64' | 'arm64';

export interface AgentBinary {
  path: string;
  sha256: string;
}

export interface AgentManifest {
  version: string;
  binaries: Record<AgentArch, AgentBinary>;
}

export function agentDistDir(): string {
  const candidates = [
    path.resolve(__dirname, '../../agent/dist'),
    path.resolve(process.cwd(), 'agent/dist'),
  ];
  return candidates.find((c) => fs.existsSync(path.join(c, 'manifest.json'))) ?? candidates[0];
}

export function loadAgentManifest(): AgentManifest | null {
  const p = path.join(agentDistDir(), 'manifest.json');
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as AgentManifest) : null;
}

export function agentArchFor(unameM: string): AgentArch | null {
  const m = unameM.trim().toLowerCase();
  if (m === 'x86_64' || m === 'amd64') return 'amd64';
  if (m === 'aarch64' || m === 'arm64') return 'arm64';
  return null;
}
