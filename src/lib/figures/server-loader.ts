import 'server-only';
import type { ImageSidecar } from '@/lib/images/types';
import { lookupServingSidecar, warmServingIndex } from './serving-index';

// The server-only door to the serving projection. serving-index.ts holds the
// one copy per instance and explains why it is read from disk on first use.
// Scripts and audits that need provenance keep reading the full catalog.

/** Server-only sidecar lookup. Do NOT import this from a client component. */
export function lookupSidecar(key: string | undefined): ImageSidecar | undefined {
  return lookupServingSidecar(key);
}

/** For keep-warm pings: read the index before a request needs it. */
export function warmSidecarIndex(): void {
  warmServingIndex();
}
