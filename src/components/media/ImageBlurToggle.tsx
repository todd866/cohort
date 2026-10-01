'use client';

import { useImageBlurPreference } from './useImageBlurPreference';

export function ImageBlurToggle() {
  const { blurImages, setBlurImages } = useImageBlurPreference();
  return (
    <button
      type="button"
      role="switch"
      aria-label="Blur images"
      aria-checked={blurImages}
      onClick={() => setBlurImages(!blurImages)}
      className="inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-1 text-xs text-[var(--md-on-surface-variant)] transition-colors hover:bg-[var(--md-surface-container-high)]"
    >
      <span>Blur<span className="hidden sm:inline"> images</span></span>
      <span className="font-medium text-[var(--md-on-surface)]">{blurImages ? 'On' : 'Off'}</span>
    </button>
  );
}
