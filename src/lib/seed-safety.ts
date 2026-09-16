/**
 * Guard against catastrophic mass deletion during seeding.
 *
 * Both the card soft-delete sweep (prisma/seed.ts) and the question-bank
 * retirement pass delete every live item not present in the freshly-parsed
 * source. A degenerate parse — empty content dir, broken `question-bank`
 * symlink in a worktree (the 2026-06-11 incident), wrong cwd — makes "the
 * source" empty and wipes the whole table with no abort. This helper turns
 * that into a hard stop.
 *
 * Pure + side-effect-free so it is unit-testable; callers decide how to abort
 * (throw / process.exit) using the returned reason.
 */
export interface MassDeletionCheck {
  /** Human label for the table being swept, e.g. "cards" / "question bank". */
  label: string;
  /** How many items were parsed from source this run. */
  parsedCount: number;
  /** How many live items currently exist in the DB. */
  liveCount: number;
  /** How many live items this run would delete/retire. */
  deletingCount: number;
  /** Max fraction of live items deletable in one run before we abort. Default 0.5. */
  maxFraction?: number;
  /** When true (operator override), skip the fraction check. The empty-parse
   *  check still fires — a 0-item parse is never a legitimate intent. */
  allowOverride?: boolean;
}

export function checkMassDeletion(c: MassDeletionCheck): { abort: boolean; reason: string } {
  const maxFraction = c.maxFraction ?? 0.5;

  // Nothing live yet (fresh DB) → nothing to protect.
  if (c.liveCount <= 0) return { abort: false, reason: '' };

  // Degenerate parse: source produced zero items but the DB has live data.
  // Never a legitimate intent — not even overridable.
  if (c.parsedCount <= 0) {
    return {
      abort: true,
      reason:
        `${c.label}: parsed 0 items from source but ${c.liveCount} are live in the DB — ` +
        `refusing to delete (degenerate parse; likely a broken symlink or wrong cwd).`,
    };
  }

  // Mass deletion: would remove more than maxFraction of live items.
  if (!c.allowOverride && c.deletingCount > maxFraction * c.liveCount) {
    const pct = Math.round((c.deletingCount / c.liveCount) * 100);
    return {
      abort: true,
      reason:
        `${c.label}: would delete ${c.deletingCount}/${c.liveCount} live items (${pct}%) ` +
        `— exceeds the ${Math.round(maxFraction * 100)}% safety threshold. ` +
        `Set ALLOW_MASS_DELETE=1 to override if this is intentional.`,
    };
  }

  return { abort: false, reason: '' };
}
