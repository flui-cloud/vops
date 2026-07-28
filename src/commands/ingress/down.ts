import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsIngressService } from '../../apps/vops-ingress.service';

export default class IngressDown extends Command {
  static readonly description =
    'Remove the vops ingress (Traefik) from a host. Refuses while apps are still routed unless --force ' +
    '(which detaches them first). Issued certificates are kept unless --purge (they are rate-limited).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1',
    '<%= config.bin %> <%= command.id %> web1 --force --purge',
  ];

  static readonly args = {
    host: Args.string({ description: 'Inventory host name', required: true }),
  };

  static readonly flags = {
    force: Flags.boolean({ default: false, description: 'Detach any routed apps first, then remove ingress' }),
    purge: Flags.boolean({ default: false, description: 'Also delete issued certificates + config (/etc/vops/ingress)' }),
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IngressDown);
    try {
      const svc = (await getVopsApp()).get(VopsIngressService);
      const r = await svc.down(args.host, { force: flags.force, purge: flags.purge });
      if (flags.json) {
        this.log(JSON.stringify(r, null, 2));
        return;
      }
      this.log(chalk.green(`✓ ingress removed from ${chalk.bold(r.host)}`) + chalk.dim(r.purged ? '  (certs + config purged)' : '  (certs kept)'));
      if (r.detached.length) this.log(chalk.dim(`  detached: ${r.detached.join(', ')}`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
