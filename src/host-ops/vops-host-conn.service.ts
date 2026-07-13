import * as net from 'node:net';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { SshExec } from '../lib/ssh-exec';
import { OPS_KEY_NAME, VopsSshKeysService } from '../ssh-keys/vops-ssh-keys.service';
import { VopsHostsService } from '../hosts/vops-hosts.service';
import { HostConn, SshKeyKind, VopsHost } from '../hosts/host.model';
import { deriveConnState, sshOutcome } from './ssh-conn';

interface ResolvedKey {
  keyPath?: string;
  keyKind: SshKeyKind;
  keyName?: string;
  publicKey?: string;
}

/**
 * Structural SSH connection state: reachable (TCP) → key configured → key
 * authorized. Cached on the host (`conn`) so the UI shows an instant badge and a
 * per-layer fix; `check` re-probes fast, `assertReady` gates SSH actions with a
 * clear message instead of a raw timeout.
 */
@Injectable()
export class VopsHostConnService {
  constructor(
    private readonly hosts: VopsHostsService,
    private readonly keys: VopsSshKeysService,
    @Inject('SshExec') private readonly ssh: SshExec,
  ) {}

  /** The key vops would manage this host with: ops if installed+present, else the user key. */
  resolveKey(host: VopsHost): ResolvedKey {
    if (host.opsKeyInstalled) {
      const ops = this.keys.list().find((k) => k.name === OPS_KEY_NAME && k.hasPrivateKey);
      if (ops) return { keyPath: ops.privateKeyPath, keyKind: 'ops', keyName: ops.name, publicKey: ops.publicKey };
    }
    const uk = this.keys.resolveUserKey(host.userKeyName);
    if (uk?.hasPrivateKey) return { keyPath: uk.privateKeyPath, keyKind: 'user', keyName: uk.name, publicKey: uk.publicKey };
    return { keyKind: 'none' };
  }

  async check(name: string): Promise<HostConn> {
    const host = this.hosts.show(name);
    const rk = this.resolveKey(host);
    let reachable = false;
    let authorized = false;
    let reason = '';
    if (rk.keyPath) {
      const res = await this.ssh.run({ host, keyPath: rk.keyPath }, 'true', { timeoutMs: 9000, connectTimeoutSec: 6 });
      ({ reachable, authorized, reason } = sshOutcome(res.code, res.stderr));
    } else {
      // No key to try — probe the port so the "reachable" layer is still truthful.
      reachable = await this.tcpProbe(host.address, host.port || 22, 5000);
    }
    const { state, message } = deriveConnState({ reachable, hasKey: !!rk.keyPath, authorized, keyKind: rk.keyKind, host, reason });
    const conn: HostConn = {
      state, keyKind: rk.keyKind, keyName: rk.keyName, publicKey: rk.publicKey,
      reachable, hasKey: !!rk.keyPath, authorized, message, checkedAt: new Date().toISOString(),
    };
    host.conn = conn;
    this.hosts.update(host);
    return conn;
  }

  /** Fail fast with a clear message when the host isn't SSH-ready. */
  async assertReady(name: string): Promise<HostConn> {
    const conn = await this.check(name);
    if (conn.state !== 'ready') throw new BadRequestException(conn.message);
    return conn;
  }

  private tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (ok: boolean) => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  }
}
