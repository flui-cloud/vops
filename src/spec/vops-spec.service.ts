import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { applicationSchema, catalogAppSchema, parseYaml, validate } from '@flui-cloud/spec';
import { AgentError, AgentFailure, AgentWarning, ExitCode, agentError } from '../agent-api/agent-envelope';
import { vopsVersion } from '../build/vops-build.service';
import { FRAMEWORK_TEMPLATES, FrameworkTemplate, findTemplate, TEMPLATE_CATALOG_VERSION } from './template-registry';
import { GenerateParams, GeneratedSpec, Provenance, generateSpec } from './spec-generate';
import { SPEC_ERROR, toSpecErrors, toSpecWarnings } from './spec-errors';
import { specVersion } from './spec-versions';

/** `vops spec` — generate a base manifest, and validate one. Neither invents anything (generation
 * is deterministic, validation is flui-spec itself); vops adds only a stable error shape to loop on. */

export interface TemplateSummary extends FrameworkTemplate {
  catalogVersion: string;
  requiredSpecVersion: string;
  requiredVopsVersion: string;
}

export interface TemplateDetail extends TemplateSummary {
  /** The manifest this template generates, rendered with a placeholder name. */
  example: string;
  requiredParams: string[];
  optionalParams: string[];
}

export interface GenerateResult {
  file?: string;
  yaml: string;
  provenance: Provenance;
  todo: string[];
}

export interface ValidateResult {
  file: string;
  valid: boolean;
  kind: string | null;
  errors: AgentError[];
  warnings: AgentWarning[];
}

const REQUIRED_PARAMS = ['name'];
const OPTIONAL_PARAMS = ['port', 'health-path', 'dockerfile', 'context', 'env', 'secret', 'volume', 'domain', 'start-command', 'exposure'];

@Injectable()
export class VopsSpecService {
  templates(): TemplateSummary[] {
    return FRAMEWORK_TEMPLATES.map((t) => this.summary(t));
  }

  describe(id: string): TemplateDetail {
    const template = this.require(id);
    return {
      ...this.summary(template),
      example: generateSpec(template, { name: 'my-app' }, this.versions()).yaml,
      requiredParams: REQUIRED_PARAMS,
      optionalParams: OPTIONAL_PARAMS,
    };
  }

  /** Generate a base manifest. Refuses to clobber an existing file without --force. */
  generate(id: string, params: GenerateParams, opts: { outputFile?: string; force?: boolean } = {}): GenerateResult {
    const template = this.require(id);
    let generated: GeneratedSpec;
    try {
      generated = generateSpec(template, params, this.versions());
    } catch (err) {
      throw new AgentFailure(
        agentError('VOPS_SPEC_GENERATE_INVALID_PARAM', 'input', err instanceof Error ? err.message : String(err)),
        ExitCode.INVALID_INPUT,
      );
    }

    if (!opts.outputFile) return { yaml: generated.yaml, provenance: generated.provenance, todo: generated.todo };

    const target = path.resolve(opts.outputFile);
    if (fs.existsSync(target) && !opts.force) {
      throw new AgentFailure(
        agentError('VOPS_SPEC_FILE_EXISTS', 'input', `${opts.outputFile} already exists.`, {
          suggestedAction: 'Edit it in place (preferred — you keep your contextualisation), or pass --force to overwrite it.',
        }),
        ExitCode.INVALID_INPUT,
      );
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, generated.yaml, 'utf8');
    return { file: opts.outputFile, yaml: generated.yaml, provenance: generated.provenance, todo: generated.todo };
  }

  validate(file: string): ValidateResult {
    if (!fs.existsSync(file)) {
      throw new AgentFailure(
        agentError('VOPS_SPEC_FILE_NOT_FOUND', 'input', `File not found: ${file}`, {
          suggestedAction: 'Generate one with `vops spec generate --template <id> --name <app> --output-file flui.yaml`.',
        }),
        ExitCode.INVALID_INPUT,
      );
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return {
        file,
        valid: false,
        kind: null,
        errors: [
          agentError(SPEC_ERROR.PARSE, 'validation', err instanceof Error ? err.message : String(err), {
            path: '<root>',
            suggestedAction: 'Fix the YAML syntax — check indentation and quoting around values with a colon.',
          }),
        ],
        warnings: [],
      };
    }

    const result = validate(parsed);
    const kind = (parsed as { kind?: string })?.kind ?? null;
    return {
      file,
      valid: result.valid,
      kind,
      errors: toSpecErrors(result.errors),
      warnings: toSpecWarnings(result.warnings),
    };
  }

  /** The JSON Schema for a manifest kind — so an agent can self-check before writing. */
  schema(kind: string): object {
    if (kind === 'Application') return applicationSchema;
    if (kind === 'CatalogApp') return catalogAppSchema;
    throw new AgentFailure(
      agentError('VOPS_SPEC_UNSUPPORTED_KIND', 'input', `No schema for kind '${kind}'.`, {
        suggestedAction: 'Use --kind Application or --kind CatalogApp.',
      }),
      ExitCode.INVALID_INPUT,
    );
  }

  private require(id: string): FrameworkTemplate {
    const template = findTemplate(id);
    if (template) return template;
    throw new AgentFailure(
      agentError('VOPS_TEMPLATE_NOT_FOUND', 'input', `Unknown template '${id}'.`, {
        suggestedAction: `List them with \`vops spec templates --json\`. Available: ${FRAMEWORK_TEMPLATES.map((t) => t.id).join(', ')}.`,
      }),
      ExitCode.INVALID_INPUT,
    );
  }

  private summary(t: FrameworkTemplate): TemplateSummary {
    return {
      ...t,
      catalogVersion: TEMPLATE_CATALOG_VERSION,
      requiredSpecVersion: specVersion(),
      requiredVopsVersion: vopsVersion(),
    };
  }

  private versions(): { spec: string; vops: string } {
    return { spec: specVersion(), vops: vopsVersion() };
  }
}
