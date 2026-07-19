function dashboardAvailability() {
  return {
    regionByCode(code) { return this.regions.find(r => r.code === code); },
    createBadgeClass(r) {
      if (r.deprecated) return 'badge-off';
      if (r.createAllowed) return this.isSoldOut(r) ? 'badge-warn' : 'badge-ok';
      return r.guided ? 'badge-warn' : 'badge-off';
    },
    createBadgeText(r) {
      if (r.deprecated) return 'deprecated';
      if (r.createAllowed) return this.isSoldOut(r) ? 'sold out' : 'allowed';
      return r.guided ? 'guide' : 'blocked';
    },
    // Region-availability badge mirrors the landing: count = coverage of ACTIVE
    // regions, colour = live stock (green all up · yellow some sold out · red
    // all sold out). Deprecated (retiring) regions are a distinct state.
    activeRegions(r) { return (r.regions || []).filter(x => !x.deprecated); },
    deprecatedRegions(r) { return (r.regions || []).filter(x => x.deprecated); },
    isSoldOut(r) {
      const a = this.activeRegions(r);
      return a.some(x => x.up !== null) && !a.some(x => x.up === true);
    },
    canProvision(r) { return r.createAllowed && !r.deprecated && !this.isSoldOut(r); },
    availBadgeClass(r) {
      if (r.deprecated) return 'badge-off';
      const a = this.activeRegions(r);
      if (!a.length) return 'badge-off';
      const signal = a.some(x => x.up !== null);
      const up = a.filter(x => x.up === true).length;
      const down = a.filter(x => x.up === false).length;
      if (signal && up === 0) return 'badge-danger';
      if (signal && down > 0) return 'badge-warn';
      return signal ? 'badge-ok' : 'badge-off';
    },
    availBadgeText(r) {
      if (r.deprecated) return 'deprecated';
      const a = this.activeRegions(r);
      const n = a.length;
      const dep = this.deprecatedRegions(r).length;
      const depSuffix = dep ? ' · ' + dep + ' deprecated' : '';
      if (!n) return dep ? dep + ' deprecated' : 'n/a';
      const signal = a.some(x => x.up !== null);
      const up = a.filter(x => x.up === true).length;
      const down = a.filter(x => x.up === false).length;
      const base = n + (n === 1 ? ' region' : ' regions');
      if (signal && up === 0) return 'sold out' + depSuffix;
      if (signal && down > 0) return base + ' (' + down + ' sold out)' + depSuffix;
      return base + depSuffix;
    },
    availTitle(r) {
      const regions = r.regions || [];
      if (!regions.length) return 'Provider reports no region data';
      const pick = (f) => regions.filter(f).map(x => x.code);
      const up = pick(x => !x.deprecated && x.up === true);
      const down = pick(x => !x.deprecated && x.up === false);
      const unknown = pick(x => !x.deprecated && x.up === null);
      const deprecated = pick(x => x.deprecated);
      const parts = [];
      if (up.length) parts.push('In stock: ' + up.join(', '));
      if (down.length) parts.push('Sold out: ' + down.join(', '));
      if (unknown.length) parts.push('Offered: ' + unknown.join(', '));
      if (deprecated.length) parts.push('Deprecated: ' + deprecated.join(', '));
      return parts.join(' — ');
    },
    availStatus(row) {
      const locs = row.locations || [];
      const up = locs.filter(l => l.available).length;
      if (!locs.length) return { status: 'unknown', up, total: 0 };
      if (up === 0) return { status: 'soldout', up, total: locs.length };
      if (up < locs.length) return { status: 'limited', up, total: locs.length };
      return { status: 'full', up, total: locs.length };
    },
    // Availability rows enriched with plan specs + indicative price, so the
    // sold-out list also says what each plan is (vCPU/RAM) and roughly costs.
    async loadAvailability() {
      this.beginLoad(); this.error = ''; this.availabilityRows = [];
      try {
        const [rows, plans] = await Promise.all([
          this.api('/providers/' + this.provider + '/availability'),
          this.plansFor(this.provider),
        ]);
        const byType = {};
        for (const pl of plans) byType[pl.name || pl.plan || pl.type] = pl;
        this.availabilityRows = rows.map(r => {
          const pl = byType[r.name];
          const price = this.planPrice(plans, r.name);
          return { ...r, cores: pl?.cores ?? null, memoryGb: pl?.memoryGb ?? null,
            monthly: price ? price.monthly : null };
        });
      } catch (e) { this.error = e.message; this.availabilityRows = []; }
      finally { this.endLoad(); }
    },
    openHowTo(r) {
      this.modal = { ...this.modal, open: true, type: 'guided', title: 'How to create', cta: 'Close', danger: false, dryRun: false,
        howTo: [
          r.provider + ' is monthly-billed — vops does not provision it (it would place a monthly commitment).',
          'Plan: ' + r.plan + ' · region ' + r.region + ' · from ' + this.money(r.monthly, 2) + ' ' + r.currency + '/mo',
          "To create it, order this plan in region '" + r.region + "' from the " + r.provider + ' control panel.',
        ] };
    },
    fromLabel(r) { return r?.fromMonthly == null ? 'price n/a' : 'from €' + this.money(r.fromMonthly, 2) + '/mo'; },
  };
}
