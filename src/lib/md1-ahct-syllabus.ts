/**
 * What AHCT 4 examines, as far as the sources say. Client-safe and pure.
 *
 * AHCT 4 (Anatomy and Histology Competency Test 4) is 12 timed stations of
 * identification only: 7 anatomy (prosections, models, MRI, photographs) and
 * 5 histology (slides plus transmission electron micrographs), each with five
 * parts A-E, written answers, 2.5 minutes a station.
 *
 * The only syllabus the course mirror holds is the 2024 sitting's list of
 * practicals ("Content", below). It names practicals, not structures: the
 * practical notes themselves are not in the mirror. So membership here is by
 * practical, and the structure-level reading of each practical is INFERRED
 * (marked `inferred`). The 2026 list was not found; it is assumed to match
 * 2024's, which is unverified.
 *
 * Source (every practical below): canvas_mirror/2024_medh_smp_year1_55362/
 * pages/information-on-anatomy-and-histology-competency-test-4-ahct-4.html,
 * "Content" section; sitting Monday 18 November 2024, Block 8.
 */

export const AHCT4_SOURCE_PAGE =
  '2024_medh_smp_year1_55362/pages/information-on-anatomy-and-histology-competency-test-4-ahct-4.html';

/**
 * The 2026 sitting date is NOT confirmed. 2024's was Monday 18 November; this
 * is the same calendar date, used only until the learner sets their own
 * (UserRotation 'md1-ahct'). PROVISIONAL: replace when the course publishes it.
 */
export const AHCT4_PROVISIONAL_DATE = '2026-11-18';

export type AhctKind = 'anatomy' | 'histology';

export interface AhctPractical {
  readonly id: string;
  readonly kind: AhctKind;
  /** Practical code as the 2024 page prints it, e.g. "Week 8.3". */
  readonly week: string;
  readonly title: string;
}

/** Stated verbatim by the source page. */
export const AHCT4_PRACTICALS: readonly AhctPractical[] = Object.freeze([
  { id: 'a-7.1', kind: 'anatomy', week: 'Week 7.1', title: 'Cross-sectional and ultrasound imaging of abdomen and pelvis' },
  { id: 'a-7.3', kind: 'anatomy', week: 'Week 7.3', title: 'Eye and ear' },
  { id: 'a-7.4', kind: 'anatomy', week: 'Week 7.4', title: 'Cross-sectional imaging of head and neck' },
  { id: 'a-8.1', kind: 'anatomy', week: 'Week 8.1', title: 'Spinal cord' },
  { id: 'a-8.2', kind: 'anatomy', week: 'Week 8.2', title: 'Brainstem' },
  { id: 'a-8.3', kind: 'anatomy', week: 'Week 8.3', title: 'Cranial nerves' },
  { id: 'a-8.4', kind: 'anatomy', week: 'Week 8.4', title: 'Senses' },
  { id: 'a-8.5', kind: 'anatomy', week: 'Week 8.5', title: 'Motor pathway' },
  { id: 'a-8.6', kind: 'anatomy', week: 'Week 8.6', title: 'Cortex/forebrain' },
  { id: 'h-7.1', kind: 'histology', week: 'Week 7.1', title: 'Upper GI' },
  { id: 'h-7.2', kind: 'histology', week: 'Week 7.2', title: 'Small and large intestine, anal canal' },
  { id: 'h-7.4', kind: 'histology', week: 'Week 7.4', title: 'Gallbladder, exocrine pancreas, liver' },
  { id: 'h-8.1', kind: 'histology', week: 'Week 8.1', title: 'Peripheral neural tissue' },
  { id: 'h-8.2', kind: 'histology', week: 'Week 8.2', title: 'CNS and meninges' },
  { id: 'h-8.5', kind: 'histology', week: 'Week 8.5', title: 'Eye and ear' },
]);

/**
 * Served sources that teach a practical. File names are the seeded sourceFile
 * stem. A mapping from a plate region to a practical is inferred (the source
 * names the practical, not the plate): `inferred: true` marks it.
 */
export interface AhctSourceMapping {
  readonly practicals: readonly string[];
  readonly inferred: boolean;
}

/** Rohen prosection plates, tagged `md1-foundations` by generate-rohen-cards.py (MD1_AHCT_REGIONS). */
export const AHCT_ROHEN_SOURCES: Readonly<Record<string, AhctSourceMapping>> = Object.freeze({
  'rohen-visual-apparatus': { practicals: ['a-7.3', 'a-8.4'], inferred: false },
  'rohen-auditory-and-vestibular-apparatus': { practicals: ['a-7.3', 'a-8.4'], inferred: false },
  'rohen-spinal-cord': { practicals: ['a-8.1'], inferred: false },
  'rohen-vertebral-canal-and-spinal-cord': { practicals: ['a-8.1'], inferred: false },
  'rohen-brain': { practicals: ['a-8.2', 'a-8.5', 'a-8.6'], inferred: true },
  'rohen-brain-and-cranial-nerves': { practicals: ['a-8.2', 'a-8.3'], inferred: true },
  // Meninges: the page lists "CNS and meninges" for HISTOLOGY only; the
  // anatomy practicals are brain/cord. Kept as the covering of both: inferred.
  'rohen-meninges': { practicals: ['a-8.1', 'a-8.6'], inferred: true },
});

/**
 * BlueLink atlas files (one per region). Only part of each file is examinable,
 * so the card-level predicate below decides; the file is a candidate source.
 */
export const AHCT_BLUELINK_SOURCES: Readonly<Record<string, AhctSourceMapping>> = Object.freeze({
  'cranial-cavity': { practicals: ['a-8.2', 'a-8.3', 'a-8.6'], inferred: true },
  orbit: { practicals: ['a-7.3', 'a-8.4'], inferred: true },
  'nasal-ear': { practicals: ['a-7.3', 'a-8.4'], inferred: true },
});

/** The histology deck: 113 cards in six groups that are exactly the six histology practicals. */
export const AHCT_HISTOLOGY_SOURCE = 'ahct-histology';

export function sourceStem(sourceFile: string | null | undefined): string {
  if (!sourceFile) return '';
  const slash = sourceFile.lastIndexOf('/');
  const base = slash >= 0 ? sourceFile.slice(slash + 1) : sourceFile;
  return base.replace(/\.mdx$/, '');
}

export interface AhctSourceIdentity {
  rotation?: string | null;
  sourceFile?: string | null;
}

/**
 * Is this item's SOURCE one the syllabus draws on? Cheap and queryless: the
 * strand mix uses it, so it must need nothing beyond rotation and source file.
 */
export function isAhctSyllabusSource(item: AhctSourceIdentity): boolean {
  const stem = sourceStem(item.sourceFile);
  if (item.rotation === 'anatomy') {
    return Object.hasOwn(AHCT_ROHEN_SOURCES, stem) || Object.hasOwn(AHCT_BLUELINK_SOURCES, stem);
  }
  if (item.rotation === 'md1-foundations') return stem === AHCT_HISTOLOGY_SOURCE;
  return false;
}

// ---------------------------------------------------------------------------
// BlueLink card-level predicate. BlueLink regions hold bones, sutures and
// nasal anatomy beside the nerves and brain; only the neural/sensory part is
// on AHCT 4. All three lists are inference from the practical titles.
// ---------------------------------------------------------------------------

/**
 * Structures of the cranial cavity that belong to brainstem, cranial nerves,
 * forebrain and meninges. Bones, sutures, foramina, fossae and the paranasal
 * sinuses are osteology (AHCT 3 and earlier), not in the AHCT 4 list.
 */
const CRANIAL_CAVITY_IN = new RegExp([
  String.raw`\(CN\b`, 'olfactory tract', 'cerebrum', 'cerebellum', 'medulla', String.raw`\bpons\b`, 'midbrain',
  'cerebral aqueduct', 'ventricle', String.raw`\b(frontal|parietal|temporal|occipital) lobe`,
  'dura mater', 'arachnoid', 'pia mater', 'subarachnoid', 'falx', 'tentori', 'diaphragma sellae',
  String.raw`(sagittal|petrosal|sigmoid|transverse|straight|cavernous|occipital) sinus`, 'confluence of sinuses',
  'great cerebral v', 'superior cerebral vv', String.raw`(cerebral|communicating|cerebellar|basilar|spinal) a\.`,
  String.raw`vertebral aa\.`, String.raw`internal carotid a\.`,
].join('|'), 'i');

/** Ear parts only: the file also holds the nose and skull base. */
const EAR_IN = new RegExp([
  'cochlea', 'malleus', 'incus', 'stapes', 'tympan', 'acoustic meatus', 'semicircular', 'oval window',
  'round window', 'promontory', 'mastoid cells', 'pharyngo-? ?tympanic', 'chorda tympani',
  'vestibulocochlear', String.raw`facial n\.`, 'tensor tympani', 'olfactory nn',
].join('|'), 'i');

/** The orbit file holds skull bones, ethmoid and nasal concha beside the eye, adnexa and nerves. */
const ORBIT_OUT = new RegExp([
  String.raw`\bbone\b`, 'orbital plate', 'perpendicular plate', 'cribriform', 'crista galli', 'concha',
  'orbital fissure', 'foramen', 'groove', 'lacrimal crest', 'trochlear fovea', 'orbital surface',
  'optic canal', 'internal carotid', 'ethmoidal n',
].join('|'), 'i');

export function isAhctBluelinkStructure(sourceFile: string | null | undefined, answer: string): boolean {
  const stem = sourceStem(sourceFile);
  const text = answer.replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (stem === 'cranial-cavity') return CRANIAL_CAVITY_IN.test(text);
  if (stem === 'nasal-ear') return EAR_IN.test(text);
  if (stem === 'orbit') return !ORBIT_OUT.test(text);
  return false;
}

/** The single predicate an MD1 AHCT admission test reads, for any served card. */
export function isAhctSyllabusCard(item: AhctSourceIdentity & { answer?: string | null }): boolean {
  if (!isAhctSyllabusSource(item)) return false;
  const stem = sourceStem(item.sourceFile);
  if (item.rotation === 'anatomy' && Object.hasOwn(AHCT_BLUELINK_SOURCES, stem)) {
    return isAhctBluelinkStructure(stem, item.answer ?? '');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Date-aware share
// ---------------------------------------------------------------------------

export const AHCT_BASELINE_SHARE = 0.15;
export const AHCT_PEAK_SHARE = 0.5;
export const AHCT_RAMP_DAYS = 7;

/** Calendar day (YYYY-MM-DD) in Sydney, the reporting day for MD1 learners. */
export function sydneyDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(now);
}

function dayNumber(isoDay: string): number {
  const [y, m, d] = isoDay.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * Share of served items the AHCT strand takes. Baseline until the final
 * AHCT_RAMP_DAYS before the test, then a linear climb to AHCT_PEAK_SHARE on
 * the day itself; baseline again afterwards. `examDate` is the learner's own
 * date when they set one, else the provisional constant.
 */
export function ahctShare(now: Date, examDate: string | null | undefined = AHCT4_PROVISIONAL_DATE): number {
  const date = examDate && /^\d{4}-\d{2}-\d{2}/.test(examDate) ? examDate.slice(0, 10) : AHCT4_PROVISIONAL_DATE;
  const daysLeft = dayNumber(date) - dayNumber(sydneyDay(now));
  if (daysLeft < 0 || daysLeft > AHCT_RAMP_DAYS) return AHCT_BASELINE_SHARE;
  const t = (AHCT_RAMP_DAYS + 1 - daysLeft) / (AHCT_RAMP_DAYS + 1);
  return AHCT_BASELINE_SHARE + (AHCT_PEAK_SHARE - AHCT_BASELINE_SHARE) * t;
}
