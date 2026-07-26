import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';

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
      if (error instanceof ZodError) {
        const first = error.issues[0];
        next(
          new HttpError(
            'validation_failed',
            first
              ? `${first.path.join('.') || 'request'}: ${first.message}`
              : 'That request is not valid.',
            { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
          ),
        );
        return;
      }
      next(error);
    });
  };
}
