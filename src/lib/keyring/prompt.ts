/** Raw mode rather than readline's private `_writeToOutput` hook, which a Node release
 * could change and start silently echoing the passphrase. Prompts on stderr so
 * `vops … --json | jq` still works while an unlock is pending. */
export class NoTtyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoTtyError';
  }
}

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = '\u007f';
const ESC = '\u001b';

export type ReaderState = 'more' | 'accept' | 'cancel';

/** Keystroke → passphrase, kept apart from the terminal so it's testable without one.
 * Handles two real-keyboard traps: arrow-key escape sequences, and backspace
 * needing to drop a whole code point (not half a multi-byte character). */
export class SecretReader {
  private buf = '';
  private escape: 'none' | 'esc' | 'csi' = 'none';

  get value(): string {
    return this.buf;
  }

  feed(chunk: string): ReaderState {
    for (const ch of chunk) {
      if (this.escape !== 'none') {
        this.consumeEscape(ch);
      } else if (ch === CTRL_C || (ch === CTRL_D && !this.buf)) {
        return 'cancel';
      } else if (ch === '\r' || ch === '\n') {
        return 'accept';
      } else {
        this.type(ch);
      }
    }
    return 'more';
  }

  /** CSI/SS3 sequences run until a final byte in @…~ — but '[' itself is in that
   * range, so the state machine must not treat it as the terminator. */
  private consumeEscape(ch: string): void {
    if (this.escape === 'esc') this.escape = ch === '[' || ch === 'O' ? 'csi' : 'none';
    else if (ch >= '@' && ch <= '~') this.escape = 'none';
  }

  private type(ch: string): void {
    if (ch === ESC) this.escape = 'esc';
    else if (ch === BACKSPACE || ch === '\b') this.buf = [...this.buf].slice(0, -1).join('');
    else if (ch >= ' ' && ch !== CTRL_D) this.buf += ch;
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

export function promptSecret(label: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    throw new NoTtyError(
      `Cannot ask for a passphrase — stdin is not a terminal. Set VOPS_PASSPHRASE for non-interactive use.`,
    );
  }

  return new Promise<string>((resolve, reject) => {
    const wasRaw = input.isRaw;
    const wasEncoding = input.readableEncoding;
    // Decode as utf8 here, not per byte: a character split across two reads must
    // still arrive whole, or an accented passphrase would derive a key that
    // depends on how the terminal happened to chunk it.
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    process.stderr.write(label);

    const reader = new SecretReader();
    const finish = (settle: () => void): void => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw ?? false);
      if (wasEncoding) input.setEncoding(wasEncoding);
      input.pause();
      process.stderr.write('\n');
      settle();
    };

    const onData = (chunk: string): void => {
      const state = reader.feed(chunk);
      if (state === 'accept') finish(() => resolve(reader.value));
      else if (state === 'cancel') finish(() => reject(new Error('Cancelled.')));
    };

    input.on('data', onData);
  });
}

/** Ask twice and refuse a mismatch — a typo here seals the vault forever. */
export async function promptNewSecret(label: string): Promise<string> {
  const first = await promptSecret(`${label}: `);
  if (!first) throw new Error('An empty passphrase is not accepted.');
  if (first !== (await promptSecret(`${label} (again): `))) {
    throw new Error('The two entries do not match.');
  }
  return first;
}
