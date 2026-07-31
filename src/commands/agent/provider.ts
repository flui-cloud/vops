import { Args, Command, Flags } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { OpenAICompatibleAgentAdapter } from '../../remote/openai-compatible-agent.adapter';
import { OpenAICompatibleConfigStore } from '../../remote/openai-compatible-config';
import { RemoteAgentPolicyStore } from '../../remote/remote-agent-policy';
import { RemoteAgentRegistry } from '../../remote/remote-agent-registry';

export default class AgentProviderCommand extends Command {
  static readonly description =
    'Inspect and govern coding-agent providers used by encrypted remote vOps chat.';

  static readonly args = {
    action: Args.string({
      required: true,
      options: [
        'status',
        'configure',
        'test',
        'remove',
        'default',
        'enable',
        'disable',
        'fallback',
      ],
    }),
  };

  static readonly flags = {
    provider: Flags.string({
      options: ['codex', 'claude-code', 'opencode', 'antigravity', 'openai-compatible'],
    }),
    providers: Flags.string({
      description: 'Comma-separated, locally approved fallback order; use an empty value to clear.',
    }),
    name: Flags.string({ default: 'Local OpenAI-compatible' }),
    url: Flags.string(),
    model: Flags.string(),
    'api-key': Flags.string({
      description: 'Stored only in the local encrypted vOps credential store.',
    }),
    'tool-calls': Flags.boolean({
      description: 'Confirm support for OpenAI-compatible structured tool calls.',
      default: false,
    }),
    'no-deterministic': Flags.boolean({
      description: 'Disable the non-model deterministic summary when configuring fallbacks.',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentProviderCommand);
    const policy = new RemoteAgentPolicyStore();
    const compatible = new OpenAICompatibleConfigStore();

    if (args.action === 'status') {
      const providers = await withService(RemoteAgentRegistry, (registry) => registry.providers());
      this.log(JSON.stringify({ policy: policy.read(), providers }, null, 2));
      return;
    }
    if (args.action === 'configure') {
      if (!flags.url || !flags.model) throw new Error('configure requires --url and --model');
      const saved = compatible.save({
        displayName: flags.name,
        baseUrl: flags.url,
        model: flags.model,
        apiKey: flags['api-key'],
        supportsToolCalls: flags['tool-calls'],
      });
      policy.setEnabled('openai-compatible', true);
      this.log(JSON.stringify(saved, null, 2));
      return;
    }
    if (args.action === 'remove') {
      if (policy.read().defaultProvider === 'openai-compatible') {
        throw new Error('Choose a different default provider before removing this endpoint.');
      }
      compatible.remove();
      policy.setEnabled('openai-compatible', false);
      this.log(JSON.stringify({ removed: true }, null, 2));
      return;
    }
    if (args.action === 'test') {
      const provider = flags.provider ?? 'openai-compatible';
      if (provider === 'openai-compatible') {
        const result = await withService(OpenAICompatibleAgentAdapter, (adapter) => adapter.test());
        this.log(JSON.stringify(result, null, 2));
        return;
      }
      const status = await withService(RemoteAgentRegistry, async (registry) =>
        (await registry.providers()).find((entry) => entry.id === provider),
      );
      this.log(JSON.stringify({ ok: status?.state === 'ready', provider: status }, null, 2));
      return;
    }
    if (args.action === 'fallback') {
      const providers = flags.providers === undefined
        ? policy.read().fallbackOrder
        : flags.providers.split(',').map((entry) => entry.trim()).filter(Boolean)
            .map((entry) => policy.assertProvider(entry));
      policy.setFallbackOrder(providers);
      const final = policy.setDeterministicFallback(!flags['no-deterministic']);
      this.log(JSON.stringify(final, null, 2));
      return;
    }

    const provider = policy.assertProvider(requireFlag(flags.provider, '--provider'));
    const updated = args.action === 'default'
      ? policy.setDefault(provider)
      : policy.setEnabled(provider, args.action === 'enable');
    this.log(JSON.stringify(updated, null, 2));
  }
}

function requireFlag(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required for this action.`);
  return value;
}
