import { podmanStaticForArch, renderPodmanInstall, PODMAN_STATIC_VERSION } from '../src/apps/podman-bootstrap';

describe('podman-static bootstrap', () => {
  it('maps uname arch to a pinned binary + SHA', () => {
    expect(podmanStaticForArch('x86_64')!.arch).toBe('amd64');
    expect(podmanStaticForArch('aarch64')!.arch).toBe('arm64');
    expect(podmanStaticForArch('riscv64')).toBeNull();
    expect(podmanStaticForArch('x86_64')!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('renders an install that verifies the SHA before unpacking and wires the generator', () => {
    const script = renderPodmanInstall(podmanStaticForArch('x86_64')!);
    expect(script).toContain(`v${PODMAN_STATIC_VERSION}/podman-linux-amd64.tar.gz`);
    expect(script).toContain('sha256sum -c -');
    expect(script.indexOf('sha256sum -c -')).toBeLessThan(script.indexOf('cp -r')); // verify BEFORE install
    expect(script).toContain('systemctl daemon-reload');
  });
});
