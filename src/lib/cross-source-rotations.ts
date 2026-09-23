/**
 * Legacy content partitions that may support a user's current exam without
 * becoming exam objectives themselves.
 *
 * This is only an eligibility allow-list. A source is usable in a session
 * only when the signed-in user is entitled/enrolled AND the individual item
 * explicitly lists the current exam in `moduleNodes`.
 */
export const EXAM_CROSS_SOURCE_ROTATION_IDS = [
  'anatomy',
  // The GSSE plate corpus, and the Kubie neuroanatomy laboratory collection.
  //
  // Omitted until 2026-09-14, which made NSx — a COMPOSED deck that owns no
  // cards and can therefore only ever serve cross-source items — unable to see
  // 4,063 of the 5,102 cards that name `neurosurg` in moduleNodes. Its own
  // definition calls it "a VIEW over the plate corpus and BlueLink"; BlueLink
  // was listed here and the plate corpus was not, so 80% of the deck was
  // unreachable while every health check stayed green. The cards seeded,
  // embedded and clustered; they simply never entered a candidate pool, and
  // ServeDecision held zero rows for them.
  'surgical-sciences',
  // The native NSx corpus (the Kubie neuroanatomy laboratory and the
  // hand-authored NSx files, moved out of surgical-sciences 2026-09-16). Every
  // Kubie card also declares surgical-sciences and anatomy, so GSSE and the
  // Anatomy view borrow it back through the same per-card gate.
  'neurosurg',
  'malleus',
  'anking',
] as const;

export type ExamCrossSourceRotationId =
  (typeof EXAM_CROSS_SOURCE_ROTATION_IDS)[number];

export function isExamCrossSourceRotation(
  rotation: string,
): rotation is ExamCrossSourceRotationId {
  return (EXAM_CROSS_SOURCE_ROTATION_IDS as readonly string[]).includes(rotation);
}

/**
 * Decks that study alongside a declared companion source.
 *
 * Requested 2026-09-11: "make sure we blend bluelink atlas into this." The GSSE deck
 * is textbook plates and BlueLink is 4,747 cadaver-photo ID cards of the same
 * structures — two decks only because the pictures came from different places,
 * which is not a distinction a student studying anatomy cares about.
 *
 * This is a declaration, not an access grant. The server resolver separately
 * requires enrollment, focus/current objective, and independent source access,
 * including owner or copyright-tier checks for personal sources. Audits share
 * this map so they cannot substitute scheduled-exam blend policy for it.
 */
export const COMPANION_SOURCE_ROTATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // The three views of one anatomy corpus. Each draws the others' cards that
  // declare its own slug in moduleNodes, so a plate is authored once and can
  // appear under Anatomy, GSSE and NSx without being copied.
  // CAH holds the valve-echo clips that also name surgical-sciences. They
  // stay one card; GSSE borrows the ones that declare it.
  'surgical-sciences': Object.freeze(['anatomy', 'neurosurg', 'cah']),
  anatomy: Object.freeze(['surgical-sciences', 'neurosurg']),
  neurosurg: Object.freeze(['surgical-sciences', 'anatomy']),
  // Paeds-Surg owns no cards at all: the paediatric module seeds under
  // surgical-sciences, and the anatomy it needs is the Rohen plate corpus that
  // seeds there too. Without this entry the deck renders in the selector and
  // serves an empty session — the exact NSx failure of 2026-09-14.
  'paediatric-surgery': Object.freeze(['surgical-sciences', 'anatomy']),
  // The Year 4 attachment decks. Each owns no cards; the material that serves
  // them is already in the corpus and declares membership per card in
  // moduleNodes. Measured 2026-09-18 by keyword over live cards: roughly 3,400
  // neurology, 4,900 urology and 1,200 geriatrics candidates, concentrated in
  // AnKing and Malleus with real contributions from the Year 3 rotations.
  // Without an entry here each of these renders in the selector and serves an
  // empty session forever — the 2026-09-14 NSx failure again.
  geriatrics: Object.freeze(['anking', 'malleus', 'toc']),
  neurology: Object.freeze(['anking', 'malleus', 'neurosurg', 'anatomy']),
  urology: Object.freeze(['anking', 'malleus', 'surgical-sciences']),
  // Radiology and neuroradiology. Measured 2026-09-18 by keyword over LIVE
  // cards (the first count was run against the local mirror and was wrong in
  // kind, not degree — it missed AnKing's 5,618 entirely): radiology is
  // anking 5,618, neurosurg 444, surgical-sciences 284, malleus 209;
  // neuroradiology is anking 838, malleus 24, surgical-sciences 21,
  // anatomy 19. The imaging corpus backs it further — 2,704 of 6,915
  // pickable figures are radiological (mri 883, ct 679, us 544, xray 378,
  // cxr 220).
  // Neuroradiology is the thin one until Osborn's Brain is indexed, which is
  // why it draws anatomy and neurosurg rather than standing on AnKing alone.
  radiology: Object.freeze(['anking', 'malleus', 'surgical-sciences', 'neurosurg', 'toc']),
  neuroradiology: Object.freeze(['anking', 'malleus', 'neurosurg', 'anatomy']),
  // Adult Medicine DWE. The cards stay in the rotation that authored them.
  // A focused BPT session draws the ones that name `bpt`.
  bpt: Object.freeze([
    'cah', 'critical-care', 'paam', 'pwh',
    'malleus', 'anking', 'toc', 'surgical-sciences',
  ]),
});

/**
 * Sources a scheduled block may borrow when the learner explicitly focuses it.
 *
 * Unlike COMPANION_SOURCE_ROTATIONS, these do not replace the unfocused exam
 * blend. Focusing Critical Care should show the CAH valve clips that name
 * `critical-care`. Sitting the block as the booked exam keeps its existing
 * dessert sources.
 */
export const FOCUS_SUPPLEMENT_ROTATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'critical-care': Object.freeze(['cah']),
});
