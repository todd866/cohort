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
 * Added 2026-09-11 to blend the BlueLink atlas into anatomy study. The GSSE deck
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
  // PWH contributes explicitly mapped pelvic and embryology scaffolds.
  // Per-card membership and independent source entitlement still apply.
  'surgical-sciences': Object.freeze(['anatomy', 'neurosurg', 'cah', 'pwh']),
  anatomy: Object.freeze(['surgical-sciences', 'neurosurg', 'pwh']),
  // CAH joined 2026-09-23: its examination clips name `neurosurg`.
  neurosurg: Object.freeze(['surgical-sciences', 'anatomy', 'cah', 'physical-exam', 'pwh']),
  // Paeds-Surg owns no cards at all: the paediatric module seeds under
  // surgical-sciences, and the anatomy it needs is the Rohen plate corpus that
  // seeds there too. Without this entry the deck renders in the selector and
  // serves an empty session — the exact NSx failure of 2026-09-14.
  'paediatric-surgery': Object.freeze(['surgical-sciences', 'anatomy', 'cah']),
  // The Year 4 attachment decks. Each owns no cards; the material that serves
  // them is already in the corpus and declares membership per card in
  // moduleNodes. Measured 2026-09-18 by keyword over live cards: roughly 3,400
  // neurology, 4,900 urology and 1,200 geriatrics candidates, concentrated in
  // AnKing and Malleus with real contributions from the Year 3 rotations.
  // Without an entry here each of these renders in the selector and serves an
  // empty session forever — the 2026-09-14 NSx failure again.
  //
  // 2026-09-23: the hand-authored rotations joined. Cards in surgical-sciences,
  // CAH and critical-care had been naming these decks for weeks — the neuro
  // examination clips among them — and none could be served there, because a
  // deck borrows only from the rotations listed here. Membership is still per
  // card: a companion contributes only cards that name the deck.
  //
  // 2026-10-31 (owner-delegated decision, BACKLOG 24): the USyd course
  // rotations are legitimate suppliers for these decks, so their declared
  // memberships are reachable. A learner choosing Neurology should see the
  // PAAM, MND, TO'C and Year 1-3 neurology cards, not only AnKing. usmle-step1
  // stays out (see COMPANION_SOURCE_EXCLUSIONS). Per-card membership and
  // independent source entitlement still apply.
  geriatrics: Object.freeze([
    'anking', 'malleus', 'toc', 'surgical-sciences', 'physical-exam',
    'paam', 'critical-care', 'year1-kat1', 'year2-kat5', 'year3-common',
  ]),
  neurology: Object.freeze([
    'anking', 'malleus', 'neurosurg', 'anatomy',
    'surgical-sciences', 'cah', 'critical-care', 'physical-exam',
    'paam', 'mnd', 'toc', 'year2-kat7', 'year3-common',
  ]),
  urology: Object.freeze(['anking', 'malleus', 'surgical-sciences', 'cah', 'pwh']),
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
  radiology: Object.freeze([
    'anking', 'malleus', 'surgical-sciences', 'neurosurg', 'toc', 'cah', 'critical-care',
    'pwh', 'mnd', 'year1-kat1', 'year2-kat5', 'year2-kat7', 'year3-common',
  ]),
  neuroradiology: Object.freeze([
    'anking', 'malleus', 'neurosurg', 'anatomy',
    'surgical-sciences', 'cah', 'critical-care',
    'pwh', 'year2-kat7', 'year3-common',
  ]),
  // Obstetrics & Gynaecology, 2026-10-28. PWH is the native corpus; GSSE and
  // anatomy hold the pelvic plates and operative tissue planes; physical-exam
  // the obstetric abdomen and speculum routines; AnKing and Malleus the
  // background. Each contributes only cards that name `obgyn`.
  obgyn: Object.freeze([
    'pwh', 'surgical-sciences', 'anatomy', 'physical-exam', 'anking', 'malleus',
  ]),
  // Physical examination, 2026-09-23. TO'C is the examination text; CAH,
  // GSSE and critical-care hold the examination clips; ortho holds the
  // special tests. Each contributes only cards that name `physical-exam`.
  'physical-exam': Object.freeze([
    'toc', 'cah', 'surgical-sciences', 'critical-care', 'ortho', 'pwh', 'paam',
  ]),
  // MD1 KAT4 + MMCA (2026-10-21): the first-year renal, gastro and neuro
  // banks, the physical-exam deck and the examination clips, each contributing
  // only the items that name `md1-foundations`.
  // TO'C holds the adult abdominal examination; CAH and GSSE hold the neuro
  // examination clips; year1-kat1 holds the Year 1 neuro and renal physiology.
  // AHCT 4 (2026-10-22): the Rohen prosection plates of the regions the test
  // covers (brain, cranial nerves, meninges, spinal cord, eye, ear).
  'md1-foundations': Object.freeze([
    'year1-kat3', 'year1-kat2', 'year1-kat1', 'year2-kat7',
    'physical-exam', 'toc', 'cah', 'surgical-sciences', 'anatomy',
  ]),
  // Adult Medicine DWE. The cards stay in the rotation that authored them.
  // A focused BPT session draws the ones that name `bpt`.
  bpt: Object.freeze([
    'cah', 'critical-care', 'paam', 'pwh',
    'malleus', 'anking', 'toc', 'surgical-sciences',
  ]),
});

/**
 * Source rotations deliberately kept out of every composed deck's companion
 * policy, with the reason. The audit reports their declarations as
 * acknowledged exclusions rather than failures.
 *
 * usmle-step1 carries US framing and is not USyd teaching. Its cards' stray
 * deck declarations (Step 1 neurology/pathology/msk/reproductive cards naming
 * neurology, radiology, neuroradiology, urology) live only in the database,
 * written by keyword/discipline backfills; no MDX `modules=` attribute or
 * overlay declares them, so there is no source line to drop. Serving already
 * refuses them because the rotation is absent from every companion list.
 */
export const COMPANION_SOURCE_EXCLUSIONS: Readonly<Record<string, string>> = Object.freeze({
  'usmle-step1': 'US-framed Step 1 notes are not USyd teaching; keep out of the USyd composed decks',
});

/**
 * Decks whose enrolment implies enrolment in their declared companions.
 *
 * Every other deck admits a companion only when the learner is enrolled in
 * that source too. That suits a Year 3 student, who is enrolled in the blocks
 * whose clips a deck borrows. A first-year is not, and enrolling them in CAH
 * to reach its examination clips would make CAH their default landing
 * (`resolvePrimaries` prefers a scheduled enrolment over a self-paced deck).
 * So for these decks the deck's own enrolment stands in for each companion's.
 * It widens nothing else: the per-item moduleNodes gate still applies, and a
 * personal companion still needs the viewer's own entitlement.
 */
export const COMPANION_ENROLMENT_IMPLIED_TARGETS: ReadonlySet<string> = new Set([
  'md1-foundations',
]);

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
  // Pelvic GSSE cards in surgical-sciences declare `pwh` in moduleNodes; they
  // already enter unfocused PWH sessions via scheduled-exam cross-source blend,
  // but explicit PWH focus stays native-only without this supplement.
  pwh: Object.freeze(['surgical-sciences']),
});
