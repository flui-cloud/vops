function dashboardAgentClients() {
  return {
    agentClientLabels: {
      codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', antigravity: 'Antigravity',
    },
    /** Picker state. `client` is null until one is chosen, which is also what keeps
     * the Continue button honest on step 1. */
    connect: { open: false, step: 1, client: null, checking: false },

    agentClientLabel(client) {
      return this.agentClientLabels[client] || client;
    },
    agentClientIcon(client) {
      return 'assets/agent-icons/' + client + '.svg';
    },
    agentClientInstalled(scope) {
      return Boolean(scope?.skill && scope?.mcp);
    },
    agentClientEntry(client) {
      return (this.agentControl.clients || []).find(entry => entry.client === client) || null;
    },
    connectedAgentClients() {
      return (this.agentControl.clients || [])
        .filter(entry => this.agentClientInstalled(entry.project) || this.agentClientInstalled(entry.user))
        .length;
    },
    /** Agents present on this machine, whether or not vops is wired into them. Read
     * from the USER scope: the dashboard has no repository context, and the funnel
     * recommends `--scope user`, so `~` is the root that answers the question. */
    agentClientPresent(entry) {
      return Boolean(entry?.user?.detected);
    },
    detectedAgentClients() {
      return (this.agentControl.clients || []).filter(entry => this.agentClientPresent(entry)).length;
    },
    /** Present first: the list is a shortlist, not a catalogue. */
    orderedAgentClients() {
      return [...(this.agentControl.clients || [])]
        .sort((a, b) => Number(this.agentClientPresent(b)) - Number(this.agentClientPresent(a)));
    },
    agentClientScopeLabel(entry) {
      if (this.agentClientInstalled(entry.user)) return 'user-wide';
      if (this.agentClientInstalled(entry.project)) return 'this project';
      return this.agentClientPresent(entry) ? 'detected' : 'not installed';
    },

    openAgentConnect() {
      const first = this.orderedAgentClients()[0];
      this.connect = { open: true, step: 1, client: this.agentClientPresent(first) ? first.client : null, checking: false };
    },
    closeAgentConnect() { this.connect.open = false; },
    pickAgentClient(client) { this.connect.client = client; },
    agentConnectNext() { if (this.connect.client) this.connect.step = 2; },
    agentConnectBack() { this.connect.step = 1; },

    /** The command the user runs themselves. vops never writes into an agent's own
     * config from the dashboard — a command is auditable and works with no UI open. */
    agentSetupCommand(client) {
      return 'vops agent setup ' + client + ' --scope user';
    },
    /** The three files that command touches, read from the server's own report so
     * this can never drift from what `agent setup` actually does. */
    agentConnectPaths(client) {
      const paths = this.agentClientEntry(client)?.user?.paths;
      if (!paths) return [];
      return [
        { part: 'skill', path: paths.skillDir },
        { part: 'mcp', path: paths.configFile },
        { part: 'bootstrap', path: paths.bootstrapFile },
      ];
    },
    async agentConnectCheck() {
      this.connect.checking = true;
      try {
        await this.loadAgentControl();
        const entry = this.agentClientEntry(this.connect.client);
        if (entry && (this.agentClientInstalled(entry.user) || this.agentClientInstalled(entry.project))) {
          this.notify(this.agentClientLabel(this.connect.client) + ' is connected');
          this.connect.open = false;
        } else {
          this.notify('Not wired yet — run the command, then check again', 'error');
        }
      } catch (e) { this.notify(e.message, 'error'); } finally { this.connect.checking = false; }
    },
    async copyAgentCommand(client) {
      try {
        await navigator.clipboard.writeText(this.agentSetupCommand(client));
        this.notify('Command copied');
      } catch { this.notify('Could not copy — select the command instead', 'error'); }
    },
  };
}
