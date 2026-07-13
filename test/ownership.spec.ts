import { ForbiddenException } from '@nestjs/common';
import { isVopsManaged, assertVopsManaged } from '../src/safety/ownership';

describe('ownership guard', () => {
  it('treats vops-* named resources as managed', () => {
    expect(isVopsManaged({ name: 'vops-d2-2-abc' })).toBe(true);
  });

  it('treats resources with the managed-by=vops label as managed', () => {
    expect(isVopsManaged({ name: 'anything', labels: [{ key: 'managed-by', value: 'vops' }] })).toBe(true);
  });

  it('treats pre-existing resources (no prefix, no label) as unmanaged', () => {
    expect(isVopsManaged({ name: 'vmi3399032' })).toBe(false);
    expect(isVopsManaged({ name: 'web-prod-01', labels: [{ key: 'env', value: 'prod' }] })).toBe(false);
  });

  it('assert() throws Forbidden for unmanaged resources', () => {
    expect(() => assertVopsManaged('server', { name: 'vmi3399032' })).toThrow(ForbiddenException);
  });

  it('assert() passes for managed resources', () => {
    expect(() => assertVopsManaged('server', { name: 'vops-x' })).not.toThrow();
  });
});
