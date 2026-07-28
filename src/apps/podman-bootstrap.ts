import { shq } from './app-scripts';

/** Bootstrap Podman 5 on any Linux host via `mgoltzsche/podman-static` — a self-contained tarball
 * that installs into `/usr/local` and ships the Quadlet generator where systemd scans natively, so
 * Quadlet works after `daemon-reload` with no manual wiring. Pinned SHA verified before unpack. */
export const PODMAN_STATIC_VERSION = '5.8.4';

const BASE = `https://github.com/mgoltzsche/podman-static/releases/download/v${PODMAN_STATIC_VERSION}`;

export interface PodmanStaticBinary {
  arch: 'amd64' | 'arm64';
  url: string;
  sha256: string;
}

// Pinned to the v5.8.4 release assets (sha256 computed from the published tarballs).
const BINARIES: Record<'amd64' | 'arm64', PodmanStaticBinary> = {
  amd64: {
    arch: 'amd64',
    url: `${BASE}/podman-linux-amd64.tar.gz`,
    sha256: 'a58765fe8be6ab3fb79f892f1a027b4ce4a7e8eb589df1ef960c167cbde08d69',
  },
  arm64: {
    arch: 'arm64',
    url: `${BASE}/podman-linux-arm64.tar.gz`,
    sha256: 'a2f6b73cc0f7018e2e8518338a4ec27db70148e1af86e16719235605aefd1df3',
  },
};

/** Map `uname -m` → the podman-static binary, or null for an unsupported arch. */
export function podmanStaticForArch(uname: string): PodmanStaticBinary | null {
  const m = uname.trim();
  if (m === 'x86_64' || m === 'amd64') return BINARIES.amd64;
  if (m === 'aarch64' || m === 'arm64') return BINARIES.arm64;
  return null;
}

/** Download + SHA-verify + install into /usr/local (+ /etc/containers, no-clobber). */
export function renderPodmanInstall(bin: PodmanStaticBinary): string {
  const dir = `podman-linux-${bin.arch}`;
  const shaLine = `${bin.sha256}  vops-podman-static.tar.gz`;
  return [
    'set -e',
    'cd /tmp',
    `curl -fsSL -o vops-podman-static.tar.gz ${shq(bin.url)}`,
    `echo ${shq(shaLine)} | sha256sum -c -`,
    'tar -xzf vops-podman-static.tar.gz',
    // --remove-destination unlinks a busy target first (safe re-install even while a
    // conmon holds the old binary); --no-clobber on etc keeps any host container config.
    `cp -r --remove-destination ${dir}/usr /`,
    `cp -rn ${dir}/etc / 2>/dev/null || true`,
    `rm -rf ${dir} vops-podman-static.tar.gz`,
    // Pin the OCI runtime + helpers to the static /usr/local binaries. Without this,
    // a pre-existing distro podman (e.g. Ubuntu 24.04's crun in /usr/bin) shadows the
    // static crun → "crun: unknown version specified" with podman 5.8. A drop-in
    // overrides cleanly without clobbering any host containers.conf.
    'mkdir -p /etc/containers/containers.conf.d',
    "cat > /etc/containers/containers.conf.d/99-vops-podman-static.conf <<'VOPS_CONF_EOF'",
    '[engine]',
    'runtime = "crun"',
    'conmon_path = ["/usr/local/lib/podman/conmon"]',
    'helper_binaries_dir = ["/usr/local/lib/podman"]',
    '[engine.runtimes]',
    'crun = ["/usr/local/bin/crun"]',
    'VOPS_CONF_EOF',
    'systemctl daemon-reload',
    "echo '@@version'",
    '/usr/local/bin/podman --version 2>&1',
    "echo '@@generator'",
    'test -e /usr/local/lib/systemd/system-generators/podman-system-generator && echo present || echo missing',
    "echo '@@existing'",
    // Flag a distro podman whose generator would double-process /etc/containers/systemd.
    'test -e /usr/lib/systemd/system-generators/podman-system-generator && echo conflict || echo clean',
  ].join('\n');
}
