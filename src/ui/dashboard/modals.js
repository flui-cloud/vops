function dashboardModals() {
  return {
    confirmDelete(kind, item) {
      const label = kind === 'server' ? 'server' : kind;
      this.modal = { ...this.modal, open: true, type: 'confirm', title: 'Delete ' + label, cta: 'Delete',
        danger: true, dryRun: false, message: 'Delete ' + label + ' "' + (item.name || item.id) + '"? This cannot be undone.',
        ctx: { kind, item } };
    },
    // Closing must also stop the Telegram link poll — otherwise dismissing the
    // notify modal mid-link leaves a timer hitting the API forever, and it could
    // still arm a watch after the user walked away.
    closeModal() {
      this.modal.open = false;
      if (typeof this.stopTelegramPoll === 'function') this.stopTelegramPoll();
    },
    closeAsk() { this.ask.open = false; },

    // Confirmable host actions — spell out what runs, then run it on confirm.
    askHostAction(action) {
      const name = this.modal.mg?.name;
      const A = {
        update: { title: 'Update ' + name, cta: 'Update now', danger: false,
          message: 'Installs all pending OS package updates on this server over SSH (apt/dnf upgrade). Services will restart and some updates can need a reboot afterwards, so the apps this server runs may be briefly unavailable during the update. Nothing is deleted.' },
        reboot: { title: 'Restart ' + name, cta: 'Restart now', danger: true,
          message: 'Reboots the server now. It goes offline for about a minute — everything running on it stops and starts again on boot — and vops waits for it to come back. Use this to finish applying updates that asked for a restart.' },
        'ops-install': { title: 'Install automation key on ' + name, cta: 'Install key', danger: false,
          message: "Authorises vops' own managed key on this host so it can run status, updates and hardening on its own — separate from your personal key. vops checks the new key works and rolls back if it fails; you can revoke it anytime." },
        'ops-revoke': { title: 'Revoke automation key from ' + name, cta: 'Revoke key', danger: true,
          message: "Removes vops' automation key. Automated actions fall back to your personal key, or stop working if none is set." },
        'monitor-on': { title: 'Enable monitoring on ' + name, cta: 'Continue', danger: false,
          message: 'Installs a small scheduled check (a cron job) on the server that reports to the vops relay, so you are alerted if the host goes silent — even with this dashboard closed. Next you will pick where those alerts are delivered. Needs vops watch login.' },
        'monitor-off': { title: 'Disable monitoring on ' + name, cta: 'Disable', danger: true,
          message: 'Removes the dead-man monitor from this host — you will no longer be alerted if it goes down.' },
        'fw-clear': { title: 'Clear firewall on ' + name, cta: 'Clear firewall', danger: true,
          message: this.fw?.view?.engine === 'provider'
            ? 'Detaches and deletes the firewall vops manages for this server at the provider. Any other firewalls on the server are left untouched.'
            : "Removes the vops firewall from this server. SSH stays reachable, and any firewall vops didn't create is left untouched." },
      }[action];
      this.ask = { open: true, action, name, title: A.title, cta: A.cta, danger: A.danger, message: A.message };
    },

    async runHostAsk() {
      const { action } = this.ask;
      this.ask.open = false;
      const h = { name: this.ask.name };
      if (action === 'update') return this.updateHost(h);
      if (action === 'reboot') return this.rebootHost(h);
      if (action === 'ops-install') return this.manageOps(true);
      if (action === 'ops-revoke') return this.manageOps(false);
      if (action === 'monitor-on') return this.manageMonitor(true);
      if (action === 'monitor-off') return this.manageMonitor(false);
      if (action === 'fw-clear') return this.fwClear(this.ask.name);
      if (action === 'ssh-harden') return this.sshHardenRun();
    },

    async submitModal(dryRun) {
      try {
        if (this.modal.type === 'provision') await this.doProvision(dryRun);
        else if (this.modal.type === 'vnet') await this.doVnetCreate(dryRun);
        else if (this.modal.type === 'sshkey') await this.doKey();
        else if (this.modal.type === 'host') await this.doHostModal();
        else if (this.modal.type === 'register') await this.doRegister();
        else if (this.modal.type === 'connect') this.closeModal();
        else if (this.modal.type === 'confirm') await this.doDelete();
        else if (this.modal.type === 'guided') this.closeModal();
      } catch (e) { this.notify(e.message, 'error'); }
    },

    async doDelete() {
      const { kind, item } = this.modal.ctx;
      if (kind === 'sshkey') {
        await this.api('/ssh-keys/' + encodeURIComponent(item.name), { method: 'DELETE' });
        this.closeModal(); this.notify('Deleted key ' + item.name); return this.reload();
      }
      if (kind === 'host') {
        await this.api('/hosts/' + encodeURIComponent(item.name), { method: 'DELETE' });
        this.closeModal(); this.notify('Forgot host ' + item.name); return this.reload();
      }
      const prov = kind === 'server' && item.provider ? item.provider : this.provider;
      const q = '?provider=' + prov + (kind === 'server' ? '&force=true' : '&yes=true');
      const path = { server: '/servers/', firewall: '/firewalls/', vnet: '/vnets/' }[kind];
      await this.api(path + item.id + q, { method: 'DELETE' });
      this.closeModal(); this.closeDrawer(); this.notify('Deleted ' + (item.name || item.id)); this.reload();
    },
  };
}
