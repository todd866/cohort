import { createHash } from 'node:crypto';

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('artifact numbers must be finite');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`unsupported artifact value: ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError('artifact cannot contain cycles');
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return `[${value.map(entry => canonicalize(entry, seen)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('artifact must contain only plain JSON objects');
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalExamTargetJson(value: unknown): string {
  return canonicalize(value, new Set());
}

export function hashExamTargetArtifact(value: unknown): string {
  return createHash('sha256')
    .update(canonicalExamTargetJson(value), 'utf8')
    .digest('hex');
}
