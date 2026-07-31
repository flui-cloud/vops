function dashboardAgentAudit() {
  return {
    agentAuditSession: '',
    agentAuditLoading: false,
    // Pages fetched past the first one. The overview keeps refreshing the head of the
    // timeline every few seconds, so older pages are held separately or a refresh
    // would throw them away mid-scroll.
    agentAuditOlder: [],
    agentAuditOlderCursor: undefined,

    agentAuditEvents() {
      const head = (this.agentControl.events || [])
        .filter(event => !this.agentAuditSession || event.sessionId === this.agentAuditSession);
      const seen = new Set(head.map(event => event.eventId));
      return [...head, ...this.agentAuditOlder.filter(event => !seen.has(event.eventId))];
    },
    agentAuditCursor() {
      return this.agentAuditOlderCursor === undefined
        ? (this.agentControl.eventsCursor ?? null)
        : this.agentAuditOlderCursor;
    },
    async reloadAgentAudit() {
      this.agentAuditOlder = [];
      this.agentAuditOlderCursor = undefined;
      if (!this.agentAuditSession) return;
      await this.loadMoreAgentAudit();
    },
    async loadMoreAgentAudit() {
      const cursor = this.agentAuditCursor();
      if (this.agentAuditLoading || (cursor === null && this.agentAuditOlder.length)) return;
      this.agentAuditLoading = true;
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (cursor !== null && cursor !== undefined) params.set('before', String(cursor));
        if (this.agentAuditSession) params.set('session', this.agentAuditSession);
        const page = await this.api('/agent/events?' + params.toString());
        this.agentAuditOlder = [...this.agentAuditOlder, ...page.events];
        this.agentAuditOlderCursor = page.nextCursor;
      } catch (e) { this.notify(e.message, 'error'); }
      finally { this.agentAuditLoading = false; }
    },
    /** Infinite scroll without an Alpine plugin: the tail element reports itself. */
    observeAgentAuditTail(el) {
      if (this._agentAuditObserver || typeof IntersectionObserver === 'undefined') return;
      this._agentAuditObserver = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        if (this.view !== 'agents' || this.agentAuditCursor() === null) return;
        this.loadMoreAgentAudit();
      }, { rootMargin: '200px' });
      this._agentAuditObserver.observe(el);
    },
  };
}
