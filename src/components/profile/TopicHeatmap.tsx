'use client';

import { useState } from 'react';
import Link from 'next/link';
import { describeTopicHeat, type TopicBand, type TopicLevel } from '@/lib/knowledge/topic-heat';

/**
 * The knowledge heatmap — one square per topic in the rotation you are on,
 * coloured by how ready it is for exam day.
 *
 * Squares are packed GitHub-style in columns of GRID_ROWS, in a stable order so
 * a topic keeps its place and can be watched turning green.
 *
 * WHY SQUARES ARE BUTTONS AND NOT LINKS. They were links, with the detail in a
 * `title` attribute. That is a ~1s delay, unstyled, and — the part that
 * mattered — completely invisible on touch, where a tap just navigated. So on a
 * phone there was no way to find out what a square WAS without committing to a
 * review session. Now hover or keyboard focus previews a square and a click
 * pins it; the panel below carries the link out. One extra click to start
 * reviewing, in exchange for being able to read the grid at all on the device
 * it is mostly read on.
 *
 * The panel has a reserved minimum height so filling it in never reflows the
 * page (.claude/rules/web-vitals.md — CLS is a budgeted metric here).
 */

export interface TopicHeatmapSquare {
  id: string;
  label: string;
  band: TopicBand;
  level: TopicLevel;
  score: number;
  itemCount: number;
  seenCount: number;
  /** A few real card fronts — what the topic actually asks. */
  sampleFronts: string[];
  lastAnsweredAt: Date | string | null;
  clusterId: string;
  rotation: string;
}

const GRID_ROWS = 7;
const CELL = 13;

/** Every band maps to exactly one token; green picks its step from the level. */
export function heatToken(band: TopicBand, level: TopicLevel): string {
  if (band === 'unseen') return 'var(--md-heat-unseen)';
  if (band === 'cold') return 'var(--md-heat-cold)';
  if (band === 'warm') return 'var(--md-heat-warm)';
  return `var(--md-heat-${Math.min(4, Math.max(1, level))})`;
}

/** Terse label for the screen reader and the native tooltip fallback. */
export function squareTitle(square: TopicHeatmapSquare): string {
  return [
    square.label,
    describeTopicHeat(square),
    `${square.seenCount}/${square.itemCount} studied`,
    `${Math.round(square.score * 100)}% ready`,
  ].join(' · ');
}

const MS_PER_DAY = 86_400_000;

/** "studied 23 days ago" / "studied today". Deterministic, no Intl dependency. */
export function describeLastStudied(
  value: Date | string | null,
  now: Date = new Date(),
): string {
  if (!value) return 'never studied';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'never studied';
  const days = Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY);
  if (days <= 0) return 'studied today';
  if (days === 1) return 'studied yesterday';
  if (days < 30) return `studied ${days} days ago`;
  const months = Math.round(days / 30);
  return `studied ${months} month${months === 1 ? '' : 's'} ago`;
}

function reviewHref(square: TopicHeatmapSquare): string {
  const params = new URLSearchParams({ rotation: square.rotation, cluster: square.clusterId });
  return `/review?${params.toString()}`;
}

/** Pack squares down columns of GRID_ROWS, the way a contribution grid reads. */
function toColumns(squares: TopicHeatmapSquare[]): TopicHeatmapSquare[][] {
  const columns: TopicHeatmapSquare[][] = [];
  for (let i = 0; i < squares.length; i += GRID_ROWS) {
    columns.push(squares.slice(i, i + GRID_ROWS));
  }
  return columns;
}

function Legend() {
  const steps = [
    { token: 'var(--md-heat-unseen)', label: 'New' },
    { token: 'var(--md-heat-cold)', label: 'Lost' },
    { token: 'var(--md-heat-warm)', label: 'Slipping' },
    { token: 'var(--md-heat-4)', label: 'Ready' },
  ];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      {steps.map((step) => (
        <span key={step.label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-[2px]"
            style={{ background: step.token }}
          />
          <span className="text-[11px] text-[var(--md-on-surface-variant)]">{step.label}</span>
        </span>
      ))}
    </div>
  );
}

function DetailPanel({ square }: { square: TopicHeatmapSquare | null }) {
  return (
    <div
      data-testid="topic-detail"
      aria-live="polite"
      className="mt-3 min-h-[7.5rem] rounded-xl border border-[var(--md-outline-soft)]
                 bg-[var(--md-surface-container-low)] px-3 py-2.5"
    >
      {!square ? (
        <p className="text-xs text-[var(--md-on-surface-variant)]">
          Hover or tap a square to see what that topic is.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span className="text-sm font-semibold text-[var(--md-on-surface)]">
              {square.label}
            </span>
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-[2px]"
                style={{ background: heatToken(square.band, square.level) }}
              />
              <span className="text-xs font-medium text-[var(--md-on-surface-variant)]">
                {describeTopicHeat(square)}
              </span>
            </span>
          </div>

          <p className="mt-0.5 text-xs tabular-nums text-[var(--md-on-surface-variant)]">
            {square.seenCount}/{square.itemCount} studied · {Math.round(square.score * 100)}% ready
            {' · '}
            {describeLastStudied(square.lastAnsweredAt)}
          </p>

          {square.sampleFronts.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {square.sampleFronts.map((front, i) => (
                <li
                  key={i}
                  className="truncate text-[11px] leading-snug text-[var(--md-on-surface-variant)]"
                >
                  {front}
                </li>
              ))}
            </ul>
          )}

          <Link
            href={reviewHref(square)}
            data-testid="topic-detail-review"
            className="mt-2 inline-block text-xs font-semibold text-[var(--md-primary)] hover:underline"
          >
            Review {square.itemCount} card{square.itemCount === 1 ? '' : 's'} →
          </Link>
        </>
      )}
    </div>
  );
}

export function TopicHeatmap({
  squares,
  rotationLabel,
  horizonDays,
}: {
  squares: TopicHeatmapSquare[];
  rotationLabel: string;
  horizonDays: number;
}) {
  // `pinned` survives pointer-out so a tapped square stays readable; `hovered`
  // is the transient preview and wins while it is set.
  const [pinned, setPinned] = useState<TopicHeatmapSquare | null>(null);
  const [hovered, setHovered] = useState<TopicHeatmapSquare | null>(null);
  const active = hovered ?? pinned;

  if (squares.length === 0) return null;

  const ready = squares.filter((s) => s.band === 'fresh').length;
  const days = Math.round(horizonDays);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
          {rotationLabel}
        </h2>
        <p className="text-xs font-medium tabular-nums text-[var(--md-on-surface-variant)]">
          {ready}/{squares.length} ready · {days}d
        </p>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="flex gap-[3px]" style={{ width: 'max-content' }}>
          {toColumns(squares).map((column, i) => (
            <div key={i} className="flex flex-col gap-[3px]">
              {column.map((square) => {
                const isActive = active?.id === square.id;
                return (
                  <button
                    key={square.id}
                    type="button"
                    data-testid={`topic-square-${square.id}`}
                    data-band={square.band}
                    aria-pressed={pinned?.id === square.id}
                    title={squareTitle(square)}
                    aria-label={squareTitle(square)}
                    onMouseEnter={() => setHovered(square)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(square)}
                    onBlur={() => setHovered(null)}
                    onClick={() => setPinned(square)}
                    className="block rounded-[3px] focus-visible:outline focus-visible:outline-2
                               focus-visible:outline-offset-1 focus-visible:outline-[var(--md-primary)]"
                    style={{
                      background: heatToken(square.band, square.level),
                      width: CELL,
                      height: CELL,
                      // A ring rather than a scale: a transform makes a 13px
                      // square jump out from under the pointer.
                      boxShadow: isActive ? '0 0 0 2px var(--md-on-surface)' : undefined,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <Legend />
      <DetailPanel square={active} />
    </div>
  );
}
