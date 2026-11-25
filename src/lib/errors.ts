import { randomUUID } from 'node:crypto'

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const errors = {
  unauthorized: (msg = 'Authentication required') =>
    new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'You do not have permission to perform this action') =>
    new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Resource not found') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg: string) => new AppError(409, 'CONFLICT', msg),
  badRequest: (msg: string, details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', msg, details),
  rateLimited: (msg = 'Too many requests') => new AppError(429, 'RATE_LIMITED', msg),
  internal: (msg = 'An unexpected error occurred', details?: unknown) =>
    new AppError(500, 'INTERNAL_ERROR', msg, details),
  validation: (details: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'Invalid request payload', details),
}

/**
 * Generates a correlation ID for request tracing
 */
export function generateCorrelationId(): string {
  return randomUUID()
}

/**
 * Standardized error response format
 */
export interface ErrorResponse {
  error: {
    code: string
    message: string
    details?: unknown
    correlationId: string
  }
}

/**
 * Creates a standardized error response
 */
export function createErrorResponse(
  error: AppError,
  correlationId: string
): ErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      correlationId,
    },
  }
}