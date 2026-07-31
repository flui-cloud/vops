import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { agentKitRoot } from './agent-kit-paths';

interface AgentKitManifest {
  schemaVersion: number;
  kitVersion: string;
  knowledge: string[];
}

export interface KnowledgeMatch {
  path: string;
  title: string;
  excerpt: string;
}

@Injectable()
export class KnowledgeService {
  list(): string[] {
    return [...this.manifest().knowledge];
  }

  read(relativePath: string): { path: string; content: string } {
    const normalized = normalizeKnowledgePath(relativePath);
    if (!this.manifest().knowledge.includes(normalized)) {
      throw new Error(`Knowledge document '${relativePath}' is not published.`);
    }
    const file = safeJoin(agentKitRoot(), normalized);
    return { path: normalized, content: fs.readFileSync(file, 'utf8') };
  }

  search(query: string, limit = 10): KnowledgeMatch[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return this.list()
      .map((entry) => {
        const content = this.read(entry).content;
        const lower = content.toLowerCase();
        const score = terms.reduce((sum, term) => sum + countOccurrences(lower, term), 0);
        return { entry, content, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.localeCompare(b.entry))
      .slice(0, Math.max(1, Math.min(limit, 25)))
      .map(({ entry, content }) => ({
        path: entry,
        title: content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(entry),
        excerpt: excerptFor(content, terms),
      }));
  }

  private manifest(): AgentKitManifest {
    const file = path.join(agentKitRoot(), 'manifest.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AgentKitManifest;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.knowledge)) {
      throw new Error(`Unsupported agent kit manifest at ${file}.`);
    }
    return parsed;
  }
}

function normalizeKnowledgePath(input: string): string {
  return input.replaceAll('\\', '/').replace(/^\/+/, '');
}

function safeJoin(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error('Knowledge path escapes the agent kit.');
  return resolved;
}

function countOccurrences(content: string, term: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(term, offset)) >= 0) {
    count += 1;
    offset += term.length;
  }
  return count;
}

function excerptFor(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const start = Math.max(0, Math.min(...positions) - 100);
  return content.slice(start, start + 320).replace(/\s+/g, ' ').trim();
}
