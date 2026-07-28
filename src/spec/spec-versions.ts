/** The flui-spec version vops validates against, read from the installed package rather than
 * pinned here, so it can never be reported as something it is not. */
export function specVersion(): string {
  try {
    return (require('@flui-cloud/spec/package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
