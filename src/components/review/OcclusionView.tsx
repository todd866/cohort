'use client';

import { useState, type CSSProperties } from 'react';

export interface OcclusionRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Convert an AnKing occlusion rect (absolute pixels on the ORIGINAL image) into
 * a percentage-based overlay style, so the mask scales with the responsively-
 * sized <img>. Needs the image's natural dimensions (captured on load). Returns
 * a hidden style until dimensions are known (avoids a mispositioned flash).
 */
export function occlusionRegionStyle(
  r: OcclusionRegion,
  naturalW: number,
  naturalH: number,
): CSSProperties {
  if (naturalW <= 0 || naturalH <= 0) return { display: 'none' };
  return {
    position: 'absolute',
    left: `${(r.x / naturalW) * 100}%`,
    top: `${(r.y / naturalH) * 100}%`,
    width: `${(r.w / naturalW) * 100}%`,
    height: `${(r.h / naturalH) * 100}%`,
  };
}

interface OcclusionViewProps {
  src: string;
  /** All occlusion regions for the source image (so siblings stay consistent). */
  regions: OcclusionRegion[];
  /** Which region THIS card tests — the n-to-answer "one by one" target. */
  targetIndex: number;
  /** Answer revealed → the mask becomes an outline highlighting what was hidden. */
  revealed: boolean;
  alt?: string;
}

/**
 * Image-occlusion (n-to-answer) renderer. One source image, N labelled regions;
 * each card hides exactly ONE region (the target — "what's under this box?") and
 * leaves the rest visible. On reveal the opaque mask becomes a coloured outline
 * so the student can confirm the spot. The DATA model + AnKing parser live in
 * scripts/anki-import/lib/anking.ts (noteToOcclusionCards).
 */
export function OcclusionView({ src, regions, targetIndex, revealed, alt }: OcclusionViewProps) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const target = regions[targetIndex];

  return (
    <div className="relative inline-block max-w-full">
      {/* A raw image exposes natural dimensions needed to align source-pixel masks. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? (revealed ? 'Occlusion region revealed' : 'Identify the masked region')}
        className="max-w-full max-h-[60vh] object-contain rounded-lg"
        onLoad={(e) =>
          setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }
      />
      {dims && target && (
        <div
          data-testid="occlusion-mask"
          data-revealed={revealed ? 'true' : 'false'}
          aria-label={revealed ? 'Revealed region' : 'Masked region — recall what is here'}
          style={occlusionRegionStyle(target, dims.w, dims.h)}
          className={
            revealed
              ? 'border-2 border-[var(--md-primary)] rounded-sm pointer-events-none'
              : 'bg-[var(--md-surface-container-highest)] border border-[var(--md-outline)] rounded-sm'
          }
        />
      )}
    </div>
  );
}
