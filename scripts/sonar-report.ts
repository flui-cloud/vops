import * as fs from 'node:fs';
import * as path from 'node:path';

const SONAR_URL = process.env.SONAR_HOST_URL ?? 'http://localhost:9000';
const TOKEN = process.env.SONAR_TOKEN;
const PROJECT_KEY = process.env.SONAR_PROJECT_KEY ?? 'FluiVops';
const OUT_DIR = path.resolve(process.cwd(), '.sonar');

if (!TOKEN) {
  console.error('SONAR_TOKEN env var is required.');
  process.exit(1);
}

const auth = `Basic ${Buffer.from(`${TOKEN}:`).toString('base64')}`;

interface SonarIssue {
  key: string;
  rule: string;
  severity: 'BLOCKER' | 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO';
  component: string;
  line?: number;
  message: string;
  effort?: string;
  type: 'CODE_SMELL' | 'BUG' | 'VULNERABILITY';
  tags?: string[];
  status: string;
}

interface SonarHotspot {
  key: string;
  component: string;
  securityCategory: string;
  vulnerabilityProbability: 'HIGH' | 'MEDIUM' | 'LOW';
  status: string;
  line?: number;
  message: string;
  ruleKey: string;
}

async function paginated<T>(
  baseUrl: string,
  itemsKey: 'issues' | 'hotspots',
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (true) {
    const url = `${baseUrl}&p=${page}&ps=500`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) {
      throw new Error(`Sonar API error ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const items = (data[itemsKey] as T[]) ?? [];
    all.push(...items);
    const total = (data['total'] as number) ?? all.length;
    if (all.length >= total || items.length === 0) break;
    page++;
    if (page > 40) break;
  }
  return all;
}

function stripComponentPrefix(component: string): string {
  return component.replace(`${PROJECT_KEY}:`, '');
}

function severityRank(s: SonarIssue['severity']): number {
  return { BLOCKER: 0, CRITICAL: 1, MAJOR: 2, MINOR: 3, INFO: 4 }[s];
}

function countSeverity(items: { severity: string }[]): string {
  const c: Record<string, number> = {};
  for (const i of items) c[i.severity] = (c[i.severity] ?? 0) + 1;
  return Object.entries(c)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
}

async function fetchMeasures(): Promise<Record<string, string>> {
  const metrics = [
    'bugs',
    'vulnerabilities',
    'code_smells',
    'security_hotspots',
    'coverage',
    'duplicated_lines_density',
    'cognitive_complexity',
    'ncloc',
    'sqale_index',
    'reliability_rating',
    'security_rating',
    'sqale_rating',
  ].join(',');
  const url = `${SONAR_URL}/api/measures/component?component=${PROJECT_KEY}&metricKeys=${metrics}`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) return {};
  const data = (await res.json()) as {
    component?: { measures?: { metric: string; value: string }[] };
  };
  const out: Record<string, string> = {};
  for (const m of data.component?.measures ?? []) out[m.metric] = m.value;
  return out;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const issues = await paginated<SonarIssue>(
    `${SONAR_URL}/api/issues/search?componentKeys=${PROJECT_KEY}&types=CODE_SMELL,BUG,VULNERABILITY&resolved=false`,
    'issues',
  );
  const hotspots = await paginated<SonarHotspot>(
    `${SONAR_URL}/api/hotspots/search?projectKey=${PROJECT_KEY}&status=TO_REVIEW`,
    'hotspots',
  );
  const measures = await fetchMeasures();

  fs.writeFileSync(
    path.join(OUT_DIR, 'issues.json'),
    JSON.stringify(issues, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'hotspots.json'),
    JSON.stringify(hotspots, null, 2),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'measures.json'),
    JSON.stringify(measures, null, 2),
  );

  const byRule = new Map<string, SonarIssue[]>();
  for (const i of issues) {
    if (!byRule.has(i.rule)) byRule.set(i.rule, []);
    byRule.get(i.rule)!.push(i);
  }
  const rulesSorted = [...byRule.entries()].sort((a, b) => {
    const aMin = Math.min(...a[1].map((i) => severityRank(i.severity)));
    const bMin = Math.min(...b[1].map((i) => severityRank(i.severity)));
    if (aMin !== bMin) return aMin - bMin;
    return b[1].length - a[1].length;
  });

  let mdRule = `# Sonar findings — by rule\n\n`;
  mdRule += `Generated: ${new Date().toISOString()}\n`;
  mdRule += `Project: \`${PROJECT_KEY}\`\n\n`;
  mdRule += `## Summary\n\n`;
  mdRule += `- Total open issues: **${issues.length}**\n`;
  mdRule += `- Bugs: ${measures.bugs ?? '?'}\n`;
  mdRule += `- Vulnerabilities: ${measures.vulnerabilities ?? '?'}\n`;
  mdRule += `- Code smells: ${measures.code_smells ?? '?'}\n`;
  mdRule += `- Security hotspots (to review): **${hotspots.length}**\n`;
  mdRule += `- Coverage: ${measures.coverage ?? '?'}%\n`;
  mdRule += `- Duplicated lines: ${measures.duplicated_lines_density ?? '?'}%\n`;
  mdRule += `- Lines of code: ${measures.ncloc ?? '?'}\n`;
  mdRule += `- Technical debt (sqale_index, minutes): ${measures.sqale_index ?? '?'}\n\n`;
  mdRule += `Severities ordered: BLOCKER → CRITICAL → MAJOR → MINOR → INFO. Rules sorted by worst severity first, then count.\n\n`;

  for (const [rule, items] of rulesSorted) {
    mdRule += `## ${rule} (${items.length})\n\n`;
    mdRule += `Severities: ${countSeverity(items)}\n\n`;
    const sample = items.slice(0, 25);
    for (const i of sample) {
      const file = stripComponentPrefix(i.component);
      mdRule += `- ${file}:${i.line ?? '?'} \`${i.severity}\` — ${i.message}\n`;
    }
    if (items.length > sample.length) {
      mdRule += `- ... and ${items.length - sample.length} more (full list in .sonar/issues.json)\n`;
    }
    mdRule += `\n`;
  }
  fs.writeFileSync(path.join(OUT_DIR, 'issues-by-rule.md'), mdRule);

  const byFile = new Map<string, SonarIssue[]>();
  for (const i of issues) {
    const f = stripComponentPrefix(i.component);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f)!.push(i);
  }
  const filesSorted = [...byFile.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 50);

  let mdFile = `# Sonar findings — top 50 files\n\n`;
  mdFile += `Generated: ${new Date().toISOString()}\n\n`;
  for (const [file, items] of filesSorted) {
    mdFile += `## ${file} (${items.length})\n\n`;
    items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    for (const i of items) {
      mdFile += `- L${i.line ?? '?'} \`${i.rule}\` (${i.severity}): ${i.message}\n`;
    }
    mdFile += `\n`;
  }
  fs.writeFileSync(path.join(OUT_DIR, 'issues-by-file.md'), mdFile);

  if (hotspots.length > 0) {
    let mdHot = `# Sonar security hotspots — to review\n\n`;
    mdHot += `Generated: ${new Date().toISOString()}\n`;
    mdHot += `Total: **${hotspots.length}**\n\n`;
    const byCat = new Map<string, SonarHotspot[]>();
    for (const h of hotspots) {
      if (!byCat.has(h.securityCategory)) byCat.set(h.securityCategory, []);
      byCat.get(h.securityCategory)!.push(h);
    }
    for (const [cat, list] of [...byCat.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )) {
      mdHot += `## ${cat} (${list.length})\n\n`;
      for (const h of list) {
        mdHot += `- ${stripComponentPrefix(h.component)}:${h.line ?? '?'} \`${h.vulnerabilityProbability}\` (${h.ruleKey}) — ${h.message}\n`;
      }
      mdHot += `\n`;
    }
    fs.writeFileSync(path.join(OUT_DIR, 'hotspots.md'), mdHot);
  }

  console.log(`Wrote .sonar/issues.json (${issues.length} issues)`);
  console.log(`Wrote .sonar/hotspots.json (${hotspots.length} hotspots)`);
  console.log(`Wrote .sonar/measures.json`);
  console.log(`Wrote .sonar/issues-by-rule.md (${rulesSorted.length} rules)`);
  console.log(`Wrote .sonar/issues-by-file.md (top ${filesSorted.length})`);
  if (hotspots.length > 0) console.log(`Wrote .sonar/hotspots.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
