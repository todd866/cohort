'use client';

import type { PromptFigure, PromptFigureView } from '@/lib/practice-exam/prompt-figure';
import type { PreparedPromptFigure } from './usePreparedPromptFigures';

/** Public builds have no private practice-exam image delivery lane. */
export function PracticePromptFigure(_props: {
  figure: PromptFigureView | PromptFigure;
  prepared?: PreparedPromptFigure;
  onRetry?: (src: string) => void;
  onImageError?: (src: string) => void;
  showAttribution?: boolean;
}) {
  return null;
}
