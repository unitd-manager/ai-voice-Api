import { ZodError } from 'zod';
import { AppError } from '../errors/app-error.js';
import { fail } from '../response/respond.js';
import { logger } from '../logging/logger.js';

export function notFoundHandler(req, res) {
  fail(res, 404, 'NOT_FOUND', 'Route not found');
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return fail(res, 400, 'VALIDATION_ERROR', 'Request validation failed', details);
  }
  if (err instanceof AppError) return fail(res, err.statusCode, err.code, err.message, err.details);
  if (err?.type === 'entity.parse.failed') return fail(res, 400, 'BAD_REQUEST', 'Malformed JSON body');
  if (err?.type === 'entity.too.large') return fail(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  // Unknown error: full detail goes to logs only, never to the client.
  logger.error({ err, requestId: req.id }, 'Unhandled error');
  return fail(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}
