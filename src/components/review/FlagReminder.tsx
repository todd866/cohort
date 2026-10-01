'use client';

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

// A generic device preference, not learner history or content. No identifiers
// or flag prose are stored here; the existing outbox owns actual submissions.
const DISMISS_KEY = 'md3:flag-reminder-dismissed:v1';
const DISMISS_EVENT = 'md3:flag-reminder-dismissed';
const SHOWN_KEY = 'md3:flag-reminder-shown:v1';
const SHOW_FOR_ITEMS = 3;

function getDismissed(): boolean {
  try { return window.localStorage.getItem(DISMISS_KEY) === '1'; }
  catch { return false; }
}

function persistDismissal() {
  try { window.localStorage.setItem(DISMISS_KEY, '1'); }
  catch { /* A local dismiss still hides it for this mounted review when storage is blocked. */ }
  window.dispatchEvent(new Event(DISMISS_EVENT));
}

function subscribe(callback: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DISMISS_KEY || event.key === null) callback();
  };
  window.addEventListener('storage', onStorage);
  window.addEventListener(DISMISS_EVENT, callback);
  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(DISMISS_EVENT, callback);
  };
}

/**
 * Points at the REAL flag controls — F, or the ⚐ Flag button in the toolbar —
 * rather than carrying an action of its own. A button here taught a third path
 * that vanished with the reminder (2026-10-01). It retires for good the first
 * time the learner opens a flag through the real control: the lesson landed.
 */
export function FlagReminder({ enabled, flagOpened, itemKey }: {
  enabled: boolean;
  flagOpened: boolean;
  /** The displayed item; the reminder retires after SHOW_FOR_ITEMS of them. */
  itemKey?: string;
}) {
  const dismissed = useSyncExternalStore(subscribe, getDismissed, () => true);
  const [dismissedHere, setDismissedHere] = useState(false);
  const reminderRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const reminder = reminderRef.current;
    const shell = reminder?.closest<HTMLElement>('.review-card-shell');
    if (!reminder || !shell) return;
    const measure = () => {
      const margin = Number.parseFloat(getComputedStyle(reminder).marginBottom) || 0;
      shell.style.setProperty('--md-review-reminder-space', `${reminder.getBoundingClientRect().height + margin}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(reminder);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      shell.style.removeProperty('--md-review-reminder-space');
    };
  }, [enabled, dismissed, dismissedHere]);
  const dismiss = () => {
    setDismissedHere(true);
    persistDismissal();
  };
  // The store subscription re-renders this once the preference lands.
  useEffect(() => {
    if (flagOpened && !dismissed) persistDismissal();
  }, [flagOpened, dismissed]);
  // A row above the question on every item is a banner, which
  // practice-exam-ux.md forbids. Teach on the first few items, then retire.
  const seenItems = useRef(new Set<string>());
  const visible = enabled && !dismissed && !dismissedHere;
  useEffect(() => {
    if (!visible || !itemKey || seenItems.current.has(itemKey)) return;
    seenItems.current.add(itemKey);
    let shown = seenItems.current.size;
    try {
      shown = Math.max(shown, (Number(window.localStorage.getItem(SHOWN_KEY)) || 0) + 1);
      window.localStorage.setItem(SHOWN_KEY, String(shown));
    } catch { /* Counted for this mounted review only when storage is blocked. */ }
    if (shown > SHOW_FOR_ITEMS) persistDismissal();
  }, [visible, itemKey]);

  if (!enabled || dismissed || dismissedHere) return null;

  return (
    <aside ref={reminderRef} aria-label="Help improve cards" className="relative mb-0 flex flex-wrap items-center gap-x-3 rounded-lg border border-[var(--md-outline-variant)] py-1 pl-3 pr-[56px] text-sm text-[var(--md-on-surface-variant)]">
      <p className="min-w-0 flex-[1_1_8rem] py-2">
        Spot a mistake?{' '}
        <span className="hidden pointer-fine:inline">
          Press <kbd className="rounded border border-[var(--md-outline-variant)] px-1 font-mono text-xs">F</kbd> or click
        </span>
        <span className="pointer-fine:hidden">Tap</span>
        {' '}<span className="whitespace-nowrap font-medium text-[var(--md-on-surface)]">⚐ Flag</span> at the top to report it.
      </p>
      <button type="button" aria-label="Dismiss flag reminder" onClick={dismiss} className="absolute right-1 top-1 min-h-[44px] min-w-[44px] text-lg">×</button>
    </aside>
  );
}
