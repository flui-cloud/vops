import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { projectPath } from './agent-project';

/** Approved plans, kept immutable: hashed over their own content, and `apply` re-derives and
 * compares before running, so a changed manifest/host/image invalidates approval instead of
 * silently deploying something nobody saw. No secret values, but they name a server, hence gitignored. */

export const PLAN_SCHEMA_VERSION = 1 as const;

export interface StoredPlan<T = unknown> {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  id: string;
  /** Hash over the inputs + rendered plan; the identity `apply` re-checks. */
  hash: string;
  createdAt: string;
  vopsVersion: string;
  /** Everything needed to re-derive the same plan. */
  inputs: PlanInputs;
  plan: T;
}

export interface PlanInputs {
  spec: string;
  /** sha256 of the manifest bytes, so an edited spec invalidates the plan. */
  specHash: string;
  host: string;
  image?: string;
  name?: string;
  domain?: string;
  tls?: boolean;
  staging?: boolean;
  auth?: string;
  public?: boolean;
  set?: Record<string, string>;
}

export function hashInputs(inputs: PlanInputs, plan: unknown): string {
  return sha256(stableStringify({ inputs, plan }));
}

export function planId(hash: string): string {
  return hash.slice(0, 12);
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashFile(file: string): string {
  return sha256(fs.readFileSync(file));
}

export function savePlan<T>(dir: string, stored: StoredPlan<T>): string {
  const file = planFile(dir, stored.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  return file;
}

export function loadPlan<T>(dir: string, id: string): StoredPlan<T> | null {
  const file = planFile(dir, id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredPlan<T>;
}

export function listPlans(dir: string): StoredPlan[] {
  const base = projectPath(dir, 'plans');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(base, f), 'utf8')) as StoredPlan)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function planFile(dir: string, id: string): string {
  if (!/^[a-f0-9]{6,64}$/.test(id)) throw new Error(`Invalid plan id '${id}'.`);
  return projectPath(dir, 'plans', `${id}.json`);
}

/**
 * Deterministic JSON: keys sorted at every level, so two structurally equal
 * plans hash identically regardless of the order their fields were built in.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
