// Live host monitoring — polls the SSH status battery on an interval while the
// page is open and keeps a short in-memory rolling window per host. Nothing is
// persisted: the sparklines/uptime strip are real-time only and reset on reload.
// Gauge colour thresholds — utilisation signals go amber then red; load is
// judged per core (load1 / cores). Independent of the backend check severity.
const MON_THRESH = {
  cpu: { warn: 75, crit: 90 },
  mem: { warn: 75, crit: 90 },
  disk: { warn: 75, crit: 90 },
  load: { warn: 0.7, crit: 1 },
};
// Plain-language name + one-line explanation per check id (target audience is a
// flui user with little devops background) — surfaced as a title + hover tooltip.
const MON_HELP = {
  'ssh.reach': { title: 'SSH reachable', help: 'Whether vops could open an SSH session at all. Everything else on this page depends on it: no connection, no readings.' },
  'sys.cpu': { title: 'CPU', help: 'Share of total CPU capacity in use, measured inside the server across all cores — the same 0-100% scale as standard monitoring tools. Brief peaks are normal; what matters is a sustained high value.' },
  'sys.disk': { title: 'Disk space', help:'How full the fullest disk is. Above ~85% things start to fail — logs, updates, databases.' },
  'sys.memory': { title: 'Memory', help: 'Share of RAM in use. Constantly near 100% means the server is starved and may slow down or kill processes.' },
  'sys.load': { title: 'System load', help: 'How long the CPU run-queue is, relative to the number of cores. Above 1.0 per core, work is piling up.' },
  'sys.io': { title: 'Disk I/O', help: 'How much data the disks are reading and writing right now, measured across the status check. High sustained I/O explains a slow server even when CPU looks idle.' },
  'sys.uptime': { title: 'Uptime', help: 'Time since the last reboot. A very recent reboot is flagged in case it was not planned.' },
  'svc.failed': { title: 'Failed services', help: 'Background services (systemd units) that crashed or refuse to start.' },
  'svc.oom': { title: 'Out-of-memory kills', help: 'Whether Linux had to kill a process because it ran out of RAM.' },
  'pkg.updates': { title: 'Pending updates', help: 'Package updates waiting to be installed. Security updates are called out separately.' },
  'pkg.reboot': { title: 'Reboot needed', help: 'A recent update (often the kernel) needs a reboot to take effect.' },
  'net.listen': { title: 'Listening ports', help: 'Ports a program is listening on for any network (not just localhost), and the program behind each. Fewer is safer. "Listening" is NOT the same as "reachable" — a firewall may still block these; see the Firewall card for what\'s actually reachable vs blocked. TCP only.' },
  'sec.sshcfg': { title: 'SSH hardening', help: 'Whether SSH still allows password login. Key-only login is much safer — turning password auth off closes it for every account, root included.' },
  'sec.logins': { title: 'Failed logins', help: 'Failed SSH password attempts in the last 24h and the IPs they came from, busiest first (×count). A big number from many IPs means bots are probing. Needs systemd (any modern Linux, not just Ubuntu); a key-only server shows 0.' },
  'sec.logins.ok': { title: 'Successful logins', help: 'Successful SSH logins in the last 24h and the source IPs, busiest first (×count). vops\'s own checks add to this from your IP — an unfamiliar address is the thing to watch.' },
  'vops.footprint': { title: 'vops footprint', help: 'What vops has installed here — its automation key and any monitor/backup schedule.' },
  'cloud.power': { title: 'Power state', help: 'What the provider reports from outside the machine: running, off, and so on — seen without SSH.' },
  'cloud.cpu': { title: 'CPU (provider)', help: 'CPU usage seen by the provider hypervisor, without touching the server. Shown as a share of ONE core, so on a multi-core server it can exceed 100% — it is not the same scale as the CPU reading taken inside the server. Used only when there is no SSH access.' },
  'cloud.net': { title: 'Network throughput', help: 'Live inbound/outbound bandwidth from the provider hypervisor.' },
  'cloud.disk': { title: 'Disk throughput', help: 'Live read/write disk bandwidth from the provider hypervisor.' },
  'cloud.hung': { title: 'Possibly hung', help: 'SSH is down but the provider says the VM is running — the guest may be stuck.' },
  'agent.cpu': { title: 'CPU (agent)', help: 'CPU usage from the optional vops agent running on the host.' },
  'agent.mem': { title: 'Memory (agent)', help: 'Memory usage from the optional vops agent running on the host.' },
  'agent.disk': { title: 'Disk (agent)', help: 'Disk usage from the optional vops agent running on the host.' },
};
// How often this page re-reads the server's stored state. No SSH is involved —
// the collector does the probing in the background, whether or not anyone is
// looking — so this is one cheap local read, not a fleet-wide poll.
const MON_UI_REFRESH_MS = 20000;
const MON_RANGES = ['1h', '6h', '24h', '7d'];

function dashboardMonitoring() {
  return {
    mon: {
      live: {}, hist: {}, range: '24h', ranges: MON_RANGES,
      interval: null, visBound: false, lastAt: '', collector: null, loaded: false, info: false,
    },

    // The monitoring surface is every SSH-managed host; provider-only rows are excluded.
    monHosts() { return (this.hosts || []).filter(h => h.sshManaged !== false); },
    monReady(h) { return h?.conn?.state === 'ready' || h?.conn?.reachable === true; },
    monDotColor(h) {
      const reach = this.mon.live[h.name]?.reachable;
      if (reach === true) return 'var(--ok)';
      if (reach === false) return 'var(--danger)';
      return this.connMeta(h.conn?.state || 'unknown').color;
    },

    // Home "Fleet health" surface: only hosts actually set up — SSH ready, an
    // automation key installed, or the dead-man monitor on. Adopted-but-unconfigured
    // hosts are left to the full Monitoring page.
    monConfigured(h) { return h?.conn?.state === 'ready' || !!h?.opsKeyInstalled || !!h?.monitorHostId; },
    fleetHosts() { return this.monHosts().filter(h => this.monConfigured(h)); },

    async loadMonitoring() {
      this.monStop();
      await this.loadHosts();
      this.monBindVisibility();
      await this.monLoadFleet();
      // Details and history are separate reads, but all of them are local SQLite —
      // the whole page costs no SSH at all.
      await Promise.all(this.monHosts().flatMap(h => [this.monLoadHost(h.name), this.monLoadHistory(h.name)]));
      this.mon.interval = setInterval(() => this.monLoadFleet(), MON_UI_REFRESH_MS);
    },

    monStop() {
      if (this.mon.interval) { clearInterval(this.mon.interval); this.mon.interval = null; }
    },

    // Pause refreshing when the tab is hidden; resume on return if still on the page.
    monBindVisibility() {
      if (this.mon.visBound) return;
      this.mon.visBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { this.monStop(); return; }
        if (this.mon.interval) return;
        if (this.view === 'monitoring') {
          this.monLoadFleet();
          this.mon.interval = setInterval(() => this.monLoadFleet(), MON_UI_REFRESH_MS);
        } else if (this.view === 'host') {
          this.hostTick();
          this.mon.interval = setInterval(() => this.hostTick(), MON_UI_REFRESH_MS);
        }
      });
    },

    // One read of what the collector already stored — for the whole fleet, without
    // a single SSH connection. The old version opened one per host per tab.
    async monLoadFleet() {
      try {
        const res = await this.api('/metrics');
        this.mon.collector = res.collector;
        for (const row of (res.hosts || [])) this.monApply(row);
        this.mon.lastAt = new Date().toLocaleTimeString();
      } catch (e) {
        this.error = e.message;
      } finally {
        this.mon.loaded = true;
      }
    },

    // The findings only come with the per-host read; the fleet read is deliberately
    // light so opening the page stays one small response.
    async monLoadHost(name) {
      try {
        this.monApply(await this.api('/metrics/' + encodeURIComponent(name)));
      } catch (e) {
        const L = this.monEntry(name);
        L.error = e.message;
      }
    },

    monEntry(name) {
      this.mon.live[name] ??= { loading: false, error: '', reachable: null, latencyMs: null, findings: [], signals: [] };
      return this.mon.live[name];
    },

    /** Fold one API row into the shape every page already binds to. */
    monApply(row) {
      const L = this.monEntry(row.name);
      L.reachable = row.reachable;
      L.latencyMs = row.latencyMs;
      L.signals = row.signals || [];
      L.worst = row.worst;
      L.issues = row.issues;
      L.ageSeconds = row.ageSeconds;
      L.at = row.at ? Date.parse(row.at) : null;
      L.eligible = row.eligible;
      L.nextAt = row.nextAt ? Date.parse(row.nextAt) : null;
      L.reason = row.reason || '';
      L.loading = !!row.collecting;
      L.error = '';
      if (row.report) L.findings = row.report.findings || [];
      return L;
    },

    async monLoadHistory(name) {
      try {
        const res = await this.api('/metrics/' + encodeURIComponent(name) + '/history?range=' + this.mon.range);
        this.mon.hist[name] = res;
      } catch { /* a host with no history yet simply has no chart */ }
    },

    async monSetRange(range) {
      if (!MON_RANGES.includes(range) || range === this.mon.range) return;
      this.mon.range = range;
      await Promise.all(this.monHosts().map(h => this.monLoadHistory(h.name)));
    },

    monSeries(name, key) { return this.mon.hist[name]?.series?.[key] || []; },
    monSamples(name) { return this.mon.hist[name]?.samples ?? 0; },

    /** True while a host has been seen but has too little history to draw. */
    monCollecting(name) {
      return this.mon.loaded && this.monSamples(name) < 2;
    },

    // One bucket of the uptime strip. `null` is a real state — the collector was
    // not running — and must not look the same as "up".
    monUpColor(v) {
      if (v === null || v === undefined) return 'var(--panel-3)';
      if (v >= 0.999) return 'var(--ok)';
      return v > 0 ? 'var(--warn)' : 'var(--danger)';
    },
    monUpTitle(v) {
      if (v === null || v === undefined) return 'no checks in this window';
      if (v >= 0.999) return 'up';
      return v > 0 ? Math.round(v * 100) + '% of checks answered' : 'down';
    },

    /** Human note under a card: when it was last collected, and how often. */
    monAgeLabel(name) {
      const s = this.mon.live[name]?.ageSeconds;
      if (s == null) return 'never checked';
      if (s < 90) return 'checked just now';
      if (s < 3600) return 'checked ' + Math.round(s / 60) + ' min ago';
      return 'checked ' + Math.round(s / 3600) + 'h ago';
    },

    // Sparkline points fitted to a 100×30 viewBox (svg uses preserveAspectRatio="none").
    // Nulls are skipped rather than drawn through: a bucketed history has holes
    // where nothing was collected, and joining across one would invent a reading.
    // For a gap-free array the output is byte-identical to the pre-history version,
    // which is what keeps the bench steal-time charts working — see test/mon-spark.
    monSpark(series) {
      const a = series || [];
      const vals = a.filter(v => Number.isFinite(v));
      if (vals.length < 2) return '';
      const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
      const n = a.length;
      const pts = [];
      for (const [i, v] of a.entries()) {
        if (!Number.isFinite(v)) continue;
        const x = (i / (n - 1)) * 100;
        const y = 28 - ((v - min) / span) * 26;
        pts.push(x.toFixed(1) + ',' + y.toFixed(1));
      }
      return pts.join(' ');
    },

    monBarPct(sig) {
      if (sig.key === 'load') return Math.max(0, Math.min(100, (sig.value / (sig.cores || 1)) * 100));
      return Math.max(0, Math.min(100, sig.value));
    },

    // Gauge colour by utilisation threshold (falls back to the backend check severity).
    monColor(sig) {
      const th = MON_THRESH[sig.key];
      if (!th) return this.sevColor(sig.severity);
      const v = sig.key === 'load' ? (sig.value / (sig.cores || 1)) : sig.value;
      if (v >= th.crit) return 'var(--danger)';
      if (v >= th.warn) return 'var(--warn)';
      return 'var(--ok)';
    },

    monTitle(id) { return MON_HELP[id]?.title || id; },
    monHelp(id) { return MON_HELP[id]?.help || ''; },

    // Uptime over the selected range, computed server-side from stored checks —
    // it survives a reload, and it says how many checks it is based on.
    monUp(name) {
      return this.mon.hist[name]?.uptimePct ?? null;
    },

    // Worst check severity + how many checks want attention (for the home summary).
    // Both come from the stored snapshot, so the home card is right before any
    // findings have been fetched for the detail view.
    monWorst(name) { return this.mon.live[name]?.worst || 'ok'; },
    monIssues(name) { return this.mon.live[name]?.issues || 0; },
    monSig(name, key) { return (this.mon.live[name]?.signals || []).find(s => s.key === key) || null; },
    fleetDot(h) {
      return this.mon.live[h.name]?.at
        ? this.sevColor(this.monWorst(h.name))
        : this.connMeta(h.conn?.state || 'unknown').color;
    },

    // The home card now reads what the collector stored, so Overview contributes
    // nothing to the SSH load it used to generate one connection at a time.
    async fleetHealthLoad() {
      await this.monLoadFleet();
    },

    // An explicit "check it now": a real probe, server-side, whose result is stored
    // like any other. Everything else on this page is a read.
    async monRefresh(name) {
      const L = this.monEntry(name);
      L.loading = true;
      try {
        this.monApply(await this.api('/metrics/' + encodeURIComponent(name) + '/refresh', { method: 'POST' }));
        await this.monLoadHistory(name);
      } catch (e) {
        L.error = e.message;
      } finally {
        L.loading = false;
      }
    },

    async monRefreshAll() {
      await Promise.all(this.monHosts().filter(h => this.monReady(h)).map(h => this.monRefresh(h.name)));
    },

    // Open the dedicated host detail page from a host record.
    monManage(h) {
      this.openHost({ name: h.name, host: h, id: h.providerServerId || h.name, provider: h.provider, publicIp: h.address, external: !h.providerServerId, managed: false });
    },
  };
}
