function dashboardModals() {
  return {
    confirmDelete(kind, item) {
      const label = kind === 'server' ? 'server' : kind;
      this.modal = { ...this.modal, open: true, type: 'confirm', title: 'Delete ' + label, cta: 'Delete',
        danger: true, dryRun: false, message: 'Delete ' + label + ' "' + (item.name || item.id) + '"? This cannot be undone.',
        ctx: { kind, item } };
    },
    closeModal() { this.modal.open = false; },

    async submitModal(dryRun) {
      try {
        if (this.modal.type === 'provision') await this.doProvision(dryRun);
        else if (this.modal.type === 'firewall') await this.doFirewallCreate(dryRun);
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
