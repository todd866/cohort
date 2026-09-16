import { NextResponse } from 'next/server';

type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const STATUS_MAP: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/**
 * Standardized API error response.
 * New routes should use this; existing routes migrate during normal maintenance.
 */
export function apiError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return NextResponse.json(
    { error: { code, message, ...(details && { details }) } },
    { status: STATUS_MAP[code], headers },
  );
}
