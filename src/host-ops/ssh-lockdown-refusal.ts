import { AgentError, EnvelopeOptions, ExitCode, NextAction, agentError } from '../agent-api/agent-envelope';
import { AgentBadRequest } from '../agent-api/agent-http-errors';
import type { LockdownPreflight, LockdownRefusal } from './vops-ssh-lockdown.service';

/**
 * Envelope fields for a `host ssh-harden` preview whose preconditions refuse. The preview
 * stays a preview: the preflight is read here, never re-decided, and the payload still travels in
 * `data` so the user can see every blocker. What changes is the signal — a refusal rides in
 * `errors`, so the process leaves with 4 instead of the 0 a clean preview also returns.
 *
 * `prerequisite` and not `approval`: a refusing preflight is not waiting for consent, it is waiting
 * for a missing precondition (a proven personal key, root, a readable sshd config, a reachable
 * host). Answering 5 would tell an agent to re-run with `--yes`, which is the one thing that cannot
 * work — `disable()` refuses on the same blockers.
 *
 * The apply path's three outcomes live here too, because the first of them is the same
 * refusal on the same blockers and must not describe them differently: blocked (4), applied-and-not-
 * taken (1), applied-then-rolled-back (8). Three distinct codes because a bare
 * `BadRequestException` collapses all of them onto VOPS_OPERATION_FAILED/1, where a hardening that
 * was reverted on a live host reads as identical to never having touched it.
 */

export const SSH_HARDEN_REFUSED = 'VOPS_SSH_HARDEN_REFUSED';
export const SSH_HARDEN_NOT_APPLIED = 'VOPS_SSH_HARDEN_NOT_APPLIED';
export const SSH_HARDEN_ROLLED_BACK = 'VOPS_SSH_HARDEN_ROLLED_BACK';

interface Remedy {
  /** What has to change before hardening can be applied, in the user's words. */
  fix: string;
  /** Commands an agent may run unattended to get there. Never the apply itself. */
  next: (host: string) => NextAction[];
}

const connectionRemedy = (host: string): NextAction[] => [
  { command: `vops host status ${host} --json`, description: 'Probe the host: which layer fails, and whether sudo works' },
];

const REMEDIES: Record<string, Remedy> = {
  'not-ready': {
    fix: "restore vops's own SSH access to the host",
    next: connectionRemedy,
  },
  'no-sudo': {
    fix: 'give the login user passwordless sudo, without which a failed change cannot be rolled back',
    next: connectionRemedy,
  },
  'sshd-unreadable': {
    fix: 'make the effective sshd config readable as root (`sudo sshd -T`)',
    next: connectionRemedy,
  },
  'no-user-key': {
    fix: 'assign the key you log in with yourself, so disabling passwords cannot lock you out',
    next: (host) => [
      { command: 'vops ssh-key list --json', description: 'Find the local key you log in with' },
      { command: `vops host key set ${host} <key> --json`, description: 'Pin that key to the host, then run this preview again' },
    ],
  },
  'user-key-unverified': {
    fix: 'repair your own key until it authenticates on its own',
    next: (host) => [
      { command: `vops host key status ${host} --json`, description: 'See which key vops uses and whether the host authorizes it' },
      { command: 'vops ssh-key list --json', description: 'Pick another local key if that one is gone' },
    ],
  },
  'password-logins': {
    fix: 'give those accounts SSH keys, or have the user accept locking them out',
    next: (host) => [
      { command: `vops host ssh-harden ${host} --json`, description: 'Re-check once those accounts no longer log in with a password' },
    ],
  },
};

const FALLBACK_FIX = 'clear the blockers listed in `refusals`';

export function preflightRefusal(pre: LockdownPreflight): EnvelopeOptions {
  if (pre.alreadyHardened || !pre.refusals.length) return {};
  return {
    errors: [refusalError(pre.host, pre.refusals, pre.overridable, 'preview')],
    nextActions: refusalNextActions(pre.host, pre.refusals),
  };
}

/**
 * `--yes` refused by the same blockers. Same code, category and exit as the preview: the
 * apply must not describe the state differently from the preview that predicted it, and the
 * blockers are still missing preconditions rather than missing consent. An `AgentBadRequest` and
 * not an `AgentFailure` because `disable()` also serves `POST /api/hosts/:name/ssh-lockdown`,
 * where the dashboard reads the message off an HTTP 400.
 */
export function hardenBlocked(host: string, blocking: LockdownRefusal[], overridable: boolean): AgentBadRequest {
  return new AgentBadRequest(refusalError(host, blocking, overridable, 'apply'), ExitCode.MISSING_PREREQUISITE);
}

/** The apply ran and did not take: the drop-in was not written or sshd refused it, the dead-man was
 * cancelled, and the host is exactly as it was. Distinct from a rollback, where the change DID take
 * effect before being reverted — and from a generic failure, which said nothing about either. */
export function hardenNotApplied(host: string, reason: string): AgentBadRequest {
  return new AgentBadRequest(
    agentError(SSH_HARDEN_NOT_APPLIED, 'operational', `SSH hardening was not applied on '${host}' — nothing changed: ${reason}`, {
      suggestedAction:
        'Password login is still on and the host is untouched, so there is nothing to undo. Read the reason, ' +
        `fix it on the host, then preview again with \`vops host ssh-harden ${host} --json\`.`,
    }),
    ExitCode.FAILURE,
  );
}

/** Applied, verified, found wanting, reverted. Exit 8 (partial), not 1: sshd was reconfigured and
 * reloaded twice on a live host, so the outcome has to be read rather than retried — and it must not
 * read the same as "nothing was ever touched". */
export function hardenRolledBack(host: string, reason: string): AgentBadRequest {
  return new AgentBadRequest(
    agentError(
      SSH_HARDEN_ROLLED_BACK,
      'operational',
      `Hardening was applied on '${host}' and then rolled back — the post-apply check failed (${reason}). Password login is back on.`,
      {
        suggestedAction:
          'Do not retry unchanged: the change took effect and was reverted, so the host is back to password login. ' +
          `Confirm the state with \`vops host status ${host} --json\` and \`vops host ssh-harden ${host} --json\`, ` +
          'and tell the user what failed the check before trying again.',
      },
    ),
    ExitCode.PARTIAL,
  );
}

function refusalError(
  host: string,
  refusals: LockdownRefusal[],
  overridable: boolean,
  stage: 'preview' | 'apply',
): AgentError {
  return agentError(
    SSH_HARDEN_REFUSED,
    'prerequisite',
    `Refusing to disable password login on '${host}': ${refusals.map((r) => r.message).join(' ')}`,
    // Not recoverable by the agent: every remedy is on the host or is the user accepting a
    // lock-out risk for someone else's account.
    { recoverable: false, suggestedAction: suggestedAction(host, refusals, overridable, stage) },
  );
}

function suggestedAction(
  host: string,
  refusals: LockdownRefusal[],
  overridable: boolean,
  stage: 'preview' | 'apply',
): string {
  const fixes = unique(refusals.map((r) => REMEDIES[r.code]?.fix ?? FALLBACK_FIX));
  const override = overridable
    ? ' Only the user can decide to proceed regardless, accepting that those accounts lose access, with --override --yes.'
    : '';
  const lead =
    stage === 'apply'
      ? `Nothing was changed. Do not retry with --yes: ${fixes.join('; ')}, then preview again with \`vops host ssh-harden ${host} --json\`.`
      : `Do not retry unchanged and do not pass --yes: ${fixes.join('; ')}, then run this preview again.`;
  return `${lead}${override}`;
}

function refusalNextActions(host: string, refusals: LockdownRefusal[]): NextAction[] {
  const all = refusals.flatMap((r) => REMEDIES[r.code]?.next(host) ?? connectionRemedy(host));
  return all.filter((a, i) => all.findIndex((b) => b.command === a.command) === i);
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
