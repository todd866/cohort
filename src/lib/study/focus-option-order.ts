/**
 * Display order for the review focus selector.
 *
 * `inPlayStudyRotations` preserves the order of `User.activeModules`, which is
 * whatever order rows were appended to a Postgres array over months of
 * enrolments — so the menu's order was an artefact of enrolment history, not a
 * decision. Requested 2026-09-18: the exam rotation first, then "All", then
 * everything else, with the paediatric-surgery deck sitting between GSSE and
 * NSx (it is built from the same surgical corpus, and reads as one of that
 * family rather than as a stray deck at the end of the list).
 *
 * The exam rotation is NOT hardcoded here: the selector lifts it out of this
 * list at render time. Which block is booked changes every term, and a
 * hardcoded slug would quietly stop being true on the day it mattered most.
 *
 * A slug this list does not name still renders — appended, in the order it
 * arrived — so adding a rotation never makes it disappear from the menu.
 */
export const FOCUS_OPTION_ORDER: readonly string[] = [
  // Scheduled blocks, in track order.
  'critical-care',
  'cah',
  'paam',
  'pwh',
  'year3-common',
  'year1-kat1',
  'year1-kat2',
  'year1-kat3',
  'usmle-step1',
  'usmle-step1-open',
  // Opt-in decks: the background banks first, then the surgical/anatomy family,
  // which shares one corpus and reads best adjacent.
  'anking',
  'malleus',
  'toc',
  'anatomy',
  'surgical-sciences',
  'paediatric-surgery',
  'neurosurg',
  // Year 4 2027 attachments, in the order they are actually sat: Geriatrics and
  // Neurology in Term 2, Neurosurgery and Urology in Term 3. NSx sits just above
  // because it is also the GSSE/anatomy family's tail.
  'geriatrics',
  'neurology',
  'urology',
  'mnd',
];

const RANK = new Map(FOCUS_OPTION_ORDER.map((slug, index) => [slug, index]));

/** Sort focus-selector options into the display order above; stable for the rest. */
export function orderFocusOptions(options: readonly string[]): string[] {
  return options
    .map((slug, index) => ({ slug, index }))
    .sort((a, b) => {
      const ra = RANK.get(a.slug) ?? FOCUS_OPTION_ORDER.length + a.index;
      const rb = RANK.get(b.slug) ?? FOCUS_OPTION_ORDER.length + b.index;
      return ra - rb;
    })
    .map((entry) => entry.slug);
}
