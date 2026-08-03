/**
 * Paediatric clinical examination protocols — the data behind /exams.
 *
 * TWO MODES, ONE DATASET (see the vision doc):
 *   - bedside mode: an operational checklist for live ward use. No scoring, no
 *     failure states, nothing on screen that would embarrass you if a parent
 *     read it over your shoulder.
 *   - study mode: spaced retrieval over the same steps. NOT BUILT YET.
 *
 * The content is authored PRE-RUBRIC. Once the WBA marking rubrics are pulled
 * from risr/advance and the Canvas submission portal, re-author against them —
 * the rubric is ground truth for what the examiner ticks.
 */

export interface ExamStep {
  /**
   * Stable authoring identity. Transitional optionality keeps the existing
   * protocols valid; every step in a lesson-bearing exam must have an id.
   */
  id?: string;
  text: string;
  /** Why it matters, or the paediatric-specific trap. */
  note?: string;
  /** Steps that are commonly missed or carry real consequence. */
  critical?: boolean;
}

export interface ExamPhase {
  name: string;
  steps: ExamStep[];
}

export interface KeyDiscriminator {
  title: string;
  innocent: string[];
  innocentMnemonic?: string;
  pathological: string[];
}

/**
 * Code-native diagrams available to the amplified Clinical lesson renderer.
 * Keep this allowlist beside the authored-data contract so protocol JSON
 * cannot select an arbitrary component, URL, or private image.
 */
export const CLINICAL_LESSON_VISUAL_IDS = [
  'wba4-branch-map',
  'paediatric-approach',
  'bp-cuff-fit',
  'cardiac-precordium',
  'radio-femoral-delay',
  'cardiac-listen-route',
  'cardiac-recall-map',
] as const;

export type ClinicalLessonVisualId =
  (typeof CLINICAL_LESSON_VISUAL_IDS)[number];

export interface ClinicalLessonVisual {
  id: ClinicalLessonVisualId;
  alt: string;
  caption: string;
}

export interface ClinicalLessonSceneBase {
  id: string;
  /** Canonical checklist steps that supply the action copy for this scene. */
  sourceStepIds: string[];
  context: string;
  heading: string;
  takeaway: string;
  /** Optional rationale kept behind progressive disclosure. */
  detail?: string;
  /** Optional protocol/source IDs used for provenance. */
  sourceIds?: string[];
}

type ClinicalLessonVisualScene = ClinicalLessonSceneBase & {
  visual: ClinicalLessonVisual;
};

/**
 * Semantic teaching scenes, deliberately narrower than a presentation layout
 * schema. A renderer chooses composition from the cognitive job (`kind`).
 */
export type ClinicalLessonScene =
  | (ClinicalLessonVisualScene & { kind: 'briefing' })
  | (ClinicalLessonVisualScene & { kind: 'technique' })
  | (ClinicalLessonVisualScene & { kind: 'sequence' })
  | (ClinicalLessonVisualScene & {
      kind: 'recall';
      prompt: string;
      revealStepIds: string[];
    });

export interface ClinicalLesson {
  id: string;
  title: string;
  defaultTrack: string;
  /** Ordered scene IDs for each authored examination track. */
  tracks: Record<string, string[]>;
  scenes: ClinicalLessonScene[];
}

export interface ClinicalExam {
  slug: string;
  title: string;
  subtitle: string;
  durationMin: number;
  /** Which WBAs this exam feeds. */
  wba: string[];
  phases: ExamPhase[];
  keyDiscriminator?: KeyDiscriminator;
  /** Model narration lines — the WBA5 rehearsal. */
  sayThis?: string[];
  redFlags?: string[];
  /** Set when the content must be confirmed against a local protocol. */
  verifyAgainst?: string;
  /** Conditions of the assessment, straight from the rubric. */
  setup?: string[];
  /** Which marking rubric this was authored from. */
  rubricSource?: string;
  /** Pointer back to the rubric protocol for shared marked items. */
  rubricNote?: string;
  /** Optional amplified teaching projection over the canonical checklist. */
  lesson?: ClinicalLesson;
  /**
   * Branches the examiner chooses between. WBA4 lets the assessor pick
   * respiratory, cardiac or gastro, so all three must be prepared.
   */
  tracks?: Record<string, ExamPhase[]>;
}

export interface ExamPrinciple {
  title: string;
  detail: string;
}

export interface ProtocolSource {
  id: string;
  label: string;
  where: string;
  role: string;
}

export interface ExamProtocolSet {
  schemaVersion: number;
  sources?: ProtocolSource[];
  rotation: string;
  updatedAt: string;
  sourceStatus: 'pre-rubric' | 'rubric-aligned';
  principles: ExamPrinciple[];
  exams: ClinicalExam[];
}

export function findExam(set: ExamProtocolSet, slug: string): ClinicalExam | null {
  return set.exams.find((e) => e.slug === slug) ?? null;
}

export function countSteps(exam: ClinicalExam): number {
  return exam.phases.reduce((n, p) => n + p.steps.length, 0);
}

/** Shared steps followed by every branch, in authored track order. */
export function allExamSteps(exam: ClinicalExam): ExamStep[] {
  return [
    ...exam.phases.flatMap((phase) => phase.steps),
    ...Object.values(exam.tracks ?? {}).flatMap((phases) =>
      phases.flatMap((phase) => phase.steps),
    ),
  ];
}

/**
 * Shared steps followed by one examiner-selected branch. An unknown track
 * resolves to the shared spine only, which keeps this helper safe for URL
 * input while the UI returns the learner to a known track.
 */
export function stepsForTrack(exam: ClinicalExam, track: string): ExamStep[] {
  return [
    ...exam.phases.flatMap((phase) => phase.steps),
    ...(exam.tracks?.[track] ?? []).flatMap((phase) => phase.steps),
  ];
}

/** Find a stable checklist step across the shared spine and all branches. */
export function findExamStep(exam: ClinicalExam, id: string): ExamStep | null {
  return allExamSteps(exam).find((step) => step.id === id) ?? null;
}

/**
 * Steps flagged `critical` — shared plus the selected track, or every branch
 * when no track is supplied. This fixes the old shared-only blind spot.
 */
export function criticalSteps(
  exam: ClinicalExam,
  track?: string,
): ExamStep[] {
  const steps =
    track === undefined ? allExamSteps(exam) : stepsForTrack(exam, track);
  return steps.filter((step) => step.critical);
}

/** Resolve a scene's canonical action steps, preserving reference order. */
export function resolveClinicalLessonSceneSteps(
  exam: ClinicalExam,
  scene: ClinicalLessonScene,
): ExamStep[] {
  return scene.sourceStepIds.flatMap((id) => {
    const step = findExamStep(exam, id);
    return step ? [step] : [];
  });
}

/** Resolve a lesson track's authored scene order. */
export function lessonScenesForTrack(
  lesson: ClinicalLesson,
  track = lesson.defaultTrack,
): ClinicalLessonScene[] {
  const sceneById = new Map(lesson.scenes.map((scene) => [scene.id, scene]));
  return (lesson.tracks[track] ?? []).flatMap((id) => {
    const scene = sceneById.get(id);
    return scene ? [scene] : [];
  });
}

/** Exams that feed a given WBA, e.g. 'WBA4'. */
export function examsForWba(set: ExamProtocolSet, wba: string): ClinicalExam[] {
  return set.exams.filter((e) => e.wba.includes(wba));
}

/** Total bedside time if you ran every protocol back to back. */
export function totalDurationMin(set: ExamProtocolSet): number {
  return set.exams.reduce((n, e) => n + e.durationMin, 0);
}

/**
 * Every distinct WBA referenced, in first-appearance order.
 * Used to render the "what this feeds" index without hard-coding WBA numbers.
 */
export function allWbas(set: ExamProtocolSet): string[] {
  const seen: string[] = [];
  for (const e of set.exams) {
    for (const w of e.wba) if (!seen.includes(w)) seen.push(w);
  }
  return seen;
}

/** Track names in a stable order, or [] when the exam has no branches. */
export function trackNames(exam: ClinicalExam): string[] {
  return exam.tracks ? Object.keys(exam.tracks) : [];
}

/** Steps in the shared phases plus every track — the true breadth to prepare. */
export function countAllSteps(exam: ClinicalExam): number {
  return allExamSteps(exam).length;
}

export type ClinicalLessonValidationCode =
  | 'missing-step-id'
  | 'duplicate-step-id'
  | 'duplicate-scene-id'
  | 'unknown-default-track'
  | 'unknown-track'
  | 'unknown-scene'
  | 'duplicate-track-scene'
  | 'orphan-scene'
  | 'unknown-step'
  | 'unknown-visual'
  | 'missing-visual-text';

export interface ClinicalLessonValidationIssue {
  code: ClinicalLessonValidationCode;
  path: string;
  message: string;
}

/**
 * Validate the authored seam between a checklist and its amplified lesson.
 * This stays pure so content tests, offline ingestion and future authoring
 * tools can all enforce the same contract.
 */
export function validateClinicalLesson(
  exam: ClinicalExam,
): ClinicalLessonValidationIssue[] {
  const lesson = exam.lesson;
  if (!lesson) return [];

  const issues: ClinicalLessonValidationIssue[] = [];
  const steps = allExamSteps(exam);
  const stepIds = new Set<string>();

  steps.forEach((step, index) => {
    const path = `${exam.slug}.steps[${index}]`;
    if (!step.id?.trim()) {
      issues.push({
        code: 'missing-step-id',
        path,
        message: 'Every step in a lesson-bearing exam needs a stable id.',
      });
      return;
    }
    if (stepIds.has(step.id)) {
      issues.push({
        code: 'duplicate-step-id',
        path,
        message: `Duplicate step id "${step.id}".`,
      });
      return;
    }
    stepIds.add(step.id);
  });

  const examTracks = new Set(Object.keys(exam.tracks ?? {}));
  if (!Object.hasOwn(lesson.tracks, lesson.defaultTrack)) {
    issues.push({
      code: 'unknown-default-track',
      path: `${exam.slug}.lesson.defaultTrack`,
      message: `Default track "${lesson.defaultTrack}" is not authored in the lesson.`,
    });
  }

  const sceneById = new Map<string, ClinicalLessonScene>();
  lesson.scenes.forEach((scene, index) => {
    const path = `${exam.slug}.lesson.scenes[${index}]`;
    if (sceneById.has(scene.id)) {
      issues.push({
        code: 'duplicate-scene-id',
        path,
        message: `Duplicate scene id "${scene.id}".`,
      });
    } else {
      sceneById.set(scene.id, scene);
    }

    for (const [field, ids] of [
      ['sourceStepIds', scene.sourceStepIds],
      [
        'revealStepIds',
        scene.kind === 'recall' ? scene.revealStepIds : [],
      ],
    ] as const) {
      ids.forEach((id, referenceIndex) => {
        if (!stepIds.has(id)) {
          issues.push({
            code: 'unknown-step',
            path: `${path}.${field}[${referenceIndex}]`,
            message: `Unknown step id "${id}".`,
          });
        }
      });
    }

    if (
      !CLINICAL_LESSON_VISUAL_IDS.includes(
        scene.visual.id as ClinicalLessonVisualId,
      )
    ) {
      issues.push({
        code: 'unknown-visual',
        path: `${path}.visual.id`,
        message: `Unsupported code-native visual "${scene.visual.id}".`,
      });
    }
    if (!scene.visual.alt.trim() || !scene.visual.caption.trim()) {
      issues.push({
        code: 'missing-visual-text',
        path: `${path}.visual`,
        message: 'Lesson visuals need both alt text and a caption.',
      });
    }
  });

  const referencedScenes = new Set<string>();
  for (const [track, sceneIds] of Object.entries(lesson.tracks)) {
    const path = `${exam.slug}.lesson.tracks.${track}`;
    if (!examTracks.has(track)) {
      issues.push({
        code: 'unknown-track',
        path,
        message: `Lesson track "${track}" does not exist on the exam.`,
      });
    }
    const seenOnTrack = new Set<string>();
    sceneIds.forEach((id, index) => {
      if (seenOnTrack.has(id)) {
        issues.push({
          code: 'duplicate-track-scene',
          path: `${path}[${index}]`,
          message: `Scene "${id}" appears more than once on track "${track}".`,
        });
      }
      seenOnTrack.add(id);
      referencedScenes.add(id);
      if (!sceneById.has(id)) {
        issues.push({
          code: 'unknown-scene',
          path: `${path}[${index}]`,
          message: `Unknown scene id "${id}".`,
        });
      }
    });
  }

  lesson.scenes.forEach((scene, index) => {
    if (!referencedScenes.has(scene.id)) {
      issues.push({
        code: 'orphan-scene',
        path: `${exam.slug}.lesson.scenes[${index}]`,
        message: `Scene "${scene.id}" is not referenced by a lesson track.`,
      });
    }
  });

  return issues;
}
