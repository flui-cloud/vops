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

    async hardenHost(h, dryRun) {
      this.hostBusy = h.name;
      try {
        const res = await this.api('/hosts/' + encodeURIComponent(h.name) + '/harden', { method: 'POST', body: JSON.stringify({ dryRun }) });
        this.openReport((dryRun ? 'Harden (dry-run) · ' : 'Harden · ') + h.name, res.findings);
        if (!dryRun) this.reload();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; }
    },

    async updateHost(h) {
      this.hostBusy = h.name;
      try {
        const res = await this.api('/hosts/' + encodeURIComponent(h.name) + '/update', { method: 'POST', body: JSON.stringify({}) });
        const r = res[0] || {};
        this.notify(h.name + ': ' + (r.summary || 'done') + (r.rebootRequired ? ' · reboot required' : ''), r.applied ? 'ok' : 'error');
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; }
    },

    async installOps(h) {
      this.hostBusy = h.name;
      try {
        await this.api('/hosts/' + encodeURIComponent(h.name) + '/key/install-ops', { method: 'POST', body: JSON.stringify({}) });
        this.notify('Ops key installed on ' + h.name); this.reload();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; }
    },

    async revokeOps(h) {
      this.hostBusy = h.name;
      try {
        await this.api('/hosts/' + encodeURIComponent(h.name) + '/key', { method: 'DELETE' });
        this.notify('Ops key revoked from ' + h.name); this.reload();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.hostBusy = ''; }
    },

    async rotateOps() {
      try {
        const rep = await this.api('/hosts/rotate-ops', { method: 'POST', body: JSON.stringify({}) });
        const findings = (rep.results || []).map(r => ({ id: r.host, severity: rotateOutcomeSeverity(r.outcome), summary: r.message || r.outcome }));
        this.openReport('Rotate ops key' + (rep.promoted ? ' · promoted' : ''), findings);
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

    // One-click, no form: enable the dead-man monitor with sane defaults.
    async enableMonitor(row) {
      this.hostBusy = row.id;
      try {
        const name = await this.ensureHostName(row);
        await this.api('/hosts/' + encodeURIComponent(name) + '/monitor', { method: 'POST', body: JSON.stringify({}) });
        this.notify('Monitoring on · ' + name);
        await this.loadHosts();
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

    async openManage(row) {
      this.modal = { ...this.modal, open: true, type: 'manage', title: 'Manage · ' + (row.name || ''),
        readonly: true, dryRun: false,
        mg: { row, name: row.host?.name || null, host: row.host || null, busy: false, statusLoading: false, findings: null, latencyMs: null } };
      try {
        if (!this.sshKeys?.length) { try { this.sshKeys = await this.api('/ssh-keys'); } catch { /* optional */ } }
        if (!this.modal.mg.name) {
          const name = await this.ensureHostName(row);
          this.modal.mg.name = name;
          this.modal.mg.host = (this.hosts || []).find(x => x.name === name) || null;
        }
        await this.manageCheck();
        // Only run the (slow) SSH status battery when the host is actually reachable.
        if (this.modal.mg.host?.conn?.state === 'ready') await this.loadManageStatus();
      } catch (e) { this.modal.mg.statusLoading = false; this.notify(e.message, 'error'); }
    },

    async loadManageStatus() {
      const mg = this.modal.mg; if (!mg?.name) return;
      mg.statusLoading = true;
      try {
        const res = await this.api('/hosts/' + encodeURIComponent(mg.name) + '/status');
        mg.findings = res.report?.findings || []; mg.latencyMs = res.latencyMs;
      } catch (e) { mg.findings = []; this.notify(e.message, 'error'); }
      finally { mg.statusLoading = false; }
    },

    async refreshManageHost() {
      await this.loadHosts();
      const mg = this.modal.mg; if (mg) mg.host = (this.hosts || []).find(x => x.name === mg.name) || mg.host;
    },

    async manageMonitor(on) {
      const mg = this.modal.mg; mg.busy = true;
      try {
        const path = '/hosts/' + encodeURIComponent(mg.name) + '/monitor';
        if (on) { await this.api(path, { method: 'POST', body: JSON.stringify({}) }); this.notify('Monitoring on · ' + mg.name); }
        else { await this.api(path, { method: 'DELETE' }); this.notify('Monitoring off · ' + mg.name); }
        await this.refreshManageHost();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { mg.busy = false; }
    },

    async manageOps(install) {
      const mg = this.modal.mg; mg.busy = true;
      try {
        if (install) { await this.api('/hosts/' + encodeURIComponent(mg.name) + '/key/install-ops', { method: 'POST', body: JSON.stringify({}) }); this.notify('Ops key installed · ' + mg.name); }
        else { await this.api('/hosts/' + encodeURIComponent(mg.name) + '/key', { method: 'DELETE' }); this.notify('Ops key revoked · ' + mg.name); }
        await this.refreshManageHost();
      } catch (e) { this.notify(e.message, 'error'); }
      finally { mg.busy = false; }
    },
  };
}
