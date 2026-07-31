/* Unlocking the sealed vault from the dashboard.
 *
 * A service started at login has no terminal, so this is the only place a
 * passphrase can be entered. It is deliberately NOT a gate on the whole app:
 * everything reached over SSH — hosts, monitoring, apps, firewalls, bench —
 * works with the vault sealed, and only provider reads need it. That is the
 * point of the progressive unlock, so a locked vault shows a dismissible banner
 * and the modal opens only when a request actually comes back 423. */
function dashboardVault() {
  return {
    vault: {
      state: 'unknown',
      open: false,
      pass: '',
      busy: false,
      err: '',
      retryInMs: 0,
      expiresAt: null,
      hint: false,
      countdown: null,
    },

    async vaultInit() {
      await this.vaultLoad();
      this.vault.hint = this.vault.state === 'locked';
    },

    async vaultLoad() {
      try {
        const s = await this.api('/vault');
        this.vault.state = s.state;
        this.vault.expiresAt = s.keyring?.expiresAt ?? null;
        this.vault.retryInMs = s.throttle?.retryInMs || 0;
        this.vaultTick();
      } catch { /* the lock chip is optional — never block the dashboard on it */ }
    },

    /** Called by api() on a 423: a page actually needed a credential. */
    vaultLocked() {
      this.vault.state = 'locked';
      this.vault.hint = false;
      this.vaultOpen();
    },

    vaultOpen() {
      this.vault.open = true;
      this.vault.err = '';
      this.vault.pass = '';
      this.vaultLoad();
    },

    vaultClose() {
      this.vault.open = false;
      this.vault.pass = '';
      this.vault.err = '';
    },

    async vaultUnlock() {
      if (this.vault.busy || this.vault.retryInMs > 0 || !this.vault.pass) return;
      this.vault.busy = true;
      this.vault.err = '';
      try {
        const res = await this.api('/vault/unlock', {
          method: 'POST',
          body: JSON.stringify({ passphrase: this.vault.pass }),
        });
        this.vault.state = res.state;
        this.vault.expiresAt = res.keyring?.expiresAt ?? null;
        this.vault.retryInMs = 0;
        this.vault.hint = false;
        this.vault.open = false;
        this.notify('Vault unlocked');
        this.reload();
      } catch (e) {
        this.vault.err = e.message;
        this.vault.retryInMs = e.body?.retryInMs || 0;
        this.vaultTick();
      } finally {
        // The passphrase never outlives the request, on any path.
        this.vault.pass = '';
        this.vault.busy = false;
      }
    },

    async vaultLock() {
      try {
        const res = await this.api('/vault/lock', { method: 'POST' });
        this.vault.state = res.state;
        this.vault.expiresAt = null;
        this.notify('Vault locked');
        this.reload();
      } catch (e) { this.notify(e.message, 'error'); }
    },

    dismissVaultHint() { this.vault.hint = false; },

    // Counts the backoff down locally so the button says when, not just "wait".
    vaultTick() {
      clearTimeout(this.vault.countdown);
      if (this.vault.retryInMs <= 0) return;
      this.vault.countdown = setTimeout(() => {
        this.vault.retryInMs = Math.max(0, this.vault.retryInMs - 1000);
        this.vaultTick();
      }, 1000);
    },

    vaultRetryLabel() {
      const s = Math.ceil(this.vault.retryInMs / 1000);
      if (s <= 0) return '';
      if (s < 60) return s + 's';
      return Math.ceil(s / 60) + ' min';
    },

    /** Minutes left on the keyring session, for the header chip. */
    vaultExpiresLabel() {
      if (!this.vault.expiresAt) return '';
      const mins = Math.round((this.vault.expiresAt - Date.now()) / 60000);
      if (mins <= 0) return '';
      if (mins < 60) return mins + ' min left';
      return Math.round(mins / 60) + 'h left';
    },
  };
}
