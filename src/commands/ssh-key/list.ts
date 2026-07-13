import { Command, Flags } from '@oclif/core';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { renderTable } from '../../lib/output';
import { VopsSshKeysService } from '../../ssh-keys/vops-ssh-keys.service';

export default class SshKeyList extends Command {
  static readonly description = 'List local SSH keys';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  static readonly flags = {
    json: Flags.boolean({ description: 'Output as JSON', default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(SshKeyList);
    try {
      const keys = (await getVopsApp()).get(VopsSshKeysService).list();
      if (flags.json) {
        this.log(JSON.stringify(keys, null, 2));
        return;
      }
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
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
