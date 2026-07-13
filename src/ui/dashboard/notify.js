// "Notify me" — routes to the vops-landing API (via the local-api proxy), the
// same backend the hosted app uses: Web Push (the vops notification app, via an
// activation URL/QR you open on your phone) and ntfy topics. No local delivery.
function dashboardNotify() {
  return {
    nfy: { plan: '', tab: 'push', topic: '', server: '', apiUrl: '', connected: false, busy: false, result: null, err: '' },

    async openNotify(plan) {
      this.nfy = { plan, tab: 'push', topic: '', server: '', apiUrl: '', connected: false, busy: false, result: null, err: '' };
      this.modal = { ...this.modal, open: true, type: 'notify', title: 'Notify me — ' + plan, cta: '', danger: false, dryRun: false };
      try {
        const s = await this.api('/watch/status');
        this.nfy.connected = !!s.connected;
        this.nfy.apiUrl = s.apiUrl || '';
      } catch (e) { this.nfy.err = e.message; }
    },

    async connectLanding() {
      const st = this.nfy;
      if (!st.apiUrl.trim()) { st.err = 'Enter the vops-landing API URL'; return; }
      st.busy = true; st.err = '';
      try {
        const r = await this.api('/watch/connect', { method: 'POST', body: JSON.stringify({ apiUrl: st.apiUrl.trim() }) });
        st.connected = true; st.apiUrl = r.apiUrl;
        this.notify('Connected to ' + r.apiUrl);
      } catch (e) { st.err = e.message; }
      finally { st.busy = false; }
    },

    async notifyPush() {
      const st = this.nfy;
      st.busy = true; st.err = '';
      try {
        st.result = await this.api('/watch/notify', { method: 'POST',
          body: JSON.stringify({ provider: this.provider, serverType: st.plan }) });
        this.markWatched(st.plan);
      } catch (e) { st.err = e.message; }
      finally { st.busy = false; }
    },

    async notifyNtfy() {
      const st = this.nfy;
      if (!st.topic.trim()) { st.err = 'Enter an ntfy topic'; return; }
      st.busy = true; st.err = '';
      try {
        await this.api('/watch/ntfy', { method: 'POST', body: JSON.stringify({
          provider: this.provider, serverType: st.plan, topic: st.topic.trim(),
          server: st.server.trim() || undefined }) });
        this.markWatched(st.plan);
        this.notify('ntfy alert set for ' + st.plan + ' → topic ' + st.topic.trim());
        this.closeModal();
      } catch (e) { st.err = e.message; }
      finally { st.busy = false; }
    },
  };
}
