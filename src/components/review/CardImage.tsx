'use client';

import { type CSSProperties, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  shouldGateClientImageMeta,
  type ClientImageMeta,
} from '@/lib/figures/types';
import type { ImageRevealRegion } from '@/lib/images/types';
import { clickFocusRegion } from './zoom-focus';
import { useImageTracking } from '@/hooks/useTracking';
import { OFFLINE_FIGURES_CHANGE_EVENT, readCachedFigure } from '@/lib/offline/figures';
import { acquirePreparedFigure, peekPreparedFigure, PREPARED_FIGURES_CHANGE_EVENT } from '@/lib/offline/prepared-figures';
import { readOfflineOwner, subscribeOfflineOwner } from '@/lib/offline/owner';
import {
  CLIENT_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';
import { SensitiveMediaGate } from '@/components/media/SensitiveMediaGate';

interface CardImageProps {
  /** A live/signed source when one is available. Offline-pack items deliberately
   * omit it and resolve their stable imageKey from the owner-scoped cache. */
  src?: string | null;
  caption?: string | null;
  meta?: ClientImageMeta;
  /** Source-authoritative prompt placement. Overrides a missing or stale
   *  sidecar showWhen value; callers still control the render slot. */
  prompt?: boolean;
  /** Whether the answer has been revealed. Drives caption visibility (so the
   *  caption itself doesn't leak the finding pre-reveal) and alt-text mode. */
  revealed: boolean;
  /** Reviewed answer-bearing description received only in the graded reveal. */
  postAnswerAlt?: string | null;
  /** Exact source URI received only in the graded reveal when prompt-unsafe. */
  postAnswerSourcePageUrl?: string | null;
  /** Canonical image key for analytics (e.g. `/figures/cah/derm/foo.jpg`).
   *  When omitted, falls back to `src` — but `src` is usually a short-lived
   *  signed R2 URL, so callers should pass the resolved imageKey when they
   *  have it. */
  imageKey?: string | null;
  /** Component id (cardId / questionId) attached to the analytics event. */
  trackingComponentId?: string;
  /** Reveals/skips the answer without consenting to the sensitive image. */
  onSkipSensitive?: () => void;
  /** Rendered in the `lg` side pane (see `review-panes.ts`) rather than stacked
   *  under the text. Caps the expanded height to what is left of the viewport
   *  once the review chrome is paid for, so the figure and the text are on
   *  screen together. Below `lg` the pane does not exist and the normal 80vh
   *  cap applies, so this stays a purely additive responsive override. */
  inSidePane?: boolean;
}

/** Image and caption share a width; only the image frame uses the viewport
 * height budget. Reveal-only credit cannot change its aspect ratio or scale. */
export const SIDE_PANE_FIGURE = 'review-figure-side-pane';

/** A separate occurrence is keyed to the displayed card/source below. Keeping
 * its state here makes an identity change remove the dialog synchronously,
 * including an answer image when the next concealed prompt arrives. */
/** Put the part of the plate this question is about in the middle of the viewport.
 *
 *  Anchoring, not centring. The learner opens the magnifier because they cannot
 *  read the highlighted structure at card size ("too many teeny tiny lines to
 *  quickly see what you're supposed to be guessing"), so the useful thing to show
 *  is where the question is pointing. The geometric centre of a whole anatomy
 *  plate is no more likely to contain it than the top edge is.
 *
 *  `revealRegions` are normalised boxes over the same plate, so the region is the
 *  question's own answer to "which bit?". It marks WHERE to look, never the
 *  structure's name, so using it before reveal gives nothing away — pre-reveal the
 *  labels are masked, and the highlight is already visible on the card.
 *
 *  Returns null when the viewport has no geometry yet; see the caller. */
function anchorScroll(
  viewport: HTMLDivElement,
  region: ImageRevealRegion | undefined,
): { left: number; top: number } | null {
  const scrollableX = viewport.scrollWidth - viewport.clientWidth;
  const scrollableY = viewport.scrollHeight - viewport.clientHeight;
  // A <dialog> is display:none until showModal(), so its subtree measures 0x0. A
  // cached image's load event can beat that, and (0 - 0) / 2 is a perfectly
  // plausible-looking 0 that pins the plate to its top-left corner.
  if (scrollableX <= 0 && scrollableY <= 0) return null;

  if (!region) {
    return { left: scrollableX / 2, top: scrollableY / 2 };
  }
  const focusX = region.x + region.width / 2;
  const focusY = region.y + region.height / 2;
  const clamp = (value: number, max: number) => Math.max(0, Math.min(Math.round(value), max));
  return {
    left: clamp(focusX * viewport.scrollWidth - viewport.clientWidth / 2, scrollableX),
    top: clamp(focusY * viewport.scrollHeight - viewport.clientHeight / 2, scrollableY),
  };
}

function CardImageZoom({ src, alt, regions, focusRegion, open, onClose, triggerRef }: {
  src: string;
  alt: string;
  regions?: ImageRevealRegion[];
  /** Owned by CardImage: the IMAGE is the trigger, so this component no longer
   *  renders a control of its own. A floating button over a labelled anatomy
   *  plate has no safe corner — it will sit on a callout — and the obvious
   *  gesture on a picture you want a closer look at is to tap the picture. */
  open: boolean;
  /** Where the learner clicked, which beats the question's own region. */
  focusRegion?: ImageRevealRegion | null;
  onClose: () => void;
  /** For restoring focus on Escape/Close, per the dialog contract. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  /** Put the region in view. Safe to call more than once and at any time: it is
   *  a no-op while nothing is scrollable, which is the state a <dialog> is in
   *  before showModal() has run. Called from BOTH the image's load and the
   *  effect that shows the dialog, because either can happen first — a cached
   *  image loads before the effect, a cold one after — and the caller that runs
   *  when the box is real is the one that lands. No timer, so nothing is left
   *  pending for a later render (or a later test) to trip over. */
  // Close if the gate re-conceals underneath an open dialog.
  //
  // This used to happen for free: concealing re-rendered the gate's children
  // and CardImageZoom's own open-state went with them. With the image as the
  // trigger, `open` lives in CardImage and outlives that, so a learner who
  // switches blur back ON while magnified would keep looking at the image they
  // just asked to hide. No dependency array on purpose — the concealed marker
  // is a DOM attribute set by an ancestor, so there is nothing to depend on
  // except the render it causes.
  useEffect(() => {
    if (!open) return;
    if (triggerRef.current?.closest('[data-sensitive-media-state="concealed"]')) onClose();
  });

  const applyAnchor = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const target = anchorScroll(viewport, focusRegion ?? regions?.[0]);
    if (!target) return;
    viewport.scrollLeft = target.left;
    viewport.scrollTop = target.top;
  }, [regions, focusRegion]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const trigger = triggerRef.current;
    dialog.showModal();
    // The box only becomes measurable here: before showModal() the dialog is
    // display:none and its subtree measures 0x0, so a cached image that already
    // fired load anchored nothing.
    applyAnchor();
    closeRef.current?.focus();

    // Native modality traps focus, but window-level review shortcuts still
    // receive keys. Stop their propagation while preserving native scrolling,
    // Tab navigation and Enter/Space activation of the Close button.
    const containKey = (event: KeyboardEvent) => {
      if (!dialog.open) return;
      event.stopImmediatePropagation();
      if (event.type === 'keydown' && event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', containKey, true);
    window.addEventListener('keyup', containKey, true);
    return () => {
      window.removeEventListener('keydown', containKey, true);
      window.removeEventListener('keyup', containKey, true);
      if (dialog.open) dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open, applyAnchor]);

  return (
    <>
      {open && (
        <dialog
          ref={dialogRef}
          aria-label="Zoomed image"
          onCancel={(event) => { event.preventDefault(); onClose(); }}
          onClose={onClose}
          className="fixed inset-0 m-auto max-h-[95dvh] w-[calc(100vw-1rem)] max-w-[96rem] overflow-hidden rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-0 text-[var(--md-on-surface)] shadow-xl backdrop:bg-[var(--md-on-surface)]/60"
        >
          <div className="flex items-center justify-between gap-4 border-b border-[var(--md-outline-variant)] px-4 py-2">
            <span className="text-sm font-medium">Image</span>
            <button ref={closeRef} type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-md px-3 text-sm hover:bg-[var(--md-surface-container-high)]">
              Close
            </button>
          </div>
          {/* Clicking the picture again puts it away. Requested 2026-09-15:
              "if I click on something, I should zoom in on *that* thing, and
              when I click again it should zoom back out" — hunting for a close
              control is the wrong gesture on a surface used this often. The
              Close button stays for keyboard and screen-reader users, who
              cannot click a picture. No transition: a magnifier on the review
              loop sits in the frequency tier whose default is no animation. */}
          <div
            ref={viewportRef}
            tabIndex={0}
            role="region"
            aria-label="Scroll to inspect the zoomed image"
            onClick={onClose}
            className="max-h-[calc(95dvh-4rem)] cursor-zoom-out overflow-auto overscroll-contain bg-[var(--md-surface-container-lowest)]">
            {/* Same resolved bytes and reveal-safe alt as the card. Natural
                width (at least 60rem) gives phone labels a useful reading size. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              className="block h-auto w-auto min-w-[60rem] max-w-none"
              onLoad={applyAnchor}
            />
          </div>
        </dialog>
      )}
    </>
  );
}

function currentImageOwner(): string {
  const owner = readOfflineOwner();
  return owner ? JSON.stringify([owner.ownerKey, owner.generation]) : 'unbound';
}

/** A stalled browser cache must not hide an otherwise valid live image forever. */
function readSavedFigure(key: string, acceptLateUrl: (url: string) => void): Promise<string | null> {
  return new Promise(resolve => {
    let finished = false;
    const timer = setTimeout(() => { finished = true; resolve(null); }, 500);
    void readCachedFigure(key).then(url => {
      if (finished) {
        // A slow local read can still replace the fallback. The caller's
        // identity/owner guard also revokes it after unmount or account change.
        if (url) acceptLateUrl(url);
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(url);
    }, () => { finished = true; clearTimeout(timer); resolve(null); });
  });
}

/**
 * Card / question image renderer with a hard rule about placement:
 *
 *  - `meta.class === 'diagnostic'` (and `showWhen` is not `'after-reveal'`) →
 *    image is the question. Caller renders it above the stem, visible from the
 *    start.
 *  - everything else — non-diagnostic (lake-reference, decorative, no meta),
 *    OR a diagnostic image explicitly marked `showWhen: 'after-reveal'` → caller
 *    renders it below the answer in the context zone, post-reveal. Use the
 *    after-reveal opt-out for diagnostic figures that are supplementary context
 *    on a text card (e.g. a CXR under a cloze) rather than the question itself.
 *
 * This component just enforces the visual contract:
 *  - capped height so images can never dominate the card
 *  - caption only when `revealed` (pre-reveal would leak the finding)
 *  - alt text diagnosis-neutral pre-reveal, descriptive (key findings) post-reveal
 *  - if `meta.showWhen === 'after-reveal'` and not revealed → render nothing
 */
export function CardImage({
  src,
  caption,
  meta,
  prompt = false,
  revealed,
  postAnswerAlt,
  postAnswerSourcePageUrl,
  imageKey,
  trackingComponentId,
  onSkipSensitive,
  inSidePane = false,
}: CardImageProps) {
  const imageOwner = useSyncExternalStore(subscribeOfflineOwner, currentImageOwner, () => 'unbound');
  const incomingSource = JSON.stringify([trackingComponentId, imageKey, src, meta?.revealImageKey]);
  const sourceOwnerRef = useRef({ source: incomingSource, owner: imageOwner });
  if (sourceOwnerRef.current.source !== incomingSource) {
    sourceOwnerRef.current = { source: incomingSource, owner: imageOwner };
  }
  // A still-mounted component cannot reuse the previous account's signed URL.
  // Stable keys may recover through the new owner's cache or delivery gate.
  const sourceBelongsToOwner = sourceOwnerRef.current.owner === imageOwner;
  const showWhen = meta?.showWhen ?? 'always';
  // Explicit source role wins over sidecar placement. Without it,
  // `showWhen: 'after-reveal'` retains the established explanation behavior.
  const visible =
    prompt
      ? true
      : showWhen === 'after-reveal'
      ? revealed
      : meta?.class === 'diagnostic' || showWhen === 'always' || revealed;

  // Identity for analytics: prefer canonical imageKey (passed by caller), only
  // fall back to src if it looks like a stable path. Don't store signed R2
  // URLs (`...?X-Amz-Signature=...`) — they fragment metrics + leak the
  // signature into FeedEvent rows.
  const safeFallback = src?.startsWith('/figures/') ? src : null;
  const analyticsKey = imageKey ?? safeFallback;
  const sensitive = shouldGateClientImageMeta(meta, analyticsKey);
  const trackedKey = visible && sourceBelongsToOwner ? analyticsKey : null;
  const trackingIdentity = analyticsKey
    ? `${trackingComponentId ?? 'media'}:${analyticsKey}`
    : null;
  const { recordReveal } = useImageTracking({
    imageKey: trackedKey,
    componentId: trackingComponentId,
    modality: meta?.modality ?? null,
    condition: prompt && !revealed ? null : meta?.condition ?? null,
  });
  const revealTrackingRef = useRef<{
    identity: string | null;
    fired: boolean;
  }>({ identity: null, fired: false });
  useEffect(() => {
    if (revealTrackingRef.current.identity !== trackingIdentity) {
      revealTrackingRef.current = { identity: trackingIdentity, fired: false };
    }
    if (revealed && trackedKey && !revealTrackingRef.current.fired) {
      revealTrackingRef.current.fired = true;
      recordReveal();
    }
  }, [revealed, trackedKey, trackingIdentity, recordReveal]);
  // A BlueLink prompt is a masked bitmap, while revealImageKey points at its
  // existing unoccluded plate. Both variants use the same stable-key resolver:
  // owner-scoped offline cache first, fresh signed delivery URL second.
  const revealImageKey = meta?.revealImageKey;
  const sourceIdentity = `${imageOwner}:${trackingComponentId ?? 'media'}:${imageKey ?? safeFallback ?? src ?? 'unknown'}`;
  const [resolvedSources, setResolvedSources] = useState<{
    identity: string;
    urls: Record<string, string>;
  }>(() => ({ identity: sourceIdentity, urls: {} }));
  const [lookupState, setLookupState] = useState<{
    identity: string;
    keys: string[];
  }>(() => ({ identity: sourceIdentity, keys: [] }));
  const mountedRef = useRef(true);
  const currentIdentityRef = useRef(sourceIdentity);
  const currentAllowedKeysRef = useRef<Array<string | null | undefined>>([]);
  currentIdentityRef.current = sourceIdentity;
  currentAllowedKeysRef.current = [imageKey, revealImageKey];
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const blobsByIdentityRef = useRef(new Map<string, Set<string>>());
  const preparedLeasesRef = useRef(new Map<string, Map<string, () => void>>());
  const acceptResolvedSource = useCallback((identity: string, key: string, url: string, shared = false) => {
    if (
      !mountedRef.current
      || currentImageOwner() !== imageOwner
      || currentIdentityRef.current !== identity
      || !currentAllowedKeysRef.current.includes(key)
    ) {
      if (!shared && url.startsWith('blob:')) URL.revokeObjectURL(url);
      return;
    }
    if (!shared && url.startsWith('blob:')) {
      const blobs = blobsByIdentityRef.current.get(identity) ?? new Set<string>();
      blobs.add(url);
      blobsByIdentityRef.current.set(identity, blobs);
    }
    setResolvedSources((previous) => {
      // A delayed signed-URL recovery must not replace bytes that finished
      // caching while that request was in flight.
      if (previous.identity === identity
        && previous.urls[key]?.startsWith('blob:')
        && !url.startsWith('blob:')) return previous;
      return {
        identity,
        urls: {
          ...(previous.identity === identity ? previous.urls : {}),
          [key]: url,
        },
      };
    });
  }, [imageOwner]);

  const pendingLookupsRef = useRef(new Set<string>());
  const loadStableSource = useCallback(async (
    requestedKey: string,
    identity: string,
    cacheOnly = false,
    refreshDelivery = false,
  ) => {
    // A cache completion may arrive while an earlier network recovery is
    // pending. Allow that local read to recover the image immediately.
    const requestId = `${identity}:${requestedKey}:${cacheOnly ? 'cache' : refreshDelivery ? 'refresh' : 'delivery'}`;
    if (pendingLookupsRef.current.has(requestId)) return;
    pendingLookupsRef.current.add(requestId);
    try {
      if (currentImageOwner() !== imageOwner) return;
      const prepared = acquirePreparedFigure(requestedKey);
      if (prepared) {
        if (!mountedRef.current || currentIdentityRef.current !== identity
          || !currentAllowedKeysRef.current.includes(requestedKey)) { prepared.release(); return; }
        const leases = preparedLeasesRef.current.get(identity) ?? new Map<string, () => void>();
        if (leases.has(requestedKey)) prepared.release();
        else leases.set(requestedKey, prepared.release);
        preparedLeasesRef.current.set(identity, leases);
        acceptResolvedSource(identity, requestedKey, prepared.url, true);
        return;
      }
      // This is the primary source for an offline-pack item (which has no
      // signed URL), and the first fallback for an expired live URL.
      const objectUrl = await readSavedFigure(requestedKey, url => acceptResolvedSource(identity, requestedKey, url));
      if (objectUrl) {
        acceptResolvedSource(identity, requestedKey, objectUrl);
        return;
      }
      if (cacheOnly) return;
      if (currentImageOwner() !== imageOwner) return;
      // A valid live URL is a fallback only after the durable cache misses.
      // Do not re-sign it merely because this renderer mounted.
      if (!refreshDelivery && sourceBelongsToOwner && requestedKey === imageKey && src) {
        acceptResolvedSource(identity, requestedKey, src);
        return;
      }

      // If the bytes were not cached but connectivity has returned, recover
      // without requiring a fresh review batch.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      const res = await fetchWithDeadline(
        `/api/figures/delivery?key=${encodeURIComponent(requestedKey)}`,
        { cache: 'no-store' },
        CLIENT_FETCH_DEADLINE_MS,
      );
      if (!res.ok) return;
      const body = (await res.json()) as { imageUrl?: unknown };
      if (typeof body.imageUrl === 'string') {
        acceptResolvedSource(identity, requestedKey, body.imageUrl);
      }
    } catch {
      // Leave the appropriate placeholder in place rather than throwing.
    } finally {
      pendingLookupsRef.current.delete(requestId);
      if (
        mountedRef.current
        && currentImageOwner() === imageOwner
        && currentIdentityRef.current === identity
        && currentAllowedKeysRef.current.includes(requestedKey)
      ) {
        setLookupState((previous) => ({
          identity,
          keys: previous.identity === identity
            ? [...new Set([...previous.keys, requestedKey])]
            : [requestedKey],
        }));
      }
    }
  }, [acceptResolvedSource, imageKey, src, imageOwner, sourceBelongsToOwner]);

  // Offline-pack payloads contain only imageKey + client-safe placement
  // metadata. Resolve the owner-scoped cached bytes as soon as the renderer
  // mounts; waiting for an <img> error is impossible when there is no src.
  useEffect(() => {
    if (imageKey) void loadStableSource(imageKey, sourceIdentity);
  }, [imageKey, loadStableSource, sourceIdentity, src]);

  // Warm the unoccluded source while the learner is still looking at the
  // prompt. Answer reveal should be an immediate swap whenever cache/network
  // permits, and must never flash the masked prompt as a fallback.
  useEffect(() => {
    if (revealImageKey) void loadStableSource(revealImageKey, sourceIdentity);
  }, [loadStableSource, revealImageKey, sourceIdentity]);

  const resignedForRef = useRef(new Set<string>());
  useEffect(() => {
    const retry = (cacheOnly: boolean) => {
      for (const key of [imageKey, revealImageKey]) {
        if (!key) continue;
        const resolved = resolvedSources.identity === sourceIdentity
          ? resolvedSources.urls[key]
          : undefined;
        if (resolved?.startsWith('blob:')) continue;
        void loadStableSource(key, sourceIdentity, cacheOnly);
      }
    };
    const onCacheChange = () => retry(true);
    const onOnline = () => retry(false);
    window.addEventListener(OFFLINE_FIGURES_CHANGE_EVENT, onCacheChange);
    window.addEventListener(PREPARED_FIGURES_CHANGE_EVENT, onCacheChange);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener(OFFLINE_FIGURES_CHANGE_EVENT, onCacheChange);
      window.removeEventListener(PREPARED_FIGURES_CHANGE_EVENT, onCacheChange);
      window.removeEventListener('online', onOnline);
    };
  }, [imageKey, revealImageKey, resolvedSources, sourceIdentity, src, loadStableSource]);

  const displayImageKey = revealed && revealImageKey ? revealImageKey : imageKey;
  const handleImageError = useCallback(() => {
    if (!displayImageKey) return;
    const retryId = `${sourceIdentity}:${displayImageKey}`;
    if (resignedForRef.current.has(retryId)) return;
    resignedForRef.current.add(retryId);
    void loadStableSource(displayImageKey, sourceIdentity, false, true);
  }, [displayImageKey, loadStableSource, sourceIdentity]);

  // Object URLs from the figure cache hold a blob in memory until revoked. A
  // review component is reused across cards, so release all variants as soon as
  // its identity changes (and again on unmount).
  useEffect(() => {
    const blobsByIdentity = blobsByIdentityRef.current;
    const preparedLeases = preparedLeasesRef.current;
    return () => {
      for (const release of preparedLeases.get(sourceIdentity)?.values() ?? []) release();
      preparedLeases.delete(sourceIdentity);
      const urls = blobsByIdentity.get(sourceIdentity);
      if (!urls) return;
      for (const url of urls) URL.revokeObjectURL(url);
      blobsByIdentity.delete(sourceIdentity);
    };
  }, [sourceIdentity]);

  const activeResolvedSources = resolvedSources.identity === sourceIdentity
    ? resolvedSources.urls
    : {};
  const showingRevealImage = Boolean(revealed && revealImageKey);
  const completedLookups = lookupState.identity === sourceIdentity ? lookupState.keys : [];
  // When the owner has durable storage, do not start a live <img> request in
  // the render-to-effect gap. A prepared URL is available synchronously.
  const checkingSavedPrimary = Boolean(imageKey && readOfflineOwner() && !completedLookups.includes(imageKey));
  const effectiveSrc = showingRevealImage
    ? (revealImageKey ? activeResolvedSources[revealImageKey] ?? peekPreparedFigure(revealImageKey) : null)
    : (imageKey ? activeResolvedSources[imageKey] ?? peekPreparedFigure(imageKey) : null)
      ?? (checkingSavedPrimary || !sourceBelongsToOwner ? null : src) ?? null;

  // Big by default (the reference learner, 2026-07-25). A clinical figure at 176px tall is
  // unreadable — you cannot see a rash, a murmur diagram or a CXR at thumbnail
  // size, which defeats the point of attaching it. Tap to shrink if it is in
  // the way.
  const [expanded] = useState(true);
  // The IMAGE is the zoom trigger. Requested 2026-09-15: "I don't see why we
  // need a button. I should just be able to click on the image and have it
  // zoom into the relevant part of the plate for the question I'm trying to
  // answer." The dialog already anchors on this question's reveal region, so
  // the behaviour existed — it was only reachable through a control that had
  // to float somewhere over the picture, and on a labelled plate every corner
  // is somebody's callout.
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoomFocus, setZoomFocus] = useState<ImageRevealRegion | null>(null);
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);

  // Close the magnified view when the FIGURE changes underneath it.
  //
  // This used to fall out of the `key` on CardImageZoom: a new identity
  // remounted the component and its internal open-state reset to false. Now
  // that the image is the trigger, `open` lives here and survives that remount
  // — so a card advance, a source swap or a reveal would leave the previous
  // card's magnified image sitting in the top layer. Made explicit rather than
  // implicit, because the old behaviour depended on where the state happened to
  // live. Declared here, above every early return, since hooks cannot be
  // conditional.
  const zoomIdentity = JSON.stringify([sourceIdentity, incomingSource, effectiveSrc, revealed, sensitive]);
  useEffect(() => { setZoomOpen(false); setZoomFocus(null); }, [zoomIdentity]);
  // Keep the source plate's aspect ratio through loading and reveal. In
  // particular, credit and captions must not shrink the picture on Space.
  const [loadedDimensions, setLoadedDimensions] = useState({ identity: '', width: 0, height: 0 });
  const imageWidth = meta?.imageWidth ?? (loadedDimensions.identity === sourceIdentity ? loadedDimensions.width : 0);
  const imageHeight = meta?.imageHeight ?? (loadedDimensions.identity === sourceIdentity ? loadedDimensions.height : 0);
  const ratio = imageWidth > 0 && imageHeight > 0 ? imageWidth / imageHeight : undefined;
  const figureStyle = {
    ...(ratio ? { '--md-figure-ratio': ratio } : {}),
    // Reserve the same space before and after reveal without putting hidden
    // answer-bearing text in the DOM. Opening Credit may scroll; it never
    // changes the image scale.
    '--md-figure-notes-space': `${(caption ? 72 : 0) + (meta?.attributionText ? 20 : 0)}px`,
  } as CSSProperties;

  if (!visible) return null;

  const altText = computeAlt(meta, caption, prompt, revealed, postAnswerAlt);
  const activeSourcePageUrl = revealed
    ? postAnswerSourcePageUrl ?? meta?.sourcePageUrl
    : meta?.sourcePageUrl;
  const showAnswerBearingCredit = !prompt || revealed;

  // The image starts at the largest contained size. An explicit tap can
  // collapse it; answering never changes its size.
  //
  // The caption sits BELOW the image in normal flow (the reference learner, 2026-07-30: "the
  // caption is covering the bottom of the image"). It used to be a translucent
  // bar absolutely pinned to bottom-0, which permanently hid the bottom slice of
  // an expanded figure — the x-axis of a chart, a figure's own printed label —
  // and on a collapsed figure it was hover-gated, so unreachable on touch. In
  // flow it costs two lines and hides nothing, and it matches every other
  // figcaption in the app (Figure.client, ClozeCard, QuestionBankMCQ).
  //
  // The caption is never also a native `title` tooltip, which doubled it up.
  // Pre-reveal it stays hidden so it can't leak the finding, and it is a sibling
  // of the button — <figcaption> inside <button> is invalid HTML and weakens
  // assistive-tech behavior.
  const consentKey = `${trackingComponentId ?? 'media'}:${imageKey ?? safeFallback ?? src ?? 'unknown'}`;


  return (
    <SensitiveMediaGate
      consentKey={consentKey}
      sensitive={sensitive}
      onSkip={sensitive && !revealed ? onSkipSensitive : undefined}
      captureReviewSpace={sensitive && !revealed}
    >
        <figure style={figureStyle} className={`review-figure mb-4${inSidePane ? ` ${SIDE_PANE_FIGURE}` : ''}${expanded ? '' : ' review-figure-compact'}`}>
          <div data-figure-frame style={ratio ? { aspectRatio: ratio } : undefined}
            className={`relative mx-auto block w-full overflow-hidden rounded-lg border border-[var(--md-outline-variant)] ${expanded ? 'cursor-zoom-out' : 'cursor-zoom-in'}`}>
            {effectiveSrc ? (
            <>
            <button
              ref={zoomTriggerRef}
              type="button"
              aria-haspopup="dialog"
              onClick={(event) => {
                // A native dialog enters the top layer and escapes ancestor
                // blur, so do not let activation of the gate's aria-hidden
                // children bypass its explicit Show image action.
                if (zoomTriggerRef.current?.closest('[data-sensitive-media-state="concealed"]')) return;
                // Anchor on the structure the learner pointed at, not on the
                // question's region. A keyboard activation has no coordinates
                // (clientX is 0 and the rect is unreachable), so it falls back
                // to the region, which is the right answer for that path.
                const rect = event.currentTarget.getBoundingClientRect();
                setZoomFocus(
                  event.detail === 0
                    ? null
                    : clickFocusRegion(rect, event.clientX, event.clientY),
                );
                setZoomOpen(true);
              }}
              aria-label={revealed && caption ? `Zoom image: ${caption}` : 'Zoom image'}
              className="relative block h-full w-full"
            >
              {/* No `title` here: the styled <figcaption> below is the single caption
                  source. A native `title` tooltip duplicated it on hover (and went
                  dark in OS dark mode), which read as captions "doubling up". */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={effectiveSrc}
                alt={altText}
                onError={handleImageError}
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget;
                  if (naturalWidth && naturalHeight) setLoadedDimensions(previous =>
                    previous.identity === sourceIdentity && previous.width > 0
                      ? previous : { identity: sourceIdentity, width: naturalWidth, height: naturalHeight });
                }}
                className="block h-full w-full object-contain"
              />
              {showingRevealImage && meta?.revealRegions?.map((region, index) => (
                <span key={index} data-reveal-region aria-hidden="true"
                  className="pointer-events-none absolute"
                  style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`,
                    width: `${region.width * 100}%`, height: `${region.height * 100}%`,
                    outline: '2px solid var(--md-anatomy-target)', outlineOffset: '1px', backgroundColor: 'transparent' }} />
              ))}
            </button>
            <CardImageZoom
              key={`${zoomIdentity}:${altText}`}
              src={effectiveSrc}
              alt={altText}
              regions={meta?.revealRegions}
              focusRegion={zoomFocus}
              open={zoomOpen}
              onClose={() => setZoomOpen(false)}
              triggerRef={zoomTriggerRef}
            />
            </>
            ) : (
              <div role="status" className="flex h-full min-h-28 items-center justify-center px-3 py-6 text-center text-sm text-[var(--md-on-surface-variant)]">
                {displayImageKey && completedLookups.includes(displayImageKey)
                  ? 'Figure unavailable offline'
                  : showingRevealImage ? 'Loading answer figure…' : 'Loading saved figure…'}
              </div>
            )}
          </div>
          {revealed && caption && (
            <figcaption className="mt-2 text-left text-sm leading-snug text-[var(--md-on-surface-variant)]">
              {caption}
            </figcaption>
          )}
          {/*
            * No "Restricted" chip here. It rendered `accessTier` —
            * auth-required or copyright-required — which is an INTERNAL rights
            * classification: it tells the learner nothing they can act on, and
            * by the time they can see the figure the gate has already let them
            * through, so it only ever appeared to people it did not apply to.
            *
            * It also cost more than a line of text. The side-pane height budget
            * bounds the whole FIGURE — image, caption and this line together —
            * so on a portrait plate every line here is subtracted from the
            * image. The two MCQ surfaces keep their own chip and their own
            * assertions; this is the review card only.
            */}
          {/*
            * Credit lives in a collapsed disclosure rather than two full lines
            * under every figure. Requested 2026-09-12: "we can hide attribution
            * in details".
            *
            * A disclosure and not a deletion, because the licences require it:
            * BlueLink is "educational, non-commercial use with credit" and the
            * textbook plates are all-rights-reserved. Credit stays on the card,
            * one click away, with its Source and Licence links — what goes is
            * the two wrapped lines of it sitting under a figure the learner is
            * trying to read. The card detail page does NOT render attribution,
            * so removing it here would have dropped credit from the product
            * entirely.
            *
            * `showAnswerBearingCredit` still gates the whole thing: before
            * reveal on a prompt figure this does not render at all, because an
            * attribution naming the structure would hand over the answer.
            */}
          {/*
            * Zoom sits HERE, under the figure, and not floating on top of it.
            *
            * It was `absolute right-1 top-1` inside the image frame. On a
            * labelled anatomy plate there is no safe corner — BlueLink and
            * Kubie put callout boxes wherever the structure happens to be — and
            * it was reported covering a callout on a cranium plate that named
            * the structure being asked for, i.e. the answer.
            *
            * It shares the Credit line rather than taking one of its own,
            * because the side-pane height budget bounds the whole FIGURE and
            * every line under the image is subtracted from the image.
            */}
          {(effectiveSrc || (meta?.attributionText && showAnswerBearingCredit)) && (
            <div className="mt-1 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
          {meta?.attributionText && showAnswerBearingCredit && (
            <details className="text-left text-xs leading-snug text-[var(--md-on-surface-variant)]">
              <summary className="cursor-pointer list-none opacity-60 hover:opacity-100">
                Credit
              </summary>
              <p className="mt-1">
              {showAnswerBearingCredit && meta?.attributionText}
              {showAnswerBearingCredit && activeSourcePageUrl && (
                <>
                  {' · '}
                  <a
                    href={activeSourcePageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-[var(--md-outline)] underline-offset-2 hover:text-[var(--md-on-surface)]"
                  >
                    Source
                  </a>
                </>
              )}
              {showAnswerBearingCredit && meta?.licenseUrl && (
                <>
                  {' · '}
                  <a
                    href={meta.licenseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-[var(--md-outline)] underline-offset-2 hover:text-[var(--md-on-surface)]"
                  >
                    Licence
                  </a>
                </>
              )}
              </p>
            </details>
          )}
              </div>
              {/* Credit must still render while the answer figure is loading and
                * effectiveSrc is briefly empty — gating the whole row on the
                * image dropped attribution mid-reveal, which is a licence
                * obligation, not a cosmetic line. */}

            </div>
          )}
        </figure>
    </SensitiveMediaGate>
  );
}

function computeAlt(
  meta: ClientImageMeta | undefined,
  caption: string | null | undefined,
  prompt: boolean,
  revealed: boolean,
  postAnswerAlt?: string | null,
): string {
  if (prompt && !revealed) return 'Question prompt image';
  if (!meta) return revealed ? (caption ?? 'Card figure') : 'Card figure';
  if (meta.class === 'diagnostic') {
    if (!revealed && meta.preAnswerAlt) return meta.preAnswerAlt;
    if (revealed && postAnswerAlt) return postAnswerAlt;
    if (revealed && meta.keyFindings && meta.keyFindings.length > 0) {
      return meta.keyFindings.join('; ');
    }
    return 'clinical image';
  }
  if (meta.class === 'diagram') return meta.topic ?? 'diagram';
  if (meta.class === 'lake-reference') return meta.topic ?? 'reference image';
  return 'figure';
}
