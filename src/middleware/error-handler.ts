import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

export function errorHandler(err: Error, c: Context) {
  const requestId = c.get('requestId');
  const locale: SupportedLocale = c.get('locale') || 'en';

  // Zod validation error (Zod v4 uses 'issues')
  if (err instanceof ZodError) {
    logger.warn({
      type: 'validation_error',
      requestId,
      errors: err.issues,
    });

    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: t(locale, 'validation', 'invalidRequest'),
          details: err.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
      400
    );
  }

  // HTTP Exception (thrown intentionally)
  if (err instanceof HTTPException) {
    logger.warn({
      type: 'http_exception',
      requestId,
      status: err.status,
      message: err.message,
    });

    return c.json(
      {
        error: {
          code: getErrorCode(err.status),
          message: err.message, // Message is already translated by the service
        },
      },
      err.status
    );
  }

  // Unexpected error
  logger.error({
    type: 'unexpected_error',
    requestId,
    error: err.message,
    stack: err.stack,
  });

  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: t(locale, 'errors', 'internalError'),
      },
    },
    500
  );
}

function getErrorCode(status: number): string {
  const codes: Record<number, string> = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'UNPROCESSABLE_ENTITY',
    429: 'TOO_MANY_REQUESTS',
    500: 'INTERNAL_ERROR',
  };
  return codes[status] || 'UNKNOWN_ERROR';
}
