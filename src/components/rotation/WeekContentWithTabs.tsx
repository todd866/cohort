'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ContentFlagOverlayProvider, type ContentFlagRequest } from '@/components/content/content-flag-overlay-context';
import { TopicTabBar } from '@/components/content/TopicTabBar';
import {
  ContentReadingModeProvider,
  useContentReadingMode,
} from '@/components/content/content-reading-mode';
import { FlagOverlay } from '@/components/review/FlagOverlay';
import { useContentKeyboard } from '@/hooks/useContentKeyboard';
import { KeyboardHintBar } from '@/components/shared/KeyboardHintBar';
import { useFlagImage } from '@/components/content/FlagImageInput';
import { submitFlag } from '@/lib/flag-submit';

interface Props {
  children: ReactNode;
  prevWeekHref: string | null;
  nextWeekHref: string | null;
}

function ShowAnswersToggle() {
  const { showAnswers, toggleShowAnswers } = useContentReadingMode();
  return (
    <button
      type="button"
      onClick={toggleShowAnswers}
      className="shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold text-[var(--md-primary)] transition-colors hover:bg-[var(--md-primary-container)]"
    >
      {showAnswers ? 'Hide answers' : 'Show answers'}
    </button>
  );
}

export function WeekContentWithTabs({ children, prevWeekHref, nextWeekHref }: Props) {
  const articleRef = useRef<HTMLDivElement>(null);
  const [flagMode, setFlagMode] = useState(false);
  const [flagMessage, setFlagMessage] = useState('');
  const [activeFlag, setActiveFlag] = useState<ContentFlagRequest | null>(null);
  const [flaggedKeys, setFlaggedKeys] = useState<Set<string>>(() => new Set());

  const image = useFlagImage(activeFlag?.flagKey ?? '');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const openFocusedFlag = useCallback(() => {
    const blocks = Array.from(
      document.querySelectorAll<HTMLElement>('[data-content-block]'),
    );
    if (blocks.length === 0) return;
    // Flag whatever the reader is looking at: the block nearest the viewport
    // centre, preferring on-screen blocks. Measured once, only on F press —
    // no per-scroll cost.
    const center = window.innerHeight / 2;
    let best: HTMLElement | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const distance = Math.abs(rect.top + rect.height / 2 - center);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = block;
      }
    }
    const target = best ?? blocks[0];
    target.querySelector<HTMLElement>('[data-content-flag-trigger]')?.click();
  }, []);

  const { keyboardActive } = useContentKeyboard({
    prevWeekHref,
    nextWeekHref,
    flagMode,
    onFlag: openFocusedFlag,
  });

  const handleOpenFlag = useCallback((request: ContentFlagRequest) => {
    setActiveFlag(request);
    setFlagMode(true);
    setFlagMessage('');
  }, []);

  const handleFlagClose = useCallback(() => {
    image.remove();
    setFlagMode(false);
    setFlagMessage('');
    setActiveFlag(null);
  }, [image]);

  const handleFlagSubmit = useCallback(async () => {
    if (!activeFlag || submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true);
    const draft = image.capture();
    try {
      const attachmentId = await image.prepare({ type: activeFlag.targetType, id: activeFlag.targetId });
      const result = await submitFlag({ type: activeFlag.targetType, id: activeFlag.targetId,
        reason: 'Other', message: flagMessage.trim(), context: activeFlag.context,
        ...(attachmentId ? { attachmentId } : {}),
      });
      if (!image.isCurrent(draft)) return;
      if (result === 'image-unavailable') { image.retryImage(); return; }
      if (result === 'dropped') { image.setError('Could not send this flag. Try again.'); return; }
      if (result === 'delivered') setFlaggedKeys(prev => new Set(prev).add(activeFlag.flagKey));
      image.committed(); handleFlagClose();
    } catch { /* The image controller keeps the draft and explains upload failures. */ }
    finally { submittingRef.current = false; setSubmitting(false); }
  }, [activeFlag, flagMessage, image, handleFlagClose]);

  const overlayContextValue = useMemo(
    () => ({
      openFlag: handleOpenFlag,
      isFlagged: (flagKey: string) => flaggedKeys.has(flagKey),
    }),
    [handleOpenFlag, flaggedKeys],
  );

  const keyboardHints = useMemo(
    () => [
      { keys: '← →', label: 'week' },
      { keys: 'F', label: 'flag' },
    ],
    [],
  );

  return (
    <ContentReadingModeProvider>
      <ContentFlagOverlayProvider value={overlayContextValue}>
        <TopicTabBar containerRef={articleRef} actions={<ShowAnswersToggle />} />
        <article className="max-w-4xl mx-auto px-6 pb-16">
          <div ref={articleRef} className="prose prose-lg max-w-none overflow-x-clip content-measure">
            {children}
          </div>
        </article>
        <KeyboardHintBar
          visible={keyboardActive}
          floating
          items={keyboardHints}
        />
        <FlagOverlay
          isOpen={flagMode}
          image={image}
          submitting={submitting}
          flagMessage={flagMessage}
          onSubmit={handleFlagSubmit}
          onClose={handleFlagClose}
          onFlagMessageChange={setFlagMessage}
        />
      </ContentFlagOverlayProvider>
    </ContentReadingModeProvider>
  );
}
