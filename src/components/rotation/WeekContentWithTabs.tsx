'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ContentFlagOverlayProvider, type ContentFlagRequest } from '@/components/content/content-flag-overlay-context';
import { TopicTabBar } from '@/components/content/TopicTabBar';
import { FlagOverlay } from '@/components/review/FlagOverlay';
import { useContentKeyboard } from '@/hooks/useContentKeyboard';
import { KeyboardHintBar } from '@/components/shared/KeyboardHintBar';
import { submitFlag } from '@/lib/flag-submit';

interface Props {
  children: ReactNode;
  prevWeekHref: string | null;
  nextWeekHref: string | null;
}

export function WeekContentWithTabs({ children, prevWeekHref, nextWeekHref }: Props) {
  const articleRef = useRef<HTMLDivElement>(null);
  const [flagMode, setFlagMode] = useState(false);
  const [flagMessage, setFlagMessage] = useState('');
  const [activeFlag, setActiveFlag] = useState<ContentFlagRequest | null>(null);
  const [flaggedKeys, setFlaggedKeys] = useState<Set<string>>(() => new Set());

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
    setFlagMode(false);
    setFlagMessage('');
    setActiveFlag(null);
  }, []);

  const handleFlagSubmit = useCallback(() => {
    if (!activeFlag) return;

    const flagPayload = {
      type: activeFlag.targetType,
      id: activeFlag.targetId,
      reason: 'Other',
      ...(flagMessage.trim() ? { message: flagMessage.trim() } : {}),
      ...(Object.keys(activeFlag.context).length > 0 ? { context: activeFlag.context } : {}),
    } as const;

    const capturedFlagKey = activeFlag.flagKey;
    handleFlagClose();

    submitFlag(flagPayload).then((result) => {
      if (result === 'delivered') {
        setFlaggedKeys((prev) => {
          const next = new Set(prev);
          next.add(capturedFlagKey);
          return next;
        });
      }
      // 'queued'/'auth-required': durable in the outbox and will replay;
      // the inline ContentFlag button surfaces pending/blocked state via
      // useFlagPending — nothing extra needed here.
    });
  }, [activeFlag, flagMessage, handleFlagClose]);

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
    <ContentFlagOverlayProvider value={overlayContextValue}>
      <TopicTabBar containerRef={articleRef} />
      <article className="max-w-4xl mx-auto px-6 pb-16">
        <div ref={articleRef} className="prose prose-lg max-w-none overflow-x-clip content-measure">
          {children}
        </div>
      </article>
      <KeyboardHintBar
        visible={keyboardActive}
        floating
        items={keyboardHints}
        className="transition-all"
      />
      <FlagOverlay
        isOpen={flagMode}
        flagMessage={flagMessage}
        onSubmit={handleFlagSubmit}
        onClose={handleFlagClose}
        onFlagMessageChange={setFlagMessage}
      />
    </ContentFlagOverlayProvider>
  );
}
