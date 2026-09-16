'use client';

import { useState } from 'react';
import useSWR from 'swr';

interface ChecklistItemProps {
  /** The text label for this item */
  label: string;
  /** Related topic tags for mastery lookup (matches Card.topics) */
  concepts?: string[];
  /** Link to a deep-dive page */
  deepDive?: string;
  /** Inline summary shown on expand */
  summary?: string;
  /** Optional static mastery percentage (0-100) - overrides computed value */
  mastery?: number;
  /** Rotation for filtering cards (optional) */
  rotation?: string;
}

// Fetcher for SWR
const fetcher = (url: string) => fetch(url).then((res) => res.json());

interface TopicMasteryResponse {
  mastery: number | null;
  cardCount: number;
  reviewed: number;
  coverage: number;
}

/**
 * Interactive checklist item for study checklists.
 *
 * Mobile: Tap to expand inline summary
 * Desktop: Hover for preview, click to expand or navigate
 *
 * Fetches real-time mastery from CardProgress via /api/mastery/topics
 */
export function ChecklistItem({
  label,
  concepts = [],
  deepDive,
  summary,
  mastery: staticMastery,
  rotation,
}: ChecklistItemProps) {
  const [expanded, setExpanded] = useState(false);

  // Fetch mastery from API if concepts provided
  const topicsQuery = concepts.length > 0 ? concepts.join(',') : null;
  const apiUrl = topicsQuery
    ? (() => {
        const params = new URLSearchParams({ topics: topicsQuery });
        if (rotation) params.set('rotation', rotation);
        return `/api/mastery/topics?${params}`;
      })()
    : null;

  const { data: masteryData } = useSWR<TopicMasteryResponse>(
    apiUrl,
    fetcher,
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );

  // Use static mastery if provided, otherwise use fetched data
  const mastery = staticMastery ?? masteryData?.mastery ?? undefined;

  // Mastery color coding
  const getMasteryColor = (m: number | undefined) => {
    if (m === undefined) return 'bg-gray-200';
    if (m >= 80) return 'bg-green-500';
    if (m >= 50) return 'bg-yellow-500';
    if (m >= 20) return 'bg-orange-500';
    return 'bg-red-500';
  };

  const getMasteryTextColor = (m: number | undefined) => {
    if (m === undefined) return 'text-gray-500';
    if (m >= 80) return 'text-green-700';
    if (m >= 50) return 'text-yellow-700';
    if (m >= 20) return 'text-orange-700';
    return 'text-red-700';
  };

  const handleClick = () => {
    if (deepDive && !expanded) {
      // If there's a deepDive and we're not expanded, navigate
      // But first toggle to show summary if available
      if (summary) {
        setExpanded(!expanded);
      } else {
        window.location.href = deepDive;
      }
    } else {
      setExpanded(!expanded);
    }
  };

  return (
    <div className="group">
      {/* Main item row */}
      <div
        onClick={handleClick}
        className="flex items-center gap-3 py-2 px-3 rounded-lg cursor-pointer
                   hover:bg-gray-50 active:bg-gray-100 transition-colors
                   touch-manipulation"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      >
        {/* Mastery indicator */}
        <div className="flex-shrink-0 w-10 text-right">
          {mastery !== undefined ? (
            <span className={`text-sm font-medium ${getMasteryTextColor(mastery)}`}>
              {mastery}%
            </span>
          ) : (
            <span className="text-sm text-gray-400">--</span>
          )}
        </div>

        {/* Progress bar */}
        <div className="flex-shrink-0 w-12 h-2 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={`h-full ${getMasteryColor(mastery)} transition-all duration-300`}
            style={{ width: `${mastery ?? 0}%` }}
          />
        </div>

        {/* Label */}
        <span className="flex-grow text-gray-700 group-hover:text-gray-900">
          {label}
        </span>

        {/* Expand/link indicator */}
        <div className="flex-shrink-0 text-gray-400 group-hover:text-gray-600">
          {expanded ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          ) : deepDive ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          ) : summary ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          ) : null}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="ml-[5.5rem] mt-1 mb-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
          {summary && (
            <p className="text-sm text-gray-600 mb-2">{summary}</p>
          )}

          {/* Coverage stats from API */}
          {masteryData && masteryData.cardCount > 0 && (
            <div className="text-xs text-gray-500 mb-2">
              {masteryData.reviewed}/{masteryData.cardCount} cards reviewed ({masteryData.coverage}% coverage)
            </div>
          )}

          {concepts.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {concepts.map((concept) => (
                <span
                  key={concept}
                  className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full"
                >
                  {concept}
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2 mt-3">
            {deepDive && (
              <a
                href={deepDive}
                className="text-sm text-blue-600 hover:text-blue-800 font-medium"
              >
                Deep dive &rarr;
              </a>
            )}
            <button
              className="text-sm text-gray-500 hover:text-gray-700"
              onClick={(e) => {
                e.stopPropagation();
                // Practice sessions cannot be started by concept/topic yet because
                // the /study route only accepts rotation and week filters, not
                // topic-level filters. Wiring this up requires adding topic query
                // params to the study page and updating the card fetch API to
                // filter by topics.
                alert(`Practice ${concepts.join(', ')} - coming soon!`);
              }}
            >
              Test myself
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Container for checklist items with header
 */
export function StudyChecklist({
  title = 'Study Checklist',
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="my-6 border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
        <h3 className="font-semibold text-gray-800">{title}</h3>
        <p className="text-sm text-gray-500">Click to expand or view deep dives</p>
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}
