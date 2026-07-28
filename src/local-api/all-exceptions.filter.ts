import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { VaultLockedError } from '../lib/keyring/vault-session';

/** 423 Locked — this Nest version's HttpStatus enum stops short of it. */
const HTTP_LOCKED = 423;

/**
 * The local UI is a 127.0.0.1-only tool: surface the real failure reason (an SSH
 * timeout, a relay error, a bad key) so the dashboard can show it, instead of
 * collapsing every plain Error into a generic 500 "Internal server error".
 * HttpExceptions already carry a status + message and pass through unchanged.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('local-api');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    // A locked vault is a state the user can fix, not a server fault: 423 lets
    // the dashboard say "unlock it" instead of showing a gateway error.
    if (exception instanceof VaultLockedError) {
      res
        .status(HTTP_LOCKED)
        .json({ statusCode: HTTP_LOCKED, error: 'Locked', message: exception.message });
      return;
    }

    let message = 'Unexpected error';
    if (exception instanceof Error) message = exception.message;
    else if (typeof exception === 'string') message = exception;
    this.logger.error(message);
    res
      .status(HttpStatus.BAD_GATEWAY)
      .json({ statusCode: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', message });
  }
}
