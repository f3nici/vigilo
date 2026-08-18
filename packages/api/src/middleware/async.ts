import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { validationErrorFrom } from './errors.js';

/**
 * Wraps an async handler so a rejected promise reaches the error middleware
 * rather than hanging the request. Express 5 forwards rejections itself, but
 * being explicit keeps Zod failures turning into `validation_failed` in one
 * place instead of in every route.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch((error: unknown) => {
      next(error instanceof ZodError ? validationErrorFrom(error) : error);
    });
  };
}
