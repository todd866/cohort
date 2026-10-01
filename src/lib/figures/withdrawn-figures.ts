import registryJson from './withdrawn-figures.json';

/**
 * Figures withdrawn from every learner-facing attachment and export.
 *
 * The 27 September 2026 correction withdrew the generated PNG originals as a
 * collection (`publicationStatus` in open-content/medical-figures/manifest.json).
 * On 30 September the owner extended it to the agent-drawn SVG schematics made
 * with the same approach. Those files are scattered across /figures
 * directories rather than held in one manifest, so this registry names each key.
 *
 * A withdrawn file keeps its bytes, sidecar and provenance on disk; only its
 * associations are gone. Every attachment and delivery path consults this list,
 * so re-wiring a withdrawn key fails closed instead of quietly reviving it:
 * resolveImage and the open-figure route answer nothing, seed validation and
 * the exporters refuse, and a source scan fails CI. Removing a key from this
 * file is the only way back, and it should come with new review evidence.
 */

export interface FigureWithdrawal {
  id: string;
  withdrawnAt: string;
  reason: string;
  receipt: string;
  figures: string[];
}

export interface WithdrawnFigureRegistry {
  schemaVersion: 1;
  withdrawals: FigureWithdrawal[];
}

const FIGURE_KEY = /^\/figures\/(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*\.(?:svg|png|jpe?g|gif|webp)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message: string): never {
  throw new Error(`Withdrawn figure registry: ${message}`);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Validate the registry shape; a malformed registry must stop the build, not admit figures. */
export function parseWithdrawnFigureRegistry(value: unknown): WithdrawnFigureRegistry {
  if (!value || typeof value !== 'object') fail('registry must be an object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) fail('schemaVersion 1 required');
  if (!Array.isArray(record.withdrawals) || record.withdrawals.length === 0) fail('withdrawals required');
  const seenIds = new Set<string>();
  const seenFigures = new Set<string>();
  const withdrawals = record.withdrawals.map((entry, index): FigureWithdrawal => {
    if (!entry || typeof entry !== 'object') fail(`withdrawal ${index} must be an object`);
    const w = entry as Record<string, unknown>;
    if (!nonEmptyText(w.id) || seenIds.has(w.id)) fail(`withdrawal ${index} needs a unique id`);
    seenIds.add(w.id);
    if (typeof w.withdrawnAt !== 'string' || !ISO_DATE.test(w.withdrawnAt)
      || Number.isNaN(Date.parse(`${w.withdrawnAt}T00:00:00Z`))) {
      fail(`${w.id}: withdrawnAt must be an ISO date`);
    }
    if (!nonEmptyText(w.reason)) fail(`${w.id}: reason required`);
    if (!nonEmptyText(w.receipt)) fail(`${w.id}: receipt required`);
    if (!Array.isArray(w.figures) || w.figures.length === 0) fail(`${w.id}: figures required`);
    for (const figure of w.figures) {
      if (typeof figure !== 'string' || !FIGURE_KEY.test(figure)) fail(`${w.id}: invalid figure key ${String(figure)}`);
      if (seenFigures.has(figure)) fail(`${w.id}: duplicate figure key ${figure}`);
      seenFigures.add(figure);
    }
    return {
      id: w.id, withdrawnAt: w.withdrawnAt, reason: w.reason, receipt: w.receipt,
      figures: [...(w.figures as string[])],
    };
  });
  return { schemaVersion: 1, withdrawals };
}

export const withdrawnFigureRegistry = parseWithdrawnFigureRegistry(registryJson);

const withdrawalByKey = new Map<string, FigureWithdrawal>(
  withdrawnFigureRegistry.withdrawals.flatMap((w) => w.figures.map((key) => [key, w] as const)),
);

/** Every withdrawn figure key, e.g. `/figures/cah/msk/salter-harris-ii-schematic.svg`. */
export const WITHDRAWN_FIGURE_KEYS: ReadonlySet<string> = new Set(withdrawalByKey.keys());

/**
 * Reduce a stored image reference to its figure key: drop a query or fragment
 * and an absolute origin, so `/figures/x.svg?v=2` cannot slip past the list.
 */
export function figureKeyOf(reference: string | null | undefined): string | null {
  if (typeof reference !== 'string') return null;
  let key = reference.trim();
  const absolute = /^https?:\/\/[^/]+(\/figures\/.*)$/i.exec(key);
  if (absolute) key = absolute[1];
  key = key.split(/[?#]/, 1)[0];
  return key.startsWith('/figures/') ? key : null;
}

export function figureWithdrawal(reference: string | null | undefined): FigureWithdrawal | undefined {
  const key = figureKeyOf(reference);
  return key ? withdrawalByKey.get(key) : undefined;
}

export function isWithdrawnFigure(reference: string | null | undefined): boolean {
  return figureWithdrawal(reference) !== undefined;
}
