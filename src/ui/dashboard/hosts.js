function rotateOutcomeSeverity(outcome) {
  if (outcome === 'failed') return 'fail';
  if (outcome === 'rotated') return 'info';
  return 'ok';
}

function dashboardHosts() {
  return {
    hosts: [],
    hostsLoaded: false,
    hostBusy: '',
    ulog: { unit: '', output: '', busy: false, err: '' },
    pud: { packages: [], total: 0, truncated: false, busy: false, err: '' },

    async loadHosts() {
      await this.load('hosts', '/hosts');
      this.hostsLoaded = true;
    },

    sevColor(s) {
      return ({ ok: 'var(--ok)', info: 'var(--accent)', warn: 'var(--warn)', fail: 'var(--danger)' })[s] || 'var(--text-dim)';
    },

    openHostForm() {
      this.modal = { ...this.modal, open: true, type: 'host', title: 'Add host', cta: 'Add', danger: false,
        dryRun: false, readonly: false,
        hs: { mode: 'add', name: '', address: '', user: 'root', port: 22, key: '', tags: '', provider: this.provider, server: '' } };
    },

    async doHostModal() {
      const hs = this.modal.hs;
      if (hs.mode === 'import') {
        if (!hs.server.trim()) throw new Error('Server id or name is required.');
        await this.api('/hosts/import', { method: 'POST', body: JSON.stringify({ provider: hs.provider, server: hs.server.trim() }) });
        this.notify('Imported host ' + hs.server);
      } else {
        if (!hs.name.trim() || !hs.address.trim()) throw new Error('Name and address are required.');
        const body = { name: hs.name.trim(), address: hs.address.trim(), user: hs.user.trim() || 'root',
          port: Number(hs.port) || 22, key: hs.key.trim() || undefined, tags: this.csv(hs.tags) };
        const out = await this.api('/hosts', { method: 'POST', body: JSON.stringify(body) });
        this.notify(out.probe?.reachable ? ('Added ' + hs.name + ' · ' + (out.host?.os?.pretty || '')) : ('Added ' + hs.name + ' (unreachable)'), out.probe?.reachable ? 'ok' : 'error');
      }
      this.closeModal(); this.reload();
    },

    openReport(title, findings) {
      this.modal = { ...this.modal, open: true, type: 'hostreport', title, readonly: true, dryRun: false,
        report: { findings: findings || [] } };
    },

    async hostStatus(h) {
      this.hostBusy = h.name;
      try {
        const res = await this.api('/hosts/' + encodeURIComponent(h.name) + '/status');
        this.openReport('Status · ' + h.name + '  (' + res.latencyMs + 'ms)', res.report?.findings);
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; }
    },

    async updateHost(h) {
      const mg = this.modal.mg;
      if (mg) { mg.busy = true; }
      this.hostBusy = h.name;
      try {
        const res = await this.api('/hosts/' + encodeURIComponent(h.name) + '/update', { method: 'POST', body: JSON.stringify({}) });
        const r = res[0] || {};
        const summary = (r.summary || 'done') + (r.rebootRequired ? ' · reboot required' : '');
        this.recordRun('update', !!r.applied, r.applied ? summary : (r.detail || summary));
        this.notify(h.name + ': ' + summary, r.applied ? 'ok' : 'error');
      } catch (e) { this.recordRun('update', false, e.message); this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; if (mg) { mg.busy = false; } await this.hostRefresh(); }
    },

    async rebootHost(h) {
      const mg = this.modal.mg;
      if (mg) { mg.busy = true; }
      this.hostBusy = h.name;
      try {
        const res = await this.api('/hosts/' + encodeURIComponent(h.name) + '/reboot', { method: 'POST', body: JSON.stringify({}) });
        const r = res[0] || {};
        this.recordRun('restart', !!r.rebooted, r.rebooted ? 'Rebooted and back online' : (r.summary || 'Reboot issued — not confirmed'));
        this.notify(h.name + ': ' + (r.summary || 'reboot issued'), r.rebooted ? 'ok' : 'error');
      } catch (e) { this.recordRun('restart', false, e.message); this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; if (mg) { mg.busy = false; } await this.hostRefresh(); }
    },

    // Disable SSH password login — runs the lockout preflight, then opens a confirm
    // (or a blocked list) before touching anything. Always key-only.
    async sshHardenStart() {
      const name = this.modal.mg?.name;
      if (!name) return;
      this.ask = { open: true, action: 'ssh-harden', name, busy: true, disabled: true,
        title: 'Disable password login',
        cta: '', danger: false, message: 'Checking lockout safety over SSH…', bullets: [] };
      try {
        const pre = await this.api('/hosts/' + encodeURIComponent(name) + '/ssh-lockdown/preflight');
        this.ask = this.sshHardenAsk(name, pre);
      } catch (e) {
        this.ask = { ...this.ask, busy: false, disabled: true, cta: '', title: 'Cannot check', message: e.message, bullets: [] };
      }
    },
    sshHardenAsk(name, pre) {
      const title = 'Disable password login';
      const base = { open: true, action: 'ssh-harden', name, busy: false, bullets: [] };
      if (pre.alreadyHardened) return { ...base, disabled: true, cta: '', danger: false, message: 'Already hardened — nothing to do.' };
      if (pre.ok) {
        return { ...base, override: false, disabled: false, danger: false, title, cta: title,
          message: 'Your own key is verified. This disables all SSH password login (key-only from now on). It auto-reverts in ' + pre.deadManMinutes + ' min if anything goes wrong.' };
      }
      return { ...base, override: !!pre.overridable, danger: true, title,
        cta: pre.overridable ? 'Disable anyway' : '', disabled: !pre.overridable,
        message: pre.overridable ? 'This would lock out accounts that still use a password:' : 'Not safe yet — fix these first:',
        bullets: (pre.refusals || []).map((r) => r.message) };
    },
    async sshHardenRun() {
      const name = this.ask.name, override = !!this.ask.override;
      const mg = this.modal.mg;
      if (mg) { mg.busy = true; }
      try {
        const res = await this.api('/hosts/' + encodeURIComponent(name) + '/ssh-lockdown', { method: 'POST', body: JSON.stringify({ override }) });
        this.recordRun('ssh-harden', !!res.applied, res.message);
        this.notify(name + ': ' + res.message, res.applied ? 'ok' : 'info');
      } catch (e) { this.recordRun('ssh-harden', false, e.message); this.notify(e.message, 'error'); }
      finally { if (mg) { mg.busy = false; } await this.hostRefresh(); }
    },

    // Read-only: fetch `systemctl status` + recent journal for one failed unit.
    async openUnitLogs(unit) {
      const name = this.modal.mg?.name;
      if (!name || !unit) return;
      this.ulog = { unit, output: '', busy: false, err: '' };
      this.modal = { ...this.modal, open: true, type: 'unitlogs', title: 'Logs · ' + unit, readonly: true };
      await this.refreshUnitLogs();
    },
    async refreshUnitLogs() {
      const name = this.modal.mg?.name, unit = this.ulog.unit;
      if (!name || !unit) return;
      this.ulog.busy = true; this.ulog.err = '';
      try {
        const r = await this.api('/hosts/' + encodeURIComponent(name) + '/unit-logs?unit=' + encodeURIComponent(unit) + '&lines=100');
        this.ulog.output = r.output || '(no output)';
      } catch (e) { this.ulog.err = e.message; }
      finally { this.ulog.busy = false; }
    },

    // Read-only, on demand: which packages have a pending update (a separate SSH
    // call — not part of the fast status poll).
    async openPendingUpdates() {
      const name = this.modal.mg?.name;
      if (!name) return;
      this.pud = { packages: [], total: 0, truncated: false, busy: false, err: '' };
      this.modal = { ...this.modal, open: true, type: 'updates', title: 'Pending updates', readonly: true };
      await this.refreshPendingUpdates();
    },
    async refreshPendingUpdates() {
      const name = this.modal.mg?.name;
      if (!name) return;
      this.pud.busy = true; this.pud.err = '';
      try {
        const r = await this.api('/hosts/' + encodeURIComponent(name) + '/updates');
        this.pud.packages = r.packages || [];
        this.pud.total = r.total || 0;
        this.pud.truncated = !!r.truncated;
      } catch (e) { this.pud.err = e.message; }
      finally { this.pud.busy = false; }
    },
    pudSecurityCount() { return this.pud.packages.filter((p) => p.security).length; },

    async installOps(h) {
      this.hostBusy = h.name;
      try {
        await this.api('/hosts/' + encodeURIComponent(h.name) + '/key/install-ops', { method: 'POST', body: JSON.stringify({}) });
        this.notify('Automation key installed on ' + h.name); this.reload();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; }
    },

    async revokeOps(h) {
      this.hostBusy = h.name;
      try {
        await this.api('/hosts/' + encodeURIComponent(h.name) + '/key', { method: 'DELETE' });
        this.notify('Automation key revoked from ' + h.name); this.reload();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; }
    },

    async rotateOps() {
      try {
        const rep = await this.api('/hosts/rotate-ops', { method: 'POST', body: JSON.stringify({}) });
        const findings = (rep.results || []).map(r => ({ id: r.host, severity: rotateOutcomeSeverity(r.outcome), summary: r.message || r.outcome }));
        this.openReport('Rotate automation key' + (rep.promoted ? ' · promoted' : ''), findings);
        this.reload();
      } catch (e) { this.notify(e.message, 'error'); }
    },

    // --- Server-as-host glue: adopt a provider row into the SSH plane on demand ---
    async ensureHostName(row) {
      if (row.host) return row.host.name;
      const h = await this.api('/hosts/ensure', { method: 'POST', body: JSON.stringify({ provider: row.provider, server: row.id }) });
      await this.loadHosts();
      return h.name;
    },

    async enableMonitor(row) {
      this.hostBusy = row.id;
      try {
        await this.openMonitorChannel(await this.ensureHostName(row));
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; }
    },

    // --- SSH connection state (cached; drives gating + instructions) ---
    connMeta(state) {
      return ({
        // 'ready' green; problems that arise AFTER opting in are warn/danger;
        // "not set up" / "not checked" are neutral — SSH management is opt-in.
        ready: { label: 'SSH ready', color: 'var(--ok)' },
        unreachable: { label: 'SSH unreachable', color: 'var(--danger)' },
        'no-key': { label: 'SSH not set up', color: 'var(--text-faint)' },
        'auth-failed': { label: 'SSH auth failed', color: 'var(--warn)' },
        unknown: { label: 'SSH not checked', color: 'var(--text-faint)' },
      })[state] || { label: state, color: 'var(--text-faint)' };
    },
    connState(row) { return row.host?.conn?.state || 'unknown'; },
    providerOnly(row) { return row.host?.sshManaged === false; },

    async setSshManaged(managed) {
      const mg = this.modal.mg; mg.busy = true;
      try {
        await this.api('/hosts/' + encodeURIComponent(mg.name) + '/ssh-managed', { method: 'POST', body: JSON.stringify({ managed }) });
        await this.loadHosts();
        mg.host = (this.hosts || []).find(x => x.name === mg.name) || mg.host;
        this.notify(managed ? 'SSH management enabled' : 'Marked provider-only');
        if (managed) await this.manageCheck();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { mg.busy = false; }
    },
    // Actions that need SSH are blocked on a KNOWN non-ready state (unknown = not
    // yet probed → let the action's preflight resolve it).
    sshBlocked(row) { const s = row.host?.conn?.state; return !!s && s !== 'ready' && s !== 'unknown'; },
    mgReady() { return this.modal.mg?.host?.conn?.state === 'ready'; },

    async checkConn(row) {
      this.hostBusy = row.id;
      try {
        const name = await this.ensureHostName(row);
        const conn = await this.api('/hosts/' + encodeURIComponent(name) + '/ssh');
        await this.loadHosts();
        this.notify('SSH · ' + this.connMeta(conn.state).label, conn.state === 'ready' ? 'ok' : 'error');
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; }
    },

    async manageCheck() {
      const mg = this.modal.mg; if (!mg?.name) return;
      mg.busy = true;
      try {
        const conn = await this.api('/hosts/' + encodeURIComponent(mg.name) + '/ssh');
        await this.loadHosts();
        mg.host = (this.hosts || []).find(x => x.name === mg.name) || mg.host;
        if (mg.host) mg.host.conn = conn;
      } catch (e) { this.notify(e.message, 'error'); }
      finally { mg.busy = false; }
    },

    // Local keys the user can assign (private half present, not the reserved ops key).
    userKeysAvail() { return (this.sshKeys || []).filter(k => k.hasPrivateKey && k.role !== 'ops'); },

    // vops fell back to its only key — nothing was chosen for this host.
    keyIsDefault() { return this.modal.mg?.host?.conn?.keySource === 'default'; },

    hostKeyPlaceholder() { return this.modal.mg?.host?.userKeyName ? 'Change key…' : 'Assign a key…'; },

    // Reached the server, tried a key, got refused — the only state where authorizing helps.
    showAuthorizeHelp() {
      const c = this.modal.mg?.host?.conn;
      return !!(c?.reachable && c.hasKey && !c.authorized && c.publicKey);
    },

    // Appends the public half on the SERVER — never run on the operator's machine.
    akInstallCmd() {
      const pk = this.modal.mg?.host?.conn?.publicKey || '';
      return String.raw`install -d -m 700 ~/.ssh && printf '%s\n' '${pk}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
    },

    async assignUserKey(keyName) {
      const mg = this.modal.mg; if (!keyName) return;
      mg.busy = true;
      try {
        const conn = await this.api('/hosts/' + encodeURIComponent(mg.name) + '/user-key', { method: 'POST', body: JSON.stringify({ key: keyName }) });
        await this.loadHosts();
        mg.host = (this.hosts || []).find(x => x.name === mg.name) || mg.host;
        if (mg.host) mg.host.conn = conn;
        this.notify('Key assigned · ' + this.connMeta(conn.state).label, conn.state === 'ready' ? 'ok' : 'error');
      } catch (e) { this.notify(e.message, 'error'); }
      finally { mg.busy = false; }
    },

    // One-click for dummies: make a key named after the host, then assign it.
    async generateKeyFor() {
      const name = this.modal.mg.name;
      try {
        try { await this.api('/ssh-keys', { method: 'POST', body: JSON.stringify({ name }) }); }
        catch (e) { if (!/already exists/i.test(e.message)) throw e; }
        try { this.sshKeys = await this.api('/ssh-keys'); } catch { /* keep old list */ }
      } catch (e) { this.notify(e.message, 'error'); return; }
      await this.assignUserKey(name);
    },

    // Open the dedicated host detail page. modal.mg carries the host state (the
    // manage.* methods read it); the page — not a modal — renders from it.
    async openHost(row) {
      if (this.view !== 'host') this.hvFrom = this.view;
      this.modal.mg = { row, name: row.host?.name || null, host: row.host || null, busy: false, statusLoading: false, findings: null, latencyMs: null };
      this.view = 'host';
      if (this.$refs.main) this.$refs.main.scrollTop = 0;
      await this.loadHostView();
    },

    async loadHostView() {
      this.monStop();
      const mg = this.modal.mg;
      if (!mg) return;
      if (!this.sshKeys?.length) { try { this.sshKeys = await this.api('/ssh-keys'); } catch { /* optional */ } }
      await this.loadHosts();
      try {
        if (!mg.name && mg.row) mg.name = await this.ensureHostName(mg.row);
        mg.host = (this.hosts || []).find(x => x.name === mg.name) || mg.host;
        await this.manageCheck();
        if (mg.name) this.fwLoad(mg.name);
        this.monBindVisibility();
        if (this.mgReady() && mg.host) {
          await this.monPoll(mg.host);
          this.mon.interval = setInterval(() => this.hostTick(), MON_INTERVAL);
        }
      } catch (e) { this.notify(e.message, 'error'); }
    },

    hostTick() {
      if (this.view !== 'host') { this.monStop(); return; }
      const h = this.modal.mg?.host;
      if (h) this.monPoll(h);
    },

    async hostRefresh() {
      await this.manageCheck();
      const h = this.modal.mg?.host;
      if (this.mgReady() && h) await this.monPoll(h);
    },

    hvBack() { this.go(this.hvFrom || 'servers'); },
    hvLive() { return this.mon.live[this.modal.mg?.name] || {}; },

    // Live-status derived state for the primary actions.
    hvFinding(id) { return (this.hvLive().findings || []).find(f => f.id === id) || null; },
    updatesState() {
      const f = this.hvFinding('pkg.updates');
      if (!f) return 'unknown';
      if (f.severity === 'ok') return 'current';
      if (f.value) return f.severity === 'warn' ? 'security' : 'pending';
      return 'unknown';
    },
    updatesCount() { return this.hvFinding('pkg.updates')?.value || 0; },
    rebootPending() { return this.hvFinding('pkg.reboot')?.severity === 'warn'; },

    hvLastRun() { return this.modal.mg?.lastRun || null; },
    recordRun(kind, ok, summary) { if (this.modal.mg) this.modal.mg.lastRun = { kind, ok, summary, at: Date.now() }; },
    agoShort(ts) {
      if (!ts) return '';
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 45) return 'just now';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      return Math.round(s / 3600) + 'h ago';
    },

    async refreshManageHost() {
      await this.loadHosts();
      const mg = this.modal.mg; if (mg) mg.host = (this.hosts || []).find(x => x.name === mg.name) || mg.host;
    },

    // Enabling asks WHERE the alert goes: a monitor with no channel registers
    // fine and then alerts nobody, which is the one failure a dead-man switch
    // must not have. Disabling stays a single call.
    async manageMonitor(on) {
      const mg = this.modal.mg;
      if (on) return this.openMonitorChannel(mg.name);
      mg.busy = true;
      try {
        await this.api('/hosts/' + encodeURIComponent(mg.name) + '/monitor', { method: 'DELETE' });
        this.notify('Monitoring off · ' + mg.name);
        await this.refreshManageHost();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { mg.busy = false; }
    },

    async manageOps(install) {
      const mg = this.modal.mg; mg.busy = true;
      try {
        if (install) { await this.api('/hosts/' + encodeURIComponent(mg.name) + '/key/install-ops', { method: 'POST', body: JSON.stringify({}) }); this.notify('Automation key installed · ' + mg.name); }
        else { await this.api('/hosts/' + encodeURIComponent(mg.name) + '/key', { method: 'DELETE' }); this.notify('Automation key revoked · ' + mg.name); }
        await this.refreshManageHost();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { mg.busy = false; }
    },
  };
}
