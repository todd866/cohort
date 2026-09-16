'use client';

import { useState } from 'react';

const ISSUE_TYPES = [
  { value: 'incorrect', label: 'Incorrect' },
  { value: 'outdated', label: 'Outdated' },
  { value: 'unclear', label: 'Unclear' },
  { value: 'typo', label: 'Typo' },
  { value: 'missing_citation', label: 'Needs citation' },
  { value: 'other', label: 'Other' },
] as const;

interface ReportIssueProps {
  targetType: 'card' | 'page' | 'component';
  targetId: string;
  contentSnapshot?: string;
  rotation?: string;
  compact?: boolean;
}

export function ReportIssue({
  targetType,
  targetId,
  contentSnapshot,
  rotation,
  compact = false,
}: ReportIssueProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [issueType, setIssueType] = useState<string>('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!issueType) return;

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType,
          targetId,
          issueType,
          description: description || undefined,
          contentSnapshot,
          path: window.location.pathname,
          rotation,
        }),
      });

      if (res.ok) {
        setSubmitted(true);
        setTimeout(() => {
          setIsOpen(false);
          setSubmitted(false);
          setIssueType('');
          setDescription('');
        }, 2000);
      }
    } catch (error) {
      console.error('Failed to submit feedback:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        Thanks for the feedback!
      </div>
    );
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className={`text-[var(--md-on-surface-variant)] hover:text-[var(--md-error)] transition-colors ${
          compact ? 'text-xs' : 'text-sm'
        } flex items-center gap-1`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        {!compact && 'Report issue'}
      </button>
    );
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-[var(--md-on-surface)]">
          Report an issue
        </span>
        <button
          onClick={() => setIsOpen(false)}
          className="text-[var(--md-on-surface-variant)] hover:text-[var(--md-on-surface)]"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Issue type chips */}
      <div className="flex flex-wrap gap-1.5 mb-2">
        {ISSUE_TYPES.map((type) => (
          <button
            key={type.value}
            onClick={() => setIssueType(type.value)}
            className={`px-2 py-1 text-xs rounded-full transition-colors ${
              issueType === type.value
                ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]'
                : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-highest)]'
            }`}
          >
            {type.label}
          </button>
        ))}
      </div>

      {/* Optional description */}
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Add details (optional)"
        rows={2}
        className="w-full px-2 py-1.5 text-sm rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] text-[var(--md-on-surface)] placeholder-[var(--md-on-surface-variant)] resize-none"
      />

      {/* Submit */}
      <div className="flex justify-end mt-2">
        <button
          onClick={handleSubmit}
          disabled={!issueType || isSubmitting}
          className="px-3 py-1 text-sm font-medium rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSubmitting ? 'Submitting...' : 'Submit'}
        </button>
      </div>
    </div>
  );
}
