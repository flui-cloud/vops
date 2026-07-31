/**
 * Removing the installed app is the one step vops cannot do for you.
 *
 * There is no web API to uninstall a PWA — it is a user action in the browser,
 * and the counterpart to `appinstalled` has never been standardised. So instead
 * of pretending, we say exactly where to click. Keeping the wording here (pure,
 * one place) means the CLI and the dashboard can never disagree about it.
 */
export interface UninstallStep {
  label: string;
  /** Something the user can paste into an address bar or a terminal, if any. */
  command?: string;
}

export interface UninstallGuide {
  title: string;
  steps: UninstallStep[];
}

export function appRemovalGuide(platform: NodeJS.Platform = process.platform): UninstallGuide {
  const chrome: UninstallStep = {
    label: 'In Chrome or Edge, open the app list, right-click vops and choose Uninstall.',
    command: 'chrome://apps',
  };
  const byPlatform: Partial<Record<NodeJS.Platform, UninstallStep[]>> = {
    darwin: [
      chrome,
      { label: 'Or drag it to the Trash from Finder → Applications → Chrome Apps.' },
    ],
    win32: [
      chrome,
      { label: 'Or use Settings → Apps → Installed apps, find vops and choose Uninstall.' },
    ],
    linux: [
      chrome,
      { label: 'Or remove its launcher from ~/.local/share/applications.' },
    ],
  };
  return {
    title: 'Remove the vops app icon',
    steps: byPlatform[platform] ?? [chrome],
  };
}
