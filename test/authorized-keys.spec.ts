import {
  assessRevokeSafety,
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

  it('assessRevokeSafety judges the file as it would be AFTER the removal', () => {
    const OPS_PUB = 'ssh-ed25519 AAAAOPSKEYOLD vops-ops';
    const decide = (before: string, verified?: string) =>
      assessRevokeSafety(before, removeOpsLine(before, TAG).content, TAG, verified);

    // The lockout the guard exists for: the ops key IS this host's userKeyName, so the
    // session that "verified" access is the very line about to be removed.
    expect(decide(`${OPS_LINE}\n`, OPS_PUB)).toEqual({
      safe: false,
      reason: 'user-key-is-being-removed',
    });
    // Same, when the ops key is authorized twice under this profile's tag.
    expect(decide(`${OPS_LINE}\n${OPS_LINE} \n`, OPS_PUB).safe).toBe(false);
    // No user key verified at all, ops line is the only one → still a lockout.
    expect(decide(`${OPS_LINE}\n`)).toEqual({ safe: false, reason: 'no-verified-user-key' });
    expect(decide(`${OPS_LINE}\n`, null).safe).toBe(false);
    // An unparseable public half proves nothing — it must not read as an access path.
    expect(decide(`${OPS_LINE}\n`, 'ssh-ed25519').safe).toBe(false);

    // Legitimate revokes must keep passing.
    expect(decide(`${USER_KEY}\n${OPS_LINE}\n`, USER_KEY)).toEqual({
      safe: true,
      reason: 'user-key-remains',
    });
    // …including when the surviving user key carries options / odd whitespace, and when
    // the verified key is not the one that survives.
    const OPTIONED = `from="203.0.113.0/24",no-pty   ssh-ed25519 AAAAUSERKEYDATA  user@laptop`;
    expect(decide(`${OPTIONED}\n${OPS_LINE}\n`, USER_KEY).safe).toBe(true);
    expect(decide(`${USER_KEY}\n${OPS_LINE}\n`).reason).toBe('other-key-remains');
    expect(decide(`  ${USER_KEY}  \n${OPS_LINE}\n`).safe).toBe(true);
    // The ops key's own material also authorized by an untagged line: that line survives.
    expect(decide(`ssh-ed25519 AAAAOPSKEYOLD spare\n${OPS_LINE}\n`, OPS_PUB)).toEqual({
      safe: true,
      reason: 'user-key-remains',
    });
    // A verified key absent from this file is authorized from a source we do not touch.
    expect(decide(`${OPS_LINE}\n`, USER_KEY)).toEqual({ safe: true, reason: 'user-key-not-in-file' });
    // Another profile's ops line counts as a remaining access path.
    expect(decide(`x ssh-ed25519 AAAAOTHER vops-ops:ffff0000\n${OPS_LINE}\n`).safe).toBe(true);
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
