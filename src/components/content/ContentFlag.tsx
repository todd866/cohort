'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { usePathname } from 'next/navigation';
import { useContentFlagOverlay } from './content-flag-overlay-context';
import { submitFlag, type FlagResult } from '@/lib/flag-submit';
import { useFlagPending } from '@/hooks/useFlagPending';
import { SessionExpiredPrompt } from './SessionExpiredPrompt';

// Flag reasons - ordered by actual usage frequency (539 flags analysed 2026-02)
const FLAG_REASONS = [
  'Context',       // 1 - needs more context/amplification (129 uses)
  'Formatting',    // 2 - broken layout, cloze issues (75 uses)
  'Needs Image',   // 3 - missing visual (77 uses)
  'Giveaway',      // 4 - answer is obvious / too easy (49 uses combined)
  'Rewrite',       // 5 - poorly written, broken card, bad distractors
  'Length Bias',   // L - longest/shortest answer correct
  'Acronym',       // A - unexpanded acronym (24 uses)
  'Too Long',      // T - card front too wordy (16 uses)
  'Other',         // O - free text
] as const;
type FlagReason = (typeof FLAG_REASONS)[number];

const REASON_SHORTCUTS: Record<FlagReason, string> = {
  'Context': '1',
  'Formatting': '2',
  'Needs Image': '3',
  'Giveaway': '4',
  'Rewrite': '5',
  'Length Bias': 'L',
  'Acronym': 'A',
  'Too Long': 'T',
  'Other': 'O',
};

// Short labels that fit in the compact grid
const REASON_LABELS: Record<FlagReason, string> = {
  'Context': 'Context',
  'Formatting': 'Format',
  'Needs Image': 'Needs Img',
  'Giveaway': 'Giveaway',
  'Rewrite': 'Rewrite',
  'Length Bias': 'Len Bias',
  'Acronym': 'Acronym',
  'Too Long': 'Too Long',
  'Other': 'Other',
};

function parseRotationWeek(pathname: string | null): { rotation?: string; week?: number } {
  if (!pathname) return {};
  const match = pathname.match(/^\/([\w-]+)\/week\/(\d+)/);
  if (!match) return {};
  return { rotation: match[1], week: parseInt(match[2], 10) };
}

interface ContentFlagProps {
  targetType: 'card' | 'question' | 'component' | 'page';
  targetId: string;
  componentType?: string;
  contentSnapshot?: string;
  path?: string;
  rotation?: string;
  week?: number;
  className?: string;
}

export function ContentFlag({
  targetType,
  targetId,
  componentType,
  contentSnapshot,
  path,
  rotation,
  week,
  className,
}: ContentFlagProps) {
  const pathname = usePathname();
  const overlay = useContentFlagOverlay();
  const derived = parseRotationWeek(path ?? pathname);

  const resolvedPath = path ?? pathname ?? '';
  const resolvedRotation = rotation ?? derived.rotation;
  const resolvedWeek = week ?? derived.week;

  const [open, setOpen] = useState(false);
  const [localFlagged, setLocalFlagged] = useState(false);
  const [otherMode, setOtherMode] = useState(false);
  const [message, setMessage] = useState('');
  const [authExpired, setAuthExpired] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  const context = useMemo(() => {
    const ctx: Record<string, unknown> = {};
    if (resolvedPath) ctx.path = resolvedPath;
    if (resolvedRotation) ctx.rotation = resolvedRotation;
    if (typeof resolvedWeek === 'number') ctx.week = resolvedWeek;
    if (componentType) ctx.componentType = componentType;
    if (contentSnapshot) ctx.contentSnapshot = contentSnapshot;
    return ctx;
  }, [resolvedPath, resolvedRotation, resolvedWeek, componentType, contentSnapshot]);

  const flagKey = useMemo(() => `${targetType}:${targetId}`, [targetType, targetId]);
  const pending = useFlagPending(flagKey);
  const delivered = overlay ? overlay.isFlagged(flagKey) : localFlagged;
  const pendingDelivery = pending === 'pending';
  const blocked = pending === 'blocked' || authExpired;

  const closeMenu = useCallback(() => {
    setOpen(false);
    setOtherMode(false);
    setMessage('');
  }, []);

  const submitFlagAction = useCallback(
    (reason: FlagReason, note?: string) => {
      closeMenu();
      const payload = {
        type: targetType,
        id: targetId,
        reason,
        ...(note && note.trim() ? { message: note.trim() } : {}),
        context,
      };
      submitFlag(payload).then((result: FlagResult) => {
        if (result === 'delivered') setLocalFlagged(true);
        else if (result === 'auth-required') setAuthExpired(true);
        // 'queued' → pending dot via useFlagPending; 'dropped' → no ✓
      });
    },
    [targetType, targetId, context, closeMenu]
  );

  const handleButtonClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      // `delivered` no longer blocks: a card can have more than one issue, so
      // after the first flag lands the trigger stays clickable to add another
      // (different reason). Only an in-flight/queued flag or auth-block stops it.
      if (pendingDelivery || blocked) return;
      if (overlay) {
        overlay.openFlag({
          flagKey,
          targetType,
          targetId,
          context,
        });
        return;
      }
      setOpen((prev) => !prev);
    },
    [pendingDelivery, blocked, overlay, flagKey, targetType, targetId, context],
  );

  const handleReasonClick = useCallback(
    (reason: FlagReason) => {
      if (reason === 'Other') {
        setOtherMode(true);
        return;
      }
      submitFlagAction(reason);
    },
    [submitFlagAction]
  );

  useEffect(() => {
    if (!open) return;
    if (otherMode) {
      textAreaRef.current?.focus();
    } else {
      menuRef.current?.focus();
    }
  }, [open, otherMode]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) return;
      if (!containerRef.current.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, closeMenu]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();

    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }

    if (otherMode) return;

    const key = event.key.toLowerCase();

    // Number keys 1-5 for first 5 reasons
    const num = parseInt(key, 10);
    if (num >= 1 && num <= 5) {
      event.preventDefault();
      handleReasonClick(FLAG_REASONS[num - 1]);
      return;
    }

    // Letter shortcuts for row 2
    if (key === 'l') {
      event.preventDefault();
      handleReasonClick('Length Bias');
      return;
    }
    if (key === 'a') {
      event.preventDefault();
      handleReasonClick('Acronym');
      return;
    }
    if (key === 't') {
      event.preventDefault();
      handleReasonClick('Too Long');
      return;
    }
    if (key === 'o') {
      event.preventDefault();
      handleReasonClick('Other');
      return;
    }
  };

  const handleTextKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitFlagAction('Other', message);
    }
  };

  return (
    <span ref={containerRef} className={`relative inline-flex ${className ?? ''}`}>
      <button
        type="button"
        data-content-flag-trigger
        aria-label="Flag content"
        title={blocked ? 'Sign in to send flag' : pendingDelivery ? 'Flag queued — sending…' : delivered ? 'Flag submitted — click to add another' : 'Flag for improvement'}
        disabled={pendingDelivery || blocked}
        onClick={handleButtonClick}
        className={`flag-btn${delivered ? ' flagged' : pendingDelivery ? ' flag-pending' : ''}`}
        style={{ position: 'relative' }}
      >
        <FlagIcon filled={delivered} className="w-4 h-4" />
        {pendingDelivery && (
          <span
            aria-hidden
            title="Flag queued — sending…"
            style={{ position: 'absolute', top: 0, right: 0, width: 6, height: 6, borderRadius: '50%', background: 'var(--md-tertiary, #d08700)' }}
          />
        )}
      </button>

      {open && !overlay && (
        <>
        <div className="fixed inset-0 z-10" onClick={(event) => { event.stopPropagation(); closeMenu(); }} />
        <menu
          ref={menuRef}
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
          onClick={(event) => event.stopPropagation()}
          className="flag-menu"
        >
          {!otherMode ? (
            <>
              <li className="grid grid-cols-5 gap-1">
                {FLAG_REASONS.slice(0, 5).map((reason) => (
                  <button key={reason} type="button" onClick={() => handleReasonClick(reason)} title={reason}
                    className="flag-reason-btn">
                    <span className="text-xs font-medium">{REASON_SHORTCUTS[reason]}</span>
                    <span className="flag-reason-label">{REASON_LABELS[reason]}</span>
                  </button>
                ))}
              </li>
              <li className="grid grid-cols-4 gap-1 mt-2">
                {FLAG_REASONS.slice(5).map((reason) => (
                  <button key={reason} type="button" onClick={() => handleReasonClick(reason)} title={reason}
                    className="flag-reason-btn">
                    <span className="text-xs font-medium">{REASON_SHORTCUTS[reason]}</span>
                    <span className="flag-reason-label">{reason}</span>
                  </button>
                ))}
              </li>
              <li className="flag-hint">esc to cancel</li>
            </>
          ) : (
            <li>
              <p className="text-xs px-1 mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>Describe the issue</p>
              <textarea
                ref={textAreaRef}
                aria-label="Describe the issue"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={handleTextKeyDown}
                rows={3}
                className="flag-textarea"
                placeholder="Describe the issue..."
              />
              <div className="flex gap-2 mt-2">
                <button type="button" onClick={closeMenu} className="btn btn-tonal btn-sm flex-1">Cancel</button>
                <button type="button" onClick={() => submitFlagAction('Other', message)} className="btn btn-filled btn-sm flex-1">Submit</button>
              </div>
              <p className="flag-hint">enter to submit</p>
            </li>
          )}
        </menu>
        </>
      )}
      {blocked && <SessionExpiredPrompt />}
    </span>
  );
}

function FlagIcon({ className, filled }: { className?: string; filled?: boolean }) {
  if (filled) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6h-5.6z" />
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}
