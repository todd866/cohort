'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { ContentBrowser, browserControl } from './ContentBrowser';

/** Native modal makes the still-mounted review inert; closing never resets its item. */
export function ContentBrowserDialog({ open, onClose, userId, rotation, initialClusterId, topicLabel, topicSummary, closeLabel = 'Back to review', returnFocusRef }: {
  open: boolean; onClose: () => void; userId: string; rotation: string; initialClusterId?: string; topicLabel?: string; topicSummary?: string; closeLabel?: string; returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [activation, setActivation] = useState({open, version: 0});
  if (activation.open !== open) setActivation({open, version: activation.version + (open ? 1 : 0)});
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      returnFocus.current = returnFocusRef?.current ?? document.activeElement as HTMLElement | null;
      node.showModal();
      close.current?.focus();
    } else if (!open && node.open) {
      node.close();
      returnFocus.current?.focus();
    }
  }, [open, returnFocusRef]);
  useEffect(() => { if (open && mounted) close.current?.focus(); }, [open, mounted]);
  return <dialog ref={dialog} aria-label="Browse content" onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => event.stopPropagation()}
    className="m-auto h-[min(52rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-1rem))] max-w-none overflow-y-auto rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-4 text-[var(--md-on-surface)] shadow-xl backdrop:bg-[var(--md-scrim)]/60">
    {mounted && <ContentBrowser active={open} userId={userId} initialRotation={rotation} initialClusterId={initialClusterId} topicLabel={topicLabel} topicSummary={topicSummary} refreshKey={activation.version}
      closeControl={<button ref={close} type="button" className={browserControl} onClick={onClose}>{closeLabel}</button>} />}
  </dialog>;
}
