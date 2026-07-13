import { CloudProvider } from '@flui-cloud/infra';
import { resolveProvider } from '../src/lib/providers';

describe('resolveProvider', () => {
  it('resolves canonical ids', () => {
    expect(resolveProvider('hetzner')).toBe(CloudProvider.HETZNER);
    expect(resolveProvider('ovh')).toBe(CloudProvider.OVH);
  });

  it('resolves display names round-tripped by the UI/API', () => {
    // The compare rows label the provider with its display name; the same value
    // comes back on the provision call and must still resolve.
    expect(resolveProvider('Hetzner Cloud')).toBe(CloudProvider.HETZNER);
    expect(resolveProvider('OVHcloud')).toBe(CloudProvider.OVH);
    expect(resolveProvider('Scaleway')).toBe(CloudProvider.SCALEWAY);
    expect(resolveProvider('Contabo')).toBe(CloudProvider.CONTABO);
  });

  it('is case- and space-insensitive', () => {
    expect(resolveProvider('HETZNER CLOUD')).toBe(CloudProvider.HETZNER);
  });

  it('rejects unknown providers', () => {
    expect(() => resolveProvider('digitalocean')).toThrow(/Unknown provider/);
  });
});
