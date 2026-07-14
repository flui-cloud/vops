import {
  buildForeignFirewall,
  decodeFluiRules,
  FLUI_RULESET_PATH,
  foreignProbeScript,
  parseForeignProbe,
  parseInputDropTables,
} from '../src/firewall/foreign-firewall';
import { VopsFirewallRule } from '../src/dto/firewall.dto';

const fluiRules: VopsFirewallRule[] = [
  { description: 'Web (HTTPS)', direction: 'in', protocol: 'tcp', port: '443' },
  { description: 'Web (HTTP)', direction: 'in', protocol: 'tcp', port: '80' },
];

const fluiFile = [
  '#!/usr/sbin/nft -f',
  '# Flui-managed host firewall — DO NOT EDIT (reconciled by Flui over SSH).',
  '# flui-rules-b64:' + Buffer.from(JSON.stringify(fluiRules)).toString('base64'),
  '',
  'table inet flui {',
  '\tchain input { type filter hook input priority 0; policy drop; }',
  '}',
].join('\n');

const chainsBoth = [
  'table inet flui {',
  '\tchain input {',
  '\t\ttype filter hook input priority filter; policy drop;',
  '\t}',
  '\tchain forward {',
  '\t\ttype filter hook forward priority filter; policy accept;',
  '\t}',
  '}',
  'table inet vops_fw {',
  '\tchain input {',
  '\t\ttype filter hook input priority filter; policy drop;',
  '\t}',
  '}',
].join('\n');

describe('decodeFluiRules', () => {
  it('decodes flui\'s embedded base64 rule comment', () => {
    expect(decodeFluiRules(fluiFile)).toEqual(fluiRules);
  });
  it('returns null when there is no flui comment', () => {
    expect(decodeFluiRules('table inet flui {}')).toBeNull();
    expect(decodeFluiRules('')).toBeNull();
  });
  it('returns null on a corrupt base64 payload (no throw)', () => {
    expect(decodeFluiRules('# flui-rules-b64:@@not-base64@@')).toBeNull();
  });
});

describe('parseInputDropTables', () => {
  it('collects tables whose input base chain has policy drop', () => {
    const t = parseInputDropTables(chainsBoth);
    expect([...t].sort()).toEqual(['flui', 'vops_fw']);
  });
  it('ignores forward/accept chains and empty input', () => {
    expect(parseInputDropTables('')).toEqual(new Set());
    const accept = 'table inet x {\n\tchain input { type filter hook input priority 0; policy accept; }\n}';
    expect(parseInputDropTables(accept)).toEqual(new Set());
  });
});

describe('parseForeignProbe', () => {
  it('splits the delimited probe output into sections', () => {
    const out = [
      '===VOPS_FLUI_FILE===',
      fluiFile,
      '===VOPS_NFT_CHAINS===',
      chainsBoth,
      '===VOPS_FLUI_UNIT===',
      'enabled',
      '===VOPS_END===',
    ].join('\n');
    const s = parseForeignProbe(out);
    expect(decodeFluiRules(s.fluiFile)).toEqual(fluiRules);
    expect(parseInputDropTables(s.chains).has('flui')).toBe(true);
    expect(s.fluiUnit).toBe('enabled');
  });
  it('yields empty sections when markers are missing', () => {
    expect(parseForeignProbe('garbage')).toEqual({ fluiFile: '', chains: '', fluiUnit: '' });
  });
});

describe('buildForeignFirewall', () => {
  it('reports flui as the source with decoded rules, active + persistent', () => {
    const fw = buildForeignFirewall({ fluiFile, chains: chainsBoth, fluiUnit: 'enabled' });
    expect(fw).toEqual({
      source: 'flui',
      active: true,
      persistent: true,
      rules: fluiRules,
      rulesetPath: FLUI_RULESET_PATH,
    });
  });
  it('flui configured but not loaded → source flui, active false', () => {
    const fw = buildForeignFirewall({ fluiFile, chains: '', fluiUnit: 'disabled' });
    expect(fw?.source).toBe('flui');
    expect(fw?.active).toBe(false);
    expect(fw?.persistent).toBe(false);
    expect(fw?.rules).toEqual(fluiRules);
  });
  it('a non-flui, non-vops input drop → generic other posture', () => {
    const chains = 'table inet myfw {\n\tchain input { type filter hook input priority 0; policy drop; }\n}';
    const fw = buildForeignFirewall({ fluiFile: '', chains, fluiUnit: '' });
    expect(fw).toEqual({ source: 'other', active: true, persistent: false, rules: [] });
  });
  it('only the vops table present → nothing foreign detected', () => {
    const chains = 'table inet vops_fw {\n\tchain input { type filter hook input priority 0; policy drop; }\n}';
    expect(buildForeignFirewall({ fluiFile: '', chains, fluiUnit: '' })).toBeNull();
  });
  it('nothing enforcing → null', () => {
    expect(buildForeignFirewall({ fluiFile: '', chains: '', fluiUnit: '' })).toBeNull();
  });
});

describe('foreignProbeScript', () => {
  it('reads flui\'s file, nft chains and the unit; honours a sudo prefix', () => {
    const s = foreignProbeScript('sudo -n ');
    expect(s).toContain(`sudo -n cat ${FLUI_RULESET_PATH}`);
    expect(s).toContain('sudo -n nft list chains');
    expect(s).toContain('systemctl is-enabled flui-firewall.service');
  });
});
