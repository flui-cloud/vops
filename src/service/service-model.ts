/** Everything a service unit needs to be written, on any platform. */
export interface ServiceContext {
  /** Absolute — a login agent inherits none of our PATH. */
  node: string;
  /** Absolute path to the vops `bin/run` entrypoint. */
  binRun: string;
  profile: string;
  /** Only when VOPS_CONFIG_DIR is explicitly set; a unit that omits it silently
   * serves the wrong profile the moment the user has more than one. */
  configDir: string | null;
  /** Pinned so the installed app's origin — and therefore its identity — is fixed. */
  port: number;
  label: string;
  logPath: string;
  user: string;
  home: string;
}

export interface ServiceStatus {
  supported: boolean;
  platform: NodeJS.Platform;
  installed: boolean;
  running: boolean;
  /**
   * Whether the service comes up without the user doing anything. On macOS a
   * LaunchAgent starts at *login*, not at boot — true boot start would need a
   * root LaunchDaemon, the wrong trade for a tool whose premise is "runs as you,
   * in your home, with your keys". On Linux this is what `loginctl enable-linger`
   * buys, and it is the one step that can fail on its own.
   */
  bootStart: boolean;
  unitPath: string;
  /** How to read the logs on this platform. */
  logHint: string;
  /** Partial installs report themselves here instead of pretending. */
  warnings: string[];
}

export interface ServiceBackend {
  readonly platform: NodeJS.Platform;
  /** Where the unit/plist/task definition lives. */
  unitPath(ctx: ServiceContext): string;
  /** The unit text itself. Pure — this is what the golden-file specs assert. */
  render(ctx: ServiceContext): string;
  install(ctx: ServiceContext): ServiceStatus;
  uninstall(ctx: ServiceContext): { removed: boolean; unitPath: string };
  status(ctx: ServiceContext): ServiceStatus;
  start(ctx: ServiceContext): void;
  stop(ctx: ServiceContext): void;
  restart(ctx: ServiceContext): void;
  logHint(ctx: ServiceContext): string;
}

export function unsupportedStatus(platform: NodeJS.Platform): ServiceStatus {
  return {
    supported: false,
    platform,
    installed: false,
    running: false,
    bootStart: false,
    unitPath: '',
    logHint: '',
    warnings: [`vops has no background service for ${platform} yet.`],
  };
}

/** The environment every backend must pass through, or the service serves the
 * wrong profile on the wrong port. */
export function serviceEnv(ctx: ServiceContext): Array<[string, string]> {
  return [
    ['VOPS_PORT', String(ctx.port)],
    ['VOPS_PROFILE', ctx.profile],
    ...((ctx.configDir ? [['VOPS_CONFIG_DIR', ctx.configDir]] : []) as Array<[string, string]>),
  ];
}
