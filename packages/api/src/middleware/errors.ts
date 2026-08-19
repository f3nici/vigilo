import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import {
  apiError,
  describeIssue,
  describeIssues,
  errorStatus,
  type ErrorCode,
} from '@vigilo/shared';

/** Thrown by services. Routes never pick a status code by hand. */
export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * A schema failure, as a validation error somebody can act on.
 *
 * The message is the plain-English one (#23): "password: String must contain
 * at least 1 character(s)" is a console line, not something to show a worker
 * halfway through a shift. `details.issues` keeps a per-field list so a form
 * can mark the field as well as say the sentence, and those are translated
 * too rather than being the raw pair the old version passed through.
 */
export function validationErrorFrom(error: ZodError): HttpError {
  return new HttpError('validation_failed', describeIssues(error.issues), {
    issues: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: describeIssue(issue),
    })),
  });
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(errorStatus.not_found).json(apiError('not_found', 'That endpoint does not exist.'));
};

/**
 * The only place an error becomes a response. Internal detail goes to the log,
 * never to the client, because stack traces from this app can carry health
 * data (doc 02 §7).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // The safety net. `asyncHandler` converts the ones it wraps, and a schema
  // parsed anywhere else still must not reach a user as a 500.
  const error = err instanceof ZodError ? validationErrorFrom(err) : err;

  if (error instanceof HttpError) {
    req.log.warn({ code: error.code }, error.message);
    res.status(errorStatus[error.code]).json(apiError(error.code, error.message, error.details));
    return;
  }

  req.log.error({ err }, 'unhandled error');
  res
    .status(errorStatus.server_error)
    .json(apiError('server_error', 'Something went wrong. Please try again.'));
};
