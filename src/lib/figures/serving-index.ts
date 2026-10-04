import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageSidecar } from '@/lib/images/types';

// The SERVING projection, not the full catalog: exactly the fields serving
// policy reads, pinned by serving-projection.test.ts. Script-safe: no
// credentials or signing logic. Server entry points should normally import
// server-loader so Next can enforce the server-component boundary.
//
// Read from disk on first lookup, never imported. A JSON import is compiled
// into the server bundle as one string literal, and every route that can
// resolve a figure then loads it before it answers anything. The 2026-08-21
// cold-start deepdive swapped the 30 MB full catalog for this projection; by
// 3 Oct 2026 the projection had grown back to 27.6 MB (53,846 entries) and was
// 27.7 of the 36.0 MB the home page loaded before its first byte. A cold first
// request took 1.4 s on a laptop (median of five), longer on a function, and
// that wait was the white screen on first open. Requiring the chunk cost
// ~600 ms and 1.6 GB RSS; reading and parsing the file costs ~140 ms, and only
// when a request first needs a figure. next.config.ts traces the file into
// every function.
export const SERVING_INDEX_PATH = join(process.cwd(), 'src', 'data', 'image-serving.generated.json');

let library: Record<string, ImageSidecar> | null = null;

// A missing index throws on every lookup. Serving every figure as unknown
// would hide images (or misjudge their access tier) without an error anywhere.
function servingLibrary(): Record<string, ImageSidecar> {
  library ??= JSON.parse(readFileSync(SERVING_INDEX_PATH, 'utf8')) as Record<string, ImageSidecar>;
  return library;
}

export function lookupServingSidecar(key: string | undefined): ImageSidecar | undefined {
  if (typeof key !== 'string') return undefined;
  const lib = servingLibrary();
  return Object.hasOwn(lib, key) ? lib[key] : undefined;
}

/** Read the index now, so a keep-warm ping leaves an instance that has it. */
export function warmServingIndex(): void {
  servingLibrary();
}
