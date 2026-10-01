/**
 * Shared string hashing utilities.
 *
 * hashString()    — djb2 variant, returns a non-negative number (for PRNG seeds, window skips)
 * hashStringHex() — djb2 variant, returns a hex string (for component/flag IDs)
 */

/** Hash a string to a non-negative 32-bit integer. djb2 variant (seed=0, multiply-by-31). */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

/** Hash a string to a hex string. djb2 variant (seed=5381, multiply-by-33-xor). */
export function hashStringHex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}
