import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The collector runs SSH probes on a timer. Nest runs `onApplicationBootstrap`
 * for an application *context* too, and `getVopsApp()` builds one of those for
 * every CLI invocation — which is why `IntentService`'s timer already starts on
 * `vops compare`. If the collector were registered in VopsModule, every CLI
 * command would quietly start probing the fleet over SSH.
 *
 * Asserted structurally rather than by booting the container: booting VopsModule
 * here would need credentials, a profile and a network, and the property being
 * protected is a wiring decision, not a runtime one.
 */
const read = (p: string): string => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

describe('collector placement', () => {
  it('is registered in the local API module, which only the server builds', () => {
    expect(read('local-api/local-api.module.ts')).toContain('MetricsCollectorService');
  });

  it('is NOT registered in the module every CLI command boots', () => {
    expect(read('vops.module.ts')).not.toContain('MetricsCollectorService');
  });

  it('keeps the prober in VopsModule, since it starts no timers', () => {
    // The single-flight prober is shared with the CLI on purpose; what must not
    // leak into a CLI context is the *timer*, not the ability to probe.
    expect(read('vops.module.ts')).toContain('MetricsProbeService');
    expect(read('metrics/metrics-probe.service.ts')).not.toContain('setInterval');
  });

  it('unrefs its timer and clears it on shutdown', () => {
    const source = read('metrics/metrics-collector.service.ts');
    expect(source).toContain('.unref()');
    expect(source).toContain('clearInterval');
    // An explicit escape hatch, so a user who never wants background SSH can say so.
    expect(source).toContain('VOPS_METRICS_DISABLED');
  });
});
