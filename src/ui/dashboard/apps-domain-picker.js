// Domain picker — shared by deploy and expose. Both modals ask the same
// question, so they run one state object (apps.picker, owned by dashboardApps())
// and one partial (sections/domain-picker.html). They used to hold a copy each,
// and the copies drifted.
function dashboardAppsDomainPicker() {
  return {
    /** `isPrivate` offers the no-domain row: right when deploying, wrong when
     *  the whole point of the action is to publish. */
    appPickerInit(host, name, isPrivate) {
      this.apps.picker = { host, name, options: [], choice: -1, domain: '', edit: false,
                           custom: false, info: -1, loading: true, private: isPrivate, note: '' };
      void this.appPickerLoad();
    },

    /** Ask the server which hostnames are actually possible here. The user should
     *  never need to know that sslip.io or a writable DNS zone exist. */
    async appPickerLoad(prev) {
      const p = this.apps.picker; if (!p) return;
      p.loading = true; p.note = '';
      if (!p.host) { p.loading = false; return; }
      try {
        const opts = await this.api('/ingress/' + encodeURIComponent(p.host) +
                                    '/domain-options/' + encodeURIComponent(p.name || 'app'));
        if (this.apps.picker === p) p.options = opts || [];
      } catch {
        // Losing the zone list must never block the action: the manual path stays.
        if (this.apps.picker === p) {
          p.options = [{ kind: 'byo', hostname: '', title: 'A domain you own', dns: 'manual', tls: 'reliable',
                         detail: 'Point an A record at this host and the certificate follows.' }];
          p.note = 'Could not read your DNS zones — type the hostname yourself.';
        }
      } finally {
        if (this.apps.picker === p) {
          p.loading = false;
          if (!p.custom) this.appPickerChoose(this.appPickerReselect(p, prev));
        }
      }
    },

    /** The host (and so the temporary hostname) or the install name changed —
     *  both move the proposals, neither is a reason to undo the user's choice. */
    appPickerRetarget() {
      const p = this.apps.picker; const f = this.apps.form;
      if (!p || !f) return;
      p.host = f.host;
      p.name = (f.name || '').trim() || f.catalog;
      void this.appPickerLoad(p.choice < 0 ? { none: true } : p.options[p.choice]);
    },

    /** Which row to land on after a reload: the same one as before if it is still
     *  offered (with its hostname re-derived), otherwise the default. */
    appPickerReselect(p, prev) {
      if (prev?.none) return -1;
      const i = prev ? p.options.findIndex((o) => o.kind === prev.kind && o.zone === prev.zone) : -1;
      if (i >= 0) return i;
      if (p.private) return -1;
      const best = p.options.findIndex((o) => o.recommended);
      if (best >= 0) return best;
      return p.options.length ? 0 : -1;
    },

    /** Clicking the row already selected must not throw away a hostname typed into it. */
    appPickerClick(idx) { const p = this.apps.picker; if (p && p.choice !== idx) this.appPickerChoose(idx); },

    /** -1 is the deliberate "no domain" choice, not the absence of one. */
    appPickerChoose(idx) {
      const p = this.apps.picker; if (!p) return;
      p.choice = idx; p.custom = false; p.info = -1;
      const o = idx >= 0 ? p.options[idx] : null;
      p.domain = o?.hostname || '';
      // "A domain you own" has nothing to propose, so it opens straight into the field.
      p.edit = !!o && !o.hostname;
    },

    /** Every proposal is a starting point, not a fixed choice. */
    appPickerEdit(idx, ev) {
      const p = this.apps.picker; if (!p) return;
      if (p.choice !== idx) this.appPickerChoose(idx);
      p.edit = true;
      // Alpine flushes x-show on a microtask, so the field is still display:none
      // at this point; a macrotask lands after that flush.
      const row = ev?.target?.closest('[data-pick-row]');
      setTimeout(() => row?.querySelector('input[type=text]')?.focus(), 0);
    },
    appPickerEditing(idx) { const p = this.apps.picker; return !!p && p.edit && p.choice === idx; },
    appPickerInfo(idx) { const p = this.apps.picker; if (p) p.info = p.info === idx ? -1 : idx; },

    appPickerLabel(o, idx) {
      const p = this.apps.picker;
      if (p?.custom && p.choice === idx) return p.domain || o.title;
      return o.hostname || o.title;
    },
    appPickerBadge(o) {
      if (o.dns === 'automatic') return 'auto DNS';
      if (o.dns === 'manual') return 'manual DNS';
      return 'temporary';
    },
    /** The hostname the action will use — '' means no domain at all. */
    appPickerDomain() {
      const p = this.apps.picker;
      if (!p || p.choice < 0) return '';
      return (p.domain || '').trim();
    },
  };
}
