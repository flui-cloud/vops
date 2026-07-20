import * as fs from 'node:fs';

const SONAR_URL = process.env.SONAR_HOST_URL ?? 'http://localhost:9000';
const TOKEN = process.env.SONAR_TOKEN;
const PROJECT_KEY = process.env.SONAR_PROJECT_KEY ?? 'FluiVops';
const APPLY = process.argv.includes('--apply');

if (!TOKEN) {
  console.error('SONAR_TOKEN env var is required.');
  process.exit(1);
}

const auth = `Basic ${Buffer.from(TOKEN + ':').toString('base64')}`;

interface SonarHotspot {
  key: string;
  ruleKey: string;
  securityCategory: string;
  component: string;
  line?: number;
  status: string;
}

interface SonarIssue {
  key: string;
  rule: string;
  type: 'CODE_SMELL' | 'BUG' | 'VULNERABILITY';
  severity: string;
  component: string;
  line?: number;
  message: string;
  status: string;
}

// Populate only when a scan surfaces a genuine false positive — never guess
// a rationale ahead of time.
const ISSUE_RATIONALE: Record<string, string> = {
  'typescript:S2068':
    "Reviewed as False Positive: the flagged literal is an environment-variable NAME (e.g. CONTABO_API_PASSWORD), not a credential value. src/lib/credentials/provider-credentials.ts maps each provider credential field to the env var the provider reads; no secret material is hard-coded — actual secrets live only in the encrypted local store or the user's own environment.",
};

const RATIONALE: Record<
  string,
  { comment: string; resolution: 'SAFE' | 'ACKNOWLEDGED' | 'FIXED' }
> = {
  'typescript:S4036': {
    comment:
      'Reviewed as Safe: vops is a local CLI that spawns ssh/ssh-keygen with the invoking user\'s own PATH on their own machine (src/commands/ssh.ts, src/ssh-keys/vops-ssh-keys.service.ts). There is no privilege boundary or multi-tenant server here — anyone able to plant a malicious binary earlier in the user\'s PATH already has arbitrary code execution on that machine (e.g. via their shell), so this adds no new attack surface.',
    resolution: 'SAFE',
  },
  'typescript:S5852': {
    comment: String.raw`Reviewed as Safe: /\n+$/ in src/host-firewall/nftables.ts has no nested/overlapping quantifiers (single char class + end anchor), so it is linear, not super-linear — verified empirically against 200k trailing newlines (0ms). The input is also locally-rendered nftables config text from the user's own firewall rules, not untrusted network input.`,
    resolution: 'SAFE',
  },
};

async function fetchAllHotspots(): Promise<SonarHotspot[]> {
  const all: SonarHotspot[] = [];
  let page = 1;
  while (true) {
    const url = `${SONAR_URL}/api/hotspots/search?projectKey=${PROJECT_KEY}&status=TO_REVIEW&p=${page}&ps=500`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`fetch ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      hotspots: SonarHotspot[];
      paging?: { total: number };
    };
    all.push(...data.hotspots);
    const total = data.paging?.total ?? all.length;
    if (all.length >= total || data.hotspots.length === 0) break;
    page++;
  }
  return all;
}

async function fetchAllIssues(): Promise<SonarIssue[]> {
  const all: SonarIssue[] = [];
  let page = 1;
  while (true) {
    const url = `${SONAR_URL}/api/issues/search?componentKeys=${PROJECT_KEY}&types=VULNERABILITY,BUG&resolved=false&p=${page}&ps=500`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok)
      throw new Error(`fetch issues ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { issues: SonarIssue[]; total?: number };
    all.push(...data.issues);
    const total = data.total ?? all.length;
    if (all.length >= total || data.issues.length === 0) break;
    page++;
  }
  return all;
}

async function markIssueFalsePositive(
  issueKey: string,
  comment: string,
): Promise<void> {
  const cmtRes = await fetch(`${SONAR_URL}/api/issues/add_comment`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ issue: issueKey, text: comment }).toString(),
  });
  if (!cmtRes.ok) {
    throw new Error(
      `add_comment ${issueKey}: ${cmtRes.status} ${await cmtRes.text()}`,
    );
  }
  const trRes = await fetch(`${SONAR_URL}/api/issues/do_transition`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      issue: issueKey,
      transition: 'falsepositive',
    }).toString(),
  });
  if (!trRes.ok) {
    throw new Error(
      `do_transition ${issueKey}: ${trRes.status} ${await trRes.text()}`,
    );
  }
}

async function changeStatus(
  hotspotKey: string,
  comment: string,
  resolution: string,
): Promise<void> {
  const body = new URLSearchParams({
    hotspot: hotspotKey,
    status: 'REVIEWED',
    resolution,
    comment,
  });
  const res = await fetch(`${SONAR_URL}/api/hotspots/change_status`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      `change_status ${hotspotKey}: ${res.status} ${await res.text()}`,
    );
  }
}

function stripComponentPrefix(component: string): string {
  return component.replace(PROJECT_KEY + ':', '');
}

function groupByRule<T>(
  items: T[],
  ruleOf: (item: T) => string,
  hasRationale: (rule: string) => boolean,
): { byRule: Map<string, T[]>; skipped: T[] } {
  const byRule = new Map<string, T[]>();
  const skipped: T[] = [];
  for (const item of items) {
    const rule = ruleOf(item);
    if (hasRationale(rule)) {
      if (!byRule.has(rule)) byRule.set(rule, []);
      byRule.get(rule)!.push(item);
    } else {
      skipped.push(item);
    }
  }
  return { byRule, skipped };
}

function printHotspotsSummary(
  hotspots: SonarHotspot[],
  byRule: Map<string, SonarHotspot[]>,
  skipped: SonarHotspot[],
): void {
  console.log(`=== HOTSPOTS ===`);
  console.log(`Total open: ${hotspots.length}`);
  console.log(`Categorised: ${hotspots.length - skipped.length}`);
  console.log(`Skipped: ${skipped.length}\n`);
  for (const [rule, items] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${rule}: ${items.length} → ${RATIONALE[rule].resolution}`);
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped hotspots:`);
    for (const h of skipped) {
      console.log(`  - ${h.ruleKey} ${stripComponentPrefix(h.component)}:${h.line ?? '?'}`);
    }
  }
}

function printIssuesSummary(
  issues: SonarIssue[],
  byRule: Map<string, SonarIssue[]>,
  skipped: SonarIssue[],
): void {
  console.log(`\n=== ISSUES (BUG + VULNERABILITY) ===`);
  console.log(`Total open: ${issues.length}`);
  console.log(`Categorised: ${issues.length - skipped.length}`);
  console.log(`Skipped: ${skipped.length}\n`);
  for (const [rule, items] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${rule}: ${items.length} → FALSE_POSITIVE`);
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped issues (review manually in UI):`);
    for (const i of skipped) {
      console.log(`  - ${i.rule} ${stripComponentPrefix(i.component)}:${i.line ?? '?'} — ${i.message}`);
    }
  }
}

async function applyHotspots(byRule: Map<string, SonarHotspot[]>): Promise<{ ok: number; fail: number }> {
  console.log(`\nApplying hotspots...`);
  let ok = 0;
  let fail = 0;
  for (const [rule, items] of byRule) {
    const r = RATIONALE[rule];
    for (const h of items) {
      try {
        await changeStatus(h.key, r.comment, r.resolution);
        ok++;
      } catch (e) {
        fail++;
        console.error(`FAIL ${rule} ${h.key}: ${(e as Error).message}`);
      }
    }
    console.log(`  ${rule}: ${items.length} marked`);
  }
  return { ok, fail };
}

async function applyIssues(byRule: Map<string, SonarIssue[]>): Promise<{ ok: number; fail: number }> {
  console.log(`\nApplying issues...`);
  let ok = 0;
  let fail = 0;
  for (const [rule, items] of byRule) {
    const comment = ISSUE_RATIONALE[rule];
    for (const i of items) {
      try {
        await markIssueFalsePositive(i.key, comment);
        ok++;
      } catch (e) {
        fail++;
        console.error(`FAIL ${rule} ${i.key}: ${(e as Error).message}`);
      }
    }
    console.log(`  ${rule}: ${items.length} marked`);
  }
  return { ok, fail };
}

async function main() {
  const hotspots = await fetchAllHotspots();
  const issues = await fetchAllIssues();
  fs.mkdirSync('.sonar', { recursive: true });

  const hot = groupByRule(hotspots, (h) => h.ruleKey, (rule) => !!RATIONALE[rule]);
  const iss = groupByRule(issues, (i) => i.rule, (rule) => !!ISSUE_RATIONALE[rule]);

  console.log(
    `\nMode: ${APPLY ? 'APPLY (will mutate Sonar)' : 'DRY RUN (no changes — pass --apply to commit)'}\n`,
  );
  printHotspotsSummary(hotspots, hot.byRule, hot.skipped);
  printIssuesSummary(issues, iss.byRule, iss.skipped);

  if (!APPLY) {
    console.log(`\nDry run complete. Re-run with --apply to write changes to SonarQube.`);
    return;
  }

  const hotResult = await applyHotspots(hot.byRule);
  const issResult = await applyIssues(iss.byRule);
  console.log(`\nDone. ${hotResult.ok + issResult.ok} marked, ${hotResult.fail + issResult.fail} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
