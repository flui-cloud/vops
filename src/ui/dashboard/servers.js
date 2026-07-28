function dashboardServers() {
  return {
    // Servers list — "all" aggregates every provider; each row carries its
    // provider and a resolved indicative monthly price (null when unknown).
    async loadServers() {
      this.beginLoad(); this.error = ''; this.servers = [];
      const provs = this.serverTab === 'all' ? this.providerIds : [this.serverTab];
      try {
        const lists = await Promise.all(provs.map(p =>
          this.api('/servers?provider=' + p).then(list => ({ p, list })).catch(() => ({ p, list: [] }))));
        const rows = [];
        for (const { p, list } of lists) {
          const plans = await this.plansFor(p);
          for (const s of list) {
            const price = this.planPrice(plans, s.type);
            rows.push({ ...s, provider: p, monthly: price ? price.monthly : null });
          }
        }
        this.servers = rows;
      } catch (e) { this.error = e.message; this.servers = []; }
      finally { this.serversReady = true; this.endLoad(); }
    },
    setServerTab(t) { this.serverTab = t; this.loadServers(); },
    openServers() { this.serverTab = 'all'; this.go('servers'); },

    // A server IS a host: resolve the SSH-plane record tracking a provider row.
    hostForServer(s) {
      return (this.hosts || []).find(h => h.provider === s.provider && (h.providerServerId === s.id || h.name === s.name));
    },
    // Provider servers (with their resolved host) plus any external hosts —
    // one fleet, one list. External hosts only surface in the "all" tab.
    // A method, not a getter: sub-factories are Object.assign sources and a
    // getter there would be invoked (and flatten) at composition time.
    fleet() {
      const rows = this.servers.map(s => ({ ...s, host: this.hostForServer(s), external: false }));
      if (this.serverTab !== 'all') return rows;
      const linked = new Set(rows.map(r => r.host?.name).filter(Boolean));
      const ext = (this.hosts || []).filter(h => !h.providerServerId && !linked.has(h.name)).map(h => ({
        external: true, host: h, id: h.name, name: h.name, provider: 'external',
        type: '—', location: '—', status: 'external', monthly: null, publicIp: h.address, managed: false,
      }));
      return [...rows, ...ext];
    },
    monitored(row) { return !!row.host?.monitorHostId; },
    // Skeleton covers the first load (even when external hosts would otherwise
    // fill the table), then only stands in for an empty table — a background
    // refresh (host chips, monitor toggle) must not blank rows already on screen.
    serversLoading() { return this.loading && (!this.serversReady || !this.fleet().length); },

    async runCompare() {
      this.beginLoad(); this.error = ''; this.comparedOnce = true; this.compareRows = [];
      // Region + billing + tier now filter client-side (geographic area, monthly/
      // hourly, tier tabs), so fetch the full set and let the compare view slice it.
      const body = {
        cpu: this.num(this.cmp.cpu), ramGb: this.num(this.cmp.ramGb),
        provider: this.cmp.provider || undefined,
        includeDeprecated: this.showDeprecated,
      };
      try { this.compareRows = await this.api('/compare', { method: 'POST', body: JSON.stringify(body) }); }
      catch (e) { this.error = e.message; this.compareRows = []; }
      finally { this.endLoad(); }
    },

    async openPlan(row) {
      try {
        const plan = await this.api('/servers/plan', { method: 'POST',
          body: JSON.stringify({ provider: row.provider, plan: row.plan, location: row.region }) });
        this.modal = { ...this.modal, open: true, type: 'provision', title: 'Provision server',
          cta: 'Create', danger: false, dryRun: true, plan, ctx: null };
      } catch (e) { this.notify(e.message, 'error'); }
    },

    async doProvision(dryRun) {
      const out = await this.api('/servers/create', { method: 'POST',
        body: JSON.stringify({ plan: this.modal.plan, dryRun, yes: !dryRun }) });
      if (dryRun) return this.notify('Dry-run OK — gate allows this plan. Nothing changed.');
      this.closeModal(); this.notify('Server created: ' + (out.server?.id || '')); this.go('servers');
    },

    // A row already tracked as a host connects via /hosts/:name/connect (ops key first, else
    // the user key) — never the cloud-provider lookup below, which deliberately refuses the ops key.
    async openConnect(server) {
      const hostBased = !!server.host;
      this.modal = { ...this.modal, open: true, type: 'connect', title: 'Connect to ' + server.name, cta: 'Close',
        danger: false, dryRun: false,
        conn: {
          server, hostBased, user: 'root', key: '', command: '',
          cli: hostBased ? '' : `vops ssh ${server.provider} ${server.id || server.name}`,
          keys: [],
        } };
      if (hostBased) return this.doHostConnect();
      let keys = this.sshKeys;
      if (!keys.length) { try { keys = await this.api('/ssh-keys'); } catch { keys = []; } }
      this.modal.conn.keys = keys.filter(k => k.hasPrivateKey);
      this.doConnect();
    },
    async doConnect() {
      const c = this.modal.conn;
      if (!c.server) return;
      try {
        const info = await this.api('/ssh-keys/connect', { method: 'POST',
          body: JSON.stringify({ provider: c.server.provider || this.provider, server: c.server.id, user: c.user || undefined, key: c.key || undefined }) });
        this.modal.conn.command = info.command;
      } catch (e) { this.modal.conn.command = ''; this.notify(e.message, 'error'); }
    },
    async doHostConnect() {
      const c = this.modal.conn;
      try {
        const info = await this.api('/hosts/' + encodeURIComponent(c.server.host.name) + '/connect');
        this.modal.conn.command = info.command;
        this.modal.conn.cli = info.cli;
        this.modal.conn.user = info.user;
      } catch (e) { this.modal.conn.command = ''; this.notify(e.message, 'error'); }
    },
    async copy(text) {
      try { await navigator.clipboard.writeText(text); this.notify('Copied'); }
      catch { this.notify('Copy failed — select manually', 'error'); }
    },
  };
}
