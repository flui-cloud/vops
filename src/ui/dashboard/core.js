const ICONS = {
  overview: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1.4"/><rect x="14" y="3" width="7" height="5" rx="1.4"/><rect x="14" y="12" width="7" height="9" rx="1.4"/><rect x="3" y="16" width="7" height="5" rx="1.4"/></svg>',
  compare: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 8h13M7 8 4 5m3 3-3 3"/><path d="M17 16H4m13 0 3-3m-3 3 3 3"/></svg>',
  availability: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 12V4.5M12 12l5.3 3"/></svg>',
  servers: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="6" rx="1.6"/><rect x="3" y="14" width="18" height="6" rx="1.6"/><circle cx="7" cy="7" r=".6" fill="currentColor"/><circle cx="7" cy="17" r=".6" fill="currentColor"/></svg>',
  firewalls: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 5 6v5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3Z"/></svg>',
  vnets: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.3 3.6 8.5S14.4 18.2 12 20.5C9.6 18.2 8.4 15.2 8.4 12S9.6 5.8 12 3.5Z"/></svg>',
  sshkeys: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="12" r="4.5"/><path d="M12 12h9m-3 0v3m-3-3v2"/></svg>',
  hosts: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
  monitoring: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M3 12h3l2.5 7 5-14L18 12h3"/></svg>',
  watchers: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  backups: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="6.5" rx="8" ry="3"/><path d="M4 6.5v11c0 1.7 3.6 3 8 3s8-1.3 8-3v-11"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  catalog: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9.5h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V9.5Z"/><path d="M5 3.5h14l1.5 4a2.2 2.2 0 0 1-4.3.6 2.2 2.2 0 0 1-4.2 0 2.2 2.2 0 0 1-4.2 0 2.2 2.2 0 0 1-4.3-.6L5 3.5Z"/></svg>',
  deploy: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3c3.4 2.2 5.2 5.7 5.2 9.6L12 16.8l-5.2-4.2C6.8 8.7 8.6 5.2 12 3Z"/><circle cx="12" cy="10" r="1.7"/><path d="m9.2 17.2-1.7 3.3 3-1.1M14.8 17.2l1.7 3.3-3-1.1"/></svg>',
};

function dashboardCore() {
  return {
    token: new URLSearchParams(location.search).get('session') || '',
    theme: 'light',
    view: 'overview',
    hvFrom: 'servers',
    provider: 'hetzner',
    providerIds: ['hetzner', 'scaleway', 'contabo', 'ovh'],
    // Comparison-only providers: shown in the compare filter + region map but never
    // provisioned (Cherry is read-only in infra), so kept out of the server/provision tabs.
    compareProviderIds: ['hetzner', 'scaleway', 'contabo', 'ovh', 'cherry'],
    loading: false,
    loads: 0,
    error: '',
    comparedOnce: false,
    syncedLabel: 'just now',
    nav: [
      { section: 'FLEET', items: [
        { id: 'overview', label: 'Overview', icon: ICONS.overview },
        { id: 'monitoring', label: 'Monitoring', icon: ICONS.monitoring, pill: true },
        { id: 'watchers', label: 'Watchers', icon: ICONS.watchers },
        { id: 'servers', label: 'Servers', icon: ICONS.servers, pill: true },
        { id: 'backups', label: 'Backups', icon: ICONS.backups, soon: true },
      ] },
      { section: 'DEPLOY', items: [
        { id: 'catalog', label: 'App Catalog', icon: ICONS.catalog, soon: true },
        { id: 'deploy', label: 'Deploy App', icon: ICONS.deploy, soon: true },
      ] },
      { section: 'MARKET', items: [
        { id: 'compare', label: 'Compare', icon: ICONS.compare },
        { id: 'availability', label: 'Availability', icon: ICONS.availability },
      ] },
      { section: 'NETWORK', items: [
        { id: 'firewalls', label: 'Firewalls', icon: ICONS.firewalls },
        { id: 'vnets', label: 'Networks', icon: ICONS.vnets },
        { id: 'sshkeys', label: 'SSH Keys', icon: ICONS.sshkeys, pill: true },
      ] },
    ],
    providers: [], servers: [], firewalls: [], vnets: [], sshKeys: [], compareRows: [], availabilityRows: [],
    ov: { serverCount: null, byProvider: [], spend: null, alerts: null, cheapest: null, bestValue: [], bvLoaded: false },
    geo: { width: 1000, height: 700, countries: [], pins: [], views: {} },
    mapView: { x: 0, y: 0, w: 1000, h: 700 }, mapZone: 'world', mapDrag: null,
    mapZones: [
      { id: 'world', label: 'World' }, { id: 'europe', label: 'Europe' },
      { id: 'namerica', label: 'N. America' }, { id: 'asia', label: 'Asia-Pacific' },
    ],
    regions: [], regionsSource: '', regionsUpdated: '', hoverCode: '',
    allPlans: [], serverTab: 'all', plansCache: {}, watched: [],
    providerColors: { hetzner: 'var(--hetzner)', scaleway: 'var(--scaleway)', contabo: 'var(--contabo)', ovh: 'var(--ovh)', cherry: 'var(--cherry)' },
    cmp: { cpu: '', ramGb: '', region: '', provider: '', hourlyOnly: false },
    showDeprecated: false,
    drawer: { open: false, kind: '', item: null, rulesJson: '', serverIds: '', subnetRange: '', subnetZone: '' },
    modal: { open: false, type: '', title: '', cta: '', danger: false, dryRun: false, readonly: false, message: '', plan: null, fw: { name: '', rules: '[]', apply: '' }, vn: { name: '', ipRange: '', zone: '', subnetRange: '' }, sk: { name: '', mode: 'create', publicKey: '', from: '' }, reg: { name: '', provider: 'hetzner' }, conn: { server: null, user: 'root', key: '', command: '', keys: [] }, hs: { mode: 'add', name: '', address: '', user: 'root', port: 22, key: '', tags: '', provider: 'ovh', server: '' }, report: { findings: [] }, ctx: null },
    toast: { show: false, msg: '', kind: 'ok' },
    ask: { open: false, action: '', name: '', title: '', message: '', cta: '', danger: false },

    get showsProvider() { return ['availability', 'vnets'].includes(this.view); },
    get serverTabs() { return ['all', ...this.providerIds]; },
    get pageTitle() {
      const m = { overview: 'Overview', monitoring: 'Monitoring', watchers: 'Watchers', compare: 'Compare', servers: 'Servers', availability: 'Availability',
        firewalls: 'Firewalls', vnets: 'Networks', sshkeys: 'SSH Keys' };
      return m[this.view] || '';
    },
    get subtitle() {
      const m = { overview: 'Your fleet at a glance — servers, spend and live regions across every provider.',
        monitoring: 'Live health of your fleet — connection, resource metrics and status checks, refreshed over SSH.',
        watchers: 'Every remote alert on your vops-landing account — availability watches, uptime probes and host monitors.',
        compare: 'Real-time plan comparison across every provider.',
        servers: 'Your fleet — provision, monitor and manage every server in one place.',
        availability: 'Plans with limited or sold-out capacity, per location.',
        firewalls: 'Firewall per server — provider-native or vops nftables, one simple view.',
        vnets: 'Private networks, subnets and routes.',
        sshkeys: 'Local SSH keys — private keys never leave this machine.' };
      return m[this.view] || '';
    },
    get primaryAction() {
      return ({ servers: '+ New server', vnets: '+ New network', sshkeys: '+ Generate key', hosts: '+ Add host' })[this.view] || '';
    },
    runPrimary() {
      if (this.view === 'servers') return this.go('compare');
      if (this.view === 'vnets') return this.openVnetForm();
      if (this.view === 'sshkeys') return this.openKeyForm();
    },
    countFor(id) {
      if (id === 'servers') return this.ov.serverCount;
      if (id === 'sshkeys') return this.sshKeys.length || (this.sshKeysLoaded ? 0 : null);
      if (id === 'monitoring' || id === 'hosts') return this.hosts.length || (this.hostsLoaded ? 0 : null);
      return null;
    },
    get availGroups() {
      const rows = (this.availabilityRows || []).map(r => ({ ...r, s: this.availStatus(r) }));
      const rank = { soldout: 0, limited: 1, unknown: 2, full: 3 };
      const limited = rows.filter(r => r.s.status === 'soldout' || r.s.status === 'limited')
        .sort((a, b) => rank[a.s.status] - rank[b.s.status]);
      return { limited, full: rows.filter(r => r.s.status === 'full'), total: rows.length };
    },
    get countriesSvg() {
      return (this.geo.countries || [])
        .map(c => '<path d="' + c.d + '" class="' + (c.eu ? 'em-country em-country--eu' : 'em-country') + '"/>')
        .join('');
    },
    get pinsSvg() {
      const r = +(5.5 * this.mapView.w / this.geo.width).toFixed(2);
      return (this.geo.pins || []).map(p => {
        const x = (p.xPct / 100) * this.geo.width;
        const y = (p.yPct / 100) * this.geo.height;
        const col = this.pinColor(p.provider);
        return '<g class="map-pin-svg" data-code="' + p.code + '">' +
          '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + col + '" class="pin-pulse-svg"/>' +
          '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + col + '" stroke="var(--map-bg)" vector-effect="non-scaling-stroke" stroke-width="1.6"/>' +
          '</g>';
      }).join('');
    },
    get mapViewBox() { const v = this.mapView; return v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h; },

    async init() {
      this.applyTheme(this.readTheme());
      this.watched = this.loadWatched();
      try {
        const r = await fetch('/world.geo.json');
        if (r.ok) this.geo = await r.json();
      } catch { /* map is decorative — ignore fetch errors */ }
      this.jumpTo(this.geo.views?.europe ? 'europe' : 'world');
      await this.loadOverview();
    },

    // Local marker of plans you've set an alert for, for the "N watching" badge.
    // Delivery itself lives on vops-landing (Web Push / ntfy) — see openNotify;
    // this is only optimistic UI state on this machine.
    loadWatched() {
      try { return JSON.parse(localStorage.getItem('vops-watched') || '[]'); } catch { return []; }
    },
    watchKey(plan) { return this.provider + ':' + plan; },
    isWatched(plan) { return this.watched.includes(this.watchKey(plan)); },
    watchCount() { return this.watched.length; },
    markWatched(plan) {
      const key = this.watchKey(plan);
      if (!this.watched.includes(key)) {
        this.watched.push(key);
        try { localStorage.setItem('vops-watched', JSON.stringify(this.watched)); } catch { /* private mode */ }
      }
    },

    readTheme() {
      try { return localStorage.getItem('vops-theme') || 'light'; } catch { return 'light'; }
    },
    applyTheme(t) {
      this.theme = t;
      try { document.documentElement.dataset.theme = t; } catch { /* SSR */ }
    },
    setTheme(t) {
      this.applyTheme(t);
      try { localStorage.setItem('vops-theme', t); } catch { /* private mode */ }
    },

    go(v) { this.view = v; this.error = ''; if (this.$refs.main) { this.$refs.main.scrollTop = 0; } this.reload(); },
    setProvider(p) { this.provider = p; this.reload(); },

    async reload() {
      if (this.view !== 'monitoring' && this.view !== 'host') this.monStop();
      if (this.view === 'overview') return this.loadOverview();
      if (this.view === 'monitoring') return this.loadMonitoring();
      if (this.view === 'watchers') return this.loadWatchers();
      if (this.view === 'host') return this.loadHostView();
      if (this.view === 'compare') return this.runCompare();
      if (this.view === 'servers') { this.plansCache = {}; this.loadHosts(); return this.loadServers(); }
      if (this.view === 'availability') { this.plansCache = {}; return this.loadAvailability(); }
      if (this.view === 'firewalls') return this.loadHosts();
      if (this.view === 'vnets') return this.load('vnets', '/vnets?provider=' + this.provider);
      if (this.view === 'sshkeys') return this.load('sshKeys', '/ssh-keys');
    },

    async api(path, opts = {}) {
      opts.headers = { 'x-vops-session': this.token, 'content-type': 'application/json', ...opts.headers };
      const r = await fetch('/api' + path, opts);
      const text = await r.text();
      if (!r.ok) throw new Error(this.extract(text) || ('HTTP ' + r.status));
      return text ? JSON.parse(text) : null;
    },
    extract(text) { try { return JSON.parse(text).message; } catch { return text; } },

    // Views fire several loads at once (a view's own data + /hosts). Count them
    // so the fastest one finishing doesn't clear the skeleton while a slower one
    // is still fetching.
    beginLoad() { this.loads++; this.loading = true; },
    endLoad() { this.loads = Math.max(0, this.loads - 1); this.loading = this.loads > 0; },

    async load(key, path) {
      this.beginLoad(); this.error = ''; this[key] = [];
      try { this[key] = await this.api(path); }
      catch (e) { this.error = e.message; this[key] = []; }
      finally { this.endLoad(); }
    },

    csv(s) { const a = (s || '').split(',').map(x => x.trim()).filter(Boolean); return a.length ? a : undefined; },
    num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : undefined; },
    money(n, d = 4) { return (n === null || n === undefined) ? 'n/a' : Number(n).toFixed(d); },
    statusBadge(s) { return ({ running: 'badge-ok', failed: 'badge-warn' })[String(s).toLowerCase()] || 'badge-off'; },
    notify(msg, kind = 'ok') {
      this.toast = { show: true, msg, kind };
      setTimeout(() => { this.toast.show = false; }, 3200);
    },
  };
}
