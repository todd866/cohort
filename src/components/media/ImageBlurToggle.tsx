'use client';

import { ChipToggle } from '@/components/shared/Chip';
import { useImageBlurPreference } from './useImageBlurPreference';

export function ImageBlurToggle() {
  const { blurImages, setBlurImages } = useImageBlurPreference();
  return (
    <ChipToggle
      on={blurImages}
      semantics="switch"
      aria-label="Blur images"
      onClick={() => setBlurImages(!blurImages)}
      className="shrink-0"
    >
      <span>Blur images</span>
    </ChipToggle>
  );
}
