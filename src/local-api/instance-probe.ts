import * as http from 'node:http';

export interface InstanceIdentity {
  service?: string;
  version?: string;
  profile?: string;
  port?: number;
}

const PROBE_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 4096;

/**
 * Ask whatever holds a local port whether it is a vops. `null` means "nothing
 * answered, or what answered isn't us" — a pidfile would have to be written,
 * cleaned up and distrusted after a crash; a live answer needs none of that.
 */
export async function probeInstance(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<InstanceIdentity | null> {
  const body = await get(`http://127.0.0.1:${port}/healthz`, timeoutMs);
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as InstanceIdentity;
    return parsed?.service === 'vops' ? parsed : null;
  } catch {
    return null;
  }
}

function get(url: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        // Whatever is on that port may not be friendly: never buffer unbounded.
        if (out.length < MAX_BODY_BYTES) out += chunk;
      });
      res.on('end', () => resolve(out));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
