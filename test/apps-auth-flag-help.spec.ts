// chalk 5 is ESM and the command modules import it for their human rendering, which these cases
// never reach — they only read flag help.
jest.mock('chalk', () => new Proxy({}, { get: () => (s: string) => s }));

import AppDeploy from '../src/commands/app/deploy';
import AppExpose from '../src/commands/app/expose';
import AppInstall from '../src/commands/app/install';
import DeployPlan from '../src/commands/deploy/plan';
import { resolveDeployGate } from '../src/apps/ingress-auth';

/**
 * `--auth`'s help has to describe the rule `resolveDeployGate` enforces, on every
 * command that can put a domain in front of an app. Naming only the first-visit case on
 * `app install|deploy|expose`, and nothing at all on `deploy plan`, leaves a user reading `--help`
 * unable to tell which apps the flag is mandatory for.
 */
const helps = (): Array<[string, string]> => [
  ['app install', String(AppInstall.flags.auth.description)],
  ['app deploy', String(AppDeploy.flags.auth.description)],
  ['app expose', String(AppExpose.flags.auth.description)],
  ['deploy plan', String(DeployPlan.flags.auth.description)],
];

/** The two app classes the resolver actually refuses an ungated domain to, and the phrase the
 * help must carry for each. Each `refused` throws today — the help is graded against behaviour,
 * not against a remembered string. */
const REFUSED: Array<[string, () => unknown, RegExp]> = [
  ['no login of its own', () => resolveDeployGate('demo', { hasIngress: true, authMode: 'none' }), /no login of its own/],
  ['first visitor is admin', () => resolveDeployGate('demo', { hasIngress: true, accessMode: 'firstVisit' }), /first visitor/],
];

describe('what --auth says it requires is what the deploy refuses', () => {
  it.each(REFUSED)('the deploy still refuses the %s case', (_label, refused) => {
    expect(refused).toThrow(/Refusing to expose/);
  });

  it.each(REFUSED)('every --auth help names the %s case', (_label, _refused, phrase) => {
    for (const [where, text] of helps()) {
      expect({ where, names: phrase.test(text) }).toEqual({ where, names: true });
    }
  });

  it('says the rule identically on every command that can expose an app on a domain', () => {
    const texts = helps().map(([, text]) => text);
    expect(new Set(texts).size).toBe(1);
  });

  it('does not present the flag as free of an obligation, nor tie it to first-visit apps alone', () => {
    for (const [where, text] of helps()) {
      expect({ where, required: /Required with --domain/.test(text) }).toEqual({ where, required: true });
      expect({ where, onlyFirstVisit: /Required to expose a first-visit-admin app/.test(text) }).toEqual({ where, onlyFirstVisit: false });
    }
  });
});
