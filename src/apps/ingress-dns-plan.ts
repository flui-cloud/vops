/** What would happen to DNS *before* anything is written. Rule: a name that already resolves
 * somewhere is not ours to take — DNS carries no undo, so publishing must never silently repoint it. */
export interface DnsRecordLike {
  recordId: string;
  type: string;
  name: string;
  value: string;
}

export type DnsAction = 'create' | 'reuse' | 'conflict';

export type DnsConflictReason =
  /** An A record is already published here, pointing at something else. */
  | 'points-elsewhere'
  /** A CNAME lives here, and DNS forbids any other record beside it. */
  | 'cname-present';

export interface DnsPlan {
  action: DnsAction;
  /** Present when `reuse`: the record already saying what we want. */
  existing?: DnsRecordLike;
  /** A records at this name pointing somewhere else. */
  stale: DnsRecordLike[];
  reason?: DnsConflictReason;
  /** Ready to show: what is published here now. */
  occupied: Array<{ type: string; value: string }>;
}

export class DnsConflictError extends Error {
  constructor(
    readonly fqdn: string,
    readonly plan: DnsPlan,
  ) {
    super(describe(fqdn, plan));
    this.name = 'DnsConflictError';
  }
}

/** Only A and CNAME can stand in the way — AAAA/MX/TXT coexist with an A record by design
 * (TXT especially, used everywhere for domain ownership proof), so treating them as conflicts would refuse ordinary zones. */
export function planARecord(
  records: readonly DnsRecordLike[],
  name: string,
  fqdn: string,
  ip: string,
): DnsPlan {
  const here = records.filter((r) => sameName(r.name, name, fqdn));
  const cname = here.filter((r) => r.type.toUpperCase() === 'CNAME');
  const a = here.filter((r) => r.type.toUpperCase() === 'A');
  // Only what the decision turns on. At an apex the name also carries NS, SOA, MX
  // and TXT, and listing those in the message buries the one line that matters.
  const occupied = [...a, ...cname].map((r) => ({ type: r.type.toUpperCase(), value: r.value }));

  if (cname.length) return { action: 'conflict', reason: 'cname-present', stale: [], occupied };
  if (!a.length) return { action: 'create', stale: [], occupied };

  const mine = a.find((r) => r.value.trim() === ip);
  const others = a.filter((r) => r.value.trim() !== ip);
  // Even one extra value is a conflict, not litter to sweep up: a second A makes
  // the name round-robin, so half the traffic already goes somewhere we did not
  // put it, and that somewhere belongs to someone.
  if (others.length) {
    return { action: 'conflict', reason: 'points-elsewhere', stale: others, occupied };
  }
  return { action: 'reuse', existing: mine, stale: [], occupied };
}

/** Providers return record names relative (`app`) or absolute (`app.example.com.`). */
export function sameName(recorded: string, relative: string, fqdn: string): boolean {
  const r = recorded.replace(/\.$/, '').toLowerCase();
  return r === relative.toLowerCase() || r === fqdn.replace(/\.$/, '').toLowerCase();
}

function describe(fqdn: string, plan: DnsPlan): string {
  const shown = plan.occupied.map((o) => `${o.type} ${o.value}`).join(', ');
  if (plan.reason === 'cname-present') {
    return `${fqdn} already has a CNAME (${shown}). DNS does not allow an A record beside one — use a different hostname, or remove the CNAME yourself.`;
  }
  return `${fqdn} already points elsewhere (${shown}). vops will not repoint a name it did not create — use a different hostname, or re-run with --force-dns if you are sure.`;
}
