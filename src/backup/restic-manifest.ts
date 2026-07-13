/**
 * The single deliberate binary exception (spec §8, rung 3): restic, pinned to one
 * version with the OFFICIAL published SHA-256 per arch. The checksum is verified
 * on the host before the binary is ever executed — this manifest is the trust
 * anchor. Checksums are the upstream `SHA256SUMS` values for the `.bz2` archives.
 */
export type Arch = 'amd64' | 'arm64';

export interface ResticBinary {
  arch: Arch;
  url: string;
  /** SHA-256 of the downloaded .bz2 archive (as published by restic). */
  sha256: string;
}

export const RESTIC_VERSION = '0.17.3';

const base = `https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}`;

export const RESTIC_BINARIES: Record<Arch, ResticBinary> = {
  amd64: {
    arch: 'amd64',
    url: `${base}/restic_${RESTIC_VERSION}_linux_amd64.bz2`,
    sha256: '5097faeda6aa13167aae6e36efdba636637f8741fed89bbf015678334632d4d3',
  },
  arm64: {
    arch: 'arm64',
    url: `${base}/restic_${RESTIC_VERSION}_linux_arm64.bz2`,
    sha256: 'db27b803534d301cef30577468cf61cb2e242165b8cd6d8cd6efd7001be2e557',
  },
};

/** Map `uname -m` to the restic binary; null for unsupported arches. */
export function resticForArch(unameM: string): ResticBinary | null {
  const m = unameM.trim().toLowerCase();
  if (m === 'x86_64' || m === 'amd64') return RESTIC_BINARIES.amd64;
  if (m === 'aarch64' || m === 'arm64') return RESTIC_BINARIES.arm64;
  return null;
}
