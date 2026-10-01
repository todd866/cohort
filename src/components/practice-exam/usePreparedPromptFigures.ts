'use client';

import type { PromptFigureView } from '@/lib/practice-exam/prompt-figure';

export type PreparedPromptFigure = { status: 'loading' | 'ready' | 'error'; src?: string };

/** Public builds omit private exam images and never request their assets. */
export function usePreparedPromptFigures(_figures: PromptFigureView[], _enabled = true): {
  prepared: Record<string, PreparedPromptFigure>;
  retry: (src: string) => void;
  markError: (src: string) => void;
} {
  return { prepared: {}, retry: () => undefined, markError: () => undefined };
}
