function dashboardAgentControl() {
  return {
    agentControl: {
      mode: 'advisory', sessions: [], approvals: [], plans: [], operations: [], events: [], capabilities: [],
      activity: [], clients: [], emergencyStop: { active: false }, eventsCursor: null,
      providers: [], providerPolicy: { defaultProvider: 'codex', fallbackOrder: [], deterministicFallback: true },
    },
    async loadAgentControl() {
      this.beginLoad(); this.error = '';
      // `loaded` distinguishes "no agent is wired" from "we have not asked yet", so the
      // first-run card cannot flash on top of a working install during the first fetch.
      try { this.agentControl = { ...await this.api('/agent/overview'), loaded: true }; }
      catch (e) { this.error = e.message; }
      finally {
        this.endLoad();
        clearTimeout(this._agentTimer);
        if (this.view === 'agents') this._agentTimer = setTimeout(() => this.loadAgentControl(), 3000);
      }
    },
    activeAgentSessions() {
      return this.agentControl.sessions.filter(s => ['active', 'paused'].includes(s.status));
    },
    pendingAgentApprovals() {
      return this.agentControl.approvals.filter(a => a.status === 'pending');
    },
    agentPlan(id) {
      return this.agentControl.plans.find(plan => plan.id === id);
    },
    async agentSessionAction(id, action) {
      try {
        await this.api('/agent/sessions/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: '{}' });
        this.notify('Session ' + action + 'd');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async stopAllAgentSessions() {
      if (!confirm('Stop everything?\n\nThis revokes every session AND blocks all future agent mutations until you release it. It survives a restart.')) return;
      try {
        await this.api('/agent/sessions/stop-all', { method: 'POST', body: '{}' });
        this.notify('Emergency stop on — agent mutations are blocked');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async revokeAllAgentSessions() {
      try {
        await this.api('/agent/sessions/revoke-all', { method: 'POST', body: '{}' });
        this.notify('All agent sessions revoked');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async clearAgentEmergencyStop() {
      try {
        await this.api('/agent/sessions/clear-emergency-stop', {
          method: 'POST', body: JSON.stringify({ reason: 'Released from the local dashboard' }),
        });
        this.notify('Emergency stop released');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    /** The four buckets the policy engine actually evaluates, in the order it checks them. */
    agentPermissionGroups(session) {
      const describe = ids => ids.map(id => ({ id, action: this.agentCapabilityAction(id) }));
      return [
        {
          key: 'allow', label: 'Can do right now', revocable: true, style: 'color:var(--ok)',
          hint: 'No approval asked. These run as soon as the agent requests them.',
          entries: describe(session.permissions.allow),
        },
        {
          key: 'plan', label: 'Only inside a plan you approved', revocable: true, style: 'color:var(--warn)',
          hint: 'The agent must propose a plan and you must approve that exact plan first.',
          entries: describe(session.permissions.allowWithinApprovedPlan),
        },
        {
          key: 'approval', label: 'Needs your explicit approval', revocable: true, style: 'color:var(--warn)',
          hint: 'Each of these raises its own approval request before anything happens.',
          entries: describe(session.permissions.requireApproval),
        },
        {
          key: 'deny', label: 'Refused outright', revocable: false, style: 'color:var(--danger)',
          hint: 'Refused whatever the agent asks and whatever you approve.',
          entries: describe(session.permissions.deny),
        },
      ];
    },
    agentSpendLeft(session) {
      const cap = session.limits.maxProviderSpendEur;
      if (!cap) return '€ 0';
      const used = session.providerSpendEur || 0;
      return '€ ' + Math.max(0, cap - used).toFixed(2) + ' of ' + cap.toFixed(2) + ' / month';
    },
    agentSessionExpiry(session) {
      const left = Date.parse(session.limits.expiresAt) - Date.now();
      if (left <= 0) return 'expired';
      if (left < 3600000) return 'in ' + Math.max(1, Math.round(left / 60000)) + ' min';
      return 'in ' + Math.round(left / 360000) / 10 + ' h';
    },
    async narrowAgentSession(id, narrow) {
      try {
        await this.api('/agent/sessions/' + encodeURIComponent(id) + '/narrow', {
          method: 'POST', body: JSON.stringify(narrow),
        });
        this.notify('Session narrowed');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async decideAgentApproval(id, decision) {
      try {
        await this.api('/agent/approvals/' + encodeURIComponent(id) + '/' + decision, {
          method: 'POST', body: JSON.stringify({ reason: decision + 'd in local dashboard' }),
        });
        this.notify('Approval ' + decision + 'd');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async cancelAgentOperation(id) {
      try {
        await this.api('/agent/operations/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: '{}' });
        this.notify('Cancellation requested');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async agentProviderAction(id, action) {
      try {
        await this.api('/agent/providers/' + encodeURIComponent(id) + '/' + action, {
          method: 'POST', body: '{}',
        });
        this.notify('Provider policy updated');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async agentProviderFallback(id, include) {
      const current = this.agentControl.providerPolicy.fallbackOrder || [];
      const providers = include
        ? [...new Set([...current, id])]
        : current.filter(provider => provider !== id);
      try {
        await this.api('/agent/providers/fallback', {
          method: 'POST',
          body: JSON.stringify({
            providers,
            deterministicFallback: this.agentControl.providerPolicy.deterministicFallback,
          }),
        });
        this.notify('Fallback contract updated');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
    async toggleDeterministicAgentFallback() {
      try {
        await this.api('/agent/providers/fallback', {
          method: 'POST',
          body: JSON.stringify({
            providers: this.agentControl.providerPolicy.fallbackOrder || [],
            deterministicFallback: !this.agentControl.providerPolicy.deterministicFallback,
          }),
        });
        this.notify('Deterministic fallback updated');
        await this.loadAgentControl();
      } catch (e) { this.notify(e.message, 'error'); }
    },
  };
}
