// "Watchers" — one page for every remote-relay alert, since they all live on the
// same vops-landing account: availability/price watches, external uptime probes,
// and per-host dead-man switches. Three distinct backend entities, one UI.
function dashboardWatchers() {
  return {
    wt: { loading: false, err: '', watches: [], uptimes: [], hostRows: [], lastAt: '' },

    // Plain methods, not getters — Object.assign() in app.js flattens accessor
    // properties from every factory but the first (core.js) into static
    // snapshot values at merge time, so a `get` here would never update.
    watcherHosts() { return (this.hosts || []).filter(h => h.monitorHostId); },
    watchersEmpty() {
      return !this.wt.watches.length && !this.wt.uptimes.length && !this.wt.hostRows.length;
    },

    async loadWatchers() {
      this.wt.loading = true; this.wt.err = '';
      try {
        await this.loadHosts();
        const [watches, uptimes, hostRows] = await Promise.all([
          this.api('/watch/list').catch(() => []),
          this.api('/watch/uptime').catch(() => []),
          Promise.all(this.watcherHosts().map(h =>
            this.api('/hosts/' + encodeURIComponent(h.name) + '/monitor')
              .then(status => ({ host: h, status, err: '' }))
              .catch(e => ({ host: h, status: null, err: e.message })))),
        ]);
        this.wt.watches = watches || [];
        this.wt.uptimes = uptimes || [];
        this.wt.hostRows = hostRows;
        this.wt.lastAt = new Date().toLocaleTimeString();
      } catch (e) { this.wt.err = e.message; }
      finally { this.wt.loading = false; }
    },

    async removeWatch(w) {
      try {
        await this.api('/watch/' + encodeURIComponent(w.id), { method: 'DELETE' });
        this.notify('Watch removed · ' + w.provider + ' ' + w.serverType);
        await this.loadWatchers();
      } catch (e) { this.notify(e.message, 'error'); }
    },

    async removeUptime(u) {
      try {
        await this.api('/watch/uptime/' + encodeURIComponent(u.id), { method: 'DELETE' });
        this.notify('Uptime monitor removed · ' + u.name);
        await this.loadWatchers();
      } catch (e) { this.notify(e.message, 'error'); }
    },

    async disableHostMonitor(row) {
      try {
        await this.api('/hosts/' + encodeURIComponent(row.host.name) + '/monitor', { method: 'DELETE' });
        this.notify('Host monitor off · ' + row.host.name);
        await this.loadWatchers();
      } catch (e) { this.notify(e.message, 'error'); }
    },

    wtStateColor(s) {
      return ({ ok: 'var(--ok)', up: 'var(--ok)', alert: 'var(--danger)', silent: 'var(--danger)', down: 'var(--danger)' })[s] || 'var(--text-faint)';
    },
  };
}
