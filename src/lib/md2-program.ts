/**
 * The second-year (USyd MD2) learner program. Client-safe and pure.
 *
 * An MD2 learner is `User.institution === 'usyd-md2'`, the value the
 * institution model already defines (src/lib/institution.ts). Like
 * `md1-program.ts`, every surface that differs for them asks `isMd2Program`
 * rather than keeping its own list.
 *
 * ROTATIONS ARE BLOCKS, NOT KAT NUMBERS. The KAT a block is examined in moves
 * between years: the Block 5 neurology/renal/GI weeks were KAT7 in 2025 and are
 * KAT8 in 2026, and the oncology and haematology blocks were KAT6 and are now
 * KAT7. A rotation id that carries the KAT number would silently describe the
 * wrong exam the following year, so content is keyed by the block that
 * teaches it and the exam calendar below maps blocks to the year's KAT.
 * (`year2-kat5` and `year2-kat7` are older buckets, kept because their cards
 * are live and embedded; they hold the GEL1 and GEL5 surgical-grand-round
 * and module notes respectively.)
 */

export const MD2_INSTITUTION = 'usyd-md2';

export type Md2BlockStatus =
  /** Cards are in the database, embedded and focusable. */
  | 'live'
  /**
   * Source exists in content/ but every item has not yet been inspected, so the
   * canonical seed does not read it (see `MD2_STAGED_ROTATION_IDS`). Promote by
   * flipping this to 'live' together with the steps in the MD2 inventory.
   */
  | 'staged';

export interface Md2Block {
  /** The rotation value stored on Card and Question rows. */
  rotation: string;
  /** Focus-selector label. */
  label: string;
  /** What the block teaches. */
  name: string;
  /** Canvas block the content belongs to (2025 course 62302 numbering). */
  canvasBlock: 1 | 2 | 3 | 4 | 5;
  status: Md2BlockStatus;
}

export const MD2_BLOCKS: readonly Md2Block[] = [
  { rotation: 'year2-kat5', label: 'GEL1 SGR', name: 'GEL Block 1: surgical grand rounds and module notes', canvasBlock: 1, status: 'live' },
  { rotation: 'year2-kat7', label: 'GEL5 SGR', name: 'GEL Block 5: surgical grand rounds and module notes', canvasBlock: 5, status: 'live' },
  { rotation: 'year2-b1-gel1', label: 'GEL1', name: 'GEL Block 1: surgery, MSK, respiratory, cardiovascular, endocrine', canvasBlock: 1, status: 'staged' },
  { rotation: 'year2-b2-trcp', label: 'TCP', name: 'Transition to Clinical Practice: sexual, adolescent, drug and alcohol, child health', canvasBlock: 2, status: 'staged' },
  { rotation: 'year2-b3-oncology', label: 'Onc', name: 'Oncology and palliative care', canvasBlock: 3, status: 'staged' },
  { rotation: 'year2-b4-haematology', label: 'Haem', name: 'Haematology', canvasBlock: 4, status: 'staged' },
  { rotation: 'year2-b5-gel2', label: 'GEL5', name: 'GEL Block 5: neurology, renal, gastroenterology and the surgery that goes with them', canvasBlock: 5, status: 'staged' },
];

const rotationsWith = (status: Md2BlockStatus): readonly string[] =>
  MD2_BLOCKS.filter((block) => block.status === status).map((block) => block.rotation);

/** Rotations with embedded, focusable cards. The first is the guest/no-signal default. */
export const MD2_LIVE_ROTATION_IDS: readonly string[] = rotationsWith('live');

/**
 * Rotations whose content sits in content/ but is withheld from the canonical
 * seed until every item is inspected. They parse only when named in
 * `MD3_STAGED_ROTATIONS` (see card-generator.ts), which is how a dry run reads
 * them without making them seedable by accident.
 */
export const MD2_STAGED_ROTATION_IDS: readonly string[] = rotationsWith('staged');

/**
 * What the first-run picker saves as `activeModules` for a learner who says
 * they are in MD2. Today this is the live rotations only: a staged rotation has
 * no rows to serve. When a block is promoted it joins this list by itself.
 */
export const MD2_ACTIVE_MODULES: readonly string[] = MD2_LIVE_ROTATION_IDS;

export interface Md2Exam {
  /**
   * The UserRotation key a personal date is stored under. Deliberately NOT a
   * rotation slug: `year2-kat7` is a content bucket, and filing the 2026 KAT7
   * date under it would make the scheduler pace the wrong deck for it.
   */
  id: string;
  short: string;
  /** The 2026 planner date (YYYY-MM-DD). A learner's own date overrides it. */
  examDate: string;
  /** Canvas blocks the sitting covers in 2026. */
  canvasBlocks: readonly number[];
}

/**
 * The 2026 sittings, from the MD2 academic planner (src/lib/curriculum/
 * usyd-md2-2026.ts). The planner places the second GEL block (KAT6) between
 * the GEL1 and the oncology/haematology blocks; the 2025 course had no such
 * block, so there is no content for it yet.
 */
export const MD2_EXAMS: readonly Md2Exam[] = [
  { id: 'md2-kat5', short: 'KAT5', examDate: '2026-03-30', canvasBlocks: [1] },
  { id: 'md2-kat6', short: 'KAT6', examDate: '2026-06-01', canvasBlocks: [] },
  { id: 'md2-kat7', short: 'KAT7', examDate: '2026-09-14', canvasBlocks: [3, 4] },
  { id: 'md2-kat8', short: 'KAT8', examDate: '2026-11-23', canvasBlocks: [5] },
];

/** Default dates by exam id, for surfaces that prefill them (MD1 has none on file). */
export function md2DefaultExamDates(): ReadonlyMap<string, string> {
  return new Map(MD2_EXAMS.map((exam) => [exam.id, exam.examDate]));
}

/**
 * The live rotation a second-year should land on, from the sitting that is next
 * on `today` (YYYY-MM-DD). The block taught for that sitting wins; with no
 * upcoming sitting, or one no live rotation covers yet (KAT6 has no content),
 * the first live rotation. Pass it as the default focus, as the Year 3 flow
 * passes the booked block.
 */
export function md2FocusRotation(today: string): string {
  const next = MD2_EXAMS.find((exam) => exam.examDate >= today);
  for (const canvasBlock of next?.canvasBlocks ?? []) {
    const block = MD2_BLOCKS.find((b) => b.status === 'live' && b.canvasBlock === canvasBlock);
    if (block) return block.rotation;
  }
  return MD2_LIVE_ROTATION_IDS[0];
}

export function isMd2Program(institution: string | null | undefined): boolean {
  return institution === MD2_INSTITUTION;
}
