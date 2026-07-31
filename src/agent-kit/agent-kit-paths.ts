import * as path from 'node:path';

export const AGENT_KIT_VERSION = '1.0.0';

export function agentKitRoot(): string {
  return __dirname;
}

export function canonicalSkillDir(): string {
  return path.join(agentKitRoot(), 'skills', 'vops-deploy');
}

export function bootstrapFile(): string {
  return path.join(agentKitRoot(), 'AGENTS.bootstrap.md');
}
