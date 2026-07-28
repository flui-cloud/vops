import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { closeVopsApp, getVopsApp } from '../../lib/nest';
import { GenerateResult, VopsSpecService } from '../../spec/vops-spec.service';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { parseSet } from '../../apps/cli-deploy';

export default class SpecGenerate extends Command {
  static readonly description =
    'Generate a base flui.yaml from a framework template. Deterministic: the same inputs produce the same bytes. ' +
    'Secret values are never written — declare them here and pass them at deploy with --set.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> --template nestjs-11 --name my-api --output-file flui.yaml',
    '<%= config.bin %> <%= command.id %> --template nextjs-16 --name shop --port 3000 --json',
    '<%= config.bin %> <%= command.id %> --template generic --name worker --secret SESSION_SECRET --volume data:/var/lib/app',
  ];

  static readonly flags = {
    template: Flags.string({ description: 'Template id (see: vops spec templates)', required: true }),
    name: Flags.string({ description: 'metadata.name — the app handle', required: true }),
    'output-file': Flags.string({ char: 'o', description: 'Write here instead of stdout' }),
    force: Flags.boolean({ default: false, description: 'Overwrite an existing output file' }),
    port: Flags.integer({ description: 'Container port (default: the template’s)' }),
    'health-path': Flags.string({ description: 'Health endpoint path (default: the template’s)' }),
    dockerfile: Flags.string({ description: 'Dockerfile path relative to the build context' }),
    context: Flags.string({ description: 'Build context relative to the repository root' }),
    env: Flags.string({ multiple: true, description: 'Literal runtime env: KEY=value (never a secret)' }),
    'build-arg': Flags.string({ multiple: true, description: 'Docker build ARG: KEY=value (baked into the image)' }),
    secret: Flags.string({ multiple: true, description: 'Env filled from a secret generated on the host: KEY' }),
    volume: Flags.string({ multiple: true, description: 'Persistent volume: name:/mount/path' }),
    domain: Flags.string({ description: 'Pin deploy.domain.fqdn (default: decided at deploy time)' }),
    exposure: Flags.string({ options: ['public', 'internal'], description: 'Whether the app is reachable off the host' }),
    'start-command': Flags.string({ description: 'Override the image entrypoint' }),
    ...agentJsonFlag,
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SpecGenerate);
    try {
      const svc = (await getVopsApp()).get(VopsSpecService);
      await runAgentCommand(
        this,
        'vops spec generate',
        flags.json,
        async () => {
          const data = svc.generate(
            flags.template,
            {
              name: flags.name,
              port: flags.port,
              healthPath: flags['health-path'],
              dockerfile: flags.dockerfile,
              context: flags.context,
              env: parseSet(flags.env),
              buildArgs: parseSet(flags['build-arg']),
              generatedSecrets: flags.secret,
              volumes: (flags.volume ?? []).map(parseVolume),
              fqdn: flags.domain,
              exposure: flags.exposure as 'public' | 'internal' | undefined,
              startCommand: flags['start-command'],
            },
            { outputFile: flags['output-file'], force: flags.force },
          );
          return {
            data,
            warnings: data.todo.map((message) => ({ code: 'VOPS_SPEC_NEEDS_REVIEW', message })),
            nextActions: nextActions(data),
          };
        },
        (data) => render(this, data),
      );
    } finally {
      await closeVopsApp();
    }
  }
}

function nextActions(data: GenerateResult) {
  const file = data.file ?? 'flui.yaml';
  return [
    { command: `vops spec validate ${file} --json`, description: 'Check the manifest after you adapt it to the repository' },
    { command: `vops build setup --spec ${file} --json`, description: 'Set up the GitHub Actions build (skip if you already have an image)' },
  ];
}

function parseVolume(v: string): { name: string; mountPath: string } {
  const idx = v.indexOf(':');
  if (idx < 1 || idx === v.length - 1) throw new Error(`Invalid --volume '${v}' (expected name:/mount/path).`);
  return { name: v.slice(0, idx), mountPath: v.slice(idx + 1) };
}

function render(cmd: Command, data: GenerateResult): void {
  if (!data.file) {
    cmd.log(data.yaml.trimEnd());
    return;
  }
  cmd.log(chalk.green('✓ wrote ') + chalk.bold(data.file));
  cmd.log(chalk.dim(`  from ${data.provenance.templateId}@${data.provenance.templateVersion} · flui-spec ${data.provenance.specVersion}`));
  for (const t of data.todo) cmd.log(chalk.yellow(`  ! ${t}`));
  cmd.log(chalk.dim(`\n  next: adapt it to the repository, then \`vops spec validate ${data.file}\``));
}
