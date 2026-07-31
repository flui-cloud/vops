/* Settings — the one place the local install describes itself: the always-on
 * service, the vault, and how to remove any of it.
 *
 * Removing vops is three separate things, and only two of them can be done from
 * here. Browsers expose no way to uninstall an installed app, so the third is
 * shown as instructions rather than a button that would quietly do nothing. */
function dashboardSettings() {
  return {
    set: { info: null, busy: '', err: '', removeOpen: false, choice: 'service', confirm: '', done: null },

    async loadSettings() {
      this.set.err = '';
      try {
        this.set.info = await this.api('/service');
      } catch (e) {
        this.set.err = e.message;
      }
      await this.vaultLoad();
    },

    setServiceLabel() {
      const s = this.set.info?.service;
      if (!s) return '—';
      if (!s.supported) return 'not available on this platform';
      if (!s.installed) return 'not installed';
      return s.running ? 'installed · running' : 'installed · stopped';
    },
    setServiceColor() {
      const s = this.set.info?.service;
      if (!s?.installed) return 'var(--text-faint)';
      return s.running ? 'var(--ok)' : 'var(--warn)';
    },

    openRemove() {
      this.set.removeOpen = true;
      this.set.choice = 'service';
      this.set.confirm = '';
      this.set.err = '';
      this.set.done = null;
    },
    closeRemove() { this.set.removeOpen = false; this.set.confirm = ''; },

    setPurgeReady() {
      return this.set.choice !== 'all' || this.set.confirm.trim() === this.set.info?.profile;
    },

    async runRemove() {
      if (!this.setPurgeReady() || this.set.busy) return;
      this.set.busy = 'remove';
      this.set.err = '';
      try {
        this.set.done = this.set.choice === 'all'
          ? await this.api('/service/purge', { method: 'POST', body: JSON.stringify({ confirm: this.set.confirm.trim() }) })
          : await this.api('/service/uninstall', { method: 'POST' });
        // A purge takes the server with it, so this window is about to lose its
        // backend on purpose — say so instead of letting the reconnect overlay
        // claim something went wrong.
        if (this.set.choice === 'all') this.offlineExpected = true;
        await this.loadSettings().catch(() => {});
      } catch (e) {
        this.set.err = e.message;
      } finally {
        this.set.busy = '';
        this.set.confirm = '';
      }
    },
  };
}
