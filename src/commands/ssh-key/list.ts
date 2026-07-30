import { Command } from '@oclif/core';
import { withService } from '../../agent-api/agent-nest';
import { agentJsonFlag, runAgentCommand } from '../../agent-api/agent-output';
import { renderTable } from '../../lib/output';
import { VopsSshKeysService } from '../../ssh-keys/vops-ssh-keys.service';

export default class SshKeyList extends Command {
  static readonly description = 'List local SSH keys';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = { ...agentJsonFlag };

  async run(): Promise<void> {
    const { flags } = await this.parse(SshKeyList);
    await runAgentCommand(
      this,
      'vops ssh-key list',
      flags.json,
      async () => ({ data: await withService(VopsSshKeysService, (svc) => svc.list()) }),
      (keys) => {
        if (!keys.length) {
          this.log('No local SSH keys. Create one with: vops ssh-key create <name>');
          return;
        }
        this.log(
          renderTable(
            ['NAME', 'ROLE', 'FINGERPRINT', 'PRIVATE KEY'],
            keys.map((k) => [k.name, k.role, k.fingerprint, k.privateKeyPath]),
          ),
        );
      },
    );
  }
}
