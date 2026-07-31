import { Injectable, OnModuleInit } from '@nestjs/common';
import { AgentStore } from './agent-store';
import { localId } from './ids';

const SETTING = 'emergency_stop';

export interface AgentEmergencyStop {
  active: boolean;
  activatedAt?: string;
  activatedBy?: string;
  reason?: string;
  clearedAt?: string;
  clearedBy?: string;
}

@Injectable()
export class AgentSafetyState implements OnModuleInit {
  private value: AgentEmergencyStop = { active: false };

  constructor(private readonly store: AgentStore) {}

  async onModuleInit(): Promise<void> {
    this.value = (await this.store.getSetting<AgentEmergencyStop>(SETTING)) ?? { active: false };
  }

  current(): AgentEmergencyStop {
    return structuredClone(this.value);
  }

  async activate(actor: string, reason: string): Promise<AgentEmergencyStop> {
    if (this.value.active) return this.current();
    this.value = {
      active: true,
      activatedAt: new Date().toISOString(),
      activatedBy: actor,
      reason: reason.slice(0, 500),
    };
    await this.store.setSetting(SETTING, this.value);
    await this.event('agent.emergency_stop.activated', actor, 'Agent emergency stop activated.');
    return this.current();
  }

  async clear(actor: string, reason: string): Promise<AgentEmergencyStop> {
    this.value = {
      active: false,
      activatedAt: this.value.activatedAt,
      activatedBy: this.value.activatedBy,
      reason: this.value.reason,
      clearedAt: new Date().toISOString(),
      clearedBy: actor,
    };
    await this.store.setSetting(SETTING, this.value);
    await this.event('agent.emergency_stop.cleared', actor, `Agent emergency stop cleared: ${reason.slice(0, 240)}`);
    return this.current();
  }

  private async event(eventType: string, actor: string, summary: string): Promise<void> {
    await this.store.appendEvent({
      eventId: localId('evt'),
      timestamp: new Date().toISOString(),
      actor,
      eventType,
      summary,
      detail: this.value,
    });
  }
}
