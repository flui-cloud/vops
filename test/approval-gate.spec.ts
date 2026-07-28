import { ForbiddenException } from '@nestjs/common';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { toFailure } from '../src/agent-api/agent-output';
import { AgentBadRequest, notFound } from '../src/agent-api/agent-http-errors';
import { assertApproved } from '../src/safety/approval-gate';

/**
 * The gate lives in the service layer so a command cannot forget it. These
 * assert the contract an agent branches on — exit code and category — because a
 * gate that refuses with the wrong code is a gate an agent will try to retry
 * around.
 */
describe('approval gate', () => {
  it('lets an approved operation through', () => {
    expect(() => assertApproved({ operation: 'deploy', target: 'web1', approved: true })).not.toThrow();
  });

  it('refuses with APPROVAL_REQUIRED and names the target', () => {
    let thrown: unknown;
    try {
      assertApproved({ operation: 'Plan abc123', target: 'web1', approved: false });
    } catch (err) {
      thrown = err;
    }
    const failure = toFailure(thrown);
    expect(failure.exitCode).toBe(ExitCode.APPROVAL_REQUIRED);
    expect(failure.error.code).toBe('VOPS_APPROVAL_REQUIRED');
    expect(failure.error.category).toBe('approval');
    expect(failure.error.message).toContain('web1');
  });

  it('marks the refusal unrecoverable — retrying never produces consent', () => {
    const failure = toFailure(caught(() => assertApproved({ operation: 'delete server', target: 'vops-x', approved: false })));
    expect(failure.error.recoverable).toBe(false);
    expect(failure.error.suggestedAction).toBeDefined();
  });

  it('carries the consequence into the message the user is shown', () => {
    const failure = toFailure(
      caught(() =>
        assertApproved({ operation: 'restore', target: 'web1', approved: false, consequence: 'It overwrites live data.' }),
      ),
    );
    expect(failure.error.message).toContain('It overwrites live data.');
  });
});

describe('failure translation', () => {
  it('gives an unknown id INVALID_INPUT, not a generic operational 1', () => {
    const failure = toFailure(notFound('VOPS_APP_NOT_FOUND', "No app install named 'x'.", 'Run `vops app list --json`.'));
    expect(failure.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(failure.error.code).toBe('VOPS_APP_NOT_FOUND');
    expect(failure.error.suggestedAction).toBe('Run `vops app list --json`.');
  });

  it('keeps AgentBadRequest a BadRequestException, so the local API still answers 400', () => {
    // Both callers share these services: the CLI needs the structured record,
    // the HTTP layer needs the Nest exception. Losing either breaks one of them.
    expect(notFound('X', 'gone', 'look').getStatus()).toBe(400);
    expect(notFound('X', 'gone', 'look')).toBeInstanceOf(AgentBadRequest);
  });

  it('translates the ownership refusal into an unrecoverable input error', () => {
    const failure = toFailure(new ForbiddenException("Refusing to delete server 'other': it was not created by vops."));
    expect(failure.exitCode).toBe(ExitCode.INVALID_INPUT);
    expect(failure.error.code).toBe('VOPS_NOT_VOPS_MANAGED');
    expect(failure.error.recoverable).toBe(false);
  });

  it('leaves a bare BadRequestException generic', () => {
    // The services raise it for bad input, missing prerequisites, unconfirmed
    // writes and unreachable hosts alike. Any single category would be a lie.
    const { BadRequestException } = jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
    const failure = toFailure(new BadRequestException('nftables is not installed'));
    expect(failure.exitCode).toBe(ExitCode.FAILURE);
    expect(failure.error.code).toBe('VOPS_OPERATION_FAILED');
  });
});

function caught(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}
