'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { reviewChallengeLabel, normalizeReviewChallengeLevel } from '@/lib/study/review-challenge';

export interface ReviewDifficultyControlProps {
  /** Current persisted preference, from -2 (foundations) to 2 (exam questions). */
  value: number;
  /** Called once a pointer or keyboard interaction has finished. */
  onCommit: (value: number) => void;
  disabled?: boolean;
  pending?: boolean;
  adjustment?: string | null;
  error?: string | null;
  ready?: boolean;
  offline?: boolean;
  /** Optional retry for a failed save, supplied by the owning review hook. */
  onRetry?: () => void;
}

const LEVELS = [-2, -1, 0, 1, 2].map(value => ({
  value, label: reviewChallengeLabel(normalizeReviewChallengeLevel(value)),
}));

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-2, Math.min(2, Math.round(value)));
}

function levelLabel(value: number): string {
  return LEVELS.find(level => level.value === clamp(value))?.label ?? 'Auto';
}

/**
 * The one always-visible challenge control in the review toolbar.
 *
 * The range is intentionally local state: dragging and arrowing should not
 * rebuild a prepared review queue for every intermediate value. The parent
 * receives only completed pointer/touch or keyboard interactions.
 */
export function ReviewDifficultyControl({
  value,
  onCommit,
  disabled = false,
  pending = false,
  adjustment = null,
  error = null,
  ready = false,
  offline = false,
  onRetry,
}: ReviewDifficultyControlProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => clamp(value));
  const draftDirtyRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) {
      draftDirtyRef.current = false;
      return;
    }
    // External preference reads can resolve after mount; keep the native
    // slider aligned until the learner starts an in-progress drag.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!draftDirtyRef.current) setDraft(clamp(value));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    // Keep mouse-only test tools and older embedded webviews on the same path.
    document.addEventListener('mousedown', onPointerDown as unknown as EventListener);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('mousedown', onPointerDown as unknown as EventListener);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Focus the native control so the popover is immediately keyboard usable.
    const frame = window.requestAnimationFrame(() => sliderRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const blocked = disabled || offline || !ready;
  const commit = () => {
    const next = clamp(draft);
    if (!blocked && next !== clamp(value)) {
      draftDirtyRef.current = false;
      onCommit(next);
    }
  };

  const status = offline
    ? 'Connect to change difficulty'
    : pending
      ? 'Preparing…'
      : null;

  return (
    <div ref={rootRef} className="relative min-w-0 shrink">
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Review difficulty: ${levelLabel(value)}`}
        aria-controls={panelId}
        aria-expanded={open}
        disabled={disabled}
        title="Review difficulty"
        onClick={() => setOpen(current => !current)}
        className="inline-flex h-[40px] min-h-[40px] min-w-[44px] max-w-[min(9.25rem,24vw)] items-center gap-[4px] rounded-full border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-[10px] text-xs leading-none text-[var(--md-on-surface-variant)] transition-colors hover:bg-[var(--md-surface-container-high)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-primary)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span aria-hidden className="text-sm">◒</span>
        <span className="hidden min-w-0 truncate @min-[60rem]/review-toolbar:inline">Difficulty: {levelLabel(value)}</span>
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Review difficulty"
          className="absolute left-1/2 right-auto top-full z-30 mt-[8px] w-[min(288px,calc(100vw-16px))] -translate-x-1/2 rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-[12px] text-[var(--md-on-surface)] shadow-lg @min-[60rem]/review-toolbar:left-auto @min-[60rem]/review-toolbar:right-0 @min-[60rem]/review-toolbar:translate-x-0"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Review difficulty</p>
              <p className="mt-0.5 text-xs text-[var(--md-on-surface-variant)]">
                {draft === -2 ? 'Simple scaffolding questions' : draft === 2 ? 'Hard exam questions in your weak topics' : levelLabel(draft)}
              </p>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-xs text-[var(--md-primary)] hover:bg-[var(--md-surface-container-high)] disabled:opacity-50"
              disabled={blocked || draft === 0}
              onClick={() => {
                setDraft(0);
                draftDirtyRef.current = false;
                if (!blocked && clamp(value) !== 0) onCommit(0);
              }}
            >
              Reset Auto
            </button>
          </div>

          <input
            ref={sliderRef}
            type="range"
            min={-2}
            max={2}
            step={1}
            value={draft}
            disabled={blocked}
            aria-label="Review difficulty"
            aria-valuetext={levelLabel(draft)}
            onChange={event => {
              draftDirtyRef.current = true;
              setDraft(clamp(Number(event.target.value)));
            }}
            onPointerUp={commit}
            onKeyUp={event => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commit();
            }}
            className="mt-3 w-full accent-[var(--md-primary)] disabled:opacity-50"
          />
          <div className="mt-1 flex justify-between gap-3 text-[0.625rem] leading-tight text-[var(--md-on-surface-variant)]">
            {LEVELS.filter(level => Math.abs(level.value) === 2).map(level => <span key={level.value}>{level.label}</span>)}
          </div>
          {status && (
            <p role="status" className="mt-3 text-xs text-[var(--md-on-surface-variant)]">{status}</p>
          )}
          {adjustment && !pending && <p role="status" className="mt-2 text-xs text-[var(--md-on-surface-variant)]">{adjustment}</p>}
          {error && (
            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--md-error)]">
              <p role="alert">{error}</p>
              {onRetry && <button type="button" className="shrink-0 underline underline-offset-2" onClick={onRetry}>Retry</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
