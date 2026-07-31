/**
 * What to do about the port we want, given what is holding it.
 *
 * Pure and separate because the interesting case is an interaction, not a step:
 * the background service pins `VOPS_PORT` so the installed app's origin stays
 * fixed, and an earlier version skipped the "is that other server one of ours?"
 * probe whenever the port was pinned. The service was therefore the single
 * configuration that could never recognise its own kind — it died on EADDRINUSE
 * and its supervisor respawned it every ten seconds, indefinitely.
 */
export type PortDecision =
  /** Nothing in the way. */
  | { kind: 'bind'; port: number }
  /** Another vops for this profile is already serving; hand over to it. */
  | { kind: 'adopt'; port: number }
  /** Same, but we are supervised: wait for it to stop and take over. */
  | { kind: 'standby'; port: number }
  /** A pinned port held by something that is not us. */
  | { kind: 'conflict'; port: number }
  /** Default port held by a stranger: take whatever the OS gives us. */
  | { kind: 'fallback' };

export interface PortSituation {
  desired: number;
  /** The port was pinned via VOPS_PORT rather than defaulted. */
  explicit: boolean;
  free: boolean;
  /** The holder answered /healthz as a vops on this same profile. */
  mine: boolean;
  /** We are a supervised service, so exiting is not an option. */
  standBy: boolean;
}

export function decidePort(s: PortSituation): PortDecision {
  if (s.free) return { kind: 'bind', port: s.desired };
  if (s.mine) return { kind: s.standBy ? 'standby' : 'adopt', port: s.desired };
  return s.explicit ? { kind: 'conflict', port: s.desired } : { kind: 'fallback' };
}
