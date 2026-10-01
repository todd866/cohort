import { useEffect, useRef } from 'react';

const MAX_REMEMBERED_URLS = 64;

type Resource = { cleanup: (abort: boolean) => void };
type ResourceFactory = (url: string, settled: (ok: boolean) => void) => Resource | null;

function trimHistory(remembered: Map<string, true>, desired: Set<string>): void {
  for (const url of remembered.keys()) {
    if (remembered.size <= MAX_REMEMBERED_URLS) break;
    if (!desired.has(url)) remembered.delete(url);
  }
}

/**
 * Best-effort media preparation with bounded successful-history bookkeeping.
 * It deliberately has no user-visible state: the real media element remains
 * the source of truth if preparation is late or fails.
 */
export function useBoundedPrefetch(
  urls: readonly (string | null | undefined)[],
  enabled: boolean,
  createResource: ResourceFactory,
): void {
  const key = urls.filter((url): url is string => Boolean(url)).join('\u0000');
  const factoryRef = useRef(createResource);
  const desiredRef = useRef<Set<string>>(new Set());
  const rememberedRef = useRef<Map<string, true>>(new Map());
  const activeRef = useRef<Map<string, Resource>>(new Map());
  useEffect(() => {
    factoryRef.current = createResource;
  }, [createResource]);

  useEffect(() => {
    const desired = new Set(key ? key.split('\u0000') : []);
    desiredRef.current = desired;
    trimHistory(rememberedRef.current, desired);

    // A card change or navigation abandons work for media no longer nearby.
    for (const [url, resource] of activeRef.current) {
      if (desired.has(url)) continue;
      resource.cleanup(true);
      activeRef.current.delete(url);
    }

    // Reveal disables new warming while the same image is about to be shown.
    // Let that current request finish; obsolete URLs were cancelled above.
    if (!enabled) return;

    for (const url of desired) {
      if (rememberedRef.current.has(url) || activeRef.current.has(url)) continue;
      let resource: Resource | null = null;
      const settled = (ok: boolean) => {
        if (resource === null || activeRef.current.get(url) !== resource) return;
        activeRef.current.delete(url);
        resource.cleanup(false);
        if (ok) {
          rememberedRef.current.set(url, true);
          // Evict the oldest terminal entries, while keeping this visible
          // lookahead set reusable during the current batch.
          trimHistory(rememberedRef.current, desiredRef.current);
        } else {
          // A later URL-list change may try a failed signed URL again; a
          // stable rerender never re-enters this effect.
          rememberedRef.current.delete(url);
        }
      };
      resource = factoryRef.current(url, settled);
      if (resource) activeRef.current.set(url, resource);
    }
  }, [enabled, key]);

  useEffect(() => () => {
    for (const resource of activeRef.current.values()) resource.cleanup(true);
    activeRef.current.clear();
    desiredRef.current.clear();
    rememberedRef.current.clear();
  }, []);
}
