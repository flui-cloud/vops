import { OsFamily } from '../hosts/host.model';

/**
 * Pure renderers for `host harden` — the exact text vops writes / runs on a host.
 * Kept side-effect-free so `--dry-run` and unit tests see precisely what a real
 * run would apply. All changes are reversible text under /etc/ssh/sshd_config.d/
 * and /etc/vops/; harden never edits distro-owned files in place.
 */
// Sorts FIRST in sshd_config.d/: sshd uses first-obtained-value-wins, so a lower
// prefix beats a distro/cloud drop-in like 50-cloud-init.conf that would otherwise
// pin `PasswordAuthentication yes` and silently neutralise our hardening.
export const SSHD_DROPIN_PATH = '/etc/ssh/sshd_config.d/00-vops.conf';
export const SSHD_LEGACY_DROPIN_PATH = '/etc/ssh/sshd_config.d/50-vops.conf';
export const RATELIMIT_PATH = '/etc/vops/nftables-ssh.conf';

export const sudoGroup = (family: OsFamily): string => (family === 'debian' ? 'sudo' : 'wheel');

/** The sshd drop-in content from the selected hardening directives. */
export function sshdDropIn(directives: string[]): string {
  return ['# Managed by vops — remove this file to revert.', ...directives, ''].join('\n');
}

/** Create a sudo admin user and install a public key for them (idempotent). */
export function adminUserScript(user: string, publicKey: string, family: OsFamily): string {
  const group = sudoGroup(family);
  return [
    'set -e',
    `id -u '${user}' >/dev/null 2>&1 || useradd -m -s /bin/bash '${user}'`,
    `getent group '${group}' >/dev/null 2>&1 && usermod -aG '${group}' '${user}' || true`,
    `install -d -m 700 -o '${user}' -g '${user}' "/home/${user}/.ssh"`,
    `touch "/home/${user}/.ssh/authorized_keys"`,
    `grep -qxF '${publicKey}' "/home/${user}/.ssh/authorized_keys" || echo '${publicKey}' >> "/home/${user}/.ssh/authorized_keys"`,
    `chown '${user}:${user}' "/home/${user}/.ssh/authorized_keys"`,
    `chmod 600 "/home/${user}/.ssh/authorized_keys"`,
  ].join('\n');
}

/** Enable unattended security updates for the OS family. */
export function unattendedUpgradesScript(family: OsFamily): string {
  if (family === 'debian') {
    return [
      'set -e',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -qq',
      'apt-get -y install unattended-upgrades',
      'cat > /etc/apt/apt.conf.d/20auto-upgrades <<EOF',
      'APT::Periodic::Update-Package-Lists "1";',
      'APT::Periodic::Unattended-Upgrade "1";',
      'EOF',
      'systemctl enable --now unattended-upgrades',
    ].join('\n');
  }
  return [
    'set -e',
    'dnf -y install dnf-automatic',
    "sed -i 's/^upgrade_type.*/upgrade_type = security/' /etc/dnf/automatic.conf",
    "sed -i 's/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf",
    'systemctl enable --now dnf-automatic.timer',
  ].join('\n');
}

/** Ensure a time-sync daemon is active. */
export function timeSyncScript(family: OsFamily): string {
  if (family === 'debian') {
    return 'systemctl enable --now systemd-timesyncd 2>/dev/null || (apt-get -y install chrony && systemctl enable --now chrony)';
  }
  return 'systemctl enable --now chronyd 2>/dev/null || systemctl enable --now systemd-timesyncd';
}

/**
 * Reload sshd across init systems: systemd (ssh/sshd unit), then SysV `service`,
 * then a direct SIGHUP; never hard-fail on reload alone — the config was already
 * `sshd -t`-validated and written, so a reboot/manual reload will apply it.
 */
export const SSHD_RELOAD =
  'systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || ' +
  'service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || ' +
  'pkill -HUP sshd 2>/dev/null || true';

/**
 * Idempotently set one sshd directive in the vops drop-in, VALIDATE with `sshd -t`
 * before reloading, and self-revert the change if validation fails (never leave a
 * host with a config that stops sshd from starting).
 */
export function sshdDirectiveScript(key: string, value: string): string {
  return [
    'set -e',
    `f='${SSHD_DROPIN_PATH}'`,
    'mkdir -p "$(dirname "$f")"',
    'touch "$f"',
    `grep -q '^# Managed by vops' "$f" || sed -i '1i # Managed by vops — remove this file to revert.' "$f"`,
    `if grep -qiE '^${key} ' "$f"; then sed -i -E 's|^${key} .*|${key} ${value}|I' "$f"; else echo '${key} ${value}' >> "$f"; fi`,
    `if ! sshd -t; then sed -i -E '/^${key} ${value}$/Id' "$f"; echo 'sshd -t validation failed' >&2; exit 1; fi`,
    SSHD_RELOAD,
  ].join('\n');
}

/** Check a directive is already in effect via `sshd -T` (lowercased keys). */
export const sshdCheck = (key: string, value: string): string =>
  `sshd -T 2>/dev/null | grep -qiE '^${key} ${value}$'`;

export interface HardenStepSpec {
  id: string;
  label: string;
}

export const DEFAULT_STEPS: HardenStepSpec[] = [
  { id: 'admin-user', label: 'Create sudo admin user + install user key' },
  { id: 'ssh-keys', label: 'Ensure ops key installed' },
  { id: 'ssh-no-root-pw', label: 'PermitRootLogin prohibit-password' },
  { id: 'ssh-no-password', label: 'PasswordAuthentication no' },
  { id: 'unattended-upgrades', label: 'Enable unattended security upgrades' },
  { id: 'time-sync', label: 'Ensure time sync active' },
  { id: 'ssh-ratelimit', label: 'nftables SSH rate-limit' },
];
