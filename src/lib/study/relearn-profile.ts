/**
 * How hard the relearn lane pushes, by session kind.
 *
 * The relearn lane re-serves a card you failed today instead of letting it
 * vanish for 24 hours. In the DAILY feed it is deliberately a sliver — a
 * quarter of the batch, two graded attempts, ten minutes apart — because the
 * daily feed has a whole rotation to get through and a drill would crowd it out.
 *
 * A topic session is the opposite case. You went there on purpose to learn one
 * subject, so repeating a card you just missed IS the session rather than an
 * interruption to it. Stated 2026-09-17: hammer the same content until it is
 * really learned, then stop seeing it.
 *
 * Only the profile changes. The lane's anti-loop structure is untouched,
 * because it is load-bearing: the delivery cap and delivery cooldown exist
 * separately from the grade cap and grade cooldown, after a card led six
 * consecutive batches across 46 minutes while never being graded once. Raising
 * the grade cap without keeping a delivery guard in proportion would restore
 * exactly that.
 */

export interface RelearnProfile {
  /** Share of a batch the lane may reserve. */
  reserveRatio: number;
  /** Graded attempts allowed per card per study day. */
  viewCap: number;
  /** Deliveries allowed per card per study day, graded or not. */
  deliveryCap: number;
  /** Minimum gap after a FAILURE before the card may return. */
  cooldownMs: number;
  /** Minimum gap after a DELIVERY before the card may be delivered again. */
  serveCooldownMs: number;
}

/**
 * The daily feed. These are the values the lane shipped with and they are
 * tuned for a session that has to cover a rotation, not drill one topic.
 */
export const DAILY_FEED_RELEARN: RelearnProfile = {
  reserveRatio: 0.25,
  viewCap: 2,
  deliveryCap: 2,
  cooldownMs: 10 * 60 * 1000,
  serveCooldownMs: 10 * 60 * 1000,
};

/**
 * A topic session: drill to criterion.
 *
 * `reserveRatio` stops short of the whole batch on purpose. A session that only
 * ever repeated what you missed would never advance through the topic, and the
 * point of opening immunology is to get through immunology — so most of a batch
 * is drill and the rest is ground you have not covered yet.
 *
 * `cooldownMs` drops to three minutes rather than to zero. Returning a card
 * immediately tests recognition of something still on screen a moment ago,
 * which is the one thing a drill must not measure. A few cards' distance is
 * enough to make it retrieval again.
 *
 * The caps rise together. Four graded attempts is a genuine hammer while still
 * bounding a card that is not going in today; when a card burns through all
 * four, that is the signal the morning check should author a sibling for it
 * rather than the session should keep grinding.
 */
export const HAMMER_RELEARN: RelearnProfile = {
  reserveRatio: 0.6,
  viewCap: 4,
  deliveryCap: 4,
  cooldownMs: 3 * 60 * 1000,
  serveCooldownMs: 3 * 60 * 1000,
};

/**
 * Pick the profile for a session.
 *
 * Scoping is the whole signal: a cluster or topic in the URL means the learner
 * chose a subject, and choosing a subject is what licenses the drill. An
 * ordinary rotation session — even a focused one — keeps the daily values.
 */
export function relearnProfileFor(session: { topicScoped: boolean }): RelearnProfile {
  return session.topicScoped ? HAMMER_RELEARN : DAILY_FEED_RELEARN;
}

/**
 * Cards that used up their attempts without being held.
 *
 * This is the hand-off to authoring. A card the learner failed to the cap is
 * not a card to serve harder tomorrow — the session already proved repetition
 * alone is not landing it. It is a card that needs a SIBLING: the same fact
 * asked a different way, which is what `variantGroup` exists to carry. The
 * morning check reads these and commissions the variants, and they arrive over
 * following days through the existing new-card ration rather than all at once.
 */
export function cardsNeedingVariants(
  attempts: ReadonlyArray<{ cardId: string; gradedAttempts: number; lastQuality: number }>,
  profile: RelearnProfile,
): string[] {
  return attempts
    .filter((a) => a.gradedAttempts >= profile.viewCap && a.lastQuality < 3)
    .map((a) => a.cardId);
}
