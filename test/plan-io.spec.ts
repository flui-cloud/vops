import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlanFile } from '../src/lib/plan-io';

describe('readPlanFile', () => {
  it('rejects an unsupported plan version', () => {
    const file = path.join(os.tmpdir(), `vops-badplan-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 'vops.plan.v2' }));
    try {
      expect(() => readPlanFile(file)).toThrow('Unsupported plan version');
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('accepts a vops.plan.v1 file', () => {
    const file = path.join(os.tmpdir(), `vops-okplan-${process.pid}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 'vops.plan.v1', action: 'server.create' }),
    );
    try {
      expect(readPlanFile(file).version).toBe('vops.plan.v1');
    } finally {
      fs.unlinkSync(file);
    }
  });
});
