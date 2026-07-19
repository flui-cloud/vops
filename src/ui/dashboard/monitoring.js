// Live host monitoring — polls the SSH status battery on an interval while the
// page is open and keeps a short in-memory rolling window per host. Nothing is
// persisted: the sparklines/uptime strip are real-time only and reset on reload.
const MON_SIGNALS = [
  // Guest-measured CPU first: it is normalised 0-100 across cores. cloud.cpu is a
  // last resort — the hypervisor scale is not per-machine and is not comparable.
  { key: 'cpu', label: 'CPU', ids: ['sys.cpu', 'agent.cpu', 'cloud.cpu'], pct: true },
  { key: 'mem', label: 'Mem used', ids: ['sys.memory', 'agent.mem'], pct: true, invert: true },
  { key: 'disk', label: 'Disk used', ids: ['sys.disk', 'agent.disk'], pct: true },
  { key: 'load', label: 'Load', ids: ['sys.load'], pct: false },
  { key: 'io', label: 'Disk I/O', ids: ['sys.io'], pct: false, unit: 'MB/s' },
];
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
const MON_CAP = 48;          // rolling points kept per series
const MON_INTERVAL = 30000;  // ms between polls (each poll is a ~5s SSH battery)

function dashboardMonitoring() {
  return {
    mon: { live: {}, series: {}, interval: null, visBound: false, lastAt: '' },

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
      await this.monPollAll();
      this.mon.interval = setInterval(() => this.monPollAll(), MON_INTERVAL);
    },

    monStop() {
      if (this.mon.interval) { clearInterval(this.mon.interval); this.mon.interval = null; }
    },

    // Pause polling when the tab is hidden; resume on return if still on the page.
    monBindVisibility() {
      if (this.mon.visBound) return;
      this.mon.visBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { this.monStop(); return; }
        if (this.mon.interval) return;
        if (this.view === 'monitoring') {
          this.monPollAll();
          this.mon.interval = setInterval(() => this.monPollAll(), MON_INTERVAL);
        } else if (this.view === 'host') {
          this.hostTick();
          this.mon.interval = setInterval(() => this.hostTick(), MON_INTERVAL);
        }
      });
    },

    async monPollAll() {
      if (this.view !== 'monitoring') { this.monStop(); return; }
      const targets = this.monHosts().filter(h => this.monReady(h));
      await Promise.all(targets.map(h => this.monPoll(h)));
      this.mon.lastAt = new Date().toLocaleTimeString();
    },

    async monPoll(h) {
      const name = h.name;
      if (!this.mon.live[name]) this.mon.live[name] = { loading: false, error: '', reachable: null, latencyMs: null, findings: [], signals: [] };
      const L = this.mon.live[name];
      L.loading = true;
      try {
        const res = await this.api('/hosts/' + encodeURIComponent(name) + '/status');
        L.findings = res.report?.findings || [];
        L.latencyMs = res.latencyMs;
        L.reachable = res.reachable !== false;
        L.error = '';
        L.signals = this.monSignals(L.findings);
      } catch (e) {
        L.reachable = false; L.error = e.message; L.signals = [];
      } finally {
        L.loading = false;
        L.at = Date.now();
        this.monRecord(name, L);
      }
    },

    // Pull the charted numeric signals out of the status findings by id.
    monSignals(findings) {
      const byId = {};
      for (const f of (findings || [])) {
        if (f?.value != null && byId[f.id] === undefined) byId[f.id] = f;
      }
      return MON_SIGNALS.map(def => this.monSignalFor(def, byId)).filter(Boolean);
    },

    monSignalFor(def, byId) {
      const f = def.ids.map(id => byId[id]).find(Boolean);
      if (!f) return null;
      let n = Number(f.value);
      if (!Number.isFinite(n)) return null;
      if (def.invert) n = Math.max(0, 100 - n);   // sys.memory reports free → show used
      const sig = { key: def.key, label: def.label, value: Math.round(n * 100) / 100, unit: def.unit || (def.pct ? '%' : ''), pct: def.pct, severity: f.severity || 'info', summary: f.summary };
      if (def.key === 'load') {
        const m = /on (\d+) core/.exec(f.summary || '');
        sig.cores = m ? Number(m[1]) : 1;
      }
      return sig;
    },

    // Append this poll to the rolling window: an up/down tick plus each signal value.
    monRecord(name, L) {
      if (!this.mon.series[name]) this.mon.series[name] = {};
      const s = this.mon.series[name];
      const push = (k, v) => {
        if (!s[k]) { s[k] = []; }
        s[k].push(v);
        if (s[k].length > MON_CAP) { s[k].shift(); }
      };
      push('up', L.reachable ? 1 : 0);
      for (const sig of (L.signals || [])) { push(sig.key, sig.value); }
    },

    monSeries(name, key) { return this.mon.series[name]?.[key] || []; },

    // Sparkline points fitted to a 100×30 viewBox (svg uses preserveAspectRatio="none").
    monSpark(series) {
      const a = series || [];
      if (a.length < 2) return '';
      const min = Math.min(...a), max = Math.max(...a), span = (max - min) || 1;
      const n = a.length;
      return a.map((v, i) => {
        const x = (i / (n - 1)) * 100;
        const y = 28 - ((v - min) / span) * 26;
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
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

    // Session uptime = share of polls this host answered, as a percentage.
    monUp(name) {
      const a = this.monSeries(name, 'up');
      if (!a.length) return null;
      return Math.round((a.reduce((n, v) => n + v, 0) / a.length) * 1000) / 10;
    },

    // Worst check severity + how many checks want attention (for the home summary).
    monWorst(name) {
      const rank = { fail: 3, warn: 2, info: 1, ok: 0 };
      let worst = 'ok';
      for (const f of (this.mon.live[name]?.findings || [])) {
        if ((rank[f.severity] || 0) > rank[worst]) worst = f.severity;
      }
      return worst;
    },
    monIssues(name) {
      return (this.mon.live[name]?.findings || []).filter(f => f.severity === 'warn' || f.severity === 'fail').length;
    },
    monSig(name, key) { return (this.mon.live[name]?.signals || []).find(s => s.key === key) || null; },
    fleetDot(h) {
      return this.mon.live[h.name]?.findings?.length
        ? this.sevColor(this.monWorst(h.name))
        : this.connMeta(h.conn?.state || 'unknown').color;
    },

    // One-shot status fetch for the home card — configured hosts only, and skip any
    // whose live data is still fresh (reused from the Monitoring poller if warm).
    async fleetHealthLoad() {
      const now = Date.now();
      const due = this.fleetHosts().filter(h => {
        const L = this.mon.live[h.name];
        return !L || (!L.loading && now - (L.at || 0) > 20000);
      });
      await Promise.all(due.map(h => this.monPoll(h)));
    },

    monRefresh(name) {
      const h = (this.hosts || []).find(x => x.name === name);
      if (h) this.monPoll(h);
    },

    // Open the dedicated host detail page from a host record.
    monManage(h) {
      this.openHost({ name: h.name, host: h, id: h.providerServerId || h.name, provider: h.provider, publicIp: h.address, external: !h.providerServerId, managed: false });
    },
  };
}
