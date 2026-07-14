import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { VopsHostKeysService } from '../host-ops/vops-host-keys.service';
import { VopsHostStatusService } from '../host-ops/vops-host-status.service';
import { VopsHostHardenService } from '../host-ops/vops-host-harden.service';
import { VopsSshLockdownService } from '../host-ops/vops-ssh-lockdown.service';
import { VopsHostUpdateService } from '../host-ops/vops-host-update.service';
import { VopsOpsRotationService } from '../host-ops/vops-ops-rotation.service';
import { VopsHostConnService } from '../host-ops/vops-host-conn.service';
import { VopsMonitorService } from '../monitor/vops-monitor.service';
import { VopsServerFirewallService } from '../firewall/vops-server-firewall.service';
import { FirewallService } from '../firewall/firewall-services';

/** Host operations for the local UI — the same services the CLI uses. */
@Controller('api/hosts')
export class HostsController {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsHostKeysService,
    private readonly status: VopsHostStatusService,
    private readonly harden: VopsHostHardenService,
    private readonly updates: VopsHostUpdateService,
    private readonly rotation: VopsOpsRotationService,
    private readonly monitor: VopsMonitorService,
    private readonly conn: VopsHostConnService,
    private readonly firewall: VopsServerFirewallService,
    private readonly sshLockdown: VopsSshLockdownService,
  ) {}

  @Get()
  list() {
    return this.hosts.list();
  }

  @Post()
  add(
    @Body() body: { name: string; address: string; user?: string; port?: number; key?: string; tags?: string[] },
  ) {
    return this.hosts.add(body.name, {
      address: body.address,
      user: body.user,
      port: body.port,
      userKeyName: body.key,
      tags: body.tags,
    });
  }

  @Post('import')
  import(@Body() body: { provider: string; server: string }) {
    return this.hosts.import(body.provider, body.server);
  }

  @Post('ensure')
  ensure(@Body() body: { provider: string; server: string }) {
    return this.hosts.ensureFromServer(body.provider, body.server);
  }

  @Get(':name/monitor')
  monitorStatus(@Param('name') name: string) {
    return this.monitor.status(name);
  }

  @Post(':name/monitor')
  monitorSetup(@Param('name') name: string, @Body() body: { dryRun?: boolean }) {
    return this.monitor.setup(name, { dryRun: body?.dryRun });
  }

  @Delete(':name/monitor')
  monitorRemove(@Param('name') name: string) {
    return this.monitor.remove(name);
  }

  @Delete(':name')
  remove(@Param('name') name: string) {
    this.hosts.remove(name);
    return { removed: name };
  }

  @Get(':name/status')
  hostStatus(@Param('name') name: string) {
    return this.status.status(name);
  }

  @Get(':name/unit-logs')
  unitLogs(@Param('name') name: string, @Query('unit') unit?: string, @Query('lines') lines?: string) {
    return this.status.unitLogs(name, unit ?? '', lines ? Number(lines) : 100);
  }

  @Get(':name/ssh')
  sshConn(@Param('name') name: string) {
    return this.conn.check(name);
  }

  @Post(':name/user-key')
  async assignUserKey(@Param('name') name: string, @Body() body: { key?: string }) {
    this.hosts.setUserKey(name, body.key);
    return this.conn.check(name);
  }

  @Post(':name/ssh-managed')
  setSshManaged(@Param('name') name: string, @Body() body: { managed: boolean }) {
    return this.hosts.setSshManaged(name, !!body.managed);
  }

  @Get(':name/key')
  keyStatus(@Param('name') name: string) {
    return this.keys.keyStatus(name);
  }

  @Post(':name/key/install-ops')
  installOps(@Param('name') name: string, @Body() body: { from?: string; dryRun?: boolean }) {
    return this.keys.installOps(name, { fromCidr: body.from, dryRun: body.dryRun });
  }

  @Delete(':name/key')
  revokeOps(@Param('name') name: string, @Query('force') force?: string) {
    return this.keys.revokeOps(name, { force: force === 'true' });
  }

  @Post(':name/harden')
  hostHarden(
    @Param('name') name: string,
    @Body() body: { user?: string; steps?: string[]; dryRun?: boolean },
  ) {
    return this.harden.harden(name, { user: body.user, steps: body.steps, dryRun: body.dryRun });
  }

  @Post(':name/update')
  hostUpdate(
    @Param('name') name: string,
    @Body() body: { securityOnly?: boolean; reboot?: boolean; dryRun?: boolean },
  ) {
    return this.updates.update([name], {
      securityOnly: body.securityOnly,
      reboot: body.reboot,
      dryRun: body.dryRun,
    });
  }

  @Post(':name/reboot')
  hostReboot(@Param('name') name: string) {
    return this.updates.reboot([name]);
  }

  @Get(':name/ssh-lockdown/preflight')
  sshLockdownPreflight(@Param('name') name: string) {
    return this.sshLockdown.preflight(name);
  }

  @Post(':name/ssh-lockdown')
  sshLockdownDisable(@Param('name') name: string, @Body() body: { override?: boolean }) {
    return this.sshLockdown.disable(name, { override: body.override });
  }

  @Get(':name/firewall')
  firewallGet(@Param('name') name: string) {
    return this.firewall.get(name);
  }

  @Post(':name/firewall')
  firewallSet(@Param('name') name: string, @Body() body: { services?: FirewallService[] }) {
    return this.firewall.set(name, body.services ?? []);
  }

  @Delete(':name/firewall')
  async firewallClear(@Param('name') name: string) {
    await this.firewall.clear(name);
    return { cleared: name };
  }

  @Get(':name/my-ip')
  async firewallMyIp(@Param('name') name: string) {
    return { ip: await this.firewall.myIp(name) };
  }

  @Post('rotate-ops')
  rotateOps(@Body() body: { dryRun?: boolean; force?: boolean }) {
    return this.rotation.rotate({ dryRun: body.dryRun, force: body.force });
  }
}
