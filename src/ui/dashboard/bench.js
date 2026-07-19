// Benchmark live view for the host page. History load + reattach to an active
// run on open, consent flow (preflight → start with explicit `yes`), then a 1 s
// poll of the run state while it runs. Sparkline reuses monSpark; the copy helper
// and api() come from the shared core/servers factories.
function dashboardBench() {
  return {
    bench: { hist: [], histShown: 5, histOpen: '', histMenu: '', histFull: {}, histLoading: '', readings: {}, readingLoading: '', cmpSel: { baseId: '', result: null, allRuns: [], loading: false, copied: false }, pre: null, preLoading: false, consent: false, profile: 'quick', install: false, runsSel: 1, run: null, timer: null, err: '', copied: '' },
    benchLoadedFor: null,

    benchName() { return this.modal.mg?.name || null; },

    // Idempotent per host (the x-effect fires on every reactive change).
    async bhInit(name) {
      if (!name || this.benchLoadedFor === name) return;
      this.benchLoadedFor = name;
      this.bhStop();
      this.bench.pre = null; this.bench.consent = false; this.bench.install = false;
      this.bench.profile = 'quick'; this.bench.runsSel = 1; this.bench.run = null; this.bench.err = ''; this.bench.hist = [];
      this.bench.histShown = 5; this.bench.histOpen = ''; this.bench.histMenu = ''; this.bench.histFull = {}; this.bench.histLoading = '';
      this.bench.readings = {}; this.bench.readingLoading = '';
      this.bench.cmpSel = { baseId: '', result: null, allRuns: [], loading: false, copied: false };
      try { this.bench.hist = await this.api('/bench/runs?host=' + encodeURIComponent(name)); }
      catch (e) { this.bench.err = e.message; this.bench.hist = []; }
      try {
        const active = await this.api('/bench/hosts/' + encodeURIComponent(name) + '/active');
        if (active && active.runId) { this.bench.run = active; this.bhPoll(active.runId); }
      } catch { /* no active run — ignore */ }
    },

    async bhAsk() {
      this.bench.consent = true; this.bench.err = '';
      const name = this.benchName();
      if (!name || this.bench.preLoading) return;
      this.bench.preLoading = true;
      try {
        this.bench.pre = await this.api('/bench/hosts/' + encodeURIComponent(name) + '/preflight?profile=' + this.bench.profile);
      } catch (e) { this.bench.err = e.message; this.bench.pre = null; }
      finally { this.bench.preLoading = false; }
    },

    async bhStart() {
      const name = this.benchName();
      if (!name) return;
      this.bench.err = '';
      try {
        const res = await this.api('/bench/hosts/' + encodeURIComponent(name) + '/run', {
          method: 'POST',
          body: JSON.stringify({ profile: this.bench.profile, install: this.bench.install, runs: this.bench.runsSel, yes: true }),
        });
        this.bench.consent = false;
        this.bench.run = { runId: res.runId, host: name, profile: this.bench.profile, startedAt: new Date().toISOString(), state: 'running', progress: [], samples: [] };
        this.bhPoll(res.runId);
      } catch (e) { this.bench.err = e.message; }
    },

    bhPoll(runId) {
      this.bhStop();
      this.bench.timer = setInterval(() => this.bhTick(runId), 1000);
    },
    async bhTick(runId) {
      if (this.view !== 'host') { this.bhStop(); return; }
      try {
        const st = await this.api('/bench/state/' + encodeURIComponent(runId));
        this.bench.run = st;
        if (st.state !== 'running') {
          this.bhStop();
          try { this.bench.hist = await this.api('/bench/runs?host=' + encodeURIComponent(st.host || this.benchLoadedFor)); }
          catch { /* keep old history */ }
        }
      } catch (e) { this.bench.err = e.message; this.bhStop(); }
    },
    bhStop() {
      if (this.bench.timer) { clearInterval(this.bench.timer); this.bench.timer = null; }
    },

    // All planned steps upfront (todo → running → done/skipped), overlaying the
    // latest progress event per probe. A probe stays "running (round r/N)" until
    // its final round finishes. Empty plan (pre-plan runs) → events only.
    bhRows() {
      const events = new Map();
      for (const p of (this.bench.run?.progress || [])) events.set(p.probe, p);
      const plan = this.bench.run?.plan || [];
      const toRow = (ev, willRun) => {
        const round = ev.round || 1;
        const rounds = ev.rounds || 1;
        let status = ev.status === 'start' ? 'running' : ev.status;
        let roundNote = '';
        if (willRun && rounds > 1) {
          if (status !== 'running' && round < rounds) status = 'running';
          if (status === 'running') roundNote = '(round ' + round + '/' + rounds + ')';
        }
        return { probe: ev.probe, status, note: ev.note, metrics: ev.metrics, roundNote };
      };
      if (!plan.length) return [...events.values()].map(ev => toRow(ev, true));
      return plan.map(pl => {
        const ev = events.get(pl.id);
        if (ev) return toRow(ev, pl.willRun);
        return { probe: pl.id, status: pl.willRun ? 'todo' : 'skipped', note: pl.reason, metrics: null, roundNote: '' };
      });
    },
    bhRowGlyph(s) { return ({ todo: '○', running: '…', done: '✓', skipped: '·' })[s] || '…'; },
    bhRowColor(s) {
      return ({ todo: 'var(--text-faint)', running: 'var(--accent)', done: 'var(--ok)', skipped: 'var(--text-faint)' })[s] || 'var(--accent)';
    },
    // Counts probe-rounds: M = willRun probes × rounds, N = finished probe-rounds.
    bhProgressCount() {
      const plan = this.bench.run?.plan || [];
      const progress = this.bench.run?.progress || [];
      const rounds = this.bench.run?.runs || 1;
      if (plan.length) {
        const runSet = new Set(plan.filter(p => p.willRun).map(p => p.id));
        const n = progress.filter(e => e.status !== 'start' && runSet.has(e.probe)).length;
        return n + '/' + (runSet.size * rounds) + ' done';
      }
      const rows = this.bhRows();
      const finished = r => r.status === 'done' || r.status === 'skipped';
      const last = progress.at(-1);
      return rows.filter(finished).length + '/' + (last?.total || rows.length) + ' done';
    },
    bhSteals() { return (this.bench.run?.samples || []).map(s => s.steal); },
    bhResultSteals(r) { return (r?.samples || []).map(s => s.steal); },
    bhElapsed() {
      const r = this.bench.run;
      if (!r?.startedAt) return '';
      const s = Math.max(0, Math.round((Date.now() - new Date(r.startedAt).getTime()) / 1000));
      const m = Math.floor(s / 60);
      return m ? m + 'm ' + (s % 60) + 's' : s + 's';
    },

    // Compact per-probe metric line, mirroring the labels/units of bench-share.ts.
    bhMetricsInline(p) {
      return Object.entries(p?.metrics || {}).map(([k, v]) => this.bhMetric(k, v)).join(' · ');
    },
    bhMetric(k, v) {
      if (k === 'mips') return 'MIPS ' + Math.round(v);
      if (k === 'iops') return 'IOPS ' + Math.round(v);
      if (k === 'p99ms') return v.toFixed(2) + ' ms';
      if (k === 'mbps') return v.toFixed(0) + ' MB/s';
      if (k === 'mibps') return v.toFixed(0) + ' MiB/s';
      return (v / 1e9).toFixed(2) + ' GB/s';
    },

    bhHeadline(row) {
      const h = row.headline || {};
      return [
        ...(h.mips != null ? [Math.round(h.mips) + ' MIPS'] : []),
        ...(h.memMiBs != null ? [Math.round(h.memMiBs) + ' MiB/s mem'] : []),
        ...(h.rr4kIops != null ? [Math.round(h.rr4kIops) + ' IOPS 4k'] : []),
      ].join(' · ');
    },

    // Preflight baseline is "busy" enough to caveat the numbers as in-vivo.
    bhBusy() {
      const p = this.bench.pre;
      if (!p) return false;
      return p.baseline.load1 >= (p.meta.cores || 1) * 0.25 || p.baseline.steal >= 1;
    },
    // Per-profile numbers from the single preflight — switching profiles is
    // purely local, no re-fetch. Falls back to the top-level fields if estimates
    // is missing (older preflight shape).
    bhEst() {
      const p = this.bench.pre;
      if (!p) return null;
      return p.estimates?.[this.bench.profile] || p;
    },
    bhSpaceOk() { const e = this.bhEst(); return e ? e.spaceOk : true; },
    bhEstMin() { const e = this.bhEst(); return e ? Math.max(1, Math.round((e.estSeconds * this.bench.runsSel) / 60)) : 0; },
    bhNeedMib() { const e = this.bhEst(); return e ? Math.round(e.needKb / 1024) : 0; },
    bhProfileLabel(profile) {
      const est = this.bench.pre?.estimates?.[profile];
      return est ? profile + ' (~' + Math.max(1, Math.round(est.estSeconds / 60)) + ' min)' : profile;
    },

    bhVisibleHist() { return this.bench.hist.slice(0, this.bench.histShown); },
    bhShowMore() { this.bench.histShown += 20; },
    bhRunDetail(id) { return this.bench.histFull[id] || null; },

    // Full results are fetched lazily on first use (expand or image export) and cached per id.
    async bhEnsureDetail(id) {
      if (!this.bench.histFull[id]) {
        if (this.bench.histLoading === id) return null;
        this.bench.histLoading = id;
        try { this.bench.histFull[id] = await this.api('/bench/runs/' + encodeURIComponent(id)); }
        catch (e) { this.notify(e.message, 'error'); }
        finally { this.bench.histLoading = ''; }
      }
      return this.bench.histFull[id] || null;
    },
    async bhEnsureReading(id) {
      if (!this.bench.readings[id] && this.bench.readingLoading !== id) {
        this.bench.readingLoading = id;
        try { this.bench.readings[id] = await this.api('/bench/runs/' + encodeURIComponent(id) + '/reading'); }
        catch { /* bands are an annotation — the detail renders without them */ }
        finally { this.bench.readingLoading = ''; }
      }
      return this.bench.readings[id] || null;
    },
    async bhToggleRun(id) {
      this.bhCmpClear();
      if (this.bench.histOpen === id) { this.bench.histOpen = ''; return; }
      this.bench.histOpen = id;
      this.bhCmpRuns();
      await Promise.all([this.bhEnsureDetail(id), this.bhEnsureReading(id)]);
    },
    bhStealText(r, id) {
      const band = this.bench.readings[id]?.bands?.steal;
      return 'CPU steal · avg ' + r.steal.avg + '% · max ' + r.steal.max + '%' + (band ? ' · ' + band : '');
    },

    bhCmpClear() {
      this.bench.cmpSel.baseId = ''; this.bench.cmpSel.result = null; this.bench.cmpSel.loading = false; this.bench.cmpSel.copied = false;
    },
    async bhCmpCopyShare() {
      const res = this.bench.cmpSel.result;
      if (!res) return;
      try {
        const out = await this.api('/bench/compare/share?a=' + encodeURIComponent(res.a.id) + '&b=' + encodeURIComponent(res.b.id));
        await this.copy(out.markdown);
        this.bench.cmpSel.copied = true;
        setTimeout(() => { this.bench.cmpSel.copied = false; }, 1800);
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async bhCmpRuns() {
      if (this.bench.cmpSel.allRuns.length) return;
      try { this.bench.cmpSel.allRuns = await this.api('/bench/runs'); }
      catch { /* picker stays empty — the detail itself is unaffected */ }
    },
    // bench.hist is newest-first, so the run before this one is the next index.
    bhPrevRun(id) {
      const i = this.bench.hist.findIndex((r) => r.id === id);
      return i >= 0 ? (this.bench.hist[i + 1] || null) : null;
    },
    // The expanded run is the subject (b); the chosen run is the baseline (a) —
    // a positive Δ on an 'up' metric reads "this run is better".
    async bhCmpAgainst(baseId) {
      const c = this.bench.cmpSel;
      const subject = this.bench.histOpen;
      if (!baseId || !subject || c.loading) return;
      c.baseId = baseId; c.loading = true;
      try {
        c.result = await this.api('/bench/compare?a=' + encodeURIComponent(baseId) + '&b=' + encodeURIComponent(subject));
      } catch (e) { this.notify(e.message, 'error'); c.result = null; c.baseId = ''; }
      finally { c.loading = false; }
    },
    bhCmpVal(v) {
      if (v == null) return '—';
      return v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100);
    },
    bhCmpDeltaText(row) {
      if (row.deltaPct == null) return '—';
      const text = (row.deltaPct >= 0 ? '+' : '') + row.deltaPct.toFixed(1) + '%';
      return Math.abs(row.deltaPct) < 3 ? '≈ ' + text : text;
    },
    bhCmpDeltaColor(row) {
      if (row.deltaPct == null || Math.abs(row.deltaPct) < 3) return 'var(--text-faint)';
      const good = (row.deltaPct > 0) === (row.better === 'up');
      return good ? 'var(--ok)' : 'var(--danger)';
    },

    async bhCopyShare(id) {
      try {
        const res = await this.api('/bench/runs/' + encodeURIComponent(id) + '/share');
        await this.copy(res.markdown);
        this.bench.copied = id;
        setTimeout(() => { if (this.bench.copied === id) this.bench.copied = ''; }, 1800);
      } catch (e) { this.notify(e.message, 'error'); }
    },
  };
}
