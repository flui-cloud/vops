function dashboardAgentActivity() {
  return {
    expandedAgentActivity: '',
    expandedAgentSession: '',
    agentActivityFilter: { session: '', outcome: '', verification: '' },

    toggleAgentActivity(id) {
      this.expandedAgentActivity = this.expandedAgentActivity === id ? '' : id;
    },
    toggleAgentSession(id) {
      this.expandedAgentSession = this.expandedAgentSession === id ? '' : id;
    },
    filteredAgentActivity() {
      const f = this.agentActivityFilter;
      return (this.agentControl.activity || []).filter(row =>
        (!f.session || row.sessionId === f.session) &&
        (!f.outcome || row.outcome === f.outcome) &&
        (!f.verification || row.verification === f.verification));
    },
    agentDuration(ms) {
      if (ms < 1000) return ms + ' ms';
      if (ms < 60000) return Math.round(ms / 100) / 10 + ' s';
      return Math.round(ms / 6000) / 10 + ' min';
    },
    agentVerificationLabel(row) {
      if (row.verification === 'passed') return 'verified healthy';
      if (row.verification === 'not_verified') return 'not verified';
      if (row.failedChecks.length) return 'verification ' + row.verification + ': ' + row.failedChecks.join(', ');
      return 'verification ' + row.verification;
    },
    agentOutcomeStyle(outcome) {
      if (outcome === 'succeeded') return 'color:var(--ok)';
      if (outcome === 'failed') return 'color:var(--danger)';
      return 'color:var(--text-faint)';
    },
    agentVerificationStyle(verification) {
      if (verification === 'passed') return 'color:var(--ok)';
      if (verification === 'failed') return 'color:var(--danger)';
      if (verification === 'degraded') return 'color:var(--warn)';
      return 'color:var(--text-faint)';
    },
    agentRiskStyle(risk) {
      if (risk === 'destructive' || risk === 'high') return 'color:var(--danger)';
      if (risk === 'medium') return 'color:var(--warn)';
      return 'color:var(--text-faint)';
    },
    agentCapabilityAction(id) {
      const found = (this.agentControl.capabilities || []).find(entry => entry.id === id);
      return found ? found.action : id;
    },
    agentStepSubject(step) {
      const input = step.input || {};
      return ['host', 'target', 'name', 'id'].map(key => input[key]).find(v => typeof v === 'string' && v) || '';
    },
    agentEmergencySince() {
      const at = this.agentControl.emergencyStop && this.agentControl.emergencyStop.activatedAt;
      return at ? new Date(at).toLocaleString() : 'earlier';
    },
  };
}
