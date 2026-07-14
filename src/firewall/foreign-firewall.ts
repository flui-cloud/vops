import { VopsFirewallRule } from '../dto/firewall.dto';

/**
 * Read-only detection of a host firewall vops does NOT manage, so a box that is
 * actually protected never shows up as "unprotected".
 *
 * The first-class case is **flui's** own host firewall (`table inet flui`): flui
 * persists its ruleset at a known path and embeds its exact `VopsFirewallRule[]`
 * as a base64 comment, so we decode its real rules instead of guessing from
 * arbitrary nftables output. Anything else that installs an `input`
 * default-deny chain surfaces only as a generic "filtered by rules not managed
 * by vops" posture — we don't try to interpret foreign rulesets.
 */

export const FLUI_RULESET_PATH = '/etc/flui/flui-firewall.nft';
export const FLUI_TABLE = 'flui';
export const FLUI_UNIT = 'flui-firewall.service';
export const VOPS_TABLE = 'vops_fw';

// flui's on-host contract (flui-core nftables-ruleset.ts): the reconciled rules
// are stored as `# flui-rules-b64:<base64 of JSON VopsFirewallRule[]>`.
const FLUI_RULES_PREFIX = '# flui-rules-b64:';

const PROBE_MARKERS = [
  '===VOPS_FLUI_FILE===',
  '===VOPS_NFT_CHAINS===',
  '===VOPS_FLUI_UNIT===',
  '===VOPS_END===',
] as const;

export interface ForeignFirewall {
  /** 'flui' when we decoded flui's own ruleset; 'other' for any non-vops input default-deny. */
  source: 'flui' | 'other';
  /** A default-deny input chain for this source is live on the host right now. */
  active: boolean;
  /** flui's boot unit is enabled (survives reboot). Only meaningful for 'flui'. */
  persistent: boolean;
  /** Decoded rules — populated only for 'flui'; empty for 'other'. */
  rules: VopsFirewallRule[];
  /** Where the source persists its ruleset (read-only hint). */
  rulesetPath?: string;
}

export interface ForeignProbeSections {
  fluiFile: string;
  chains: string;
  fluiUnit: string;
}

/** The single best-effort SSH probe: flui's file, the nftables chains, flui's unit state. */
export function foreignProbeScript(sudo: string): string {
  return [
    `echo '${PROBE_MARKERS[0]}'`,
    `${sudo}cat ${FLUI_RULESET_PATH} 2>/dev/null || true`,
    `echo '${PROBE_MARKERS[1]}'`,
    `${sudo}nft list chains 2>/dev/null || true`,
    `echo '${PROBE_MARKERS[2]}'`,
    `systemctl is-enabled ${FLUI_UNIT} 2>/dev/null || true`,
    `echo '${PROBE_MARKERS[3]}'`,
    '',
  ].join('\n');
}

export function parseForeignProbe(output: string): ForeignProbeSections {
  const idx = PROBE_MARKERS.map((m) => output.indexOf(m));
  const between = (i: number): string =>
    idx[i] < 0 || idx[i + 1] < 0
      ? ''
      : output.slice(idx[i] + PROBE_MARKERS[i].length, idx[i + 1]).trim();
  return { fluiFile: between(0), chains: between(1), fluiUnit: between(2) };
}

/** Decode flui's embedded `VopsFirewallRule[]` from its ruleset file text. */
export function decodeFluiRules(rulesetText: string): VopsFirewallRule[] | null {
  const line = rulesetText
    .split('\n')
    .find((l) => l.startsWith(FLUI_RULES_PREFIX));
  if (!line) return null;
  try {
    const b64 = line.slice(FLUI_RULES_PREFIX.length).trim();
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as VopsFirewallRule[]) : null;
  } catch {
    return null;
  }
}

/** Table names that own an `input` base chain with `policy drop`, from `nft list chains`. */
export function parseInputDropTables(nftChains: string): Set<string> {
  const tables = new Set<string>();
  let currentTable: string | null = null;
  for (const raw of nftChains.split('\n')) {
    const line = raw.trim();
    const table = /^table\s+\S+\s+(\S+)/.exec(line);
    if (table) {
      currentTable = table[1];
      continue;
    }
    if (currentTable && line.includes('hook input') && /policy\s+drop/.test(line)) {
      tables.add(currentTable);
    }
  }
  return tables;
}

export function buildForeignFirewall(
  sections: ForeignProbeSections,
): ForeignFirewall | null {
  const dropTables = parseInputDropTables(sections.chains);
  const fluiRules = decodeFluiRules(sections.fluiFile);

  if (fluiRules != null || dropTables.has(FLUI_TABLE)) {
    return {
      source: 'flui',
      active: dropTables.has(FLUI_TABLE),
      persistent: sections.fluiUnit.trim() === 'enabled',
      rules: fluiRules ?? [],
      rulesetPath: FLUI_RULESET_PATH,
    };
  }

  const other = [...dropTables].some((t) => t !== VOPS_TABLE);
  if (other) {
    return { source: 'other', active: true, persistent: false, rules: [] };
  }
  return null;
}
