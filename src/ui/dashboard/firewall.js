function dashboardFirewall() {
  const WK = [
    { id: 'ssh', label: 'SSH', protocol: 'tcp', port: '22' },
    { id: 'http', label: 'Web (HTTP)', protocol: 'tcp', port: '80' },
    { id: 'https', label: 'Web (HTTPS)', protocol: 'tcp', port: '443' },
  ];
  const NATIVE = ['hetzner', 'scaleway'];
  return {
    fw: { view: null, loading: false, busy: false, model: [], myIp: null, custom: { port: '', proto: 'tcp', source: '' } },

    async fwLoad(name) {
      this.fw.loading = true; this.fw.view = null; this.fw.model = [];
      try {
        const view = await this.api('/hosts/' + encodeURIComponent(name) + '/firewall');
        this.fw.view = view;
        this.fw.model = this.fwBuildModel(view);
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.fw.loading = false; }
      this.api('/hosts/' + encodeURIComponent(name) + '/my-ip').then((r) => { this.fw.myIp = r.ip; }).catch(() => {});
    },

    fwMyCidr() { if (!this.fw.myIp) { return ''; } return this.fw.myIp + (this.fw.myIp.includes(':') ? '/128' : '/32'); },
    fwUseMyIp(row) { if (this.fw.myIp) row.source = this.fwMyCidr(); },

    // Is there a vops-managed firewall to clear (even if inactive / probe failed)?
    fwHasManaged() { const v = this.fw.view; return !!v && (v.active || !!v.providerFirewallId || !!v.appliedAt || (v.services || []).length > 0); },

    // Cross-plane: which listening (TCP) ports the APPLIED firewall passes vs blocks.
    fwListening() {
      const f = (this.hvLive().findings || []).find((x) => x.id === 'net.listen');
      if (!f?.detail) return [];
      return f.detail.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    },
    fwPortCovers(spec, port) {
      return String(spec).split(',').some((raw) => {
        const part = raw.trim();
        if (part === String(port)) return true;
        const m = /^(\d+)-(\d+)$/.exec(part);
        return !!m && +m[1] <= port && port <= +m[2];
      });
    },
    // What's actually filtering inbound right now: the vops firewall if active,
    // otherwise a detected non-vops firewall (flui gives per-port detail; 'other' doesn't).
    fwEnforced() {
      const v = this.fw.view;
      if (v?.active) return { active: true, hasDetail: true, services: v.services || [], sshPort: v.sshPort || 22, sshAlwaysOpen: !!v.sshAlwaysOpen };
      const d = v?.detected;
      // 'other' is a bare default-deny with no decodable rules; flui/provider give per-port detail.
      if (d?.active) return { active: true, hasDetail: d.source !== 'other', services: d.services || [], sshPort: v?.sshPort || 22, sshAlwaysOpen: d.source === 'flui', source: d.source };
      return { active: false, hasDetail: false, services: [], sshPort: v?.sshPort || 22, sshAlwaysOpen: false };
    },

    // Someone else owns this firewall — vops shows it, never edits it.
    fwCeded() { return !!this.fw.view?.cededTo; },
    fwCededLabel() { return this.fw.view?.cededTo === 'provider' ? 'managed at the provider' : 'managed by flui'; },
    fwCededNote() {
      const d = this.fw.view?.detected;
      if (this.fw.view?.cededTo === 'provider') {
        return '“' + (d?.name || 'A provider firewall') + '” already guards this server and vops didn\'t create it. vops won\'t attach a second firewall to the same server — edit it where it\'s managed, or detach it first. Its rules are read-only below.';
      }
      return "flui manages this host's firewall — vops won't add a second, stacking ruleset here. Edit these rules in flui, or remove flui's firewall first. They're shown read-only below.";
    },
    fwDetectedLabel() {
      const s = this.fw.view?.detected?.source;
      if (s === 'flui') return 'Detected — flui firewall';
      if (s === 'provider') return 'Detected — provider firewall · ' + (this.fw.view?.detected?.name || '');
      return 'Detected — other host firewall';
    },
    // Reads what's enforced (vops or a detected firewall), not the unsaved draft (fw.model).
    fwPortAllowed(port) {
      const e = this.fwEnforced();
      if (e.sshAlwaysOpen && port === e.sshPort) return true;
      return e.services.some((s) => s.protocol === 'tcp' && this.fwPortCovers(s.port, port));
    },
    fwExposure() {
      const e = this.fwEnforced();
      const all = this.fwListening();
      const rest = all.filter((p) => p !== e.sshPort); // SSH is intentionally open — don't alarm on it
      return {
        listening: all,
        active: e.active,
        hasDetail: e.hasDetail,
        source: e.source,
        allowed: rest.filter((p) => this.fwPortAllowed(p)),
        blocked: rest.filter((p) => !this.fwPortAllowed(p)),
      };
    },

    // Standard toggles (SSH/HTTP/HTTPS) always shown; any other allowed port kept as a custom row.
    fwBuildModel(view) {
      const cur = {}; (view.services || []).forEach((s) => { cur[s.id] = s; });
      const rows = WK.map((w) => {
        const c = cur[w.id];
        const isSsh = w.id === 'ssh';
        const nftLocked = isSsh && view.sshAlwaysOpen;           // engine keeps SSH open, not editable
        const providerSsh = isSsh && view.engine === 'provider'; // must stay allowed → default on
        return {
          ...w,
          enabled: nftLocked || (c ? true : providerSsh),
          source: (c?.sources || []).join(', '),
          locked: nftLocked,
          omit: nftLocked,                                        // dropped from payload — engine injects SSH
          custom: false,
        };
      });
      const extra = (view.services || []).filter((s) => !WK.some((w) => w.id === s.id))
        .map((s) => ({ id: s.id, label: s.label, protocol: s.protocol, port: s.port, enabled: true, source: (s.sources || []).join(', '), locked: false, omit: false, custom: true }));
      return [...rows, ...extra];
    },

    fwEngineLabel(e) { return ({ provider: 'Provider firewall', nftables: 'vops firewall', none: 'Not available' })[e] || e; },
    fwCanApply() { return !this.fw.busy && !this.fwCeded() && (this.fw.view?.engine !== 'nftables' || this.mgReady()); },

    fwAddCustom() {
      const c = this.fw.custom; const port = (c.port || '').trim();
      if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(port)) { this.notify('Enter a valid port, e.g. 8080, 8000-8100 or 80,443', 'error'); return; }
      this.fw.model.push({ id: 'port-' + c.proto + '-' + port, label: 'Port ' + port, protocol: c.proto, port, enabled: true, source: (c.source || '').trim(), locked: false, omit: false, custom: true });
      this.fw.custom = { port: '', proto: 'tcp', source: '' };
    },
    fwRemove(i) { this.fw.model.splice(i, 1); },

    // SSH is dropped from the payload only on the nftables engine (it injects SSH itself);
    // on the provider engine SSH must be sent as a real allow rule.
    fwPayload() {
      return this.fw.model.filter((s) => s.enabled && !s.omit).map((s) => ({
        id: s.id, label: s.label, protocol: s.protocol, port: s.port, enabled: true,
        sources: (s.source || '').split(',').map((x) => x.trim()).filter(Boolean),
      }));
    },

    async fwApply(name) {
      this.fw.busy = true;
      try {
        await this.api('/hosts/' + encodeURIComponent(name) + '/firewall', { method: 'POST', body: JSON.stringify({ services: this.fwPayload() }) });
        await this.fwLoad(name); // re-read so exposure + detected reflect the live host
        this.notify('Firewall applied · ' + name);
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.fw.busy = false; }
    },

    async fwClear(name) {
      this.fw.busy = true;
      try {
        await this.api('/hosts/' + encodeURIComponent(name) + '/firewall', { method: 'DELETE' });
        await this.fwLoad(name);
        this.notify('Firewall cleared · ' + name);
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.fw.busy = false; }
    },

    // Fleet overview: cheap client-side engine + summary from the cached host list (no per-host call).
    fwEngineFor(host) {
      const p = (host.provider || '').toLowerCase();
      if (p && NATIVE.some((n) => p.startsWith(n))) return 'provider';
      if (host.sshManaged === false) return 'none';
      return 'nftables';
    },
    fwHostSummary(host) {
      if (this.fwEngineFor(host) === 'provider') return 'managed on provider';
      const rules = host.firewall?.rules || [];
      if (!rules.length) return host.firewall ? 'no rules' : 'not set';
      return rules.length + ' rule(s)';
    },
  };
}
