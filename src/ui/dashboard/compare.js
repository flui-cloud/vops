// Compare view: the 3-tier split (Shared / Dedicated vCPU / Bare metal), a
// geographic Region filter (continent → country, matched against a plan's full
// region coverage), and honest billing — mirrors vops-landing's Comparator so the
// two surfaces read the same even though this one is Alpine + a REST table.

// code → geographic area. Every code resolves to a continent (always) and a
// country (except opaque multi-country buckets like Contabo's `eu`, kept
// continent-only so they never masquerade as one country). Superset of the live
// region codes; an unmapped code lands under "Other".
const CMP_CONTINENT_LABEL = { europe: 'Europe', namerica: 'North America', apac: 'Asia-Pacific', other: 'Other' };
const CMP_CONTINENT_ORDER = ['europe', 'namerica', 'apac', 'other'];
const CMP_REGION_AREA = {
  // Europe
  fsn1: { continent: 'europe', country: 'Germany' }, nbg1: { continent: 'europe', country: 'Germany' },
  de: { continent: 'europe', country: 'Germany' }, 'de-frankfurt': { continent: 'europe', country: 'Germany' },
  'fr-par': { continent: 'europe', country: 'France' }, 'fr-par-1': { continent: 'europe', country: 'France' },
  'fr-par-2': { continent: 'europe', country: 'France' }, gra: { continent: 'europe', country: 'France' },
  rbx: { continent: 'europe', country: 'France' }, sbg: { continent: 'europe', country: 'France' },
  'nl-ams': { continent: 'europe', country: 'Netherlands' }, 'nl-amsterdam': { continent: 'europe', country: 'Netherlands' },
  hel1: { continent: 'europe', country: 'Finland' }, uk: { continent: 'europe', country: 'United Kingdom' },
  'pl-waw': { continent: 'europe', country: 'Poland' }, waw: { continent: 'europe', country: 'Poland' },
  'lt-siauliai': { continent: 'europe', country: 'Lithuania' }, 'se-stockholm': { continent: 'europe', country: 'Sweden' },
  eu: { continent: 'europe' }, // Contabo's single opaque EU bucket — continent only
  // North America
  ash: { continent: 'namerica', country: 'United States' }, hil: { continent: 'namerica', country: 'United States' },
  'us-c': { continent: 'namerica', country: 'United States' }, 'us-central': { continent: 'namerica', country: 'United States' },
  'us-east': { continent: 'namerica', country: 'United States' }, 'us-west': { continent: 'namerica', country: 'United States' },
  'us-chicago': { continent: 'namerica', country: 'United States' }, bhs: { continent: 'namerica', country: 'Canada' },
  // Asia-Pacific
  'sg-singapore': { continent: 'apac', country: 'Singapore' }, sgp: { continent: 'apac', country: 'Singapore' },
  sin: { continent: 'apac', country: 'Singapore' }, 'jp-tokyo': { continent: 'apac', country: 'Japan' },
  jpn: { continent: 'apac', country: 'Japan' }, ind: { continent: 'apac', country: 'India' },
  aus: { continent: 'apac', country: 'Australia' }, syd: { continent: 'apac', country: 'Australia' },
};
const CMP_HOURS_PER_MONTH = 730;

function dashboardCompare() {
  return {
    cmpTab: 'shared',
    cmpBilling: 'monthly',
    cmpTabs: [
      { id: 'shared', label: 'Shared' },
      { id: 'dedicated', label: 'Dedicated vCPU' },
      { id: 'metal', label: 'Bare metal' },
    ],

    // Bare metal reads cpuType='dedicated' too, so test bareMetal FIRST.
    tierOf(r) {
      if (r.bareMetal) return 'metal';
      return r.cpuType === 'dedicated' ? 'dedicated' : 'shared';
    },
    setCmpTab(t) { this.cmpTab = t; if (!this.cmpAreaValid()) this.cmp.region = ''; },
    setCmpBilling(b) { this.cmpBilling = b; if (!this.cmpAreaValid()) this.cmp.region = ''; },

    cmpAreaOf(code) { return CMP_REGION_AREA[String(code).toLowerCase()] || { continent: 'other' }; },
    // Does any region this plan serves fall in the selected place? token is
    // '' (anywhere), 'cont:<continent>' or 'ctry:<country>'. Matches the plan's
    // FULL coverage (regions[]), so a place filter never hides a plan offered there.
    cmpMatchesArea(r, token) {
      if (!token) return true;
      const i = token.indexOf(':');
      const kind = token.slice(0, i), key = token.slice(i + 1);
      return (r.regions || []).some((rg) => {
        const a = this.cmpAreaOf(rg.code);
        return kind === 'cont' ? a.continent === key : a.country === key;
      });
    },

    hourlyMonthly(r) { return r.hourly == null ? null : r.hourly * CMP_HOURS_PER_MONTH; },
    monthlyView(r) { return r.monthly == null ? this.hourlyMonthly(r) : r.monthly; },
    // A committed monthly sits well under pay-as-you-go (big commitment discount).
    isCommitted(r) {
      const pg = this.hourlyMonthly(r);
      return pg != null && r.monthly != null && r.monthly < pg * 0.7;
    },
    // Monthly cell: real committed monthly, else the pay-as-you-go 24/7 estimate
    // for an hourly-only plan (honest — a month of an hourly machine is buyable),
    // else n/a. Never fabricates a monthly for a plan with neither.
    cmpMonthlyText(r) {
      if (r.monthly != null) return this.money(r.monthly, 2);
      const pg = this.hourlyMonthly(r);
      return pg == null ? 'n/a' : '~' + this.money(pg, 2);
    },

    // Rows after tier + billing-availability, before the region filter — feeds the
    // Region dropdown so it only offers places that exist for the current tab.
    // Methods, not getters: this factory is an Object.assign source, and a getter
    // there is invoked (and flattened to a frozen value) at composition time.
    cmpBase() {
      return (this.compareRows || []).filter((r) =>
        this.tierOf(r) === this.cmpTab &&
        (this.cmpBilling === 'monthly' || r.hourly != null),
      );
    },
    filteredCompareRows() {
      const rows = this.cmpBase().filter((r) => this.cmpMatchesArea(r, this.cmp.region));
      const key = this.cmpBilling === 'monthly'
        ? (r) => this.monthlyView(r) ?? Infinity
        : (r) => (r.hourly == null ? Infinity : r.hourly);
      return [...rows].sort((a, b) => key(a) - key(b));
    },
    // Continent → countries present in the current set (a plan counts under every
    // place it serves, so shared cities across providers collapse to one entry).
    cmpRegionGroups() {
      const byCont = {}, present = new Set();
      for (const r of this.cmpBase())
        for (const rg of (r.regions || [])) {
          const a = this.cmpAreaOf(rg.code);
          present.add(a.continent);
          if (a.country) {
            byCont[a.continent] ??= new Set();
            byCont[a.continent].add(a.country);
          }
        }
      return CMP_CONTINENT_ORDER.filter((c) => present.has(c)).map((c) => ({
        continent: c,
        label: CMP_CONTINENT_LABEL[c],
        countries: [...(byCont[c] || [])].sort((x, y) => x.localeCompare(y)),
      }));
    },
    cmpAreaValid() {
      const t = this.cmp.region;
      if (!t) return true;
      return this.cmpRegionGroups().some((g) => t === 'cont:' + g.continent || g.countries.some((c) => t === 'ctry:' + c));
    },
    cmpDisk(r) {
      const g = r.diskGb;
      if (!g) return '—';
      if (g < 1000) return g + 'G';
      return (g / 1000).toFixed(g % 1000 ? 1 : 0) + 'T';
    },
    cmpTierCaption() {
      if (this.cmpTab === 'dedicated') return 'Dedicated vCPU — reserved physical cores with no noisy neighbours, but still a virtual machine (Hetzner ccx, OVH c3, Contabo Cloud VDS, Cherry VDS).';
      if (this.cmpTab === 'metal') return 'Bare metal — a whole physical server, no hypervisor. On-demand from Scaleway and Cherry.';
      return '';
    },
  };
}
