/**
 * Time budget for one run of /api/cron/concept-topk-refresh. Kept out of the
 * route file: a Next.js route module may export only its HTTP handlers and
 * segment config, and any other export fails `next build`'s route type check.
 *
 * Every partition build finishes by this deadline (none starts with under 30 s
 * left, and its statements are capped at the time remaining); only compaction
 * (CONCEPT_TOPK_COMPACTION_TIMEOUT_MS) follows, inside the 300 s limit. The
 * largest partition measured took ~22 s.
 */
export const CONCEPT_TOPK_CRON_TIME_BUDGET_MS = 230_000;
