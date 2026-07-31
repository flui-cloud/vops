function dashboardRemote() {
  return {
    remote: {
      loaded: false,
      status: { enabled: false, state: 'disabled' },
      devices: [],
      pairings: [],
      busy: '',
      advanced: false,
      relayUrl: '',
      pair: null,
      pairLeft: 0,
      confirm: { label: 'My phone', role: 'viewer' },
      details: '',
    },
    // Plain-language roles. The wire values are the only thing the policy engine
    // reads; the labels exist so nobody grants admin by accident.
    remoteRoles: [
      { id: 'viewer', label: 'View only', hint: 'Can see your servers and apps, and run read-only requests. Cannot change anything.' },
      { id: 'approver', label: 'Approver', hint: 'Everything above, plus approving or rejecting the plans this computer proposes.' },
      { id: 'admin', label: 'Full control', hint: 'Everything above, plus the administrative controls, including stopping every agent.' },
    ],

    // Methods, not getters: app.js merges every factory with Object.assign, which
    // reads a getter once and stores its value — only core.js (the target) keeps
    // them live. A getter here would freeze the page on its first state.
    remoteStage() {
      const state = this.remote.status?.state;
      if (state === 'vault_locked') return 'locked';
      if (!this.remote.status?.enabled) return 'off';
      if (this.remote.pair) return this.remotePairSession()?.status === 'hello_received' ? 'confirm' : 'waiting';
      return this.remoteDevices().length ? 'devices' : 'ready';
    },
    remoteOnline() { return this.remote.status?.state === 'online'; },
    remoteStateLabel() {
      return ({ online: 'Online', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline',
        vault_locked: 'Vault locked', disabled: 'Off' })[this.remote.status?.state] || 'Off';
    },
    remoteDevices() {
      return (this.remote.devices || []).filter(d => d.status !== 'revoked');
    },
    remotePairSession() {
      const id = this.remote.pair?.pairing?.id;
      return id ? (this.remote.pairings || []).find(p => p.id === id) || null : null;
    },
    remotePairExpired() {
      const session = this.remotePairSession() || this.remote.pair?.pairing;
      if (!session) return false;
      return session.status === 'expired' || Date.parse(session.expiresAt) <= Date.now();
    },
    remotePairCountdown() {
      const seconds = Math.floor(Math.max(0, this.remote.pairLeft) / 1000);
      return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    },
    remoteRoleLabel(role) {
      return this.remoteRoles.find(r => r.id === role)?.label ?? role;
    },
    remoteFingerprint(value) {
      const text = String(value || '');
      return text.length > 22 ? text.slice(0, 10) + '…' + text.slice(-8) : text;
    },
    remoteSeen(device) {
      if (!device.lastSeenAt) return 'never connected';
      const minutes = Math.round((Date.now() - Date.parse(device.lastSeenAt)) / 60000);
      if (minutes < 1) return 'just now';
      if (minutes < 60) return minutes + ' min ago';
      return new Date(device.lastSeenAt).toLocaleString();
    },

    async loadRemote() {
      this.beginLoad(); this.error = '';
      try {
        const [status, devices, pairings] = await Promise.all([
          this.api('/remote/status'), this.api('/remote/devices'), this.api('/remote/pairings'),
        ]);
        this.remote = { ...this.remote, status, devices, pairings, loaded: true };
        this.remote.relayUrl ||= status.relayUrl || '';
        this.remoteSyncPairing();
      } catch (e) { this.error = e.message; }
      finally {
        this.endLoad();
        clearTimeout(this._remoteTimer);
        // A pairing in flight is the one moment the page has to feel live: the
        // phone's hello arrives over the relay, not over this HTTP surface.
        if (this.view === 'remote') this._remoteTimer = setTimeout(() => this.loadRemote(), this.remote.pair ? 1500 : 6000);
      }
    },
    remoteStop() { clearTimeout(this._remoteTimer); clearInterval(this._remoteClock); },
    /** The pairing is confirmed on the relay side too, so a device can land while
     * this tab was polling — treat the session list as the source of truth. */
    remoteSyncPairing() {
      if (this.remote.pair && this.remotePairSession()?.status === 'confirmed') {
        this.remote.pair = null;
        clearInterval(this._remoteClock);
      }
    },
    remoteClock() {
      clearInterval(this._remoteClock);
      this._remoteClock = setInterval(() => {
        if (!this.remote.pair || this.view !== 'remote') { clearInterval(this._remoteClock); return; }
        const session = this.remotePairSession() || this.remote.pair.pairing;
        this.remote.pairLeft = Math.max(0, Date.parse(session.expiresAt) - Date.now());
      }, 1000);
    },

    async remoteEnable() {
      this.remote.busy = 'enable';
      try {
        const relayUrl = (this.remote.relayUrl || '').trim();
        await this.api('/remote/enable', { method: 'POST', body: JSON.stringify(relayUrl ? { relayUrl } : {}) });
        this.notify('Remote access is on');
        await this.loadRemote();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.remote.busy = ''; }
    },
    async remoteDisable() {
      if (!confirm('Turn off remote access?\n\nYour paired devices stay registered but cannot reach this computer until you turn it back on.')) return;
      this.remote.busy = 'disable';
      try {
        await this.api('/remote/disable', { method: 'POST', body: '{}' });
        this.remote.pair = null;
        this.notify('Remote access is off');
        await this.loadRemote();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.remote.busy = ''; }
    },

    async remoteCreatePairing() {
      this.remote.busy = 'pair';
      try {
        this.remote.pair = await this.api('/remote/pairings', { method: 'POST', body: '{}' });
        this.remote.confirm = { label: 'My phone', role: 'viewer' };
        this.remote.pairLeft = Math.max(0, Date.parse(this.remote.pair.pairing.expiresAt) - Date.now());
        this.remoteClock();
        await this.loadRemote();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.remote.busy = ''; }
    },
    remoteCancelPairing() {
      this.remote.pair = null;
      clearInterval(this._remoteClock);
      this.loadRemote();
    },
    async remoteCopyPairingLink() {
      try {
        await navigator.clipboard.writeText(this.remote.pair.activationUrl);
        this.notify('Pairing link copied');
      } catch { this.notify('This browser blocked the clipboard — scan the code instead', 'error'); }
    },
    async remoteConfirmPairing() {
      const id = this.remote.pair?.pairing?.id;
      if (!id) return;
      this.remote.busy = 'confirm';
      try {
        await this.api('/remote/pairings/' + encodeURIComponent(id) + '/confirm', {
          method: 'POST',
          body: JSON.stringify({
            label: (this.remote.confirm.label || '').trim() || 'My phone',
            role: this.remote.confirm.role,
          }),
        });
        this.remote.pair = null;
        clearInterval(this._remoteClock);
        this.notify('Device connected');
        await this.loadRemote();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.remote.busy = ''; }
    },

    async remoteDeviceAction(device, action, body = {}) {
      this.remote.busy = device.id + ':' + action;
      try {
        await this.api('/remote/devices/' + encodeURIComponent(device.id) + '/' + action, {
          method: 'POST', body: JSON.stringify(body),
        });
        this.notify(({ suspend: 'Device paused', resume: 'Device resumed', revoke: 'Device revoked',
          role: 'Role updated', notify: 'Test notification sent' })[action] || 'Done');
        await this.loadRemote();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.remote.busy = ''; }
    },
    remoteSetRole(device, role) {
      if (role === device.role) return;
      return this.remoteDeviceAction(device, 'role', { role });
    },
    remoteRevoke(device) {
      if (!confirm('Revoke "' + device.label + '"?\n\nIt loses access immediately and cannot be restored — you would have to pair the device again from scratch.')) return;
      return this.remoteDeviceAction(device, 'revoke');
    },
  };
}
