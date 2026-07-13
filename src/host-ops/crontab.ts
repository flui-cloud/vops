/**
 * Pure crontab-block transforms. vops owns a single delimited block per feature
 * (`# vops:<tag>:start` … `# vops:<tag>:end`); everything else in the user's
 * crontab is preserved verbatim. Idempotent: re-applying replaces the block.
 */
const start = (tag: string): string => `# vops:${tag}:start`;
const end = (tag: string): string => `# vops:${tag}:end`;

function stripBlock(lines: string[], tag: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.trim() === start(tag)) { inBlock = true; continue; }
    if (line.trim() === end(tag)) { inBlock = false; continue; }
    if (!inBlock) out.push(line);
  }
  return out;
}

function toLines(content: string): string[] {
  const trimmed = content.replace(/\n+$/, '');
  return trimmed.length ? trimmed.split('\n') : [];
}

/** Insert/replace the tagged block with `body` lines. */
export function upsertCronBlock(content: string, tag: string, body: string[]): string {
  const kept = stripBlock(toLines(content), tag);
  const block = [start(tag), ...body, end(tag)];
  return [...kept, ...block].join('\n') + '\n';
}

/** Remove the tagged block; reports whether one was present. */
export function removeCronBlock(content: string, tag: string): { content: string; removed: boolean } {
  const lines = toLines(content);
  const kept = stripBlock(lines, tag);
  const removed = kept.length !== lines.length;
  return { content: kept.length ? kept.join('\n') + '\n' : '', removed };
}

export function hasCronBlock(content: string, tag: string): boolean {
  return toLines(content).some((l) => l.trim() === start(tag));
}
