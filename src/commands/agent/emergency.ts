import { Args, Command, Flags } from '@oclif/core';
import { withApp } from '../../agent-api/agent-nest';
import { AgentSafetyState } from '../../agent-control/agent-safety-state';
import { AgentSessionManager } from '../../agent-control/agent-session-manager';

export default class AgentEmergencyCommand extends Command {
  static readonly description =
    'Inspect, activate, or locally clear the persistent agent-mutation emergency stop.';
  static readonly args = {
    action: Args.string({ required: true, options: ['status', 'stop', 'clear'] }),
  };
  static readonly flags = {
    reason: Flags.string({ default: 'Requested from the local vOps CLI.' }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AgentEmergencyCommand);
    const result = await withApp(async (app) => {
      const safety = app.get(AgentSafetyState);
      if (args.action === 'status') return safety.current();
      if (args.action === 'clear') {
        return safety.clear('local_user', flags.reason);
      }
      const stop = await safety.activate('local_user', flags.reason);
      const sessions = await app.get(AgentSessionManager).stopAll();
      return { emergencyStop: stop, stoppedSessions: sessions.map((entry) => entry.id) };
    });
    this.log(JSON.stringify(result, null, 2));
  }
}
