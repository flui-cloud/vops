function dashboardOverview() {
  return {
    async loadOverview() {
      this.loading = true; this.error = '';
      this.ov = { serverCount: null, byProvider: [], spend: null, alerts: null, cheapest: null, bestValue: [], bvLoaded: false };
      this.plansCache = {};
      try {
        const res = await this.api('/providers/regions');
        this.regions = res.regions; this.regionsSource = res.source; this.regionsUpdated = res.updatedAt;
        this.computeRegionStats();
      } catch (e) { this.error = e.message; }
      try { this.providers = await this.api('/providers'); } catch { /* panel optional */ }
      this.loading = false;
      this.loadBestValue();
      this.loadFleetStats();
      this.loadKeyCount();
    },
    computeRegionStats() {
      const priced = (this.regions || []).filter(r => r.fromMonthly != null)
        .sort((a, b) => a.fromMonthly - b.fromMonthly);
      this.ov.cheapest = priced[0] || null;
    },
    // Best value = the strongest €/GB plan at each RAM tier (2/4/8 GB), so the
    // panel shows a spread of real sizes instead of three tiny nano plans.
    // Hourly-billed plans get a small edge (no lock-in — vops's whole point).
    async loadBestValue() {
      try { this.allPlans = await this.api('/compare', { method: 'POST', body: JSON.stringify({}) }); }
      catch { this.allPlans = []; }
      const tiers = [{ label: '2 GB', min: 2, max: 4 }, { label: '4 GB', min: 4, max: 8 }, { label: '8 GB', min: 8, max: 16 }];
      const score = p => (p.monthly / p.memoryGb) * (p.hourly == null ? 1 : 0.9);
      this.ov.bestValue = tiers.map(t => {
        const bucket = this.allPlans
          .filter(p => p.monthly != null && p.memoryGb >= t.min && p.memoryGb < t.max)
          .sort((a, b) => score(a) - score(b));
        const p = bucket[0];
        return p ? { tier: t.label, key: this.providerKey(p.provider), provider: p.provider, plan: p.plan,
          region: p.region, cores: p.cores, memoryGb: p.memoryGb, monthly: p.monthly,
          isHourly: p.hourly != null, perGb: p.monthly / p.memoryGb } : null;
      }).filter(Boolean);
      this.ov.bvLoaded = true;
    },
    providerKey(name) {
      const n = String(name).toLowerCase();
      return ['hetzner', 'scaleway', 'contabo', 'ovh'].find(k => n.includes(k)) || n;
    },
    // Fleet aggregation across every provider — best-effort: credentialed calls
    // for unconfigured providers fail quietly and simply contribute nothing.
    async loadFleetStats() {
      const results = await Promise.all(this.providerIds.map(p =>
        this.api('/servers?provider=' + p).then(list => ({ p, list })).catch(() => ({ p, list: [] }))));
      const byProvider = results.filter(r => r.list.length).map(r => ({ id: r.p, count: r.list.length, list: r.list }));
      this.ov.serverCount = results.reduce((n, r) => n + r.list.length, 0);
      this.ov.byProvider = byProvider.map(b => ({ id: b.id, count: b.count }));
      this.computeSpend(byProvider);
      this.computeAlerts();
    },
    // Estimated spend: match each server's plan type to a catalogue price —
    // hourly OR monthly (Contabo is monthly-only). Types that don't resolve to a
    // plan (e.g. Contabo's internal "V95" code) are counted in `total` but not
    // priced, and the card surfaces "N of M priced" rather than inventing a cost.
    async computeSpend(byProvider) {
      const parts = await Promise.all(byProvider.map(b => this.providerSpend(b)));
      const sum = parts.reduce((a, p) => ({
        monthly: a.monthly + p.monthly,
        priced: a.priced + p.priced, total: a.total + p.total,
      }), { monthly: 0, priced: 0, total: 0 });
      this.ov.spend = sum.total ? sum : null;
    },
    async providerSpend(b) {
      const plans = await this.plansFor(b.id);
      const priced = b.list.map(s => this.planPrice(plans, s.type)).filter(Boolean);
      return {
        monthly: priced.reduce((n, p) => n + p.monthly, 0),
        priced: priced.length, total: b.list.length,
      };
    },
    // Plan catalogue per provider, cached for the load so the servers table and
    // the spend total resolve prices from the exact same source.
    async plansFor(p) {
      if (this.plansCache[p]) return this.plansCache[p];
      let plans = [];
      try { plans = await this.api('/providers/' + p + '/plans'); } catch { plans = []; }
      this.plansCache[p] = plans;
      return plans;
    },
    planPrice(plans, type) {
      const pl = (plans || []).find(x => (x.name || x.plan || x.type) === type);
      if (!pl || (pl.hourly == null && pl.monthly == null)) return null;
      return {
        monthly: pl.monthly == null ? pl.hourly * 730 : pl.monthly,
        hourly: pl.hourly == null ? pl.monthly / 730 : pl.hourly,
      };
    },
    async computeAlerts() {
      let count = 0, total = 0; const bits = [];
      const results = await Promise.all(this.providerIds.map(p =>
        this.api('/providers/' + p + '/availability').then(rows => ({ p, rows })).catch(() => ({ p, rows: [] }))));
      for (const { p, rows } of results) {
        for (const row of (rows || [])) {
          total++;
          const st = this.availStatus(row);
          if (st.status === 'soldout' || st.status === 'limited') count++;
        }
        const soldout = (rows || []).filter(r => this.availStatus(r).status === 'soldout').length;
        if (soldout) bits.push(soldout + ' sold-out on ' + p);
      }
      this.ov.alerts = { count, total, detail: bits.slice(0, 1).join(' · ') };
    },
    async loadKeyCount() {
      try { this.sshKeys = await this.api('/ssh-keys'); } catch { /* keep [] */ }
      this.sshKeysLoaded = true;
    },
  };
}
