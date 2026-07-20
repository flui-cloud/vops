// Provider credentials view. The form is rendered dynamically from each
// provider's `credentialFields` (label/hint/secret/required) served by the API,
// so it adapts to whatever a provider requires. Values go to the encrypted
// local store; only "configured" + field metadata ever come back.
function dashboardCredentials() {
  return {
    credentials: [],
    credLoaded: false,
    credModal: {
      open: false, provider: '', displayName: '', type: '',
      fields: [], values: {}, busy: false, error: '', result: null, configured: false,
    },

    async loadCredentials() {
      this.beginLoad(); this.error = '';
      try { this.credentials = await this.api('/credentials'); this.credLoaded = true; }
      catch (e) { this.error = e.message; }
      finally { this.endLoad(); }
    },

    openCredModal(p) {
      const values = {};
      (p.fields || []).forEach((f) => { values[f.key] = ''; });
      this.credModal = {
        open: true, provider: p.provider, displayName: p.displayName, type: p.credentialType,
        fields: p.fields || [], values, busy: false, error: '', result: null, configured: p.configured,
      };
    },
    closeCredModal() { this.credModal.open = false; },

    async saveCredentials() {
      const m = this.credModal;
      const missing = m.fields.filter((f) => f.required && !String(m.values[f.key] || '').trim());
      if (missing.length) {
        m.error = 'Fill required field(s): ' + missing.map((f) => f.label).join(', ');
        return;
      }
      m.busy = true; m.error = ''; m.result = null;
      try {
        const res = await this.api('/credentials/' + m.provider, {
          method: 'POST', body: JSON.stringify({ values: m.values }),
        });
        m.result = res.validation;
        const ok = res.validation?.ok;
        this.notify(ok ? m.displayName + ' connected' : m.displayName + ' saved (not verified)', ok ? 'ok' : 'warn');
        await this.loadCredentials();
        if (ok) this.closeCredModal(); else m.configured = true;
      } catch (e) { m.error = e.message; }
      finally { m.busy = false; }
    },

    async removeCredentials() {
      const m = this.credModal;
      m.busy = true; m.error = '';
      try {
        await this.api('/credentials/' + m.provider, { method: 'DELETE' });
        this.notify(m.displayName + ' disconnected');
        await this.loadCredentials();
        this.closeCredModal();
      } catch (e) { m.error = e.message; }
      finally { m.busy = false; }
    },
  };
}
