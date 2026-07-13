function dashboardSshKeys() {
  return {
    openKeyForm() {
      this.modal = { ...this.modal, open: true, type: 'sshkey', title: 'Generate SSH key', cta: 'Generate',
        danger: false, dryRun: false, sk: { name: '', mode: 'create', publicKey: '', from: '' } };
    },
    openImportForm() {
      this.modal = { ...this.modal, open: true, type: 'sshkey', title: 'Import SSH key', cta: 'Import',
        danger: false, dryRun: false, sk: { name: '', mode: 'import', publicKey: '', from: '' } };
    },
    async doKey() {
      const sk = this.modal.sk;
      if (!sk.name.trim()) throw new Error('Key name is required.');
      if (sk.mode === 'create') {
        await this.api('/ssh-keys', { method: 'POST', body: JSON.stringify({ name: sk.name.trim() }) });
        this.notify('Generated key ' + sk.name);
      } else {
        const body = { name: sk.name.trim(), from: sk.from.trim() || undefined, publicKey: sk.publicKey.trim() || undefined };
        await this.api('/ssh-keys/import', { method: 'POST', body: JSON.stringify(body) });
        this.notify('Imported key ' + sk.name);
      }
      this.closeModal(); this.reload();
    },
    openRegister(k) {
      this.modal = { ...this.modal, open: true, type: 'register', title: 'Register key to provider', cta: 'Register',
        danger: false, dryRun: false, reg: { name: k.name, provider: this.provider } };
    },
    async doRegister() {
      const out = await this.api('/ssh-keys/' + encodeURIComponent(this.modal.reg.name) + '/register',
        { method: 'POST', body: JSON.stringify({ provider: this.modal.reg.provider }) });
      this.closeModal(); this.notify('Registered → key id ' + (out.providerKeyId || ''));
    },
  };
}
