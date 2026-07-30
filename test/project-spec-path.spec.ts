import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { specPath } from '../src/agent-api/agent-project';
import { VopsAgentApiService } from '../src/agent-api/vops-agent-api.service';
import { VopsBuildService } from '../src/build/vops-build.service';
import { sha256 } from '../src/agent-api/plan-store';
import { WORKFLOW_PATH } from '../src/build/github-workflow';

const manifest = (dockerfile: string) => `apiVersion: flui.cloud/v1beta1
kind: Application
metadata:
  name: my-api
build:
  strategy: dockerfile
  dockerfile: ${dockerfile}
deploy:
  port: 3000
`;

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vops-specpath-'));
}

/** A decoy `flui.yaml` in the process CWD: the whole point is that `--project` wins over it. */
function decoyCwd(): string {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'flui.yaml'), manifest('./Decoy.Dockerfile'), 'utf8');
  return dir;
}

async function inCwd<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

describe('specPath', () => {
  it('resolves a relative manifest against the project root, not the working directory', () => {
    expect(specPath('/srv/app', 'flui.yaml')).toBe(path.join('/srv/app', 'flui.yaml'));
    expect(specPath('/srv/app', 'deploy/flui.yaml')).toBe(path.join('/srv/app', 'deploy', 'flui.yaml'));
  });

  it('leaves an absolute manifest alone', () => {
    expect(specPath('/srv/app', '/elsewhere/flui.yaml')).toBe('/elsewhere/flui.yaml');
  });
});

describe('build setup with --project', () => {
  it('reads the manifest from the project root when --spec is left at its default', async () => {
    const project = tmpdir();
    fs.writeFileSync(path.join(project, 'flui.yaml'), manifest('./Api.Dockerfile'), 'utf8');

    const result = await inCwd(decoyCwd(), () =>
      new VopsBuildService().setup({ projectDir: project, specFile: 'flui.yaml', repo: 'me/app', branch: 'main' }),
    );

    expect(result.written).toBe(true);
    const yaml = fs.readFileSync(path.join(project, WORKFLOW_PATH), 'utf8');
    expect(yaml).toContain('file: ./Api.Dockerfile');
    expect(yaml).not.toContain('Decoy.Dockerfile');
  });
});

describe('deploy plan with --project', () => {
  it('hashes and deploys the project manifest, not one that happens to sit in the working directory', async () => {
    const project = tmpdir();
    const spec = path.join(project, 'flui.yaml');
    fs.writeFileSync(spec, manifest('./Api.Dockerfile'), 'utf8');

    const deploy = jest.fn().mockResolvedValue({ app: 'my-api', host: 'web1', kind: 'application', files: {}, secrets: [], endpoints: [] });
    const svc = new VopsAgentApiService({ deploy } as never);

    const created = await inCwd(decoyCwd(), () => svc.plan({ projectDir: project, spec: 'flui.yaml', host: 'web1', image: 'ghcr.io/me/app:1' }));

    expect(deploy).toHaveBeenCalledWith({ file: spec, image: 'ghcr.io/me/app:1' }, 'web1', expect.objectContaining({ dryRun: true }));
    const stored = JSON.parse(fs.readFileSync(created.file, 'utf8'));
    expect(stored.inputs.specHash).toBe(sha256(fs.readFileSync(spec)));
    expect(stored.inputs.spec).toBe('flui.yaml');
  });
});
