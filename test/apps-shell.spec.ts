import { buildExecCommand, pickShellComponent } from '../src/apps/app-shell';
import { launcherFileName, renderLauncherScript, resolveTerminal, terminalCandidates } from '../src/apps/terminal-launch';
import { AppInstallV1 } from '../src/apps/app.model';

const install = {
  name: 'wordpress',
  primary: 'web',
  components: [
    { name: 'web', container: 'vops-wordpress-web', image: 'wordpress:6', published: [] },
    { name: 'db', container: 'vops-wordpress-db', image: 'mariadb:11', published: [] },
  ],
} as unknown as AppInstallV1;

describe('app shell — component pick', () => {
  it('defaults to the primary component', () => {
    expect(pickShellComponent(install).container).toBe('vops-wordpress-web');
  });

  it('accepts the logical name or the container name', () => {
    expect(pickShellComponent(install, 'db').container).toBe('vops-wordpress-db');
    expect(pickShellComponent(install, 'vops-wordpress-db').name).toBe('db');
  });

  it('lists the valid components when the name is unknown', () => {
    expect(() => pickShellComponent(install, 'cache')).toThrow(/have: web, db/);
  });
});

describe('app shell — podman exec line', () => {
  it('allocates a TTY and detects bash with an sh fallback', () => {
    const cmd = buildExecCommand({ container: 'vops-x-web', interactive: true, sudo: false });
    expect(cmd).toBe(`podman exec -it 'vops-x-web' sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`);
  });

  it('sudos when the login user is not root (deploys are rootful)', () => {
    expect(buildExecCommand({ container: 'c', interactive: true, sudo: true })).toMatch(/^sudo podman exec -it/);
    expect(buildExecCommand({ container: 'c', interactive: false, sudo: true, command: ['ls'] })).toMatch(/^sudo -n podman exec -i /);
  });

  it('passes a one-shot argv through without a shell, each word quoted', () => {
    const cmd = buildExecCommand({ container: 'c', interactive: false, sudo: false, command: ['php', 'occ', "a b'c"] });
    expect(cmd).toBe(`podman exec -i 'c' 'php' 'occ' 'a b'\\''c'`);
  });

  it('honours an explicit shell', () => {
    expect(buildExecCommand({ container: 'c', interactive: true, sudo: false, shell: '/bin/ash' })).toContain(`'/bin/ash'`);
  });
});

describe('terminal launch', () => {
  it('opens Terminal.app on macOS and honours VOPS_TERMINAL first', () => {
    expect(terminalCandidates('darwin', '/tmp/s.command')).toEqual([
      { cmd: 'open', args: ['-a', 'Terminal', '/tmp/s.command'], label: 'Terminal' },
    ]);
    expect(terminalCandidates('darwin', '/tmp/s.command', 'iTerm')[0].label).toBe('iTerm');
  });

  it('tries the usual Linux emulators and nothing elsewhere', () => {
    expect(terminalCandidates('linux', '/tmp/s.sh').map((c) => c.cmd)).toContain('gnome-terminal');
    expect(terminalCandidates('win32', 'C:\\s.bat')).toEqual([]);
  });

  it('picks the first candidate that exists on PATH', () => {
    const found = resolveTerminal(terminalCandidates('linux', '/tmp/s.sh'), (c) => (c === 'konsole' ? '/usr/bin/konsole' : null));
    expect(found?.cmd).toBe('konsole');
    expect(resolveTerminal(terminalCandidates('linux', '/tmp/s.sh'), () => null)).toBeNull();
  });

  it('writes a self-deleting launcher and a .command file macOS Terminal will run', () => {
    const script = renderLauncherScript(['-t', 'root@1.2.3.4', 'podman exec -it c sh'], 'c · box');
    expect(script.split('\n')[1]).toBe('rm -f -- "$0"');
    expect(script).toContain(`exec ssh '-t' 'root@1.2.3.4' 'podman exec -it c sh'`);
    expect(launcherFileName('darwin', 'ab12')).toBe('vops-shell-ab12.command');
    expect(launcherFileName('linux', 'ab12')).toBe('vops-shell-ab12.sh');
  });
});
