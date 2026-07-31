// How the Monitoring page reads: a fleet answer above the fold, one row per host
// that opens into its detail, and charts on a fixed scale. Split from monitoring.js
// — that file owns the data and the polling, this one owns what it looks like.
const MON_STATE = {
  // Colour alone cannot carry state: amber and red are barely separable for a
  // deuteranope, so every state ships a word and a glyph next to the swatch.
  fail: { word: 'down', glyph: '✕', color: 'var(--danger)', soft: 'var(--danger-soft)' },
  warn: { word: 'warning', glyph: '!', color: 'var(--warn)', soft: 'var(--warn-soft)' },
  ok: { word: 'healthy', glyph: '✓', color: 'var(--ok)', soft: 'var(--ok-soft)' },
  idle: { word: 'not checked', glyph: '·', color: 'var(--text-faint)', soft: 'var(--panel-3)' },
};
const SPARK_H = 40;
const SEV_ORDER = { fail: 0, warn: 1 };

function dashboardMonitoringView() {
  return {
    monOpen: {},

    monState(h) {
      const L = this.mon.live[h.name];
      if (!L?.at) return 'idle';
      if (L.reachable === false || L.worst === 'fail') return 'fail';
      return L.worst === 'warn' ? 'warn' : 'ok';
    },
    monStateMeta(h) { return MON_STATE[this.monState(h)]; },
    sevSoft(s) {
      return ({ ok: 'var(--ok-soft)', info: 'var(--panel-2)', warn: 'var(--warn-soft)', fail: 'var(--danger-soft)' })[s] || 'var(--panel-2)';
    },

    // A host that wants attention opens itself; a healthy one stays one line.
    monIsOpen(h) {
      return this.monOpen[h.name] ?? ['fail', 'warn'].includes(this.monState(h));
    },
    monToggle(h) { this.monOpen[h.name] = !this.monIsOpen(h); },

    /** The whole fleet in one object — what the band at the top prints. */
    monFleet() {
      const hosts = this.monHosts();
      const seen = hosts.map(h => this.mon.live[h.name]).filter(L => L?.at);
      const findings = seen.flatMap(L => L.findings || []);
      const bySev = s => findings.filter(f => f.severity === s).length;
      const ups = hosts.map(h => this.monUp(h.name)).filter(v => v != null);
      return {
        total: hosts.length,
        healthy: seen.filter(L => L.reachable === true).length,
        down: hosts.filter(h => this.monState(h) === 'fail'),
        fail: bySev('fail'),
        warn: bySev('warn'),
        clear: bySev('ok'),
        samples: hosts.reduce((n, h) => n + this.monSamples(h.name), 0),
        uptime: ups.length ? Math.round(ups.reduce((a, b) => a + b, 0) / ups.length) : null,
      };
    },

    /** When the collector wakes next — the honest answer to "is this live?". */
    monNextCheck() {
      const due = this.monHosts().map(h => this.mon.live[h.name]?.nextAt).filter(Boolean);
      if (!due.length) return '';
      const mins = Math.round((Math.min(...due) - Date.now()) / 60000);
      if (mins <= 0) return 'due now';
      return mins < 60 ? 'in ' + mins + ' min' : 'in ' + Math.round(mins / 60) + ' h';
    },

    /** The host working hardest right now, by its most-used percentage signal. */
    monBusiest() {
      const rows = this.monHosts()
        .map(h => ({ name: h.name, sigs: (this.mon.live[h.name]?.signals || []).filter(s => s.unit === '%') }))
        .filter(r => r.sigs.length)
        .map(r => ({ name: r.name, top: r.sigs.reduce((a, b) => (b.value > a.value ? b : a)) }));
      return rows.length ? rows.reduce((a, b) => (b.top.value > a.top.value ? b : a)) : null;
    },

    /** Why a host is red, in the words of the check that failed. */
    monDownReason(h) {
      const L = this.mon.live[h.name] || {};
      const failed = (L.findings || []).find(f => f.severity === 'fail');
      return failed?.summary || L.error || L.reason || 'No answer from the last check.';
    },

    // ── charts ──────────────────────────────────────────────────────────────
    // Percentages are drawn against 0-100 and load against its core count, so a
    // flat machine draws a flat line. Fitting each series to its own min/max —
    // what the old sparkline did — turns 3%-to-5% idle into a mountain range.
    monSigMax(sig, series) {
      if (sig.unit === '%') return 100;
      if (sig.key === 'load') return Math.max(1, sig.cores || 1);
      const peak = Math.max(sig.value, ...(series || []).filter(v => Number.isFinite(v)));
      return Math.max(1, Math.ceil(peak * 1.25));
    },
    monScaleLabel(sig, series) {
      if (sig.unit === '%') return '0–100%';
      const unit = sig.unit ? ' ' + sig.unit : '';
      return '0–' + this.monSigMax(sig, series) + unit;
    },

    monPointY(v, max) {
      return SPARK_H - (Math.min(Math.max(v, 0), max) / max) * (SPARK_H - 4) - 2;
    },
    monPointX(i, n) { return n < 2 ? 0 : (i / (n - 1)) * 100; },

    // Contiguous runs only. A bucketed history has holes where nothing was
    // collected, and an area drawn across one invents the readings it spans.
    monSparkSegs(series, max) {
      const a = series || [];
      const runs = [[]];
      for (const [i, v] of a.entries()) {
        if (Number.isFinite(v)) runs.at(-1).push(this.monPointX(i, a.length).toFixed(1) + ',' + this.monPointY(v, max).toFixed(1));
        else if (runs.at(-1).length) runs.push([]);
      }
      const foot = p => p.split(',')[0] + ',' + SPARK_H;
      return runs.filter(r => r.length >= 2).map(r => ({
        line: r.join(' '),
        area: r.join(' ') + ' ' + foot(r.at(-1)) + ' ' + foot(r[0]),
      }));
    },

    /**
     * The whole chart as markup, injected with x-html: Alpine's x-for does not
     * work inside an <svg>, so a template that loops over segments there renders
     * nothing at all. Colours come from our own token map, never from the host.
     */
    monSparkSvg(series, sig) {
      const color = this.monColor(sig);
      const max = this.monSigMax(sig, series);
      const end = this.monSparkEnd(series, max);
      const mid = SPARK_H / 2;
      return [
        this.monSparkGaps(series),
        `<line x1="0" y1="${mid}" x2="100" y2="${mid}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>`,
        ...this.monSparkSegs(series, max).flatMap(s => [
          `<polygon points="${s.area}" fill="${color}" opacity="0.1"/>`,
          `<polyline points="${s.line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`,
        ]),
        ...(end ? [`<circle cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="3.5" fill="${color}" stroke="var(--panel-2)" stroke-width="3" vector-effect="non-scaling-stroke"/>`] : []),
      ].join('');
    },

    /**
     * Windows where nothing was collected, shaded. A host adopted an hour ago has
     * 23 empty hours behind it; leaving them blank reads as "flat", which is a
     * different — and wrong — claim from "we weren't watching".
     */
    monSparkGaps(series) {
      const a = series || [];
      const n = a.length;
      const step = 100 / Math.max(1, n - 1);
      const runs = [];
      let from = -1;
      for (const [i, v] of a.entries()) {
        const missing = !Number.isFinite(v);
        if (missing && from < 0) from = i;
        if (!missing && from >= 0) { runs.push([from, i - 1]); from = -1; }
      }
      if (from >= 0) runs.push([from, n - 1]);
      return runs
        .map(([s, e]) => {
          const x = this.monPointX(s, n);
          const w = Math.min(100 - x, this.monPointX(e, n) - x + step);
          return `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(w, 0.5).toFixed(1)}" height="${SPARK_H}" fill="var(--panel-3)" opacity="0.6"/>`;
        })
        .join('');
    },

    /** The latest reading, emphasised — the point a glance actually lands on. */
    monSparkEnd(series, max) {
      const a = series || [];
      const i = a.findLastIndex(v => Number.isFinite(v));
      return i < 0 ? null : { x: this.monPointX(i, a.length), y: this.monPointY(a[i], max) };
    },

    // ── checks ──────────────────────────────────────────────────────────────
    monChecks(name, sevs) { return (this.mon.live[name]?.findings || []).filter(f => sevs.includes(f.severity)); },
    monAttention(name) { return this.monChecks(name, ['fail', 'warn']).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]); },
    // `cloud.*` is what the provider says from outside the machine; keeping it in
    // its own group is the difference between "the server says" and "the invoice
    // says", which is exactly what a user needs to know when the two disagree.
    monClearChecks(name) { return this.monChecks(name, ['ok']).filter(f => !f.id.startsWith('cloud.')); },
    monReported(name) { return this.monChecks(name, ['info']).filter(f => !f.id.startsWith('cloud.')); },
    monProviderChecks(name) { return this.monChecks(name, ['ok', 'info']).filter(f => f.id.startsWith('cloud.')); },
  };
}
