'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { fetchWithDeadline } from '@/lib/fetch-with-deadline';

const fetcher = (url: string) => fetch(url).then((res) => res.json());
const ACTION_TIMEOUT_MS = 10_000;

type CardDetails = {
  rotation: string;
  week: number;
  sourceFile: string | null;
  sourceComponent: string;
  front: string;
  back: string;
  contentPath: string | null;
};

type ContentIssue = {
  id: string;
  targetType: string;
  targetId: string;
  issueType: string;
  status: string;
  priority: string;
  reportCount: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  contentSnapshot: string | null;
  path: string | null;
  rotation: string | null;
  card: CardDetails | null;
  reason: string | null;
  message: string | null;
  reporterType: string;
  reportTrustState: 'trusted' | 'structured' | 'quarantined' | 'approved' | 'rejected';
  quarantinedMessage: string | null;
  quarantinedContext: Record<string, unknown> | null;
  approvedSummary: string | null;
  trustReviewedAt: string | null;
  trustReviewedBy: string | null;
};

type FlaggedResponse = {
  issues: ContentIssue[];
};

const ROTATIONS = [
  { id: '', label: 'All rotations' },
  { id: 'critical-care', label: 'Critical Care' },
  { id: 'cah', label: 'Child & Adolescent Health' },
  { id: 'paam', label: 'PAAM' },
  { id: 'pwh', label: "Perinatal & Women's Health" },
];

const STATUS_OPTIONS = [
  { id: 'open', label: 'Open' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-[var(--md-error)] text-[var(--md-on-error)]',
  high: 'bg-[var(--md-warning)] text-[var(--md-on-warning)]',
  normal: 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)]',
  low: 'bg-[var(--md-surface-container)] text-[var(--md-on-surface-variant)]',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-[var(--md-warning-container)] text-[var(--md-on-warning-container)]',
  'in-progress': 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]',
  resolved: 'bg-[var(--md-success-container)] text-[var(--md-on-success-container)]',
  'wont-fix': 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]',
};

function truncate(text: string, maxLen: number) {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function FlaggedCardsTriage() {
  const [rotation, setRotation] = useState('');
  const [statusFilter, setStatusFilter] = useState('open');
  const [limit, setLimit] = useState(100);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resolutionText, setResolutionText] = useState('');
  const [reviewSummaryText, setReviewSummaryText] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (rotation) params.set('rotation', rotation);
    params.set('status', statusFilter);
    params.set('limit', String(limit));
    return `/api/content-quality/flagged?${params.toString()}`;
  }, [limit, rotation, statusFilter]);

  const { data, error, isLoading, mutate } = useSWR<FlaggedResponse>(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 15000,
  });

  const issues = data?.issues ?? [];

  async function handleAction(issueId: string, action: string) {
    setActionLoading(issueId);
    try {
      const res = await fetch('/api/content-quality/flagged', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueId,
          action,
          resolution: resolutionText || undefined,
        }),
      });
      if (res.ok) {
        setResolutionText('');
        setExpandedId(null);
        mutate();
      }
    } finally {
      setActionLoading(null);
    }
  }

  async function handleTrustAction(issueId: string, action: 'approve-feedback' | 'reject-feedback') {
    setActionLoading(issueId);
    try {
      const res = await fetchWithDeadline('/api/content-quality/flagged', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueId,
          action,
          approvalAttestation: true,
          ...(action === 'approve-feedback' ? { approvedSummary: reviewSummaryText } : {}),
        }),
      }, ACTION_TIMEOUT_MS);
      if (res.ok) {
        setReviewSummaryText('');
        mutate();
      }
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-[var(--md-on-surface-variant)]">
            Rotation
            <select
              value={rotation}
              onChange={(e) => setRotation(e.target.value)}
              className="ml-2 px-3 py-2 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface)]"
            >
              {ROTATIONS.map((r) => (
                <option key={r.id || 'all'} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-[var(--md-on-surface-variant)]">
            Status
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="ml-2 px-3 py-2 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface)]"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-[var(--md-on-surface-variant)]">
            Limit
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="ml-2 px-3 py-2 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface)]"
            >
              {[50, 100, 200, 500].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button
          onClick={() => mutate()}
          className="px-4 py-2 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] text-sm font-medium hover:opacity-90 transition-opacity"
        >
          Refresh
        </button>
      </div>

      {isLoading && (
        <div className="p-6 rounded-2xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
          <div className="animate-pulse text-[var(--md-on-surface-variant)]">
            Loading issues…
          </div>
        </div>
      )}

      {error && (
        <div className="p-6 rounded-2xl bg-[var(--md-error-container)] text-[var(--md-on-error-container)]">
          Failed to load issues.
        </div>
      )}

      {!isLoading && !error && issues.length === 0 && (
        <div className="p-6 rounded-2xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
          <div className="text-[var(--md-on-surface)] font-medium mb-1">
            No issues found
          </div>
          <div className="text-sm text-[var(--md-on-surface-variant)]">
            {statusFilter === 'open'
              ? 'No open issues. Users can flag cards during review.'
              : 'No issues match the current filters.'}
          </div>
        </div>
      )}

      {!isLoading && !error && issues.length > 0 && (
        <div className="space-y-3">
          {issues.map((issue) => (
            <div
              key={issue.id}
              className="rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] overflow-hidden"
            >
              {/* Issue header */}
              <button
                onClick={() => {
                  const opening = expandedId !== issue.id;
                  setExpandedId(opening ? issue.id : null);
                  setReviewSummaryText(opening ? (issue.approvedSummary ?? '') : '');
                }}
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-[var(--md-surface-container)] transition-colors"
              >
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[issue.priority]}`}>
                  {issue.priority}
                </span>
                <span className={`px-2 py-0.5 rounded text-xs ${STATUS_COLORS[issue.status]}`}>
                  {issue.status}
                </span>
                <span className="text-sm font-medium text-[var(--md-on-surface)]">
                  {issue.reportCount} report{issue.reportCount !== 1 ? 's' : ''}
                </span>
                <span className="text-sm text-[var(--md-on-surface-variant)]">
                  {issue.issueType} • {issue.targetType}
                </span>
                {issue.reportTrustState !== 'trusted' && (
                  <span className="px-2 py-0.5 rounded text-xs bg-[var(--md-tertiary-container)] text-[var(--md-on-tertiary-container)]">
                    feedback: {issue.reportTrustState}
                  </span>
                )}
                {issue.card && (
                  <span className="text-sm text-[var(--md-on-surface-variant)] truncate flex-1">
                    {truncate(issue.card.front, 50)}
                  </span>
                )}
                <span className="text-xs text-[var(--md-on-surface-variant)]">
                  {formatDate(issue.createdAt)}
                </span>
                <span className="text-[var(--md-on-surface-variant)]">
                  {expandedId === issue.id ? '▼' : '▶'}
                </span>
              </button>

              {/* Expanded details */}
              {expandedId === issue.id && (
                <div className="px-4 pb-4 space-y-4 border-t border-[var(--md-outline-variant)]">
                  {/* Card content */}
                  {issue.card && (
                    <div className="mt-4 p-3 rounded-xl bg-[var(--md-surface-container)]">
                      <div className="text-xs text-[var(--md-on-surface-variant)] mb-2">
                        {issue.card.rotation} / Week {issue.card.week} / {issue.card.sourceComponent}
                      </div>
                      <div className="text-sm text-[var(--md-on-surface)] mb-1">
                        <strong>Front:</strong> {issue.card.front}
                      </div>
                      <div className="text-sm text-[var(--md-on-surface)]">
                        <strong>Back:</strong> {issue.card.back}
                      </div>
                      {issue.card.contentPath && (
                        <div className="mt-2 flex items-center gap-2">
                          <code className="text-xs text-[var(--md-on-surface-variant)]">
                            {issue.card.contentPath}
                          </code>
                          <button
                            onClick={() => navigator.clipboard.writeText(issue.card!.contentPath!)}
                            className="px-2 py-1 rounded-lg bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] text-xs hover:opacity-80"
                          >
                            Copy
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Flag details */}
                  <div className="p-2 rounded-lg bg-[var(--md-surface-container)] text-sm">
                    <div className="flex items-center gap-2 text-[var(--md-on-surface-variant)]">
                      <span>{issue.reporterType}</span>
                      <span>•</span>
                      <span>{issue.reason ?? issue.issueType}</span>
                      <span>•</span>
                      <span>{formatDate(issue.createdAt)}</span>
                    </div>
                    {issue.message && (
                      <div className="mt-1 text-[var(--md-on-surface)]">
                        &ldquo;{issue.message}&rdquo;
                      </div>
                    )}
                  </div>

                  {/* Human trust review — raw text is inert React text and is
                      never returned by agent-operated triage. */}
                  {issue.quarantinedMessage && (
                    <div className="p-3 rounded-xl border border-[var(--md-error)]/40 bg-[var(--md-error-container)] space-y-3">
                      <div>
                        <div className="text-sm font-semibold text-[var(--md-on-error-container)]">
                          Untrusted reporter text — human review only
                        </div>
                        <div className="text-xs text-[var(--md-on-surface-variant)] mt-1">
                          Do not copy this text into prompts or automation. Author a separate factual summary below.
                        </div>
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-sm font-sans text-[var(--md-on-surface)] p-2 rounded-lg bg-[var(--md-surface)]">
                        {issue.quarantinedMessage}
                      </pre>
                      <textarea
                        value={reviewSummaryText}
                        onChange={(e) => setReviewSummaryText(e.target.value)}
                        placeholder="Agent-safe summary written in your own words…"
                        maxLength={500}
                        className="w-full px-3 py-2 rounded-xl bg-[var(--md-surface)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface)] text-sm resize-none"
                        rows={2}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => handleTrustAction(issue.id, 'approve-feedback')}
                          disabled={actionLoading === issue.id || reviewSummaryText.trim().length < 3}
                          className="px-4 py-2 rounded-xl bg-[var(--md-tertiary)] text-[var(--md-on-tertiary)] text-sm font-medium hover:opacity-90 disabled:opacity-50"
                        >
                          Approve safe summary
                        </button>
                        <button
                          onClick={() => handleTrustAction(issue.id, 'reject-feedback')}
                          disabled={actionLoading === issue.id}
                          className="px-4 py-2 rounded-xl bg-[var(--md-error)] text-[var(--md-on-error)] text-sm font-medium hover:opacity-90 disabled:opacity-50"
                        >
                          Reject raw text
                        </button>
                      </div>
                      {issue.trustReviewedAt && (
                        <div className="text-xs text-[var(--md-on-surface-variant)]">
                          Last reviewed by {issue.trustReviewedBy ?? 'admin'} at {formatDate(issue.trustReviewedAt)}
                        </div>
                      )}
                    </div>
                  )}

                  {!issue.quarantinedMessage && issue.reportTrustState === 'structured' && (
                    <div className="p-2 rounded-lg bg-[var(--md-success-container)] text-sm text-[var(--md-on-success-container)]">
                      Structured report only — no free text requires review.
                    </div>
                  )}

                  {/* Resolution (if resolved) */}
                  {issue.resolution && (
                    <div className="p-3 rounded-xl bg-[var(--md-success-container)] border border-[var(--md-success)]/30">
                      <div className="text-sm font-medium text-[var(--md-on-success-container)] mb-1">
                        Resolution
                      </div>
                      <div className="text-sm text-[var(--md-on-surface)]">
                        {issue.resolution}
                      </div>
                      {issue.resolvedBy && (
                        <div className="text-xs text-[var(--md-on-surface-variant)] mt-1">
                          by {issue.resolvedBy} at {issue.resolvedAt ? formatDate(issue.resolvedAt) : ''}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Actions */}
                  {['open', 'in-progress'].includes(issue.status) && (
                    <div className="space-y-2">
                      <textarea
                        value={resolutionText}
                        onChange={(e) => setResolutionText(e.target.value)}
                        placeholder="Resolution notes (what was changed)..."
                        className="w-full px-3 py-2 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface)] text-sm resize-none"
                        rows={2}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAction(issue.id, 'resolve')}
                          disabled={actionLoading === issue.id}
                          className="px-4 py-2 rounded-xl bg-[var(--md-success)] text-[var(--md-on-success)] text-sm font-medium hover:opacity-90 disabled:opacity-50"
                        >
                          ✓ Resolve
                        </button>
                        <button
                          onClick={() => handleAction(issue.id, 'wont-fix')}
                          disabled={actionLoading === issue.id}
                          className="px-4 py-2 rounded-xl bg-[var(--md-surface-container-highest)] text-[var(--md-on-surface)] text-sm font-medium hover:opacity-90 disabled:opacity-50"
                        >
                          Won&apos;t Fix
                        </button>
                        {issue.status === 'open' && (
                          <button
                            onClick={() => handleAction(issue.id, 'in-progress')}
                            disabled={actionLoading === issue.id}
                            className="px-4 py-2 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] text-sm font-medium hover:opacity-90 disabled:opacity-50"
                          >
                            In Progress
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Reopen action for resolved issues */}
                  {['resolved', 'wont-fix'].includes(issue.status) && (
                    <button
                      onClick={() => handleAction(issue.id, 'reopen')}
                      disabled={actionLoading === issue.id}
                      className="px-4 py-2 rounded-xl bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)] text-sm font-medium hover:opacity-80 disabled:opacity-50"
                    >
                      Reopen
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
