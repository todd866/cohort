/**
 * Per-learner layout of the statistics page: which instruments show, in what
 * order, and how dense. Stored in `User.experience.layouts.stats`, beside the
 * knob profile the learner-shaping design keeps in the same column
 * (docs/designs/2026-10-14-learner-shaping.md), so a later chat tool
 * (`set_my_experience`) writes this through the same schema.
 *
 * Client-safe leaf: zod only. Every value space is closed, so a chat tool can
 * never write free text into the page.
 */
import { z } from 'zod';
import { isCalendarZoom, type CalendarZoom } from './calendar-grid';

export const STATS_SECTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'forecast', label: 'Due forecast' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'daily', label: 'Reviews per day' },
  { id: 'time', label: 'Review time' },
  { id: 'stages', label: 'Reviews by stage' },
  { id: 'counts', label: 'Card counts' },
  { id: 'memory', label: 'Intervals and memory' },
  { id: 'retention', label: 'Spaced-review pass rate' },
  { id: 'hourly', label: 'Hour of day' },
  { id: 'buttons', label: 'Answer buttons' },
  { id: 'kinds', label: 'Cloze vs MCQ' },
  { id: 'areas', label: 'Blueprint areas' },
  { id: 'practice', label: 'Practice papers' },
] as const;

export type StatsSectionId = (typeof STATS_SECTIONS)[number]['id'];
export const STATS_SECTION_IDS = STATS_SECTIONS.map((s) => s.id) as [StatsSectionId, ...StatsSectionId[]];
export const STATS_DENSITIES = ['comfortable', 'compact'] as const;
export type StatsDensity = (typeof STATS_DENSITIES)[number];
export type { CalendarZoom };

const sectionId = z.enum(STATS_SECTION_IDS);

/** What a client or a chat tool may write. Duplicates are refused, not merged. */
export const statsLayoutSchema = z.object({
  order: z.array(sectionId).max(STATS_SECTION_IDS.length)
    .refine((ids) => new Set(ids).size === ids.length, 'order repeats a section'),
  hidden: z.array(sectionId).max(STATS_SECTION_IDS.length)
    .refine((ids) => new Set(ids).size === ids.length, 'hidden repeats a section'),
  density: z.enum(STATS_DENSITIES),
  /** Month / block / year on the review calendar. Omitted on layouts saved before it existed. */
  zoom: z.enum(['month', 'block', 'year']).optional(),
}).strict();

export type StatsLayoutSetting = z.infer<typeof statsLayoutSchema>;

export const DEFAULT_STATS_LAYOUT: StatsLayoutSetting = {
  order: [...STATS_SECTION_IDS],
  hidden: [],
  density: 'comfortable',
  zoom: 'block',
};

export interface AppliedStatsLayout {
  /** Every section, in the learner's order; sections added later go at the end. */
  order: StatsSectionId[];
  /** Visible sections, in order. */
  visible: StatsSectionId[];
  hidden: StatsSectionId[];
  density: StatsDensity;
  /** The review calendar zoom. Block is the default: the block the learner is in. */
  zoom: CalendarZoom;
}

/**
 * The layout to render from whatever is stored. Never throws: unknown ids are
 * dropped, missing ones appended in default order, and an unreadable setting
 * falls back to the default, so a stale or hand-edited value cannot blank the page.
 */
export function applyStatsLayout(setting: unknown): AppliedStatsLayout {
  const record = setting && typeof setting === 'object' && !Array.isArray(setting)
    ? (setting as Record<string, unknown>)
    : {};
  const known = (value: unknown): StatsSectionId[] => {
    if (!Array.isArray(value)) return [];
    const out: StatsSectionId[] = [];
    for (const id of value) {
      if (typeof id === 'string' && (STATS_SECTION_IDS as string[]).includes(id) && !out.includes(id as StatsSectionId)) {
        out.push(id as StatsSectionId);
      }
    }
    return out;
  };
  const stored = known(record.order);
  const order = [...stored, ...STATS_SECTION_IDS.filter((id) => !stored.includes(id))];
  const hidden = known(record.hidden);
  const density: StatsDensity = record.density === 'compact' ? 'compact' : 'comfortable';
  const zoom: CalendarZoom = isCalendarZoom(record.zoom) ? record.zoom : 'block';
  return { order, visible: order.filter((id) => !hidden.includes(id)), hidden, density, zoom };
}

/** The setting that reproduces an applied layout, for writing back. */
export function toStatsLayoutSetting(layout: AppliedStatsLayout): StatsLayoutSetting {
  return { order: [...layout.order], hidden: [...layout.hidden], density: layout.density, zoom: layout.zoom };
}

/** Move a section one place up (-1) or down (+1); out-of-range moves are no-ops. */
export function moveSection(layout: AppliedStatsLayout, id: StatsSectionId, delta: -1 | 1): AppliedStatsLayout {
  const order = [...layout.order];
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return layout;
  [order[from], order[to]] = [order[to], order[from]];
  return { ...layout, order, visible: order.filter((s) => !layout.hidden.includes(s)) };
}

export function setCalendarZoom(layout: AppliedStatsLayout, zoom: CalendarZoom): AppliedStatsLayout {
  return { ...layout, zoom };
}

export function toggleSection(layout: AppliedStatsLayout, id: StatsSectionId): AppliedStatsLayout {
  const hidden = layout.hidden.includes(id) ? layout.hidden.filter((s) => s !== id) : [...layout.hidden, id];
  return { ...layout, hidden, visible: layout.order.filter((s) => !hidden.includes(s)) };
}

/** Read the stats layout out of a stored experience profile. */
export function statsLayoutFromExperience(experience: unknown): AppliedStatsLayout {
  const record = experience && typeof experience === 'object' && !Array.isArray(experience)
    ? (experience as Record<string, unknown>)
    : {};
  const layouts = record.layouts && typeof record.layouts === 'object' ? (record.layouts as Record<string, unknown>) : {};
  return applyStatsLayout(layouts.stats);
}
