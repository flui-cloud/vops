/* Duotone icon set — see design/vops-ds/icons.html for the rationale per mark.
 * Body strokes inherit currentColor; each icon carries exactly ONE accent shape,
 * `.a` (filled) or `.as` (stroked), which resolves through --icon-accent. Four of
 * them (servers/hosts/monitoring/deploy) share one outer slab on purpose: same
 * object, different question. */
const ICON_ART = {
  // A world map of the fleet. Accent: a region you hold.
  overview: '<circle cx="12" cy="12" r="9"/><path d="M3.5 9.2h17M3.5 14.8h17M12 3a15.5 15.5 0 0 0 0 18 15.5 15.5 0 0 0 0-18Z"/><circle cx="15.9" cy="7.9" r="2.2" class="a"/>',
  // Slab + a trace read live over SSH. Accent: the endpoint, i.e. now.
  monitoring: '<rect x="2.9" y="4.6" width="18.2" height="14.8" rx="2.8"/><path d="M6.1 13.4h2.4l1.7 3.2 2.5-6.6 1.7 3.4h3.5"/><circle cx="17.9" cy="13.4" r="1.9" class="a"/>',
  // An empty slot and a signal out, waiting for stock to return. Accent: the ping.
  watchers: '<rect x="2.9" y="8.7" width="6.6" height="6.6" rx="1.7"/><path d="M13.1 8.2a5.3 5.3 0 0 1 0 7.6" class="as"/><path d="M16.8 5.3a10 10 0 0 1 0 13.4" class="as"/>',
  // Rack units. Accent: the LEDs — the only part that says it is alive.
  servers: '<rect x="3" y="4" width="18" height="6.5" rx="2"/><rect x="3" y="13.5" width="18" height="6.5" rx="2"/><path d="M13.4 7.25h4.2M13.4 16.75h4.2"/><circle cx="7" cy="7.25" r="1.6" class="a"/><circle cx="7" cy="16.75" r="1.6" class="a"/>',
  // Snapshots offset in time, newest in front. Accent: the newest.
  backups: '<rect x="3" y="3.2" width="13.6" height="13.6" rx="2.2"/><path d="M7.4 20.8h11.2a2.2 2.2 0 0 0 2.2-2.2V7.4"/><rect x="6.6" y="6.8" width="6.4" height="6.4" rx="1.6" class="a"/>',
  // A Quadlet pod of containers. Accent: the primary component.
  deploy: '<rect x="2.9" y="4.6" width="18.2" height="14.8" rx="2.8"/><rect x="12.7" y="8.1" width="5.4" height="7.8" rx="1.6"/><rect x="5.9" y="8.1" width="5.4" height="7.8" rx="1.6" class="a"/>',
  // Prices ranked against one axis. Accent: the cheapest bar.
  compare: '<path d="M3.6 4.4v15.2"/><rect x="6.2" y="5.6" width="13.6" height="3.6" rx="1.8"/><rect x="6.2" y="10.2" width="9.4" height="3.6" rx="1.8"/><rect x="6.2" y="14.8" width="5.4" height="3.6" rx="1.8" class="a"/>',
  // A capacity reading, not a clock. Accent: the portion still in stock.
  availability: '<path d="M3.4 17.8a8.8 8.8 0 1 1 17.2 0"/><path d="m12 17.8 4.6-6.4"/><path d="M3.4 17.8a8.8 8.8 0 0 1 3.4-6.9" class="as"/>',
  // An allow-list is defined by its opening. Accent: the port you opened.
  firewalls: '<rect x="3" y="4.8" width="18" height="14.4" rx="2.4"/><path d="M3 9.6h18M3 14.4h18"/><path d="M9.6 4.8v4.8M14.4 4.8v4.8M6.8 14.4v4.8M17.2 14.4v4.8"/><rect x="8.9" y="9.6" width="6.2" height="4.8" class="a"/>',
  // A private subnet with instances attached. Accent: the subnet.
  vnets: '<circle cx="6.4" cy="5.9" r="2.6"/><circle cx="17.6" cy="5.9" r="2.6"/><circle cx="12" cy="18.1" r="2.6"/><path d="M6.4 8.5v2.4M17.6 8.5v2.4M12 15.5v-2.4"/><rect x="3" y="10.9" width="18" height="2.2" rx="1.1" class="a"/>',
  // Accent: the bow — the half you hold is the private one.
  sshkeys: '<path d="M12.4 12H21m-3.3 0v3.2m-3.2-3.2v2.2"/><circle cx="8" cy="12" r="3.3" class="as" stroke-width="3"/>',
  // A scoped session that ran because it was approved. Accent: the approval.
  agents: '<rect x="3" y="4.6" width="18" height="14.8" rx="2.8"/><path d="M3 9.1h18"/><path d="m8.6 13.1 2.5 2.5 4.5-5" class="as"/>',
  // Remote accounts collected into one local store. Accent: the store — it is yours.
  providers: '<circle cx="6" cy="5.6" r="2.7"/><circle cx="18" cy="5.6" r="2.7"/><path d="M6 8.3v2.5a2.4 2.4 0 0 0 2.4 2.4h7.2a2.4 2.4 0 0 0 2.4-2.4V8.3M12 13.2v2.2"/><rect x="8.9" y="15.4" width="6.2" height="5.2" rx="1.9" class="a"/>',
  // A machine you hold a shell on. Accent: the prompt — the vops mark itself.
  hosts: '<rect x="2.9" y="4.6" width="18.2" height="14.8" rx="2.8"/><path d="M13.2 15.4h4.4"/><path d="m7.1 9.6 3.1 2.9-3.1 2.9" class="as"/>',
  // This machine, and what vops has put on it. Accent: the part that keeps running.
  settings: '<rect x="2.9" y="4.6" width="18.2" height="12.4" rx="2.4"/><path d="M8 20.4h8M12 17v3.4"/><circle cx="12" cy="10.8" r="2.4" class="a"/>',
  // This machine reachable from a phone you hold. Accent: the paired device.
  remote: '<rect x="2.6" y="4.8" width="12.4" height="9.6" rx="2.4"/><path d="M6 17.6h5.6M8.8 14.4v3.2"/><rect x="16.4" y="7.6" width="5" height="12.8" rx="1.9" class="a"/>',
  // A shelf of manifests ready to install. Accent: the one you are picking.
  catalog: '<rect x="3.2" y="3.4" width="7.5" height="7.5" rx="1.9"/><rect x="13.3" y="3.4" width="7.5" height="7.5" rx="1.9"/><rect x="13.3" y="13.1" width="7.5" height="7.5" rx="1.9"/><rect x="3.2" y="13.1" width="7.5" height="7.5" rx="1.9" class="a"/>',
};

const ICONS = Object.fromEntries(
  Object.entries(ICON_ART).map(([name, art]) => [
    name,
    `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${art}</svg>`,
  ]),
);

function dashboardCore() {
  return {
    token: new URLSearchParams(location.search).get('session') || '',
    theme: 'light',
    view: 'overview',
    hvFrom: 'servers',
    provider: 'hetzner',
    providerIds: ['hetzner', 'scaleway', 'contabo', 'ovh', 'cherry'],
    // Compare filter + region map. A comparison-only provider (catalog but no
    // provisioning) would live here without joining providerIds; today they coincide.
    compareProviderIds: ['hetzner', 'scaleway', 'contabo', 'ovh', 'cherry'],
    loading: false,
    loads: 0,
    error: '',
    offline: false,
    // Set when the server is going away because we asked it to — the reconnect
    // screen then explains instead of implying something broke.
    offlineExpected: false,
    pwa: false, svc: null, svcHintDismissed: false,
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
        { id: 'apps', label: 'Apps', icon: ICONS.deploy, pill: true },
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
      { section: 'SETTINGS', items: [
        { id: 'agents', label: 'Agents', icon: ICONS.agents, pill: true },
        { id: 'remote', label: 'Remote access', icon: ICONS.remote, pill: true },
        { id: 'providers', label: 'Providers', icon: ICONS.providers },
        { id: 'settings', label: 'This computer', icon: ICONS.settings },
      ] },
    ],
    navFade: { top: 0, bottom: 0 },
    providers: [], servers: [], firewalls: [], vnets: [], sshKeys: [], compareRows: [], availabilityRows: [],
    ov: { serverCount: null, byProvider: [], spend: null, alerts: null, cheapest: null, bestValue: [], bvLoaded: false },
    geo: { width: 1000, height: 700, countries: [], pins: [], views: {} },
    mapView: { x: 0, y: 0, w: 1000, h: 700 }, mapZone: 'world', mapDrag: null,
    mapZones: [
      { id: 'world', label: 'World' }, { id: 'europe', label: 'Europe' },
      { id: 'namerica', label: 'N. America' }, { id: 'asia', label: 'Asia-Pacific' },
    ],
    regions: [], regionsSource: '', regionsUpdated: '', hoverCode: '',
    allPlans: [], serverTab: 'all', plansCache: {}, watched: [], serversReady: false,
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
        firewalls: 'Firewalls', vnets: 'Networks', sshkeys: 'SSH Keys', apps: 'Apps', agents: 'Agents', remote: 'Remote access',
        providers: 'Providers', settings: 'This computer' };
      return m[this.view] || '';
    },
    get subtitle() {
      const m = { overview: 'Your fleet at a glance — servers, spend and live regions across every provider.',
        monitoring: 'Health of your fleet — checked over SSH in the background, with 7 days of history kept on this machine.',
        watchers: 'Every remote alert on your vops-landing account — availability watches, uptime probes and host monitors.',
        compare: 'Real-time plan comparison across every provider.',
        servers: 'Your fleet — provision, monitor and manage every server in one place.',
        availability: 'Plans with limited or sold-out capacity, per location.',
        firewalls: 'Firewall per server — provider-native or vops nftables, one simple view.',
        vnets: 'Private networks, subnets and routes.',
        sshkeys: 'Local SSH keys — private keys never leave this machine.',
        settings: 'What vops has installed on this computer — the always-on service, your vault, and how to remove any of it.',
        apps: 'Deploy flui.yaml apps to your hosts over SSH — rootful Podman + Quadlet, no agent installed.',
        agents: 'Short-lived coding-agent sessions, approvals, operations and audit — controlled locally.',
        remote: 'Use vops from your phone — pair a device here, then check your fleet and approve actions while you are away.',
        providers: 'Connect your provider accounts — keys are stored encrypted on this machine and never leave it.' };
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
    /** Fade the nav's clipped edge only where content actually continues, so a
     * list that fits shows no gradient at all. */
    navScrollState(el) {
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      this.navFade = {
        top: el.scrollTop > 2 ? 14 : 0,
        bottom: max > 2 && el.scrollTop < max - 2 ? 18 : 0,
      };
    },
    countFor(id) {
      if (id === 'servers') return this.ov.serverCount;
      if (id === 'sshkeys') return this.sshKeys.length || (this.sshKeysLoaded ? 0 : null);
      if (id === 'monitoring' || id === 'hosts') return this.hosts.length || (this.hostsLoaded ? 0 : null);
      if (id === 'apps') return this.apps.installs.length || (this.apps.loaded ? 0 : null);
      if (id === 'agents') return this.activeAgentSessions().length;
      if (id === 'remote') return this.remote.loaded ? this.remoteDevices().length : null;
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
      this.heartbeat();
      this.pwaInit();
      this.vaultInit();
      this.applyTheme(this.readTheme());
      this.watched = this.loadWatched();
      try {
        const r = await fetch('/world.geo.json');
        if (r.ok) this.geo = await r.json();
      } catch { /* map is decorative — ignore fetch errors */ }
      this.jumpTo(this.geo.views?.europe ? 'europe' : 'world');
      this.initRouting();
      await this.reload();
    },

    // Sync `view` with the URL hash so a deep link (or a refresh) lands on the
    // same section instead of snapping back to Overview. `go()` writes the hash;
    // the `hashchange` guard is a no-op when go() already moved us (h === view).
    initRouting() {
      const ids = new Set(this.nav.flatMap((s) => s.items).filter((i) => !i.soon).map((i) => i.id));
      const h = (location.hash || '').replace(/^#/, '');
      if (ids.has(h)) this.view = h;
      addEventListener('hashchange', () => {
        const next = (location.hash || '').replace(/^#/, '');
        if (ids.has(next) && next !== this.view) { this.view = next; this.error = ''; this.reload(); }
      });
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

    go(v) { this.view = v; this.error = ''; try { location.hash = v; } catch { /* file:// */ } if (this.$refs.main) { this.$refs.main.scrollTop = 0; } this.reload(); },
    setProvider(p) { this.provider = p; this.reload(); },

    async reload() {
      if (this.view !== 'agents') clearTimeout(this._agentTimer);
      if (this.view !== 'remote') this.remoteStop();
      if (this.view !== 'monitoring' && this.view !== 'host') this.monStop();
      return ({
        overview: () => this.loadOverview(),
        monitoring: () => this.loadMonitoring(),
        watchers: () => this.loadWatchers(),
        host: () => this.loadHostView(),
        compare: () => this.runCompare(),
        servers: () => { this.plansCache = {}; this.loadHosts(); return this.loadServers(); },
        availability: () => { this.plansCache = {}; return this.loadAvailability(); },
        firewalls: () => this.loadHosts(),
        vnets: () => this.load('vnets', '/vnets?provider=' + this.provider),
        sshkeys: () => this.load('sshKeys', '/ssh-keys'),
        apps: () => this.loadApps(),
        agents: () => this.loadAgentControl(),
        remote: () => this.loadRemote(),
        providers: () => this.loadCredentials(),
        settings: () => this.loadSettings(),
      })[this.view]?.();
    },

    async api(path, opts = {}) {
      opts.headers = { 'x-vops-session': this.token, 'content-type': 'application/json', ...opts.headers };
      let r;
      try {
        r = await fetch('/api' + path, opts);
      } catch (e) {
        this.offline = true; // server unreachable — the reconnect overlay takes over
        throw e;
      }
      const text = await r.text();
      if (!r.ok) {
        // Carry the status and the parsed body: callers that only read `.message`
        // are unaffected, but a 423 (sealed vault) or a 429 (unlock backoff) can
        // now be told apart from a generic failure.
        const err = new Error(this.extract(text) || ('HTTP ' + r.status));
        err.status = r.status;
        try { err.body = JSON.parse(text); } catch { /* not JSON */ }
        if (r.status === 423) this.vaultLocked();
        throw err;
      }
      return text ? JSON.parse(text) : null;
    },

    // Two independent "installs" exist: the browser PWA and the background service
    // (`vops service install`). A PWA with no service opens onto a dead server, so once installed we nudge the user to finish setup (the browser can't run the command itself).
    pwaInit() {
      try {
        this.pwa = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
        this.svcHintDismissed = localStorage.getItem('vops-svc-hint') === '1';
      } catch { /* private mode / older engine */ }
      addEventListener('appinstalled', () => { this.pwa = true; this.svcHintDismissed = false; this.loadService(); });
      if (this.pwa) this.loadService();
    },
    async loadService() {
      try { this.svc = await this.api('/ui-service'); } catch { /* server may be down */ }
    },
    needsService() { return this.pwa && !!this.svc && this.svc.supported && !this.svc.installed && !this.svcHintDismissed; },
    dismissServiceHint() {
      this.svcHintDismissed = true;
      try { localStorage.setItem('vops-svc-hint', '1'); } catch { /* private mode */ }
    },

    // The dashboard is useless without the local API. When `vops ui` is stopped,
    // show a reconnect screen and keep polling — the moment the server returns we
    // reload, so the installed PWA springs back to life with no manual step.
    heartbeat() {
      // /healthz, not HEAD / — the latter re-renders the whole inlined dashboard
      // document server-side every 6s just to throw it away.
      fetch('/healthz', { cache: 'no-store' })
        .then((r) => {
          if (this.offline && r.ok) { location.reload(); return; }
          this.offline = !r.ok;
        })
        .catch(() => { this.offline = true; })
        .finally(() => setTimeout(() => this.heartbeat(), this.offline ? 2000 : 6000));
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
