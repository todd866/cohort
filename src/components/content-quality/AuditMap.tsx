'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

type AuditItemRow = {
  id: string;
  targetType: string;
  targetId: string;
  rotation: string | null;
  week: number | null;
  sourceFile: string | null;
  jurisdiction: string;
  riskTier: string;
  status: string;
  nextAuditAt: string | null;
  lastAuditedAt: string | null;
  harmSeverity: string | null;
  harmDomains: string[];
  contentPath: string | null;
};

type AuditResponse = {
  items: AuditItemRow[];
  statusCounts: Record<string, number>;
};

const ROTATIONS = [
  { id: '', label: 'All rotations' },
  { id: 'critical-care', label: 'Critical Care' },
  { id: 'cah', label: 'Child & Adolescent Health' },
  { id: 'paam', label: 'PAAM' },
  { id: 'pwh', label: "Perinatal & Women's Health" },
];

const STATUSES = [
  { id: '', label: 'All statuses' },
  { id: 'needs-audit', label: 'Needs audit' },
  { id: 'due', label: 'Due' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'up-to-date', label: 'Up to date' },
  { id: 'blocked', label: 'Blocked' },
];

const JURISDICTIONS = [
  { id: '', label: 'All jurisdictions' },
  { id: 'nsw', label: 'NSW' },
  { id: 'wa', label: 'WA' },
  { id: 'national', label: 'National' },
  { id: 'international', label: 'International' },
];

const RISK_TIERS = [
  { id: '', label: 'All risk tiers' },
  { id: 'critical', label: 'Critical' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
];

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString();
}

export function AuditMap() {
  const [rotation, setRotation] = useState('');
  const [status, setStatus] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [riskTier, setRiskTier] = useState('');
  const [limit, setLimit] = useState(100);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (rotation) params.set('rotation', rotation);
    if (status) params.set('status', status);
    if (jurisdiction) params.set('jurisdiction', jurisdiction);
    if (riskTier) params.set('riskTier', riskTier);
    params.set('limit', String(limit));
    return `/api/content-audit/items?${params.toString()}`;
  }, [rotation, status, jurisdiction, riskTier, limit]);

  const { data, error, isLoading, mutate } = useSWR<AuditResponse>(url, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 15000,
  });

  const items = data?.items ?? [];
  const statusCounts = data?.statusCounts ?? {};

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
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="ml-2 px-3 py-2 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface)]"
            >
              {STATUSES.map((s) => (
                <option key={s.id || 'all'} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-[var(--md-on-surface-variant)]">
            Jurisdiction
            <select
              value={jurisdiction}
              onChange={(e) => setJurisdiction(e.target.value)}
              className="ml-2 px-3 py-2 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface)]"
            >
              {JURISDICTIONS.map((j) => (
                <option key={j.id || 'all'} value={j.id}>
                  {j.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm text-[var(--md-on-surface-variant)]">
            Risk
            <select
              value={riskTier}
              onChange={(e) => setRiskTier(e.target.value)}
              className="ml-2 px-3 py-2 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface)]"
            >
              {RISK_TIERS.map((tier) => (
                <option key={tier.id || 'all'} value={tier.id}>
                  {tier.label}
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

      <div className="flex flex-wrap gap-2 text-sm">
        {Object.entries(statusCounts).map(([key, value]) => (
          <div
            key={key}
            className="px-3 py-1 rounded-full bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-[var(--md-on-surface-variant)]"
          >
            {key}: {value}
          </div>
        ))}
      </div>

      {isLoading && (
        <div className="p-6 rounded-2xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
          <div className="animate-pulse text-[var(--md-on-surface-variant)]">
            Loading audit map…
          </div>
        </div>
      )}

      {error && (
        <div className="p-6 rounded-2xl bg-[var(--md-error-container)] text-[var(--md-on-error-container)]">
          Failed to load audit items.
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="p-6 rounded-2xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)]">
          <div className="text-[var(--md-on-surface)] font-medium mb-1">
            No audit items
          </div>
          <div className="text-sm text-[var(--md-on-surface-variant)]">
            Adjust filters or run the sync script to populate the audit map.
          </div>
        </div>
      )}

      {!isLoading && !error && items.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-[var(--md-outline-variant)]">
          <table className="min-w-full text-sm bg-[var(--md-surface)]">
            <thead className="bg-[var(--md-surface-container)]">
              <tr className="text-left text-[var(--md-on-surface-variant)]">
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Risk</th>
                <th className="px-4 py-3 font-medium">Jurisdiction</th>
                <th className="px-4 py-3 font-medium">Rotation</th>
                <th className="px-4 py-3 font-medium">Week</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Next Audit</th>
                <th className="px-4 py-3 font-medium">Last Audit</th>
                <th className="px-4 py-3 font-medium">Harm</th>
                <th className="px-4 py-3 font-medium">Target</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-[var(--md-outline-variant)]">
                  <td className="px-4 py-3 text-[var(--md-on-surface)] font-medium">
                    {item.status}
                  </td>
                  <td className="px-4 py-3 text-[var(--md-on-surface)]">
                    {item.riskTier}
                  </td>
                  <td className="px-4 py-3 text-[var(--md-on-surface)]">
                    {item.jurisdiction}
                  </td>
                  <td className="px-4 py-3 text-[var(--md-on-surface)]">
                    {item.rotation ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-[var(--md-on-surface)]">
                    {item.week ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-[var(--md-on-surface)]">
                    {item.targetType}
                  </td>
                  <td className="px-4 py-3 text-[var(--md-on-surface-variant)] whitespace-nowrap">
                    {formatDate(item.nextAuditAt)}
                  </td>
                  <td className="px-4 py-3 text-[var(--md-on-surface-variant)] whitespace-nowrap">
                    {formatDate(item.lastAuditedAt)}
                  </td>
                  <td className="px-4 py-3 text-[var(--md-on-surface)]">
                    {item.harmSeverity ?? '—'}
                    {item.harmDomains.length > 0 ? ` (${item.harmDomains.join(', ')})` : ''}
                  </td>
                  <td className="px-4 py-3">
                    {item.contentPath ? (
                      <div className="flex items-center gap-2">
                        <code className="text-xs text-[var(--md-on-surface-variant)]">
                          {item.contentPath}
                        </code>
                        <button
                          onClick={() => navigator.clipboard.writeText(item.contentPath!)}
                          className="px-2 py-1 rounded-lg bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] text-xs hover:opacity-80"
                        >
                          Copy
                        </button>
                      </div>
                    ) : (
                      <span className="text-[var(--md-on-surface-variant)]">
                        {item.targetId}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
