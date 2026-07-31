import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { RootController } from '../src/local-api/root.controller';
import { probeInstance } from '../src/local-api/instance-probe';
import { profileFingerprint, setRuntimeInfo } from '../src/local-api/runtime-info';
import { profileId } from '../src/lib/profile';
import { decidePort } from '../src/local-api/port-decision';

function serve(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('/healthz', () => {
  let base: string;
  const prevConfig = process.env.VOPS_CONFIG_DIR;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-health-'));
    process.env.VOPS_CONFIG_DIR = base;
  });

  afterEach(() => {
    if (prevConfig === undefined) delete process.env.VOPS_CONFIG_DIR;
    else process.env.VOPS_CONFIG_DIR = prevConfig;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('publishes identity without leaking the profile id itself', () => {
    setRuntimeInfo(7788);
    const body = new RootController().healthz();

    expect(body).toMatchObject({ ok: true, service: 'vops', port: 7788 });
    expect(typeof body.version).toBe('string');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);

    // profileId() tags this install's line in the authorized_keys of every server
    // it manages, and /healthz is readable by any local process: only the hash.
    const id = profileId();
    expect(body.profile).toHaveLength(12);
    expect(body.profile).not.toBe(id);
    expect(JSON.stringify(body)).not.toContain(id);
  });

  it('carries no host names, paths or vault state', () => {
    setRuntimeInfo(7788);
    expect(Object.keys(new RootController().healthz()).sort()).toEqual(
      ['ok', 'port', 'profile', 'service', 'startedAt', 'uptimeSeconds', 'version'],
    );
  });
});

describe('single-instance probe', () => {
  it('reports nothing when the port is closed', async () => {
    const { port, close } = await serve(() => undefined);
    await close();
    await expect(probeInstance(port, 200)).resolves.toBeNull();
  });

  it('ignores a stranger holding the port', async () => {
    const s = await serve((_req, res) => res.end('not vops at all'));
    await expect(probeInstance(s.port, 200)).resolves.toBeNull();
    await s.close();
  });

  it('ignores a JSON service that is not vops', async () => {
    const s = await serve((_req, res) => res.end(JSON.stringify({ service: 'grafana', profile: 'x' })));
    await expect(probeInstance(s.port, 200)).resolves.toBeNull();
    await s.close();
  });

  it('recognises another vops and reports its profile', async () => {
    const s = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: 'vops', profile: 'abc123abc123', version: '9.9.9' }));
    });
    await expect(probeInstance(s.port, 200)).resolves.toMatchObject({ service: 'vops', profile: 'abc123abc123' });
    await s.close();
  });

  it('gives up rather than hanging on a port that never answers', async () => {
    const s = await serve(() => {
      /* accept, then stay silent */
    });
    const started = Date.now();
    await expect(probeInstance(s.port, 150)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    await s.close();
  });
});

describe('profile fingerprint', () => {
  it('is stable for a profile and differs across profiles', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vops-fp-'));
    const prevConfig = process.env.VOPS_CONFIG_DIR;
    const prevProfile = process.env.VOPS_PROFILE;
    process.env.VOPS_CONFIG_DIR = base;
    try {
      process.env.VOPS_PROFILE = 'one';
      const first = profileFingerprint();
      expect(profileFingerprint()).toBe(first);

      process.env.VOPS_PROFILE = 'two';
      expect(profileFingerprint()).not.toBe(first);
    } finally {
      if (prevConfig === undefined) delete process.env.VOPS_CONFIG_DIR;
      else process.env.VOPS_CONFIG_DIR = prevConfig;
      if (prevProfile === undefined) delete process.env.VOPS_PROFILE;
      else process.env.VOPS_PROFILE = prevProfile;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('port decision', () => {
  const base = { desired: 7788, explicit: false, free: false, mine: false, standBy: false };

  it('binds when the port is free', () => {
    expect(decidePort({ ...base, free: true })).toEqual({ kind: 'bind', port: 7788 });
  });

  it('hands over to another vops of the same profile', () => {
    expect(decidePort({ ...base, mine: true })).toEqual({ kind: 'adopt', port: 7788 });
  });

  it('probes for its own kind even when the port was pinned', () => {
    // The regression: the background service pins VOPS_PORT, and skipping this
    // check for a pinned port made the service the one configuration that could
    // never recognise itself — it crashed on EADDRINUSE and was respawned every
    // ten seconds, forever.
    expect(decidePort({ ...base, explicit: true, mine: true })).toEqual({ kind: 'adopt', port: 7788 });
    expect(decidePort({ ...base, explicit: true, mine: true, standBy: true })).toEqual({ kind: 'standby', port: 7788 });
  });

  it('waits instead of exiting when supervised', () => {
    // Exiting would just get it respawned; waiting takes the port the moment the
    // other instance stops.
    expect(decidePort({ ...base, mine: true, standBy: true })).toEqual({ kind: 'standby', port: 7788 });
  });

  it('fails loudly on a pinned port held by a stranger', () => {
    expect(decidePort({ ...base, explicit: true })).toEqual({ kind: 'conflict', port: 7788 });
  });

  it('falls back to an ephemeral port only when the default was a default', () => {
    expect(decidePort(base)).toEqual({ kind: 'fallback' });
  });
});
