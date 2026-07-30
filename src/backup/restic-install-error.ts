import { BadRequestException } from '@nestjs/common';
import { ExitCode, agentError } from '../agent-api/agent-envelope';
import { AgentBadRequest } from '../agent-api/agent-http-errors';
import { RESTIC_NO_BZIP2_MARKER } from './backup-render';

const BZIP2_ACTION =
  'Install bzip2 on the host, then re-run `vops backup setup`: `apt-get install -y bzip2` ' +
  '(Debian/Ubuntu), `dnf install -y bzip2` (RHEL/Fedora) or `apk add bzip2` (Alpine).';

// A host that predates the self-installing script (or any wrapper that swallows it)
// still reports the bare shell error — classify that the same way.
const LEGACY_MISSING = /(bunzip2|bzip2):?\s*(command\s+)?not found/i;

/**
 * Turn a failed restic install into a refusal the caller can act on. Only the
 * missing-decompressor case is classified — everything else keeps the generic
 * operational error, since its cause (checksum mismatch, no curl, network) is
 * carried by the message.
 */
export function resticInstallFailure(stderr: string): BadRequestException {
  const text = stderr.trim();
  if (text.includes(RESTIC_NO_BZIP2_MARKER) || LEGACY_MISSING.test(text)) {
    return new AgentBadRequest(
      agentError(
        'VOPS_RESTIC_DECOMPRESS_UNAVAILABLE',
        'prerequisite',
        'restic install/verify failed: the host cannot decompress the restic archive — bunzip2, bzip2, python3 and busybox are all absent and bzip2 could not be installed.',
        { suggestedAction: BZIP2_ACTION },
      ),
      ExitCode.MISSING_PREREQUISITE,
    );
  }
  return new BadRequestException(`restic install/verify failed: ${text || 'checksum mismatch'}`);
}
