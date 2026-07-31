// Apps view: an offline app marketplace over the bundled flui catalog. Browse +
// filter, open a detail drawer, deploy to a host (dry-run preview then deploy),
// and manage installs (status / logs / expose / remove). Talks only to the local
// API, which drives the same VopsAppsService as the CLI.
function dashboardApps() {
  return {
    apps: {
      installs: [], catalog: [], hosts: [], loaded: false,
      q: '', cat: '',        // search text + active category filter
      sel: null, selTab: 'about', // catalog detail drawer
      form: null,            // deploy form { catalog, host, name, email, tls, staging }
      picker: null,          // domain picker, shared by the deploy + expose modals
      preview: null,         // dry-run plan
      inspect: null,         // deployed-install status/logs panel { name, units?, logs? }
      shell: null,           // container-shell panel { app, container, components, cli, command }
      menu: '',              // name of the install whose "⋯ more" card menu is open
      restarting: '',        // name of the install currently restarting (disables its button)
      byop: false,           // "Deploy your own code" overlay
      byopAgent: 'claude-code', // which coding agent the overlay is showing
      done: null,            // last successful deploy result (for the Access card)
      revealed: {},          // { [secretName]: plaintext } after an explicit reveal
      progress: null,        // { pct, label } while a deploy is streaming to a host
      confirm: null,         // in-page confirm modal { kind, name, busy, err, … }
      busy: false, msg: '', err: '',
    },
    _progTimer: null,

    async loadApps() {
      this.beginLoad();
      try {
        const [installs, catalog, hosts] = await Promise.all([
          this.api('/apps'), this.api('/apps/catalog'), this.api('/hosts'),
        ]);
        this.apps.installs = installs || [];
        this.apps.catalog = catalog || [];
        this.apps.hosts = (hosts || []).filter((h) => h.sshManaged !== false);
        this.apps.loaded = true;
      } catch (e) { this.apps.err = e.message; } finally { this.endLoad(); }
    },

    // ── Browse / filter ───────────────────────────────────────────────────
    catalogView() {
      const q = this.apps.q.trim().toLowerCase();
      const cat = this.apps.cat;
      return this.apps.catalog.filter((c) => {
        if (cat && c.category !== cat) return false;
        if (!q) return true;
        const hay = [c.name, c.id, c.description, c.category, ...(c.tags || []), ...(c.alternativeTo || [])].join(' ').toLowerCase();
        return hay.includes(q);
      });
    },
    appCategories() {
      const m = new Map();
      for (const c of this.apps.catalog) m.set(c.category, (m.get(c.category) || 0) + 1);
      return [...m.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => a.id.localeCompare(b.id));
    },

    // ── Card helpers ──────────────────────────────────────────────────────
    appIconUrl(c) { return c.iconFile ? '/assets/' + c.iconFile : ''; },
    appRating(c) {
      const r = c.ratings;
      if (!r) return null;
      const v = ['wow', 'utility', 'euFit', 'community'].map((k) => r[k]).filter((n) => typeof n === 'number');
      return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
    },
    appInstalls(id) { return this.apps.installs.filter((i) => i.appId === id); },
    appOrphanCount() { return this.apps.installs.filter((i) => i.hostMissing).length; },
    // Installs are keyed by (host, name): the same name can live on two hosts, so every
    // per-install call carries its host — without it the API refuses to guess.
    appUrl(name, host, path, q) {
      const query = [host ? 'host=' + encodeURIComponent(host) : '', q || ''].filter(Boolean).join('&');
      return '/apps/' + encodeURIComponent(name) + path + (query ? '?' + query : '');
    },
    appKey(i) { return i.host + '/' + i.name; },

    /** Six-word-per-step summary; the detail lives in the skill the agent reads, so it isn't
     * duplicated here. `stop` marks the one moment a human is required. */
    byopSteps() {
      return [
        { t: 'reads your repo' },
        { t: 'writes flui.yaml' },
        { t: 'builds the image on CI' },
        { t: 'shows you a plan', stop: true },
        { t: 'deploys' },
        { t: 'verifies' },
      ];
    },

    /** Native skill directories per coding agent, verified against current client documentation. */
    byopAgents() {
      return [
        { id: 'claude-code', name: 'Claude Code', home: '~/.claude/skills/vops-deploy/', project: '.claude/skills/vops-deploy/' },
        { id: 'codex', name: 'Codex', home: '~/.agents/skills/vops-deploy/', project: '.agents/skills/vops-deploy/' },
        { id: 'antigravity', name: 'Antigravity', home: '~/.gemini/config/skills/vops-deploy/', project: '.agents/skills/vops-deploy/' },
        { id: 'opencode', name: 'OpenCode', home: '~/.config/opencode/skills/vops-deploy/', project: '.opencode/skills/vops-deploy/' },
      ];
    },
    byopAgent() { return this.byopAgents().find((a) => a.id === this.apps.byopAgent) || this.byopAgents()[0]; },
    byopCommand(scope) {
      const a = this.byopAgent();
      return 'vops agent setup --client ' + a.id + ' --scope ' + scope;
    },

    appKindLabel(t) {
      if (t === 'composed') return 'stack';
      if (t === 'building-block') return 'service';
      return 'app';
    },

    // ── Detail drawer ─────────────────────────────────────────────────────
    appOpen(c) { this.apps.sel = c; this.apps.selTab = 'about'; this.apps.err = ''; },
    appCloseSel() { this.apps.sel = null; },
    appDeployFromSel() { const id = this.apps.sel?.id; this.appCloseSel(); if (id) this.appOpenDeploy(id); },

    // ── Deploy ────────────────────────────────────────────────────────────
    appOpenDeploy(catId) {
      const host = this.apps.hosts[0]?.name || '';
      const entry = this.apps.catalog.find((c) => c.id === catId);
      const set = {};
      for (const inp of entry?.inputs || []) if (inp.default != null) set[inp.name] = inp.default;
      this.apps.form = { catalog: catId, host, name: '', email: '', tls: true, staging: false, set, confirm: {}, reveal: {} };
      this.apps.preview = null; this.apps.msg = ''; this.apps.err = '';
      this.appPickerInit(host, catId, true);
    },
    appCloseDeploy() { this.apps.form = null; this.apps.preview = null; this.apps.picker = null; },

    // ── Domain picker methods (appPickerInit/Load/Retarget/Reselect/Click/
    // Choose/Edit/Editing/Info/Label/Badge/Domain) live in
    // dashboard/apps-domain-picker.js — they share this file's `apps.picker`
    // state object but are merged onto the same flat Alpine scope.

    appFormEntry() { return this.apps.catalog.find((c) => c.id === this.apps.form?.catalog) || null; },
    appFormInputs() { return this.appFormEntry()?.inputs || []; },
    appInputRequired(inp) {
      if (inp.group) return false;
      return inp.required == null ? !!inp.sensitive : !!inp.required;
    },
    // True only for the first member of a group → render the "at least one" header
    // once above the group instead of tagging every field.
    appGroupFirst(inp) { return !!inp.group && this.appFormInputs().find((i) => i.group === inp.group)?.name === inp.name; },
    // Generate only fits a secret the user INVENTS (an admin password, marked
    // `confirm`) — never an externally-issued API key / bot token you must paste.
    appCanGenerate(inp) { return !!inp.sensitive && !!inp.confirm; },

    /** Fill a value with a strong random secret (client-side) and reveal it. */
    appGenSecret(name) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      const a = new Uint32Array(24); crypto.getRandomValues(a);
      const v = Array.from(a, (n) => chars[n % chars.length]).join('');
      this.apps.form.set[name] = v; this.apps.form.confirm[name] = v; this.apps.form.reveal[name] = true;
    },
    appToggleReveal(name) { this.apps.form.reveal[name] = !this.apps.form.reveal[name]; },

    /** Validate one input against the backend secret rules — '' when ok. */
    appOneInputError(inp) {
      const f = this.apps.form;
      const v = f.set[inp.name] ?? '';
      if (this.appInputRequired(inp) && !v) return `${inp.label} is required.`;
      if (v && inp.minLength && v.length < inp.minLength) return `${inp.label} must be at least ${inp.minLength} characters.`;
      if (v && inp.maxLength && v.length > inp.maxLength) return `${inp.label} must be at most ${inp.maxLength} characters.`;
      if (v && inp.pattern && !new RegExp(inp.pattern).test(v)) return inp.description || `${inp.label} is invalid.`;
      if (inp.confirm && v !== (f.confirm[inp.name] ?? '')) return `${inp.label} confirmation does not match.`;
      return '';
    },
    /** Front-end validation mirroring the backend secret rules — returns '' when ok. */
    appInputError() {
      for (const inp of this.appFormInputs()) {
        const e = this.appOneInputError(inp);
        if (e) return e;
      }
      return this.appGroupError();
    },
    /** "At least one of" groups: each group must have ≥1 member filled in — '' when ok. */
    appGroupError() {
      const f = this.apps.form;
      const groups = {};
      for (const inp of this.appFormInputs()) {
        if (!inp.group) continue;
        groups[inp.group] ??= [];
        groups[inp.group].push(inp);
      }
      for (const inps of Object.values(groups)) {
        if (inps.some((inp) => (f.set[inp.name] ?? '') !== '')) continue;
        return `Provide at least one: ${inps.map((inp) => inp.label).join(', ')}.`;
      }
      return '';
    },
    appSet(f) {
      const out = {};
      for (const [k, v] of Object.entries(f.set || {})) if (v !== '' && v != null) out[k] = v;
      return out;
    },

    appIngress(f) {
      const domain = this.appPickerDomain();
      if (!domain) return undefined;
      return { domain, email: f.email || undefined, tls: f.tls, staging: f.staging, exposeDirect: false };
    },
    appResultUrl(res) {
      if (!res.ingress) return res.endpoints?.[0]?.url || 'ok';
      return (res.ingress.tls ? 'https://' : 'http://') + res.ingress.hostname;
    },

    // ── Deploy progress (optimistic) ──────────────────────────────────────
    // The deploy is one blocking request, so we ease a bar toward 90% over the
    // app's estimated install time and hold there until it actually resolves —
    // then snap to 100%. Honest: no faked per-phase status, just a paced wait.
    appProgStart(est, label) {
      this.appProgClear();
      this.apps.progress = { pct: 6, label };
      const rate = Math.min(0.12, (250 / (Math.max(20, est || 60) * 1000)) * 2.4);
      this._progTimer = setInterval(() => {
        const p = this.apps.progress; if (!p) return;
        p.pct = Math.min(90, p.pct + (90 - p.pct) * rate);
      }, 250);
    },
    appProgClear() { if (this._progTimer) { clearInterval(this._progTimer); this._progTimer = null; } },
    appProgDone() { this.appProgClear(); if (this.apps.progress) { this.apps.progress.pct = 100; } setTimeout(() => { this.apps.progress = null; }, 600); },
    appProgFail() { this.appProgClear(); this.apps.progress = null; },

    // ── Pre-install sign-in preview (from catalog meta `access`) ───────────
    appFormAccess() { return this.appFormEntry()?.access || null; },
    appAccessPartText(part) {
      if (!part) return '';
      if (part.kind === 'value') return part.value || '';
      if (part.kind === 'userSet') return 'the value you set below';
      return 'auto-generated on the host — reveal it after deploy';
    },
    /** A default/generated password the user should rotate right after first login. */
    appAccessRotate(a) {
      return !!a && a.mode === 'credentials' && !!a.password && (a.password.kind === 'value' || a.password.kind === 'generated');
    },

    // ── Access / credentials display ──────────────────────────────────────
    appCredText(part) {
      if (!part) return '';
      if (part.kind === 'userSet') return '(set by you at install)';
      if (part.kind === 'generated') return '(generated on host)';
      return part.value || '';
    },
    /** Read back a generated/user-set secret on explicit user action (never auto-shown). */
    async appReveal(name, host, secret) {
      if (!secret) return;
      this.apps.err = '';
      try {
        const r = await this.api(this.appUrl(name, host, '/credentials', 'secret=' + encodeURIComponent(secret)));
        this.apps.revealed = { ...this.apps.revealed, [secret]: r.value };
      } catch (e) { this.apps.err = e.message; }
    },

    async appPreview() {
      const f = this.apps.form; if (!f.host) { this.apps.err = 'Pick a host.'; return; }
      this.apps.busy = true; this.apps.err = '';
      try {
        this.apps.preview = await this.api('/apps/deploy', {
          method: 'POST',
          body: JSON.stringify({ catalog: f.catalog, host: f.host, name: f.name || undefined, ingress: this.appIngress(f), set: this.appSet(f) }),
        });
      } catch (e) { this.apps.err = e.message; } finally { this.apps.busy = false; }
    },

    async appDeploy() {
      const f = this.apps.form; if (!f.host) { this.apps.err = 'Pick a host.'; return; }
      const ierr = this.appInputError(); if (ierr) { this.apps.err = ierr; return; }
      this.apps.busy = true; this.apps.err = ''; this.apps.msg = '';
      this.appProgStart(this.appFormEntry()?.estSeconds, this.appPickerDomain() ? `Deploying ${f.catalog} + provisioning ingress over SSH…` : `Deploying ${f.catalog} over SSH…`);
      try {
        const res = await this.api('/apps/deploy', {
          method: 'POST',
          body: JSON.stringify({ catalog: f.catalog, host: f.host, name: f.name || undefined, ingress: this.appIngress(f), set: this.appSet(f), yes: true }),
        });
        this.appProgDone();
        this.apps.msg = `✓ Deployed ${res.app} — ${this.appResultUrl(res)} (${res.ingress ? res.ingress.note : res.smoke})`;
        this.apps.done = res.access ? res : null; this.apps.revealed = {};
        this.apps.form = null; this.apps.preview = null;
        this.notify(`✓ ${res.app} deployed`, 'ok');
        await this.loadApps();
      } catch (e) { this.appProgFail(); this.apps.err = e.message; this.apps.msg = ''; this.notify('Deploy failed — see the error above', 'error'); } finally { this.apps.busy = false; }
    },

    // ── Manage an install (in-page confirm — never a native dialog) ────────
    // Browsers silently suppress repeated native confirm()/prompt() dialogs, so these actions
    // drive a real modal instead, with its own busy flag and in-place errors.
    appAskRemove(name, host, orphaned) { this.apps.confirm = { kind: 'remove', name, host, orphaned: !!orphaned, purge: false, busy: false, err: '' }; },
    appAskExpose(name, host) {
      this.apps.confirm = { kind: 'expose', name, host, email: '', busy: false, err: '' };
      this.appPickerInit(host || '', name, false);
    },
    appAskUnexpose(name, host) { this.apps.confirm = { kind: 'unexpose', name, host, busy: false, err: '' }; },
    appCloseConfirm() { if (!this.apps.confirm?.busy) { this.apps.confirm = null; this.apps.picker = null; } },
    appConfirmCta() {
      const c = this.apps.confirm; if (!c) return '';
      if (c.kind === 'expose') return c.busy ? 'Exposing…' : 'Expose';
      if (c.kind === 'unexpose') return c.busy ? 'Detaching…' : 'Detach';
      if (c.busy) return c.orphaned ? 'Forgetting…' : 'Removing…';
      if (c.orphaned) return 'Forget';
      return c.purge ? 'Delete + purge' : 'Remove';
    },
    /** What the in-modal loader says while an action runs — honest about the actual
     * work (stop services → remove containers → purge), so a fast op isn't a blank wait. */
    appConfirmBusyLabel() {
      const c = this.apps.confirm; if (!c) return 'Working…';
      if (c.kind === 'expose') return `Exposing ${c.name} — provisioning domain + TLS over SSH…`;
      if (c.kind === 'unexpose') return `Detaching ${c.name} from ingress over SSH…`;
      if (c.orphaned) return `Forgetting ${c.name} locally…`;
      if (c.purge) return `Removing ${c.name} — stopping services, deleting containers + data over SSH…`;
      return `Removing ${c.name} — stopping services + deleting containers over SSH…`;
    },

    async appConfirmRun() {
      const c = this.apps.confirm; if (!c || c.busy) return;
      if (c.kind === 'expose' && !this.appPickerDomain()) { c.err = 'Pick a domain, or type one with ✎.'; return; }
      c.busy = true; c.err = '';
      try {
        if (c.kind === 'remove') await this.appRunRemove(c);
        else if (c.kind === 'unexpose') await this.appRunUnexpose(c);
        else if (c.kind === 'expose') await this.appRunExpose(c);
        this.apps.confirm = null; this.apps.picker = null;
        await this.loadApps();
      } catch (e) { c.err = e.message; c.busy = false; }
    },
    async appRunRemove(c) {
      const res = await this.api('/apps/' + encodeURIComponent(c.name) + '/remove', { method: 'POST', body: JSON.stringify({ yes: true, host: c.host, purge: c.orphaned ? false : c.purge }) });
      this.apps.inspect = null;
      this.apps.msg = this.appRemoveMsg(c, res);
      this.notify(res.orphaned ? `✓ ${c.name} forgotten` : `✓ ${c.name} removed`, 'ok');
    },
    appRemoveMsg(c, res) {
      if (res.orphaned) return `✓ Forgot ${c.name} — host ${res.host} was gone; clean that server by hand if it still exists`;
      return `✓ Removed ${c.name}${c.purge ? ' (volumes + secrets deleted)' : ' (data kept)'}`;
    },
    async appRunUnexpose(c) {
      await this.api('/apps/' + encodeURIComponent(c.name) + '/unexpose', { method: 'POST', body: JSON.stringify({ yes: true, host: c.host }) });
      this.apps.msg = `✓ ${c.name} detached from ingress`;
      this.notify(`${c.name} detached from ingress`, 'ok');
    },
    async appRunExpose(c) {
      const res = await this.api('/apps/' + encodeURIComponent(c.name) + '/expose', {
        method: 'POST', body: JSON.stringify({ domain: this.appPickerDomain(), email: c.email.trim() || undefined, tls: true, yes: true, host: c.host }),
      });
      this.apps.msg = `✓ Exposed ${res.app} — ${this.appResultUrl(res)}`;
      this.notify(`✓ ${res.app} exposed`, 'ok');
    },

    async appStatus(name, host) {
      this.apps.inspect = { name, host, loading: true }; this.apps.err = '';
      try { this.apps.inspect = { name, host, ...(await this.api(this.appUrl(name, host, '/status'))) }; }
      catch (e) { this.apps.err = e.message; this.apps.inspect = null; }
    },
    // A quick self-recovery action (not a redeploy): units/images/secrets are
    // untouched, so it skips the in-page confirm modal reserved for destructive
    // or exposure-changing actions (Remove, Expose, Unexpose).
    async appRestart(name, host) {
      if (this.apps.restarting) return;
      this.apps.restarting = host + '/' + name;
      try {
        await this.api(this.appUrl(name, host, '/restart'), { method: 'POST' });
        this.notify(`✓ ${name} restarted`, 'ok');
        if (this.apps.inspect?.name === name && this.apps.inspect?.host === host) await this.appStatus(name, host);
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.apps.restarting = ''; }
    },
    async appLogs(name, host) {
      try { const r = await this.api(this.appUrl(name, host, '/logs', 'lines=200')); this.apps.inspect = { name, host, logs: r.logs }; }
      catch (e) { this.apps.err = e.message; }
    },
    // Export a fuller tail (not just the 200 shown) as a text file, client-side.
    async appDownloadLogs() {
      const name = this.apps.inspect?.name; if (!name) return;
      try {
        const r = await this.api(this.appUrl(name, this.apps.inspect?.host, '/logs', 'lines=2000'));
        const url = URL.createObjectURL(new Blob([r.logs || ''], { type: 'text/plain' }));
        const a = document.createElement('a');
        a.href = url; a.download = name + '-logs.txt'; a.click();
        URL.revokeObjectURL(url);
      } catch (e) { this.apps.err = e.message; }
    },
    appCloseInspect() { this.apps.inspect = null; },

    // ── Container shell ───────────────────────────────────────────────────
    // The UI never proxies a session: it resolves the same `ssh … podman exec`
    // invocation the CLI runs, then asks vops to open it in the user's own
    // terminal (local API is 127.0.0.1 — same machine) or hands it over to copy.
    async appShell(name, host, component) {
      this.apps.shell = { name, loading: true }; this.apps.err = '';
      const q = component ? 'component=' + encodeURIComponent(component) : '';
      try { this.apps.shell = { name, busy: false, ...(await this.api(this.appUrl(name, host, '/shell', q))) }; }
      catch (e) { this.apps.err = e.message; this.apps.shell = null; }
    },
    async appShellOpen() {
      const s = this.apps.shell;
      if (!s || s.busy) return;
      s.busy = true;
      try {
        const r = await this.api('/apps/' + encodeURIComponent(s.app) + '/shell', {
          method: 'POST', body: JSON.stringify({ component: s.component, host: s.host }),
        });
        this.apps.shell = { name: s.name, busy: false, ...r };
        this.notify(r.launched ? 'Terminal opened — ' + r.terminal : (r.reason || 'No terminal app found'), r.launched ? 'ok' : 'error');
      } catch (e) { s.busy = false; this.notify(e.message, 'error'); }
    },
    appCloseShell() { this.apps.shell = null; },
  };
}
