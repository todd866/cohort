import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/;
const READ_SLOT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

type CanonicalValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export interface UnifiedSchedulerSharedReadContext {
  /** Bind the context to exactly one normalized scheduler request. */
  assertFingerprint(fingerprint: string): void;
  /** Load a named read once, then return a branch-local clone to every caller. */
  read<T>(slot: string, loader: () => Promise<T>): Promise<T>;
}

function canonicalize(value: unknown, ancestors: WeakSet<object>): CanonicalValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { $number: 'NaN' };
    if (value === Number.POSITIVE_INFINITY) return { $number: 'Infinity' };
    if (value === Number.NEGATIVE_INFINITY) return { $number: '-Infinity' };
    if (Object.is(value, -0)) return { $number: '-0' };
    return value;
  }
  if (typeof value === 'bigint') return { $bigint: value.toString(10) };
  if (typeof value === 'undefined') return { $undefined: true };
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('scheduler shared-read fingerprints accept data values only');
  }
  if (ancestors.has(value)) {
    throw new TypeError('scheduler shared-read fingerprints cannot contain cycles');
  }

  ancestors.add(value);
  try {
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) {
        throw new TypeError('scheduler shared-read fingerprints require valid dates');
      }
      return { $date: value.toISOString() };
    }
    if (Array.isArray(value)) {
      return value.map(entry => canonicalize(entry, ancestors));
    }
    if (value instanceof Set) {
      return {
        $set: [...value]
          .map(entry => canonicalize(entry, ancestors))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      };
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].map(([key, entry]) => [
        canonicalize(key, ancestors),
        canonicalize(entry, ancestors),
      ] as const);
      entries.sort((left, right) => {
        const keyOrder = JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0]));
        return keyOrder || JSON.stringify(left[1]).localeCompare(JSON.stringify(right[1]));
      });
      return { $map: entries };
    }
    if (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('scheduler shared-read fingerprints require plain data');
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [
          key,
          canonicalize((value as Record<string, unknown>)[key], ancestors),
        ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function fingerprintUnifiedSchedulerSharedReadInput(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value, new WeakSet()));
  return createHash('sha256').update(canonical).digest('hex');
}

function cloneReadValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as T;

  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const entry of value) clone.push(cloneReadValue(entry, seen));
    return clone as T;
  }
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    seen.set(value, clone);
    for (const [key, entry] of value) {
      clone.set(cloneReadValue(key, seen), cloneReadValue(entry, seen));
    }
    return clone as T;
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(value, clone);
    for (const entry of value) clone.add(cloneReadValue(entry, seen));
    return clone as T;
  }
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (ArrayBuffer.isView(value)) {
    return structuredClone(value) as T;
  }

  const clone = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) {
      descriptor.value = cloneReadValue(descriptor.value, seen);
      // The cached snapshot is frozen, but every consumer receives an ordinary
      // mutable working copy so existing scheduler code keeps its current
      // in-place sorting and scoring behavior.
      descriptor.writable = true;
    }
    descriptor.configurable = true;
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}

function sealReadSnapshot(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      sealReadSnapshot(key, seen);
      sealReadSnapshot(entry, seen);
    }
  } else if (value instanceof Set) {
    for (const entry of value) sealReadSnapshot(entry, seen);
  } else {
    for (const key of Reflect.ownKeys(value)) {
      sealReadSnapshot((value as Record<PropertyKey, unknown>)[key], seen);
    }
  }
  Object.freeze(value);
}

export function createUnifiedSchedulerSharedReadContext(): UnifiedSchedulerSharedReadContext {
  let boundFingerprint: string | null = null;
  const reads = new Map<string, Promise<unknown>>();

  return Object.freeze({
    assertFingerprint(fingerprint: string): void {
      if (!SHA256.test(fingerprint)) {
        throw new TypeError('scheduler shared-read fingerprint must be a SHA-256 digest');
      }
      if (boundFingerprint === null) {
        boundFingerprint = fingerprint;
        return;
      }
      if (boundFingerprint !== fingerprint) {
        throw new Error('scheduler shared-read fingerprint mismatch');
      }
    },

    async read<T>(slot: string, loader: () => Promise<T>): Promise<T> {
      if (boundFingerprint === null) {
        throw new Error('scheduler shared-read context is not bound to a request');
      }
      if (!READ_SLOT.test(slot) || slot.length > 100) {
        throw new TypeError('scheduler shared-read slot is invalid');
      }
      if (typeof loader !== 'function') {
        throw new TypeError('scheduler shared-read loader must be a function');
      }

      let pending = reads.get(slot);
      if (!pending) {
        pending = Promise.resolve()
          .then(loader)
          .then((loaded) => {
            const snapshot = cloneReadValue(loaded);
            sealReadSnapshot(snapshot);
            return snapshot;
          });
        reads.set(slot, pending);
      }
      return cloneReadValue(await pending) as T;
    },
  });
}
