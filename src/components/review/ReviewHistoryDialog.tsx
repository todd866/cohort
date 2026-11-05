'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FlagButton } from '@/components/ui/FlagButton';
import { useFlagging } from './hooks/useFlagging';
import { FlagOverlay } from './FlagOverlay';
import { isEditableShortcutTarget, isInteractiveActivationTarget } from '@/components/shared/keyboardTarget';
import type { ReviewItem } from './hooks/types';
import { CardItemView } from './CardItemView';
import { McqItemView } from './McqItemView';
import { VideoItemView } from './VideoItemView';
import { itemUsesSidePane, reviewPaneKind, reviewShellWidthClass } from './review-panes';

export interface ReviewHistoryEntry {
  item: ReviewItem;
  selectedOption: string | null;
  mcqResult: { isCorrect: boolean; correctOption: string } | null;
  context?: string | null;
}

interface ReviewHistoryDialogProps {
  entries: ReviewHistoryEntry[];
  index: number | null;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/** Read-only replay of earlier items. It never calls a grading or feedback path. */
export function ReviewHistoryDialog({ entries, index, onIndexChange, onClose }: ReviewHistoryDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const live = index == null ? null : entries[index] ?? null;
  // Keep the last entry painted until the native dialog has closed, so closing
  // never shows an empty open dialog for a frame.
  const [lastEntry, setLastEntry] = useState<ReviewHistoryEntry | null>(null);
  if (live && live !== lastEntry) setLastEntry(live);
  const entry = live ?? lastEntry;
  const restore = useRef<{ x: number; y: number; scrollers: Array<[HTMLElement, number]> } | null>(null);

  const resetFlag = useRef<(() => void) | null>(null);
  const registerResetCallback = useCallback((cb: () => void) => {
    resetFlag.current = cb;
    return () => { if (resetFlag.current === cb) resetFlag.current = null; };
  }, []);
  const flagging = useFlagging({ item: entry?.item, registerResetCallback });
  const { flagMode, flagged, flagPending, flagMessage, setFlagMode, setFlagMessage, handleFlagSubmit, closeFlag } = flagging;
  const entryKey = live ? `${live.item.type}:${live.item.deliveryId ?? live.item.serveDecisionId ?? live.item.id}` : null;
  useEffect(() => { resetFlag.current?.(); }, [entryKey]);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (live && !node.open) {
      const active = document.activeElement as HTMLElement | null;
      returnFocus.current = active;
      const scrollers: Array<[HTMLElement, number]> = [];
      for (let el = active?.parentElement ?? null; el; el = el.parentElement) {
        if (el.scrollTop) scrollers.push([el, el.scrollTop]);
      }
      restore.current = { x: window.scrollX, y: window.scrollY, scrollers };
      node.showModal();
      node.focus({ preventScroll: true });
    } else if (!live && node.open) {
      node.close();
      returnFocus.current?.focus({ preventScroll: true });
      const saved = restore.current;
      if (saved) {
        window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
        for (const [el, top] of saved.scrollers) el.scrollTop = top;
      }
      restore.current = null;
    }
  }, [live]);

  useEffect(() => {
    if (!live) return;
    if (body.current) body.current.scrollTop = 0;
  }, [live]);

  useEffect(() => {
    const node = dialog.current;
    if (!node || !live) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (flagMode) return; // the flag note owns the keyboard
      if (isEditableShortcutTarget(event.target)) return;
      if (event.key === ' ' && isInteractiveActivationTarget(event.target)) return;
      if (event.key === 'Escape' || event.key === 'z' || event.key === 'Z') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        setFlagMode(true);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (index != null && index > 0) onIndexChange(index - 1);
      } else if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault();
        if (index != null && index < entries.length - 1) onIndexChange(index + 1);
        else onClose();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [entries.length, live, index, onClose, onIndexChange, flagMode, setFlagMode]);

  const item = entry?.item;
  const pos = entry ? (index ?? Math.max(0, entries.indexOf(entry))) : 0;
  const blankCount = item?.front?.match(/\[_{2,}\]/g)?.length ?? 0;

  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      aria-label="Review history"
      aria-modal={live ? true : undefined}
      onCancel={event => { event.preventDefault(); if (flagMode) closeFlag(); else onClose(); }}
      onKeyDown={event => event.stopPropagation()}
      className={`m-auto open:flex h-[min(52rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-[calc(100vw-1rem)] ${reviewShellWidthClass(itemUsesSidePane(item, true), item ? reviewPaneKind(item) : undefined)} flex-col overflow-hidden rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] text-[var(--md-on-surface)] shadow-xl backdrop:bg-[var(--md-scrim)]/60`}
    >
      {entry && item && <>
      <div className="sticky top-0 z-10 shrink-0 border-b border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-2 pt-2">
      <div className="flex items-center justify-between gap-1">
        <button type="button" className="min-h-[44px] min-w-[44px] shrink-0 rounded-md sm:px-2 text-sm disabled:opacity-40" disabled={pos <= 0} onClick={() => onIndexChange(pos - 1)} aria-label="Previous question (←)" title="Previous question (←)">←<span className="hidden sm:inline"> Previous</span></button>
        <span className="whitespace-nowrap text-xs text-[var(--md-on-surface-variant)]">{pos + 1} / {entries.length}</span>
        <button type="button" className="min-h-[44px] min-w-[44px] shrink-0 rounded-md sm:px-2 text-sm" onClick={() => pos < entries.length - 1 ? onIndexChange(pos + 1) : onClose()} aria-label="Next question" title="Next question (→)"><span className="hidden sm:inline">Next </span>→</button>
        <FlagButton
          onClick={() => setFlagMode(true)}
          disabled={flagPending}
          aria-keyshortcuts="F"
          flagged={flagged}
          pending={flagPending}
          aria-label={flagged ? 'Flagged — press to add another flag' : flagPending ? 'Flag queued — sending…' : 'Flag this item (F)'}
        />
        <button type="button" className="min-w-[44px] min-h-[44px] shrink-0 rounded-md text-sm" onClick={onClose} aria-label="Back to review (Z)" title="Back to review (Z)">×</button>
      </div>
      <p data-testid="history-hint" className="pb-1 text-center text-[11px] text-[var(--md-on-surface-variant)]">← → step · Z / Esc return · F flag</p>
      </div>
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto p-4">
        {item.type === 'card' && (
          <CardItemView item={item} revealedBlanks={blankCount || 1} blankCount={blankCount} cardFullyRevealed onSuppress={() => {}} inlineReveal={false} cardAnswerRef={{ current: null }} publicSurface />
        )}
        {item.type === 'question' && (
          <HistoryQuestion key={`${pos}:${item.deliveryId ?? item.serveDecisionId ?? item.id}`} entry={entry} />
        )}
        {item.type === 'video' && <VideoItemView item={item} />}
      </div>
      <FlagOverlay
        isOpen={flagMode}
        image={flagging.image}
        submitting={flagPending}
        flagMessage={flagMessage}
        onSubmit={handleFlagSubmit}
        onClose={closeFlag}
        onFlagMessageChange={setFlagMessage}
      />
      </>}
    </dialog>
  );
}

function HistoryQuestion({ entry }: { entry: ReviewHistoryEntry }) {
  const [expandedExplanations, setExpandedExplanations] = useState<Set<string>>(new Set());
  return (
    <McqItemView
      item={entry.item}
      selectedOption={entry.selectedOption}
      mcqResult={entry.mcqResult}
      context={entry.context}
      expandedOptionExplanations={expandedExplanations}
      handleSelectOption={() => {}}
      onSuppress={() => {}}
      toggleOptionExplanation={label => setExpandedExplanations(previous => {
        const next = new Set(previous);
        if (next.has(label)) next.delete(label); else next.add(label);
        return next;
      })}
      readOnly
      interactionDisabled
      publicSurface
    />
  );
}
