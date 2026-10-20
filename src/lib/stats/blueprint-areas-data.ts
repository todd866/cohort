/**
 * Public build: no exam blueprints ship, by design.
 *
 * The private instance maps each item's exam domain onto one university's
 * official exam areas. That taxonomy is the institution's material, so the
 * exporter substitutes this empty map and the statistics report each item's
 * own domain label. Register your own blueprint here: rotation -> { areas,
 * areaForDomain }. See ./blueprint-areas.ts for the shape.
 */
import type { StatsBlueprint } from './blueprint-areas';

export const STATS_BLUEPRINTS: Readonly<Record<string, StatsBlueprint>> = {};
