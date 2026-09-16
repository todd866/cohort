/**
 * Who counts as a trusted content reporter.
 *
 * The flag trust boundary quarantines every non-admin reporter's prose, which
 * is right for the open internet and wrong for the handful of classmates who
 * actually study here. Their reports are the best content signal the product
 * gets — "HUS in the question is a giveaway", a proposed cloze rewrite — and
 * quarantining them means they never reach agent triage and are silently lost.
 *
 * ANCHORED TO THE COPYRIGHT IMAGE GRANT, deliberately, rather than a second
 * list: `User.imageTier = 'copyright'` is already a hand-curated, per-person
 * decision to expose rights-managed textbook figures to that account. Anyone
 * trusted with that is trusted not to attack their own study tool, and one list
 * cannot drift out of sync with the other. It also keeps classmates' emails out
 * of source, which matters because `src/lib/**` ships inside the FOSS
 * distribution boundary.
 *
 * Trust means "this person is not hostile" — NOT "this text is safe to hand an
 * agent". `trustDecisionForReport` still applies the length and
 * instruction-marker checks to a trusted note exactly as it does to an admin's,
 * and a note that fails them falls back to quarantine.
 */

export function isTrustedReporterTier(
  imageTier: string | null | undefined,
): boolean {
  return imageTier === 'copyright';
}
