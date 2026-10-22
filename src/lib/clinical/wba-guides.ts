/**
 * Workplace-based assessment how-to guides.
 *
 * The guide CONTENT lives in `content/clinical/`, not here, and that placement
 * is load-bearing: `content/` is structurally excluded from the FOSS
 * distribution while `src/` is shipped in it. These are institution-specific
 * assessment materials, so the rendering code is public and the material is not.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstitution } from '@/lib/effective-institution';

export interface WbaLink { label: string; href: string }

/** One rating level of an official rubric domain, quoted verbatim. */
export interface WbaRubricLevel {
  label: string;
  /** True for the levels that meet the expected standard. */
  meets: boolean;
  text: string;
}

export interface WbaRubricDomain {
  name: string;
  description?: string;
  levels: WbaRubricLevel[];
}

/** An official rubric shared by several WBAs, quoted verbatim from its source. */
export interface WbaRubric {
  id: string;
  /** Short name for a dense row, e.g. "Procedural". */
  name: string;
  /** The source's own heading, verbatim. */
  heading: string;
  domains: WbaRubricDomain[];
}

/** A speakable talk-through, grouped by the rubric's or the clinical task's own phases. */
export interface WbaTalkPhase {
  phase: string;
  lines: string[];
}

/**
 * How the WBA runs on the day, in order: who agrees the case, what you do,
 * what you present, how the assessor records it. The ask line sits between
 * approval and doing, from the guide's own `ask`.
 */
export interface WbaRun {
  approve: string;
  do: string;
  present?: string;
  /** Falls back to the set's `handover`. */
  handover?: string;
}

export interface WbaGuide {
  number: number;
  slug: string;
  title: string;
  format: string;
  oneLine: string;
  howTo?: string[];
  rubric?: string[];
  prepare?: string[];
  trap?: string;
  autoFail?: string[];
  resources?: WbaLink[];
  /** What the student says to a doctor to ask for the assessment: what it is, what they do. */
  ask?: string;
  /** What to arrange before asking: case approval, consent, kit, the risr form. */
  setup?: string;
  /** The official task text, verbatim. */
  task?: string;
  taskSource?: WbaLink;
  /** Who may assess, as the source states it. */
  assessor?: string;
  /** Who approves the case before the patient is approached, from the task text. */
  approval?: string;
  /** Submission steps; falls back to the set's `submit`. */
  submit?: string[];
  /** Id of a set-level rubric; resolved into `rubricDomains` by the loader. */
  rubricId?: string;
  rubricName?: string;
  rubricHeading?: string;
  rubricDomains?: WbaRubricDomain[];
  /** Plain statement when no rubric is published for this WBA. */
  rubricNote?: string;
  talkThrough?: WbaTalkPhase[];
  traps?: string[];
  practice?: WbaLink[];
  /** Display code replacing "WBA<number>", e.g. "ED1"; an empty string shows the title alone. */
  code?: string;
  /** The group or category the WBA counts towards, in the source's words. */
  group?: string;
  /** What the set requires of this WBA, e.g. "MANDATORY" or "pick 1 of 3". */
  requirement?: string;
  mandatory?: boolean;
  /** Due points in course-relative weeks; dated when a verified term is current. */
  due?: WbaDue[];
  /** Where sources disagree on a due date: what the later source says. */
  dueNote?: string;
  /** The assessor-facing task text, verbatim. */
  assessorTask?: string;
  /** Case options the WBA may be done on, verbatim. */
  options?: string[];
  /** Reflective questions the source asks the student to answer, verbatim. */
  reflect?: string[];
  /** Where sources disagree about the task itself. */
  sourceNote?: string;
  /** Clinical sources behind the talk-through and traps. */
  clinicalSources?: string[];
  /** Talk-through or trap content resting on a single source, or not checked against one. */
  unverified?: string[];
  run?: WbaRun;
  /** What a suitable patient looks like, from the task text and common presentations. */
  cases?: string[];
}

export type WbaDay = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
const WBA_DAYS: readonly WbaDay[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A due point relative to the block, e.g. { label: '3', week: 4, day: 'Fri' }. */
export interface WbaDue {
  /** What must be done by then, e.g. "3" or "all 7"; omitted for a single WBA. */
  label?: string;
  week: number;
  day: WbaDay;
  /** 24-hour clock in the course's timezone, when the source states one. */
  time?: string;
}

/** A verified teaching term: the Monday its block's week 1 starts. */
export interface WbaTerm { id: string; label: string; week1Monday: string }

export interface WbaSharedRules {
  attempts: string;
  missedDeadline: string;
  assessorMinimum: string;
  portfolio: string;
  allCompulsory: string;
}

/** The viewer fields that decide clinical-guide access (a session.user subset). */
export interface ClinicalViewer {
  betaAccess?: boolean;
  imageTier?: 'standard' | 'copyright';
  institution?: string | null;
  /**
   * The learner's Year 3 stream. With no institution recorded, a stream of 1-4
   * reads as usyd (effective-institution.ts); an explicit institution wins.
   */
  track?: number | null;
}

/**
 * Who may see institution-specific assessment guidance.
 *
 * Rolled out from beta holders to every copyright-tier user. Gating on
 * institution alone would have reached several times the intended audience,
 * so the tier is load-bearing and is NOT interchangeable with institution here.
 *
 * The institution match is required on BOTH paths, including `betaAccess`.
 * These guides encode one school's assessment conventions. Shown to a student
 * at another school they are not merely irrelevant, they are misleading, and
 * learners from other institutions are a real case. A manual beta grant is not
 * a licence to be shown another school's marking rules.
 *
 * `imageTier` is nominally about image redistribution rights. Reusing it as the
 * trust signal for other gated material is a deliberate call, not an accident:
 * it is the existing marker for the vetted, signed-in cohort. If the two ever
 * need to diverge, this is the seam to split — give clinical access its own
 * field rather than widening what imageTier means.
 */
export function canViewClinicalGuides(
  viewer: ClinicalViewer | null | undefined,
  guideInstitution: string,
): boolean {
  if (!viewer) return false;
  // A viewer here is a signed-in session user, never a guest.
  const viewerInstitution = effectiveInstitution({
    institution: viewer.institution, track: viewer.track, registered: true,
  })?.toLowerCase();
  if (!viewerInstitution) return false;
  if (viewerInstitution !== guideInstitution.trim().toLowerCase()) return false;
  return viewer.betaAccess === true || viewer.imageTier === 'copyright';
}

export interface WbaGuideSet {
  institution: string;
  rotation: string;
  sourceVerifiedAt: string;
  shared: WbaSharedRules;
  guides: WbaGuide[];
  rubrics?: WbaRubric[];
  submit?: string[];
  submitSource?: string;
  /** Default `assessor` for guides that do not state their own. */
  assessor?: string;
  source?: string;
  sourceNote?: string;
  studyBoundary?: string;
  /** Mix rules beyond each WBA's own requirement, verbatim or close to it. */
  requirementsNote?: string;
  /** Block-level due summary for the index. */
  dueSummary?: WbaDue[];
  /** Terms whose dates are verified, for dating relative due points. */
  termStarts?: WbaTerm[];
  /** Default last step of every guide's run: how the assessor records it. */
  handover?: string;
  /** Rostered placements where a WBA can be done, matched on the roster's own titles. */
  placements?: WbaPlacement[];
}

/** One kind of rostered placement and the WBAs it makes possible, by guide number. */
export interface WbaPlacement {
  /** Roster titles for this placement, compared whole and case-insensitively. */
  titles: string[];
  wbas?: number[];
  /**
   * For a roster title that can mean more than one kind of placement (a
   * "Wards" day may be a gynaecology or a postnatal ward): each kind and its
   * WBAs, shown side by side rather than guessed.
   */
  variants?: { label: string; wbas: number[] }[];
}

/** Rotations with a published guide set. Everything else hides the entry point. */
const SUPPORTED = new Set(['cah', 'pwh', 'paam', 'critical-care']);

export function isWbaRotationSupported(rotation: string): boolean {
  return SUPPORTED.has(rotation);
}

function guidePath(rotation: string): string {
  return join(process.cwd(), 'content', 'clinical', `${rotation}-wba-guides.json`);
}

export function loadWbaGuides(rotation: string): WbaGuideSet | null {
  if (!isWbaRotationSupported(rotation)) return null;
  const path = guidePath(rotation);
  if (!existsSync(path)) return null;
  const set = JSON.parse(readFileSync(path, 'utf8')) as WbaGuideSet;
  return {
    ...set,
    guides: [...set.guides].sort((a, b) => a.number - b.number).map((g) => resolveGuide(set, g)),
  };
}

/** Attach the shared rubric and submission steps a guide refers to. */
function resolveGuide(set: WbaGuideSet, guide: WbaGuide): WbaGuide {
  const rubric = guide.rubricId ? set.rubrics?.find((r) => r.id === guide.rubricId) : undefined;
  return {
    ...guide,
    ...(rubric && !guide.rubricDomains
      ? { rubricDomains: rubric.domains, rubricName: rubric.name, rubricHeading: rubric.heading }
      : {}),
    ...(!guide.submit && set.submit ? { submit: set.submit } : {}),
    ...(!guide.assessor && set.assessor ? { assessor: set.assessor } : {}),
    ...(guide.run && !guide.run.handover && set.handover ? { run: { ...guide.run, handover: set.handover } } : {}),
  };
}

/** Words in a speakable line: tokens carrying a letter or digit. */
export function spokenWordCount(line: string): number {
  return line.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

export const TALK_LINE_MAX_WORDS = 6;
export const TRAP_MAX_WORDS = 15;
export const ASK_MAX_WORDS = 60;
export const RUN_LINE_MAX_WORDS = 20;
export const CASE_MAX_WORDS = 9;

/**
 * Structural problems in a guide set: unresolved rubric ids, empty lists,
 * talk-through lines too long to say in one breath, rubric domains without a
 * standard-meeting level. Content correctness is a separate, human question.
 */
export function wbaGuideProblems(set: WbaGuideSet): string[] {
  const problems: string[] = [];
  for (const rubric of set.rubrics ?? []) {
    if (rubric.domains.length === 0) problems.push(`rubric ${rubric.id}: no domains`);
    for (const d of rubric.domains) {
      if (d.levels.length === 0) problems.push(`rubric ${rubric.id} ${d.name}: no levels`);
      if (!d.levels.some((l) => l.meets)) problems.push(`rubric ${rubric.id} ${d.name}: no meeting level`);
      for (const l of d.levels) {
        if (!l.text.trim()) problems.push(`rubric ${rubric.id} ${d.name} ${l.label}: empty`);
      }
    }
  }
  for (const p of set.placements ?? []) {
    if (p.titles.length === 0) problems.push('placement: no titles');
    if (!p.wbas?.length && !p.variants?.length) problems.push(`placement ${p.titles[0]}: no WBAs`);
    for (const n of [...(p.wbas ?? []), ...(p.variants ?? []).flatMap((v) => v.wbas)]) {
      if (!set.guides.some((g) => g.number === n)) problems.push(`placement ${p.titles[0]}: unknown WBA ${n}`);
    }
  }
  for (const g of set.guides) {
    const at = `WBA ${g.number}`;
    if (g.rubricId && !set.rubrics?.some((r) => r.id === g.rubricId)) {
      problems.push(`${at}: unknown rubric ${g.rubricId}`);
    }
    for (const [name, list] of [
      ['talkThrough', g.talkThrough], ['traps', g.traps], ['practice', g.practice], ['submit', g.submit],
      ['options', g.options], ['reflect', g.reflect], ['due', g.due],
    ] as const) {
      if (list && list.length === 0) problems.push(`${at}: empty ${name}`);
    }
    for (const phase of g.talkThrough ?? []) {
      if (phase.lines.length === 0) problems.push(`${at} ${phase.phase}: empty phase`);
      for (const line of phase.lines) {
        const n = spokenWordCount(line);
        if (n === 0 || n > TALK_LINE_MAX_WORDS) problems.push(`${at} "${line}": ${n} words`);
      }
    }
    if (g.ask !== undefined) {
      const n = spokenWordCount(g.ask);
      if (n === 0 || n > ASK_MAX_WORDS) problems.push(`${at} ask: ${n} words`);
    }
    if (g.cases && g.cases.length === 0) problems.push(`${at}: empty cases`);
    for (const c of g.cases ?? []) {
      const n = spokenWordCount(c);
      if (n === 0 || n > CASE_MAX_WORDS) problems.push(`${at} case "${c}": ${n} words`);
    }
    for (const key of ['approve', 'do', 'present', 'handover'] as const) {
      const line = g.run?.[key];
      if (line === undefined) continue;
      const n = spokenWordCount(line);
      if (n === 0 || n > RUN_LINE_MAX_WORDS) problems.push(`${at} run ${key}: ${n} words`);
    }
    for (const d of g.due ?? []) {
      if (!WBA_DAYS.includes(d.day) || d.week < 1 || d.week > 12) problems.push(`${at} due: ${d.day} wk${d.week}`);
    }
    for (const trap of g.traps ?? []) {
      const n = spokenWordCount(trap);
      if (n > TRAP_MAX_WORDS) problems.push(`${at} trap "${trap}": ${n} words`);
    }
  }
  return problems;
}

export function wbaGuideBySlug(rotation: string, slug: string): WbaGuide | null {
  return loadWbaGuides(rotation)?.guides.find((g) => g.slug === slug) ?? null;
}

const DAY_MS = 86_400_000;

/** The verified term whose block (week 1 Monday to the end of week 8) contains `now`. */
export function currentWbaTerm(set: Pick<WbaGuideSet, 'termStarts'>, now: Date = new Date()): WbaTerm | null {
  return set.termStarts?.find((t) => {
    const start = Date.parse(`${t.week1Monday}T00:00:00+11:00`);
    return now.getTime() >= start - DAY_MS && now.getTime() < start + 56 * DAY_MS;
  }) ?? null;
}

/** "Fri wk4 17:00" plus " 6 Nov" when a term is known; "3 by …" when the point has a label. */
export function wbaDueLabel(due: WbaDue, term?: WbaTerm | null): string {
  let text = `${due.day} wk${due.week}${due.time ? ` ${due.time}` : ''}`;
  if (term) {
    const offset = (due.week - 1) * 7 + WBA_DAYS.indexOf(due.day);
    const date = new Date(Date.parse(`${term.week1Monday}T12:00:00+11:00`) + offset * DAY_MS);
    text += ` ${new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' }).format(date)}`;
  }
  return due.label ? `${due.label} by ${text}` : text;
}

/** The header facts and due line of one WBA page, for sets that carry per-guide requirements. */
export function wbaGuideHeader(guide: WbaGuide, term?: WbaTerm | null) {
  const facts: { label: string; value: string; strong?: boolean }[] = [
    ...(guide.group ? [{ label: 'Counts as', value: guide.group }] : []),
    ...(guide.requirement ? [{ label: 'Required', value: guide.requirement, strong: guide.mandatory === true }] : []),
    { label: 'Rubric', value: guide.rubricName ?? 'not published' },
    ...(guide.approval ? [{ label: 'Case OK', value: guide.approval }] : []),
    ...(guide.assessor ? [{ label: 'Assessor', value: guide.assessor }] : []),
  ];
  const due = guide.due?.length ? guide.due.map((d) => wbaDueLabel(d, term)).join(' · ') : undefined;
  return { facts, due };
}
