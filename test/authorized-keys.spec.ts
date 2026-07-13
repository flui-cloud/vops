import {
  authorizesKeyData,
  buildOpsLine,
  classifyRotation,
  extractOptions,
  findOpsLine,
  hasOtherAuthorizedKey,
  isOpsLine,
  opsTag,
  removeOpsLine,
  upsertOpsLine,
} from '../src/host-ops/authorized-keys';

const TAG = opsTag('ab12cd34');
const TEMP = `${TAG}:next`;
const USER_KEY = 'ssh-ed25519 AAAAUSERKEYDATA user@laptop';
const OPS_LINE = `no-agent-forwarding,no-X11-forwarding,no-user-rc ssh-ed25519 AAAAOPSKEYOLD ${TAG}`;
const NEXT_PUB = 'ssh-ed25519 AAAAOPSKEYNEW vops-ops.next';

describe('authorized-keys transforms', () => {
  it('isOpsLine matches only the tagged key line', () => {
    expect(isOpsLine(OPS_LINE, TAG)).toBe(true);
    expect(isOpsLine(USER_KEY, TAG)).toBe(false);
    expect(isOpsLine(`# a comment ${TAG}`, TAG)).toBe(false);
    // a temp-tagged line must NOT match the canonical tag (endsWith is exact on the token)
    expect(isOpsLine(`x ssh-ed25519 AAAA ${TEMP}`, TAG)).toBe(false);
  });

  it('upsertOpsLine appends when absent, replaces when different, no-ops when identical', () => {
    const line = buildOpsLine('ssh-ed25519 AAAAOPS x', TAG, 'no-user-rc');
    const empty = upsertOpsLine('', line, TAG);
    expect(empty.changed).toBe(true);
    expect(empty.content.trim()).toBe(line);

    const again = upsertOpsLine(empty.content, line, TAG);
    expect(again.changed).toBe(false);

    const withUser = upsertOpsLine(`${USER_KEY}\n${OPS_LINE}\n`, line, TAG);
    expect(withUser.changed).toBe(true);
    expect(withUser.content).toContain(USER_KEY);
    expect(findOpsLine(withUser.content, TAG)).toBe(line);
    // exactly one ops line survives
    expect(withUser.content.split('\n').filter((l) => isOpsLine(l, TAG))).toHaveLength(1);
  });

  it('removeOpsLine removes exactly the tagged line(s)', () => {
    const { content, removed } = removeOpsLine(`${USER_KEY}\n${OPS_LINE}\n`, TAG);
    expect(removed).toBe(1);
    expect(content).toContain(USER_KEY);
    expect(findOpsLine(content, TAG)).toBeNull();
  });

  it('hasOtherAuthorizedKey enforces the lockout guard', () => {
    // removing the ops line while a user key remains → safe
    const safe = removeOpsLine(`${USER_KEY}\n${OPS_LINE}\n`, TAG).content;
    expect(hasOtherAuthorizedKey(safe, TAG)).toBe(true);
    // removing the ops line when it is the ONLY key → unsafe
    const unsafe = removeOpsLine(`${OPS_LINE}\n`, TAG).content;
    expect(hasOtherAuthorizedKey(unsafe, TAG)).toBe(false);
  });

  it('authorizesKeyData matches by the base64 blob only', () => {
    expect(authorizesKeyData(`${USER_KEY}\n`, 'ssh-ed25519 AAAAUSERKEYDATA other@comment')).toBe(true);
    expect(authorizesKeyData(`${USER_KEY}\n`, 'ssh-ed25519 AAAANOPE x')).toBe(false);
  });

  it('extractOptions reads the options prefix', () => {
    expect(extractOptions(OPS_LINE)).toBe('no-agent-forwarding,no-X11-forwarding,no-user-rc');
    expect(extractOptions(USER_KEY)).toBe('');
  });

  it('classifyRotation reads host state from the file', () => {
    expect(classifyRotation('', TAG, TEMP, NEXT_PUB)).toBe('absent');
    expect(classifyRotation(`${OPS_LINE}\n`, TAG, TEMP, NEXT_PUB)).toBe('old');
    const mid = upsertOpsLine(`${OPS_LINE}\n`, buildOpsLine(NEXT_PUB, TEMP, ''), TEMP).content;
    expect(classifyRotation(mid, TAG, TEMP, NEXT_PUB)).toBe('mid');
    const done = `${buildOpsLine(NEXT_PUB, TAG, '')}\n`;
    expect(classifyRotation(done, TAG, TEMP, NEXT_PUB)).toBe('done');
  });
});
