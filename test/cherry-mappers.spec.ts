import {
  CloudProvider,
  regionSlug,
  planSlug,
  publicIp,
  privateIp,
  rawStatus,
  mapInstanceStatus,
  toServerResponseDto,
  toInstanceEntity,
  CherryServer,
} from '@flui-cloud/infra';

const server: CherryServer = {
  id: 4242,
  hostname: 'vops-b2-1-1699999999',
  name: 'B2-1',
  username: 'root',
  state: 'active',
  status: 'active',
  region: { slug: 'LT-Siauliai', name: 'Šiauliai' },
  plan: { slug: 'B2-1-1gb-20s-shared', name: 'B2 Shared' },
  ip_addresses: [
    { address: '5.199.1.2', type: 'primary-ip' },
    { address: '10.0.0.7', type: 'private-ip' },
  ],
  tags: { 'managed-by': 'vops' },
  created_at: '2026-07-20T10:00:00Z',
};

describe('cherry mappers', () => {
  it('regionSlug/planSlug read the slug from object or string', () => {
    expect(regionSlug('LT-Siauliai')).toBe('LT-Siauliai');
    expect(regionSlug({ slug: 'NL-Amsterdam' })).toBe('NL-Amsterdam');
    expect(regionSlug({ name: 'Frankfurt' })).toBe('Frankfurt');
    expect(regionSlug(undefined)).toBe('');
    expect(planSlug({ slug: 'G1-4' })).toBe('G1-4');
    expect(planSlug('C1-4')).toBe('C1-4');
  });

  it('splits public vs private addresses by type', () => {
    expect(publicIp(server)).toBe('5.199.1.2');
    expect(privateIp(server)).toBe('10.0.0.7');
  });

  it('maps a Cherry server to the neutral ServerResponseDto', () => {
    const dto = toServerResponseDto(server);
    expect(dto.id).toBe('4242');
    // vops names servers via the Cherry hostname → ownership guard sees vops-*.
    expect(dto.name).toBe('vops-b2-1-1699999999');
    expect(dto.provider).toBe(CloudProvider.CHERRY);
    expect(dto.provider_resource_id).toBe('4242');
    expect(dto.server_type).toBe('B2-1-1gb-20s-shared');
    expect(dto.location).toBe('LT-Siauliai');
    expect(dto.status).toBe('active');
    expect(dto.public_ip).toBe('5.199.1.2');
    expect(dto.private_ip).toBe('10.0.0.7');
    expect(dto.labels).toEqual([{ key: 'managed-by', value: 'vops' }]);
    expect(dto.created_at.toISOString()).toBe('2026-07-20T10:00:00.000Z');
  });

  it('normalises status and defaults unknowns', () => {
    expect(mapInstanceStatus({ id: 1, status: 'active' })).toBe('running');
    expect(mapInstanceStatus({ id: 1, status: 'pending' })).toBe('provisioning');
    expect(mapInstanceStatus({ id: 1, status: 'weird' })).toBe('unknown');
    expect(rawStatus({ id: 1 })).toBe('unknown');
  });

  it('maps to a light InstanceEntity honouring the interface', () => {
    const inst = toInstanceEntity(server);
    expect(inst.providerId).toBe('4242');
    expect(inst.provider).toBe(CloudProvider.CHERRY);
    expect(inst.region).toBe('LT-Siauliai');
    expect(inst.status).toBe('running');
    expect(inst.defaultUser).toBe('root');
    expect(inst.ipConfig?.v4?.ip).toBe('5.199.1.2');
  });
});
