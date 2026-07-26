import type { ErrorRequestHandler, RequestHandler } from 'express';
import { apiError, errorStatus, type ErrorCode } from '@vigilo/shared';

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

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(errorStatus.not_found).json(apiError('not_found', 'That endpoint does not exist.'));
};

/**
 * The only place an error becomes a response. Internal detail goes to the log,
 * never to the client, because stack traces from this app can carry health
 * data (doc 02 §7).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    req.log.warn({ code: err.code }, err.message);
    res.status(errorStatus[err.code]).json(apiError(err.code, err.message, err.details));
    return;
  }

  req.log.error({ err }, 'unhandled error');
  res
    .status(errorStatus.server_error)
    .json(apiError('server_error', 'Something went wrong. Please try again.'));
};
