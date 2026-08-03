'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientImageMeta } from '@/lib/figures/types';
import { useImageTracking } from '@/hooks/useTracking';
import { readCachedFigure } from '@/lib/offline/figures';
import {
  CLIENT_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';

interface CardImageProps {
  /** A live/signed source when one is available. Offline-pack items deliberately
   * omit it and resolve their stable imageKey from the owner-scoped cache. */
  src?: string | null;
  caption?: string | null;
  meta?: ClientImageMeta;
  /** Whether the answer has been revealed. Drives caption visibility (so the
   *  caption itself doesn't leak the finding pre-reveal) and alt-text mode. */
  revealed: boolean;
  /** Canonical image key for analytics (e.g. `/figures/cah/derm/foo.jpg`).
   *  When omitted, falls back to `src` — but `src` is usually a short-lived
   *  signed R2 URL, so callers should pass the resolved imageKey when they
   *  have it. */
  imageKey?: string | null;
  /** Component id (cardId / questionId) attached to the analytics event. */
  trackingComponentId?: string;
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
 *  - alt text generic pre-reveal, descriptive (key findings) post-reveal
 *  - if `meta.showWhen === 'after-reveal'` and not revealed → render nothing
 */
export function CardImage({
  src,
  caption,
  meta,
  revealed,
  imageKey,
  trackingComponentId,
}: CardImageProps) {
  const showWhen = meta?.showWhen ?? 'always';
  // `showWhen: 'after-reveal'` always wins, even for diagnostic images: those
  // are rendered in the post-reveal context zone, so they must stay hidden
  // until the answer is shown (otherwise the figure would leak the answer).
  const visible =
    showWhen === 'after-reveal'
      ? revealed
      : meta?.class === 'diagnostic' || showWhen === 'always' || revealed;

  // Identity for analytics: prefer canonical imageKey (passed by caller), only
  // fall back to src if it looks like a stable path. Don't store signed R2
  // URLs (`...?X-Amz-Signature=...`) — they fragment metrics + leak the
  // signature into FeedEvent rows.
  const safeFallback = src?.startsWith('/figures/') ? src : null;
  const trackedKey = visible ? (imageKey ?? safeFallback) : null;
  const { recordReveal } = useImageTracking({
    imageKey: trackedKey,
    componentId: trackingComponentId,
    modality: meta?.modality ?? null,
    condition: meta?.condition ?? null,
  });
  const revealFiredRef = useRef(false);
  useEffect(() => {
    if (revealed && trackedKey && !revealFiredRef.current) {
      revealFiredRef.current = true;
      recordReveal();
    }
  }, [revealed, trackedKey, recordReveal]);
  // Figure URLs are signed with hourFloor(now) + a 7200s TTL, so a batch fetched
  // at HH:59 carries URLs that die ~61 minutes later. Studying past that point
  // 403s every copyright-tier image still on screen, and nothing re-signed them.
  // Re-request a fresh URL once, off the stable imageKey. Once only: if the
  // fresh URL also fails the image is genuinely gone, and a retry loop would
  // hammer the route for every card in the batch.
  // Keyed by imageKey rather than reset in an effect: a new card falls back to
  // its own `src` automatically, and gets its own single retry.
  const [signed, setSigned] = useState<{ key: string; url: string } | null>(null);
  const [lookupCompleteFor, setLookupCompleteFor] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const currentKeyRef = useRef(imageKey);
  currentKeyRef.current = imageKey;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const acceptResolvedSource = useCallback((key: string, url: string) => {
    if (!mountedRef.current || currentKeyRef.current !== key) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      return;
    }
    setSigned({ key, url });
  }, []);

  const loadStableSource = useCallback(async () => {
    if (!imageKey) return;
    const requestedKey = imageKey;
    try {
      // This is the primary source for an offline-pack item (which has no
      // signed URL), and the first fallback for an expired live URL.
      const objectUrl = await readCachedFigure(requestedKey);
      if (objectUrl) {
        acceptResolvedSource(requestedKey, objectUrl);
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
        acceptResolvedSource(requestedKey, body.imageUrl);
      }
    } catch {
      // Leave the placeholder/original source in place rather than throwing
      // inside a render.
    } finally {
      if (mountedRef.current && currentKeyRef.current === requestedKey) {
        setLookupCompleteFor(requestedKey);
      }
    }
  }, [acceptResolvedSource, imageKey]);

  // Offline-pack payloads contain only imageKey + client-safe placement
  // metadata. Resolve the owner-scoped cached bytes as soon as the renderer
  // mounts; waiting for an <img> error is impossible when there is no src.
  useEffect(() => {
    if (!src && imageKey) void loadStableSource();
  }, [imageKey, loadStableSource, src]);

  const resignedForRef = useRef<string | null>(null);
  const handleImageError = useCallback(() => {
    if (!imageKey || resignedForRef.current === imageKey) return;
    resignedForRef.current = imageKey;
    void loadStableSource();
  }, [imageKey, loadStableSource]);

  // Object URLs from the figure cache hold a blob in memory until revoked.
  useEffect(() => {
    const url = signed?.url;
    if (!url?.startsWith('blob:')) return;
    return () => URL.revokeObjectURL(url);
  }, [signed?.url]);
  const effectiveSrc = signed && signed.key === imageKey ? signed.url : (src ?? null);

  // Big by default (the reference learner, 2026-07-25). A clinical figure at 176px tall is
  // unreadable — you cannot see a rash, a murmur diagram or a CXR at thumbnail
  // size, which defeats the point of attaching it. Tap to shrink if it is in
  // the way.
  const [expanded, setExpanded] = useState(true);
  // Sensitive clinical photos (genital/STI) render blurred behind a tap-to-reveal
  // overlay so they aren't displayed openly. Opt-in per image via meta.sensitive;
  // resets per card (new CardImage instance → blurred again).
  const [unblurred, setUnblurred] = useState(false);
  const blurred = meta?.sensitive === true && !unblurred;

  if (!visible) return null;

  const altText = computeAlt(meta, caption, revealed);

  if (!effectiveSrc) {
    return (
      <div
        role="status"
        className="mb-4 rounded-lg border border-[var(--md-outline-variant)] px-3 py-6 text-center text-sm text-[var(--md-on-surface-variant)]"
      >
        {lookupCompleteFor === imageKey ? 'Figure unavailable offline' : 'Loading saved figure…'}
      </div>
    );
  }

  // The image is a tap/click control: compact by default so it never buries the
  // answers (esp. on mobile), enlarges to near-fullscreen on tap.
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
  return (
    <figure className="mb-4">
      <div className={`relative mx-auto block max-w-full ${expanded ? 'cursor-zoom-out' : 'cursor-zoom-in'}`}>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-label={revealed && caption ? caption : expanded ? 'Collapse image' : 'Enlarge image'}
          className="block w-full"
        >
          {/* No `title` here: the styled <figcaption> below is the single caption
              source. A native `title` tooltip duplicated it on hover (and went
              dark in OS dark mode), which read as captions "doubling up". */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={effectiveSrc}
            alt={altText}
            onError={handleImageError}
            className={`block mx-auto w-auto max-w-full rounded-lg border border-[var(--md-outline-variant)] ${
              expanded ? 'max-h-[80vh]' : 'max-h-44 sm:max-h-72'
            } ${blurred ? 'blur-xl select-none' : ''}`}
          />
        </button>
        {blurred && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setUnblurred(true); }}
            aria-label="Reveal sensitive image"
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded-lg bg-black/40 text-center text-xs font-medium text-white"
          >
            <EyeIcon className="h-5 w-5" />
            <span>Sensitive image</span>
            <span className="opacity-80">tap to reveal</span>
          </button>
        )}
      </div>
      {/* Caption is suppressed while blurred so it can't leak the finding. */}
      {revealed && caption && !blurred && (
        <figcaption className="mt-2 text-left text-sm leading-snug text-[var(--md-on-surface-variant)]">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function computeAlt(
  meta: ClientImageMeta | undefined,
  caption: string | null | undefined,
  revealed: boolean,
): string {
  if (!meta) return revealed ? (caption ?? 'Card figure') : 'Card figure';
  if (meta.class === 'diagnostic') {
    if (revealed && meta.keyFindings && meta.keyFindings.length > 0) {
      return meta.keyFindings.join('; ');
    }
    return 'clinical image';
  }
  if (meta.class === 'diagram') return meta.topic ?? 'diagram';
  if (meta.class === 'lake-reference') return meta.topic ?? 'reference image';
  return 'figure';
}
