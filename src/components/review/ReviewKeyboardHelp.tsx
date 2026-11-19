'use client';

import { CHAT_SHORTCUT, TALK_SHORTCUT } from '@/lib/review/ai-shortcuts';
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { PadGlyph, PadGlyphRow } from '@/components/shared/PadGlyph';
import { padGlyphsForShortcutKeys } from '@/components/shared/review-gamepad';

export type ReviewShortcutContext =
  | 'card-reveal'
  | 'card-grade-required'
  /** @deprecated Use card-grade-required. Kept for parent integration during rollout. */
  | 'card-grade'
  | 'mcq-select'
  | 'mcq-grade'
  /** @deprecated Use mcq-grade. */
  | 'mcq-confidence'
  | 'mcq-continue'
  | 'video-rate'
  | 'video-continue';

export interface ReviewShortcut {
  keys: string;
  label: string;
}

export function reviewShortcutsFor(context: ReviewShortcutContext): readonly ReviewShortcut[] {
  switch (context) {
    case 'card-reveal': return [
      { keys: 'Space / Enter', label: 'Reveal the next blank' },
      { keys: 'A', label: 'Reveal all blanks' },
      { keys: 'F', label: 'Flag this item' },
      { keys: '?', label: 'Open shortcuts' },
    ];
    case 'card-grade-required':
    case 'card-grade': return [
      { keys: '1–4 · J K L ;', label: 'Rate the card' },
      { keys: 'Space / Enter', label: 'Rate Good' },
      { keys: 'F', label: 'Flag this item' },
      { keys: '?', label: 'Open shortcuts' },
    ];
    case 'mcq-select': return [
      { keys: "1–5 · J K L ; '", label: 'Choose an answer' },
      { keys: 'Space / Enter', label: 'Show the answer' },
      { keys: 'F', label: 'Flag this item' },
      { keys: '?', label: 'Open shortcuts' },
    ];
    case 'mcq-grade':
    case 'mcq-confidence': return [
      { keys: '1–4 · J K L ;', label: 'Set confidence' },
      { keys: 'F', label: 'Flag this item' },
      { keys: '?', label: 'Open shortcuts' },
    ];
    case 'mcq-continue': return [
      { keys: 'Space / Enter', label: 'Continue' },
      { keys: 'F', label: 'Flag this item' },
      { keys: '?', label: 'Open shortcuts' },
    ];
    case 'video-rate': return [
      { keys: '1–4 · J K L ;', label: 'Rate the video' },
      { keys: 'Space / Enter', label: 'Continue' },
      { keys: 'F', label: 'Flag this item' },
      { keys: '?', label: 'Open shortcuts' },
    ];
    case 'video-continue': return [
      { keys: 'Space / Enter', label: 'Continue' },
      { keys: 'F', label: 'Flag this item' },
      { keys: '?', label: 'Open shortcuts' },
    ];
  }
}

export function ReviewKeyboardHelp({
  open,
  onClose,
  context,
  returnFocusRef,
  canBrowse = false,
  canGoBack = false,
  rewound = false,
  ai,
}: {
  /** The AI controls on this screen: their keys are listed in every mode. */
  ai?: { talk: boolean; chat: boolean };
  canBrowse?: boolean;
  canGoBack?: boolean;
  rewound?: boolean;
  open: boolean;
  onClose: () => void;
  context: ReviewShortcutContext;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const shortcuts = [
    ...reviewShortcutsFor(context),
    ...(canGoBack ? [{ keys: 'Z / Left', label: 'Previous item' }] : []),
    ...(rewound ? [
      { keys: 'Shift+Z / Right', label: 'Next item' },
      { keys: 'Esc', label: 'Current item' },
    ] : []),
    ...(canBrowse ? [{ keys: 'B', label: 'Browse content' }] : []),
    ...(ai?.talk ? [{ keys: TALK_SHORTCUT, label: 'Talk on/off' }] : []),
    ...(ai?.chat ? [{ keys: CHAT_SHORTCUT, label: 'AI chat' }] : []),
  ];

  useEffect(() => {
    if (open) {
      previousFocusRef.current = returnFocusRef?.current ?? document.activeElement as HTMLElement | null;
      closeRef.current?.focus();
      return;
    }
    const target = returnFocusRef?.current ?? previousFocusRef.current;
    if (target?.isConnected) target.focus();
  }, [open, returnFocusRef]);

  if (!open) return null;

  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])') ?? [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--md-scrim)]/60 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Review shortcuts" tabIndex={-1} onKeyDown={trap} className="max-h-[calc(100dvh-2rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-4 text-[var(--md-on-surface)] shadow-xl">
        <div className="mb-2 flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold">Review shortcuts</h2>
          <button ref={closeRef} type="button" onClick={onClose} className="min-h-11 min-w-11 rounded-md px-2 text-sm underline underline-offset-2">Close</button>
        </div>
        <dl className="divide-y divide-[var(--md-outline-variant)] text-sm">
          {shortcuts.map(({ keys, label }) => {
            const padGlyphs = padGlyphsForShortcutKeys(keys);
            return (
              <div key={`${keys}-${label}`} className="flex items-center justify-between gap-4 py-2">
                <dt>{label}</dt>
                <dd className="flex items-center justify-end gap-1">
                  <kbd className="review-shortcut-kbd rounded border border-[var(--md-outline-variant)] px-1.5 py-0.5 font-mono text-xs">{keys}</kbd>
                  {padGlyphs ? (
                    <span className="review-shortcut-pad inline-flex items-center gap-0.5">
                      {Array.isArray(padGlyphs) ? <PadGlyphRow marks={padGlyphs} /> : <PadGlyph mark={padGlyphs} />}
                    </span>
                  ) : null}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}
