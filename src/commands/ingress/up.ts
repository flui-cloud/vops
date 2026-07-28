import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { getVopsApp, closeVopsApp } from '../../lib/nest';
import { VopsIngressService } from '../../apps/vops-ingress.service';
import { ProxyKind } from '../../apps/ingress-proxy';

export default class IngressUp extends Command {
  static readonly description =
    'Install or refresh the vops ingress on a host: binds :80/:443, enables ACME TLS, and serves ' +
    'per-app routes. Backend is Traefik or Caddy (--proxy). Refuses if another process holds :80/:443 (e.g. k3s).';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> web1 --email you@example.com',
    '<%= config.bin %> <%= command.id %> web1 --email you@example.com --proxy caddy',
  ];

  static readonly args = {
    host: Args.string({ description: 'Inventory host name', required: true }),
  };

  static readonly flags = {
    email: Flags.string({ description: 'ACME account email (or set VOPS_ACME_EMAIL)' }),
    proxy: Flags.string({ options: ['traefik', 'caddy'], description: 'Ingress backend (default: keep the host’s current, else caddy)' }),
    json: Flags.boolean({ default: false, description: 'Output as JSON' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IngressUp);
    try {
      const svc = (await getVopsApp()).get(VopsIngressService);
      const r = await svc.up(args.host, { email: flags.email, proxy: flags.proxy as ProxyKind | undefined });
      if (flags.json) {
        this.log(JSON.stringify(r, null, 2));
        return;
      }
      this.log(chalk.green(`✓ ingress ${r.alreadyUp ? 'refreshed' : 'up'} on ${chalk.bold(r.host)}`) + chalk.dim(`  ${r.proxy} · ${r.image}`));
      this.log(chalk.dim(`  health: ${r.health ? 'ok' : 'starting'} · acme email: ${r.email}`));
      this.log(chalk.yellow(`  firewall: ${r.firewall.hint}`));
    } catch (err) {
      this.error(err instanceof Error ? err.message : String(err), { exit: 1 });
    } finally {
      await closeVopsApp();
    }
  }
}
