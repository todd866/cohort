'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  describeTopicHeat,
  summarizeTopicReadiness,
  type TopicBand,
  type TopicLevel,
} from '@/lib/knowledge/topic-heat';

/**
 * The knowledge heatmap — one square per topic in the rotation you are on,
 * coloured by how ready it is for exam day.
 *
 * Squares fill the width row by row, in a stable order so a topic keeps its
 * place and can be watched turning green.
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
 *
 * LAYOUT. On a phone everything stacks. From `lg` up the grid and its legend
 * sit in a left column and the detail panel and the trend fill the right one,
 * so on a laptop the whole section is one row instead of a scroll (owner,
 * 2026-09-18: the page was spending a full viewport on ~250px of squares).
 *
 * FILLING THE WIDTH. The squares used to be a fixed 13px, seven to a column,
 * so 49 topics made a 7×7 block in the left third of a phone with nothing to
 * its right (owner, 2026-10-02: "fill the space at least"). Now the grid is
 * CSS: `auto-fill` tracks whose minimum is the container's width divided by a
 * column target, clamped to 14–28px, stretched by `1fr` so the row always
 * reaches the right edge, and kept square by `aspect-ratio`. The target comes
 * from the topic count alone (`topicGridColumns`), so the server's HTML is
 * already the final layout: nothing is measured, so nothing jumps.
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

const GAP = 3;
/** Smaller than this and a square stops being something you can read or tap. */
const MIN_CELL = 14;
/** The largest a track's minimum gets; `1fr` stretches a square a little past it, to ~31px. */
const MAX_CELL = 28;
/**
 * The grid's width on a phone: a 360–430px screen less the profile's 16px
 * gutters. The reference is a 390px phone.
 */
const PHONE = { narrowest: 328, widest: 398, reference: 358 } as const;
/** Past this many columns every phone is at the 14px floor, so more change nothing there. */
const PHONE_MAX_COLUMNS = Math.floor((PHONE.widest + GAP) / (MIN_CELL + GAP)) + 1;

/**
 * The grid's height on a phone before it filled the width — up to seven rows
 * of 13px squares. It may not now exceed it.
 */
function oldPhoneHeight(count: number): number {
  const rows = Math.min(count, 7);
  return rows * 13 + (rows - 1) * GAP;
}

/**
 * The track list. `+ 0.5` sets the minimum halfway between the sizes at which
 * `columns` and `columns + 1` tracks fit, so rounding never costs a column;
 * `1fr` then shares out the rest. Below the 14px floor or above the 28px cap,
 * auto-fill picks the count instead — fewer columns on a narrow screen, more
 * on a wide one.
 */
function topicGridTemplate(columns: number): string {
  return `repeat(auto-fill, minmax(clamp(${MIN_CELL}px, (100cqi + ${GAP}px) / ${columns + 0.5} - ${GAP}px, ${MAX_CELL}px), 1fr))`;
}

/** What a browser makes of `topicGridTemplate(columns)` in a container `width` px wide. */
export function topicGridLayout(width: number, columns: number, count: number) {
  const min = Math.min(MAX_CELL, Math.max(MIN_CELL, (width + GAP) / (columns + 0.5) - GAP));
  const fitted = Math.max(1, Math.floor((width + GAP) / (min + GAP)));
  const cell = (width + GAP) / fitted - GAP;
  const rows = Math.ceil(count / fitted);
  return { columns: fitted, cell, rows, height: rows > 0 ? rows * (cell + GAP) - GAP : 0 };
}

function tallestOnAPhone(columns: number, count: number): number {
  let tallest = 0;
  for (let width = PHONE.narrowest; width <= PHONE.widest; width++) {
    tallest = Math.max(tallest, topicGridLayout(width, columns, count).height);
  }
  return tallest;
}

/**
 * The column target for `count` topics: the fewest columns, so the biggest
 * squares, that a 390px phone actually shows, whose last row is at least half
 * full, and whose grid is no taller than the old one on any phone. Bigger
 * rotations cannot fit that height with 14px squares; they get the shortest
 * grid the floor allows, a row or two more than before rather than a sideways
 * scroll.
 */
export function topicGridColumns(count: number): number {
  if (count <= 1) return 1;
  let shortest = { columns: 1, height: Infinity };
  for (let columns = 1; columns <= Math.min(count, PHONE_MAX_COLUMNS); columns++) {
    const tallest = tallestOnAPhone(columns, count);
    if (tallest < shortest.height) shortest = { columns, height: tallest };
    const shown = topicGridLayout(PHONE.reference, columns, count).columns === columns || columns === count;
    const lastRow = count - (Math.ceil(count / columns) - 1) * columns;
    if (shown && lastRow * 2 >= columns && tallest <= oldPhoneHeight(count)) return columns;
  }
  return shortest.columns;
}

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
      className="mt-3 min-h-[7.5rem] rounded-xl border border-[var(--md-outline-soft)] lg:mt-0
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

          {/* Deliberately no card count. A session serves about fifteen items,
              so "Review 166 cards" promised a sitting nobody has and made the
              first pass feel like it achieved nothing — while the line above
              already says "46/166 studied". Learners click a red square to turn
              it green, and that takes a few sessions on a big topic. */}
          <Link
            href={reviewHref(square)}
            data-testid="topic-detail-review"
            className="mt-2 inline-block text-xs font-semibold text-[var(--md-primary)] hover:underline"
          >
            Review this topic →
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
  aside,
}: {
  squares: TopicHeatmapSquare[];
  rotationLabel: string;
  horizonDays: number;
  /** Rendered under the detail panel — the readiness trend on the profile. */
  aside?: ReactNode;
}) {
  // `pinned` survives pointer-out so a tapped square stays readable; `hovered`
  // is the transient preview and wins while it is set.
  const [pinned, setPinned] = useState<TopicHeatmapSquare | null>(null);
  const [hovered, setHovered] = useState<TopicHeatmapSquare | null>(null);
  const active = hovered ?? pinned;
  const columns = useMemo(() => topicGridColumns(squares.length), [squares.length]);

  if (squares.length === 0) return null;

  const summary = summarizeTopicReadiness(squares);
  const days = Math.round(horizonDays);

  return (
    // From lg the panel and trend get a fixed 22rem — the 260px trend and the
    // panel's status line fit — and the squares take the rest of the row.
    <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-x-8">
      <div>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
            {rotationLabel}
          </h2>
          <p className="text-xs font-medium tabular-nums text-[var(--md-on-surface-variant)]">
            {summary.ready} ready · {summary.slipping} slipping · {summary.unseen} unseen · {days}d
          </p>
        </div>

        {/* The container the squares size themselves against (100cqi). */}
        <div className="@container">
          <div
            data-testid="topic-grid"
            data-columns={columns}
            // The class is the fallback for a browser without container
            // units, below Next's own floor: without it, a dropped template
            // leaves one column of full-width squares.
            className="grid grid-cols-[repeat(auto-fill,minmax(18px,1fr))]"
            style={{ gap: GAP, gridTemplateColumns: topicGridTemplate(columns) }}
          >
            {squares.map((square) => {
              const isActive = active?.id === square.id;
              return (
                <button
                  key={square.id}
                  type="button"
                  data-testid={`topic-square-${square.id}`}
                  data-band={square.band}
                  aria-pressed={pinned?.id === square.id}
                  // No `title`. The browser's native tooltip rendered the
                  // same sentence the panel below already shows, ~1s after
                  // hover, unstyled, and floating over the grid — reported
                  // 2026-09-17 as covering two rows of squares while reading
                  // them. The panel is the hover affordance; this string stays
                  // as the ACCESSIBLE name, which is not drawn.
                  aria-label={squareTitle(square)}
                  onMouseEnter={() => setHovered(square)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(square)}
                  onBlur={() => setHovered(null)}
                  onClick={() => setPinned(square)}
                  className="block aspect-square w-full rounded-[3px] focus-visible:outline
                             focus-visible:outline-2 focus-visible:outline-offset-1
                             focus-visible:outline-[var(--md-primary)]"
                  style={{
                    background: heatToken(square.band, square.level),
                    // A ring rather than a scale: a transform makes a small
                    // square jump out from under the pointer.
                    boxShadow: isActive ? '0 0 0 2px var(--md-on-surface)' : undefined,
                  }}
                />
              );
            })}
          </div>
        </div>

        <Legend />
      </div>

      <div className="lg:flex lg:flex-col">
        <DetailPanel square={active} />
        {aside}
      </div>
    </div>
  );
}
