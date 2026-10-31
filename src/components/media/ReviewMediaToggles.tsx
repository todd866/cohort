'use client';

import { ChipToggle } from '@/components/shared/Chip';
import type { ReviewMediaPreferences } from '@/lib/study/review-media-preferences';

/**
 * "No videos" / "No images": the same labelled switch chips as Blur images,
 * placed beside it. Items whose clip or picture is the question leave the
 * queue; media after the answer is not shown.
 */
export function ReviewMediaToggles({
  preferences,
  onToggle,
}: {
  preferences: ReviewMediaPreferences;
  onToggle: (kind: 'hideVideos' | 'hideImages', on: boolean) => void;
}) {
  return (
    <>
      <ChipToggle
        on={preferences.hideVideos}
        semantics="switch"
        aria-label="No videos"
        onClick={() => onToggle('hideVideos', !preferences.hideVideos)}
        className="shrink-0"
      >
        <span>No videos</span>
      </ChipToggle>
      <ChipToggle
        on={preferences.hideImages}
        semantics="switch"
        aria-label="No images"
        onClick={() => onToggle('hideImages', !preferences.hideImages)}
        className="shrink-0"
      >
        <span>No images</span>
      </ChipToggle>
    </>
  );
}
