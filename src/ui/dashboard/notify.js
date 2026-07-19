// "Notify me" — routes to the vops-landing API (via the local-api proxy), the
// same backend the hosted app uses. Three peer channels, matching the landing:
// Telegram, ntfy, and Web Push (the vops notification app, via an activation
// URL/QR you open on your phone). No local delivery.
const TG_POLL_MS = 3000;
const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

/**
 * Suggest a topic so nobody has to invent one to get an alert.
 *
 * The random suffix is not decoration: ntfy.sh has no authentication, so the
 * topic NAME is the only thing standing between these alerts and anyone who
 * guesses it. Hence 40 bits from the CSPRNG rather than Math.random().
 */
function suggestTopic(provider, plan) {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const rnd = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return ('vops-' + provider + '-' + plan + '-' + rnd).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * `mode` decides what the chosen channel is attached to:
 *  - 'watch'   → an availability alert for a plan (target = plan name)
 *  - 'monitor' → the dead-man monitor for a host (target = host name)
 * Web Push is offered in 'watch' mode only — a host
 * monitor needs an activated `deviceId`, which nothing in vops can obtain yet.
 */
function emptyNotifyState(mode = 'watch', target = '', topic = '') {
  return {
    mode, plan: target, host: target,
    tab: 'telegram', topic, server: NTFY_DEFAULT_SERVER, apiUrl: '',
    connected: false, busy: false, result: null, err: '',
    tg: { code: '', url: '', qr: '', linked: false, timer: null },
  };
}

function dashboardNotify() {
  return {
    nfy: emptyNotifyState(),

    async openNotify(plan) {
      await this.openChannelPicker('watch', plan, suggestTopic(this.provider, plan), 'Notify me — ' + plan);
    },

    /** Same picker, attached to a host's dead-man monitor instead of a plan. */
    async openMonitorChannel(hostName) {
      await this.openChannelPicker('monitor', hostName, suggestTopic('host', hostName), 'Monitor alerts — ' + hostName);
    },

    async openChannelPicker(mode, target, topic, title) {
      this.stopTelegramPoll();
      this.nfy = emptyNotifyState(mode, target, topic);
      this.modal = { ...this.modal, open: true, type: 'notify', title, cta: '', danger: false, dryRun: false };
      try {
        const s = await this.api('/watch/status');
        this.nfy.connected = !!s.connected;
        this.nfy.apiUrl = s.apiUrl || '';
      } catch (e) { this.nfy.err = e.message; }
    },

    async applyChannel(channel) {
      const st = this.nfy;
      if (st.mode === 'monitor') {
        await this.api('/hosts/' + encodeURIComponent(st.host) + '/monitor', {
          method: 'POST', body: JSON.stringify({ channels: [channel] }),
        });
        if (typeof this.loadHosts === 'function') await this.loadHosts();
        this.notify('Monitoring on · ' + st.host);
        return;
      }
      if (channel.type === 'telegram') {
        await this.api('/watch/telegram', { method: 'POST', body: JSON.stringify({
          provider: this.provider, serverType: st.plan, linkCode: channel.linkCode }) });
        this.notify('Telegram alert set for ' + st.plan);
      } else {
        await this.api('/watch/ntfy', { method: 'POST', body: JSON.stringify({
          provider: this.provider, serverType: st.plan, topic: channel.topic, server: channel.server }) });
        this.notify('ntfy alert set for ' + st.plan + ' → topic ' + channel.topic);
      }
      this.markWatched(st.plan);
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

    pickChannel(tab) {
      if (this.nfy.tab === 'telegram' && tab !== 'telegram') this.stopTelegramPoll();
      this.nfy.tab = tab;
    },

    stopTelegramPoll() {
      if (this.nfy?.tg?.timer) clearInterval(this.nfy.tg.timer);
      if (this.nfy?.tg) this.nfy.tg.timer = null;
    },

    async telegramConnect() {
      const st = this.nfy;
      st.busy = true; st.err = '';
      try {
        const link = await this.api('/watch/telegram/link', { method: 'POST' });
        if (!link.url) throw new Error('Telegram bot not configured on the landing — try another channel.');
        st.tg = { ...st.tg, code: link.code, url: link.url, qr: link.qr || '', linked: false };
        this.pollTelegram();
      } catch (e) { st.err = e.message; }
      finally { st.busy = false; }
    },

    pollTelegram() {
      const st = this.nfy;
      this.stopTelegramPoll();
      st.tg.timer = setInterval(async () => {
        try {
          const { linked } = await this.api('/watch/telegram/link/' + encodeURIComponent(st.tg.code));
          if (!linked) return;
          this.stopTelegramPoll();
          st.tg.linked = true;
          await this.applyChannel({ type: 'telegram', linkCode: st.tg.code });
          this.closeModal();
        } catch (e) {
          this.stopTelegramPoll();
          st.err = e.message;
          st.tg.linked = false;
        }
      }, TG_POLL_MS);
    },

    async notifyNtfy() {
      const st = this.nfy;
      if (!st.topic.trim()) { st.err = 'Enter an ntfy topic'; return; }
      st.busy = true; st.err = '';
      try {
        await this.applyChannel({
          type: 'ntfy',
          topic: st.topic.trim(),
          server: st.server.trim() || undefined,
        });
        this.closeModal();
      } catch (e) { st.err = e.message; }
      finally { st.busy = false; }
    },
  };
}
