function dashboardFirewallsVnets() {
  return {
    openFirewallForm() {
      this.modal = { ...this.modal, open: true, type: 'firewall', title: 'New firewall', cta: 'Create',
        danger: false, dryRun: true, fw: { name: '', rules: '[]', apply: '' } };
    },
    async doFirewallCreate(dryRun) {
      const body = { provider: this.provider, name: this.modal.fw.name,
        rules: JSON.parse(this.modal.fw.rules || '[]'),
        applyToServerIds: this.csv(this.modal.fw.apply), dryRun, yes: !dryRun };
      const out = await this.api('/firewalls', { method: 'POST', body: JSON.stringify(body) });
      if (dryRun) return this.notify('Dry-run OK — would create firewall. Nothing changed.');
      this.closeModal(); this.notify('Firewall created: ' + (out.firewall?.id || '')); this.reload();
    },
    async saveRules() {
      try {
        await this.api('/firewalls/' + this.drawer.item.id + '/rules', { method: 'PUT',
          body: JSON.stringify({ provider: this.provider, rules: JSON.parse(this.drawer.rulesJson) }) });
        this.notify('Rules saved'); this.reload();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async applyFirewall(remove) {
      try {
        await this.api('/firewalls/' + this.drawer.item.id + '/apply', { method: 'POST',
          body: JSON.stringify({ provider: this.provider, serverIds: this.csv(this.drawer.serverIds), remove }) });
        this.notify(remove ? 'Removed from servers' : 'Applied to servers'); this.reload();
      } catch (e) { this.notify(e.message, 'error'); }
    },

    openVnetForm() {
      this.modal = { ...this.modal, open: true, type: 'vnet', title: 'New network', cta: 'Create',
        danger: false, dryRun: true, vn: { name: '', ipRange: '', zone: '', subnetRange: '' } };
    },
    async doVnetCreate(dryRun) {
      const vn = this.modal.vn;
      const subnets = vn.zone && vn.subnetRange ? [{ networkZone: vn.zone, ipRange: vn.subnetRange }] : undefined;
      const body = { provider: this.provider, name: vn.name, ipRange: vn.ipRange, subnets, dryRun, yes: !dryRun };
      const out = await this.api('/vnets', { method: 'POST', body: JSON.stringify(body) });
      if (dryRun) return this.notify('Dry-run OK — would create network. Nothing changed.');
      this.closeModal(); this.notify('Network created: ' + (out.vnet?.id || '')); this.reload();
    },
    async attachServer(detach) {
      try {
        await this.api('/vnets/' + this.drawer.item.id + '/attach', { method: 'POST',
          body: JSON.stringify({ provider: this.provider, serverId: this.drawer.serverIds.trim(), detach }) });
        this.notify(detach ? 'Detached' : 'Attached'); this.reload(); this.closeDrawer();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async addSubnet() {
      try {
        await this.api('/vnets/' + this.drawer.item.id + '/subnet', { method: 'POST',
          body: JSON.stringify({ provider: this.provider, ipRange: this.drawer.subnetRange, networkZone: this.drawer.subnetZone }) });
        this.notify('Subnet added'); this.reload(); this.closeDrawer();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async deleteSubnet(ipRange) {
      try {
        await this.api('/vnets/' + this.drawer.item.id + '/subnet', { method: 'POST',
          body: JSON.stringify({ provider: this.provider, ipRange, remove: true }) });
        this.notify('Subnet removed'); this.reload(); this.closeDrawer();
      } catch (e) { this.notify(e.message, 'error'); }
    },

    openDrawer(kind, item) {
      this.drawer = { open: true, kind, item, serverIds: '', subnetRange: '', subnetZone: '',
        rulesJson: kind === 'firewall' ? JSON.stringify(item.rules, null, 2) : '' };
    },
    closeDrawer() { this.drawer.open = false; },
  };
}
