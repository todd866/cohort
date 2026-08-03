import type { PublicUsmleProvenanceV1 } from '@/lib/usmle/public-corpus';

export type RotationId =
  | 'critical-care' | 'paam' | 'cah' | 'pwh'
  // Personal licensed rotations
  | 'anking'
  // USMLE Step 1
  | 'usmle-step1' | 'usmle-biochem' | 'usmle-immunology' | 'usmle-micro'
  | 'usmle-pathology' | 'usmle-pharm' | 'usmle-cardio' | 'usmle-endo'
  | 'usmle-gi' | 'usmle-heme-onc' | 'usmle-msk' | 'usmle-neuro'
  | 'usmle-psych' | 'usmle-renal' | 'usmle-repro' | 'usmle-resp'
  // Cross-rotation core skills
  | 'year3-common';

export type QuestionDifficulty = 'easy' | 'medium' | 'hard';

export type QuestionType =
  | 'diagnosis'
  | 'next-step'
  | 'mechanism'
  | 'calculation'
  | 'management'
  | 'interpretation';

export interface CuratedQuestionOption {
  label: string;
  text: string;
  isCorrect: boolean;
  /** What misunderstanding leads to selecting this distractor */
  misconception?: string;
  /** Per-option explanation for post-answer feedback */
  explanation?: string;
}

/**
 * Cross-links connect MCQs to learning content so users can "tap to learn more"
 */
export interface QuestionCrosslinks {
  /** Primary deep-dive page (e.g., "/deep-dive/cards/bank-critical-care-sepsis-v1") */
  primary?: string;
  /** Related content pages */
  related?: string[];
  /** Tappable concept tags that link to wiki/content */
  concepts?: string[];
}

/**
 * Annotations provide inline context for values in the stem
 * Key is the text to annotate, value is the explanation
 * e.g., {"lactate 5.1": "↑↑ severe (normal <2)", "BP 86/50": "↓ hypotensive"}
 */
export type QuestionAnnotations = Record<string, string>;

/**
 * Abbreviations define terms used in the question
 * e.g., {"STEMI": "ST-Elevation Myocardial Infarction", "PCI": "Percutaneous Coronary Intervention"}
 */
export type QuestionAbbreviations = Record<string, string>;

/**
 * Pre-defined combination of option indices to show together.
 * Each combination must include index 0 (correct answer) and have exactly 5 indices.
 */
export type OptionCombination = [number, number, number, number, number];

export interface CuratedQuestion {
  id: string;
  sourceFile?: string;
  rotation: RotationId;
  /** Hierarchical memberships used for cross-listed exam/public surfaces. */
  moduleNodes?: string[];
  week?: number;
  topics: string[];
  questionType: QuestionType;
  difficulty: QuestionDifficulty;
  stem: string;
  options: CuratedQuestionOption[];
  context: string;
  imageUrl?: string | null;
  /** Always-visible teaching caption for the image. Required whenever
   *  imageUrl is set (the harness floor — see feedback_image_quality_floor
   *  + feedback_pedagogy_harness). Populated from the JSON's imageCaption
   *  field; the systemic flag detector tracks unfilled cases. */
  imageCaption?: string | null;
  variantGroupId?: string | null;
  /** 'contrast-set' = a member of a shared-choice-pool family; see contrast-set.ts. */
  variantType?: 'anchor' | 'shuffled' | 'rephrased' | 'different-scenario' | 'near-duplicate' | 'contrast-set' | null;

  // Citation for audit trail — format: source-slug#section
  // e.g. "atls#haemorrhagic-shock" or "surviving-sepsis-2021#vasopressors"
  cite?: string | null;

  /**
   * Versioned public-USMLE provenance. The seeder persists this under
   * Question.citations.publicUsmle; absence means the item is not public.
   */
  publicUsmle?: PublicUsmleProvenanceV1 | null;

  // Cross-referencing for "learn more" functionality
  crosslinks?: QuestionCrosslinks | null;
  annotations?: QuestionAnnotations | null;
  abbreviations?: QuestionAbbreviations | null;

  // Option pool expansion (anti-gaming)
  /** Pre-defined combinations of option indices. Each attempt cycles through these. */
  combinations?: OptionCombination[] | null;
  /** Paraphrased versions of the correct answer text. Cycled per attempt. */
  correctVariants?: string[] | null;
}
