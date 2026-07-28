import { Command } from '@oclif/core';

export default class CatalogTemplates extends Command {
  static readonly description = 'Framework templates for custom applications — see `vops spec templates`.';

  static readonly hidden = false;

  async run(): Promise<void> {
    this.log('Framework templates live under `vops spec`:');
    this.log('  vops spec templates --json');
    this.log('  vops spec templates describe <id> --json');
    this.log('  vops spec generate --template <id> --name <app> --output-file flui.yaml');
  }
}
