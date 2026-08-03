'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Image, { type StaticImageData } from 'next/image';
import { useReviewMode } from '@/components/review/ReviewModeProvider';
import { ImageOcclusion, type OcclusionRegion } from '@/components/content/ImageOcclusion';
import { useFigureTracking, useImageTracking } from '@/hooks/useTracking';
import { ContentFlag } from './ContentFlag';
import { normalizeSnapshot } from './content-flag-utils';
import type { ClientImageMeta } from '@/lib/figures/types';

type FigureSrc = string | StaticImageData;

interface FigureClientProps {
  src: FigureSrc;
  alt: string;
  caption?: string;
  source?: string;
  href?: string;
  id?: string;
  occlusions?: OcclusionRegion[];
  occlude?: 'all' | 'random';
  occludeCount?: number;
  /** Resolved metadata forwarded from the server wrapper. */
  meta?: ClientImageMeta;
  /** Original imageKey (e.g. /figures/cah/derm/hsp.jpg) for analytics. */
  imageKey?: string;
}

function resolveSrc(src: FigureSrc): string {
  return typeof src === 'string' ? src : src.src;
}

export function FigureClient({
  src,
  alt,
  caption,
  source,
  href,
  id,
  occlusions,
  occlude,
  occludeCount,
  meta,
  imageKey,
}: FigureClientProps) {
  const reviewMode = useReviewMode();
  const resolvedSrc = useMemo(() => resolveSrc(src), [src]);
  const figureId = id ?? resolvedSrc;
  // source + href come from explicit MDX props; meta.attributionText is the tooltip
  const effectiveSource = source;
  const effectiveHref = href;
  const attributionText = meta?.attributionText;
  const flagSnapshot = useMemo(
    () => normalizeSnapshot([caption, alt].filter(Boolean).join(' ')),
    [caption, alt]
  );

  const [zoomOpen, setZoomOpen] = useState(false);
  const { onOpen, onClose } = useFigureTracking(figureId);

  // Image impression tracking. Identity is the canonical imageKey from the
  // server resolver — never the signed R2 URL in `src`. Reveal fires when
  // the user opens the zoom view (treat it as the "uncovered" interaction).
  const { recordReveal } = useImageTracking({
    imageKey: imageKey ?? (typeof src === 'string' && src.startsWith('/figures/') ? src : null),
    componentId: figureId,
    modality: meta?.modality ?? null,
    condition: meta?.condition ?? null,
  });

  const openZoom = useCallback(() => {
    setZoomOpen(true);
    onOpen();
    recordReveal();
  }, [onOpen, recordReveal]);

  const closeZoom = useCallback(() => {
    setZoomOpen(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!zoomOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeZoom();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeZoom, zoomOpen]);

  const shouldRenderOcclusion =
    reviewMode.enabled && Array.isArray(occlusions) && occlusions.length > 0;

  if (shouldRenderOcclusion) {
    const effectiveOcclude: 'all' | 'random' = occlude ?? 'random';
    const effectiveOccludeCount =
      effectiveOcclude === 'random'
        ? typeof occludeCount === 'number'
          ? occludeCount
          : Math.min(3, occlusions?.length ?? 0)
        : occludeCount;

    return (
      <ImageOcclusion
        id={figureId}
        title={caption}
        src={src}
        alt={alt}
        regions={occlusions ?? []}
        occlude={effectiveOcclude}
        occludeCount={effectiveOccludeCount}
        rotation={reviewMode.rotation}
        week={reviewMode.week}
        topics={reviewMode.topics}
      />
    );
  }

  return (
    <figure className="my-8 relative">
      <ContentFlag
        targetType="component"
        targetId={figureId}
        componentType="Figure"
        contentSnapshot={flagSnapshot}
        className="absolute right-3 top-3 z-10"
      />
      <button
        type="button"
        onClick={openZoom}
        className="w-full rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] overflow-hidden hover:brightness-[0.99] transition"
        aria-label={caption ? `Open image: ${caption}` : 'Open image'}
      >
        {typeof src === 'string' ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={src}
            alt={alt}
            loading="lazy"
            className="w-full h-auto block"
          />
        ) : (
          <Image
            src={src}
            alt={alt}
            className="w-full h-auto"
          />
        )}
      </button>

      {(caption || effectiveSource) && (
        <figcaption className="mt-3 text-sm text-[var(--md-on-surface-variant)]">
          {caption && (
            <span className="font-medium text-[var(--md-on-surface)]">{caption}</span>
          )}
          {effectiveSource && (
            <span className={caption ? 'ml-2' : ''}>
              {caption ? '— ' : ''}
              {effectiveHref ? (
                <a
                  href={effectiveHref}
                  className="text-[var(--md-primary)] hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                  title={attributionText}
                >
                  {effectiveSource}
                </a>
              ) : (
                <span title={attributionText}>{effectiveSource}</span>
              )}
            </span>
          )}
        </figcaption>
      )}

      {zoomOpen && (
        <div
          className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closeZoom}
          role="presentation"
        >
          <div
            className="relative max-w-6xl w-full max-h-[90vh] rounded-2xl overflow-hidden bg-black"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={closeZoom}
              className="absolute top-3 right-3 z-10 px-3 py-1.5 rounded-lg bg-black/60 text-white text-sm hover:bg-black/70"
            >
              Close
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={resolvedSrc}
              alt={alt}
              className="w-full h-auto max-h-[90vh] object-contain block"
            />
          </div>
        </div>
      )}
    </figure>
  );
}
