import type { Prisma } from '@prisma/client';

/**
 * Safely cast a Prisma JSON value to a plain object.
 * Returns {} for null, arrays, and non-object primitives.
 */
export function asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Return the value if it's a string, otherwise null.
 * Useful for extracting typed fields from untyped JSON annotations.
 */
export function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
