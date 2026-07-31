import chalk from 'chalk';
import { ServiceStatus } from './service-model';

/**
 * One rendering of a service status, shared by `vops service status` and the
 * confirmation printed after an install — so the two can never drift into
 * describing the same state differently.
 */
export function statusLines(status: ServiceStatus): string[] {
  if (!status.supported) {
    return [chalk.yellow(`  vops has no background service for ${status.platform} yet.`)];
  }

  const installed = status.installed ? chalk.green('installed') : chalk.dim('not installed');
  const running = status.running ? chalk.green('running') : chalk.dim('stopped');
  const lines = [`  Service:  ${installed} · ${running}`];

  if (status.installed) {
    lines.push(
      status.bootStart
        ? chalk.dim('  Startup:  comes up on its own, no terminal needed')
        : chalk.yellow('  Startup:  only while you are logged in'),
      chalk.dim(`  Unit:     ${status.unitPath}`),
      chalk.dim(`  Logs:     ${status.logHint}`),
    );
  }
  return [...lines, ...status.warnings.map((w) => chalk.yellow(`  ! ${w}`))];
}
