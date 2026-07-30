import { SET_MASK, digestsMatch, redactSet, setDigests } from '../src/agent-api/plan-secrets';
import { PlanInputs, sha256, stableStringify } from '../src/agent-api/plan-store';

const PASSWORD = 'hunter2-correct-horse';

/** The shape the quadlet renderer actually produces, which is where a leaked value would land. */
function renderedView(value: string) {
  return {
    dryRun: true as const,
    app: 'demo',
    files: {
      'demo-app.container': ['[Container]', 'Image=demo:1', `Environment=DB_PASSWORD=${value}`, 'Environment=LOG_LEVEL=debug'].join('\n'),
    },
    access: { mode: 'credentials', password: { kind: 'value', value } },
  };
}

describe('plan secrets', () => {
  it('digests --set values instead of carrying them', () => {
    const digests = setDigests({ DB_PASSWORD: PASSWORD });
    expect(digests).toEqual({ DB_PASSWORD: sha256(PASSWORD) });
    expect(JSON.stringify(digests)).not.toContain(PASSWORD);
  });

  it('leaves a plan with no --set values untouched', () => {
    expect(setDigests(undefined)).toBeUndefined();
    expect(setDigests({})).toBeUndefined();
    const view = renderedView('public');
    expect(redactSet(view, undefined)).toBe(view);
  });

  it('removes the value from every place the renderer put it', () => {
    const redacted = redactSet(renderedView(PASSWORD), { DB_PASSWORD: PASSWORD });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(PASSWORD);
    expect(redacted.files['demo-app.container']).toContain(`Environment=DB_PASSWORD=${SET_MASK}`);
    expect(redacted.access.password.value).toBe(SET_MASK);
    // Untouched config stays readable — the plan is still something a human reviews.
    expect(redacted.files['demo-app.container']).toContain('Environment=LOG_LEVEL=debug');
  });

  it('masks a short value on its own line without blanking the rest of the plan', () => {
    const redacted = redactSet(renderedView('80'), { DB_PASSWORD: '80' });
    expect(redacted.files['demo-app.container']).toContain(`Environment=DB_PASSWORD=${SET_MASK}`);
    expect(redacted.files['demo-app.container']).toContain('Image=demo:1');
  });

  it('is deterministic, so plan and apply still hash to the same value', () => {
    const once = stableStringify(redactSet(renderedView(PASSWORD), { DB_PASSWORD: PASSWORD }));
    const twice = stableStringify(redactSet(renderedView(PASSWORD), { DB_PASSWORD: PASSWORD }));
    expect(once).toBe(twice);
  });

  it('refuses values that are not the approved ones', () => {
    const approved = setDigests({ DB_PASSWORD: PASSWORD });
    expect(digestsMatch(approved, { DB_PASSWORD: PASSWORD })).toBe(true);
    expect(digestsMatch(approved, { DB_PASSWORD: 'swapped-under-the-plan' })).toBe(false);
    expect(digestsMatch(approved, { DB_PASSWORD: PASSWORD, EXTRA: 'x' })).toBe(false);
    expect(digestsMatch(approved, {})).toBe(false);
  });

  it('keeps the plan inputs free of plaintext', () => {
    const inputs: PlanInputs = {
      spec: 'flui.yaml',
      specHash: sha256('manifest'),
      host: 'vmi3399032',
      setDigest: setDigests({ DB_PASSWORD: PASSWORD }),
    };
    expect(stableStringify(inputs)).not.toContain(PASSWORD);
  });
});
