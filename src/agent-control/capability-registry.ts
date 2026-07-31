import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import Ajv, { ErrorObject, ValidateFunction } from 'ajv';

export type CapabilityRisk = 'read_only' | 'low' | 'medium' | 'high' | 'destructive';
export type CapabilityAccess = 'read' | 'local_write' | 'remote_write' | 'provider_write';
export type ApprovalDefault = 'session_grant' | 'plan_approval' | 'explicit_approval';

export interface CapabilityDefinition {
  id: string;
  version: number;
  summary: string;
  /** Short imperative label for humans — what the user sees on a permission chip or an
   * activity line, instead of the dotted capability id. */
  action: string;
  category: string;
  access: CapabilityAccess;
  risk: CapabilityRisk;
  reversible: boolean | 'conditional';
  idempotent: boolean | 'conditional';
  supportsPlan: boolean;
  supportsDryRun: boolean;
  enabled?: boolean;
  unavailableReason?: string;
  possibleEffects: string[];
  /** True when the capability acts on one managed host that its input identifies only
   * indirectly (by application name). Those inputs carry no `target`, so the session
   * target scope can only be enforced once a host has been resolved for them. */
  hostScoped?: boolean;
  approvalDefaults: Record<'development' | 'staging' | 'production', ApprovalDefault>;
  inputSchema: Record<string, unknown>;
}

interface CapabilityDocument {
  schemaVersion: number;
  capabilities: CapabilityDefinition[];
}

export interface CapabilityValidation {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

@Injectable()
export class CapabilityRegistry {
  readonly schemaVersion: number;
  private readonly definitions: CapabilityDefinition[];
  private readonly byId: Map<string, CapabilityDefinition>;
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

  constructor() {
    const document = readCapabilityDocument();
    this.schemaVersion = document.schemaVersion;
    this.definitions = document.capabilities.map((entry) => ({
      ...entry,
      enabled: entry.enabled ?? true,
    }));
    this.byId = new Map(this.definitions.map((entry) => [entry.id, entry]));
    if (this.byId.size !== this.definitions.length) {
      throw new Error('Capability registry contains duplicate ids.');
    }
  }

  list(opts: { includeUnavailable?: boolean } = {}): CapabilityDefinition[] {
    return this.definitions
      .filter((entry) => opts.includeUnavailable || entry.enabled)
      .map((entry) => structuredClone(entry));
  }

  describe(id: string): CapabilityDefinition {
    const found = this.byId.get(id);
    if (!found) throw new Error(`Unknown capability '${id}'.`);
    return structuredClone(found);
  }

  has(id: string): boolean {
    return this.byId.get(id)?.enabled === true;
  }

  validate(id: string, input: unknown): CapabilityValidation {
    const definition = this.byId.get(id);
    if (!definition) return { valid: false, errors: [{ path: '/', message: `Unknown capability '${id}'.` }] };
    if (!definition.enabled) {
      return { valid: false, errors: [{ path: '/', message: definition.unavailableReason ?? `${id} is unavailable.` }] };
    }

    const validate = this.validator(definition);
    const valid = validate(input);
    return {
      valid,
      errors: valid ? [] : (validate.errors ?? []).map(validationError),
    };
  }

  private validator(definition: CapabilityDefinition): ValidateFunction {
    const cached = this.validators.get(definition.id);
    if (cached) return cached;
    const created = this.ajv.compile(definition.inputSchema);
    this.validators.set(definition.id, created);
    return created;
  }
}

export function capabilitySourceFile(): string {
  return path.join(__dirname, 'capabilities.json');
}

function readCapabilityDocument(): CapabilityDocument {
  const file = capabilitySourceFile();
  if (!fs.existsSync(file)) throw new Error(`Capability registry is missing from this install (${file}).`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CapabilityDocument;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.capabilities)) {
    throw new Error(`Unsupported capability registry schema in ${file}.`);
  }
  return parsed;
}

function validationError(error: ErrorObject): { path: string; message: string } {
  const property = error.params && 'missingProperty' in error.params ? `/${String(error.params.missingProperty)}` : '';
  return {
    path: `${error.instancePath || '/'}${property}`,
    message: error.message ?? 'Invalid value',
  };
}
