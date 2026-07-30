import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import type { Command } from '@oclif/core';
import { ExitCode } from '../src/agent-api/agent-envelope';
import { runAgentCommand, toFailure } from '../src/agent-api/agent-output';
import { loadAppPlan } from '../src/apps/app-source';

/**
 * Planning a `kind: Application` manifest with no image names two remedies to a human, and the
 * envelope has to carry them both. `VOPS_OPERATION_FAILED` / `operational` / exit 1 with
 * `suggestedAction: null` says "it broke, maybe transient" and invites a retry that can never
 * succeed. It is an *input* error: the manifest is right, the invocation is incomplete.
 */

const APPLICATION = `apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: my-api
build:
  strategy: dockerfile
  dockerfile: ./Dockerfile
deploy:
  port: 3000
`;

/** A real catalog manifest, so the control is the shape vops actually ships. */
const CATALOG_APP = path.join(__dirname, '..', 'src', 'apps', 'catalog', 'it-tools.flui.yaml');

function manifest(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-f51-'));
  const file = path.join(dir, 'flui.yaml');
  fs.writeFileSync(file, body);
  return file;
}

const noCatalog = () => null;

function thrownBy(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (err) {
    return err;
  }
}

describe('an Application manifest planned without --image', () => {
  const file = manifest(APPLICATION);

  it('is an input error with both remedies in suggestedAction, not a generic operational failure', () => {
    const failure = toFailure(thrownBy(() => loadAppPlan({ file }, noCatalog)));

    expect({ code: failure.error.code, category: failure.error.category, exit: failure.exitCode }).toEqual({
      code: 'VOPS_IMAGE_REQUIRED',
      category: 'input',
      exit: ExitCode.INVALID_INPUT,
    });
    expect(failure.error.recoverable).toBe(true);
    expect(failure.error.suggestedAction).toContain('--image');
    expect(failure.error.suggestedAction).toContain('vops build run');
    expect(failure.error.documentation).toContain('#vops_image_required');
  });

  it('keeps the message that already named the remedies', () => {
    const failure = toFailure(thrownBy(() => loadAppPlan({ file }, noCatalog)));
    expect(failure.error.message).toContain('carries no image');
  });

  it('refuses a blank --image the same way', () => {
    expect(toFailure(thrownBy(() => loadAppPlan({ file, image: '   ' }, noCatalog))).error.code).toBe('VOPS_IMAGE_REQUIRED');
  });

  it('stays an HTTP 400 for the local API', () => {
    const err = thrownBy(() => loadAppPlan({ file }, noCatalog));
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getStatus()).toBe(400);
  });

  it('plans normally once the image is supplied', () => {
    const { plan } = loadAppPlan({ file, image: 'ghcr.io/me/my-api:abc1234' }, noCatalog);
    expect(plan.components[0].image).toBe('ghcr.io/me/my-api:abc1234');
  });

  it('never fires for a CatalogApp, whose image ships with the manifest', () => {
    const { plan } = loadAppPlan({ file: CATALOG_APP }, noCatalog);
    expect(plan.components[0].image).toBeTruthy();
  });
});

/** The exit code is what a caller branches on, so pin it at the boundary the command uses. */
describe('the envelope `deploy plan` emits for it', () => {
  class FakeExit extends Error {
    constructor(readonly code: number) {
      super(`exit ${code}`);
    }
  }

  const fakeCommand = () => {
    const out: string[] = [];
    const cmd = {
      id: 'deploy:plan',
      log: (line = '') => {
        out.push(line);
      },
      exit: (code = 0): never => {
        throw new FakeExit(code);
      },
      error: (_m: string, opts: { exit?: number } = {}): never => {
        throw new FakeExit(opts.exit ?? 2);
      },
    };
    return { cmd: cmd as unknown as Command, out };
  };

  it('is one error envelope, exit 2, with the remedies attached', async () => {
    const file = manifest(APPLICATION);
    const { cmd, out } = fakeCommand();
    let code: number = ExitCode.SUCCESS;
    try {
      await runAgentCommand(
        cmd,
        'vops deploy plan',
        true,
        async () => ({ data: loadAppPlan({ file }, noCatalog).plan }),
        () => undefined,
      );
    } catch (err) {
      if (!(err instanceof FakeExit)) throw err;
      code = err.code;
    }

    const env = JSON.parse(out.join('\n'));
    expect(code).toBe(ExitCode.INVALID_INPUT);
    expect(env.status).toBe('error');
    expect(env.requiresApproval).toBe(false);
    expect(env.errors[0].code).toBe('VOPS_IMAGE_REQUIRED');
    expect(env.errors[0].suggestedAction).toBeTruthy();
  });
});
