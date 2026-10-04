/**
 * The task axis: what an item asks the learner to do.
 *
 *   knowledge  — recall a fact, mechanism, number or association
 *   diagnosis  — read a finding, name the condition, or choose the test
 *   management — decide what to do: treat, refer, advise, exclude
 *
 * `questionType` grew about 40 spellings and thousands of bank items have
 * none, so counts by raw label are wrong. This is the one mapper the supply
 * audit, the served-mix audit and the practice-paper ceilings share, so they
 * can never disagree about what "knowledge" means. Design:
 * docs/BACKLOG.md, "Knowledge and management mix" (2026-10-02).
 */

export type TaskAxis = 'knowledge' | 'diagnosis' | 'management';

const AXIS_BY_TYPE: Record<string, TaskAxis> = {
  knowledge: 'knowledge',
  recall: 'knowledge',
  mechanism: 'knowledge',
  'basic-science': 'knowledge',
  'clinical-features': 'knowledge',
  'clinical-feature': 'knowledge',
  definition: 'knowledge',
  classification: 'knowledge',
  'risk-factors': 'knowledge',
  'risk-factor': 'knowledge',
  risk: 'knowledge',
  prognosis: 'knowledge',
  pathophysiology: 'knowledge',
  physiology: 'knowledge',
  epidemiology: 'knowledge',
  pharmacology: 'knowledge',
  'adverse-effect': 'knowledge',
  comparison: 'knowledge',
  calculation: 'knowledge',

  diagnosis: 'diagnosis',
  interpretation: 'diagnosis',
  'image-interpretation': 'diagnosis',
  investigation: 'diagnosis',
  assessment: 'diagnosis',

  management: 'management',
  'next-step': 'management',
  technique: 'management',
  prevention: 'management',
  indication: 'management',
  monitoring: 'management',
  ethics: 'management',
};

function normalise(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '-');
}

/** The axis a questionType label decides on its own, or null if it is vague or missing. */
export function taskAxisForQuestionType(questionType: string | null | undefined): TaskAxis | null {
  if (!questionType) return null;
  return AXIS_BY_TYPE[normalise(questionType)] ?? null;
}

const MANAGEMENT_LEAD_IN =
  /\b(most appropriate (next step|management|treatment|plan|initial)|best (initial |next )?(management|treatment|step|plan)|what should (the [a-z]+ |you |she |he |they )?do|which (plan|treatment|drug|medication|discharge plan)|correct advice|when can (s?he|they|the child) (return|go back))\b/i;
const DIAGNOSIS_LEAD_IN =
  /\b(most likely (diagnosis|cause)|which (investigation|test|study)|best (describes|explains) (the|this) (finding|image|appearance)|what does (the|this) [a-z]+ show|interpret)\b/i;

function leadIn(stem: string): string {
  const parts = stem.trim().split(/\n\s*\n/);
  return parts[parts.length - 1] ?? stem;
}

/**
 * The axis of one item. A decisive questionType wins; otherwise the stem's
 * lead-in decides, and a lead-in that names no action or diagnosis is
 * knowledge. A cloze card is always knowledge.
 */
export function taskAxisFor(item: { kind?: 'card' | 'question'; questionType?: string | null; stem?: string | null }): TaskAxis {
  if (item.kind === 'card') return 'knowledge';
  const fromType = taskAxisForQuestionType(item.questionType);
  if (fromType) return fromType;
  const lead = leadIn(item.stem ?? '');
  if (MANAGEMENT_LEAD_IN.test(lead)) return 'management';
  if (DIAGNOSIS_LEAD_IN.test(lead)) return 'diagnosis';
  return 'knowledge';
}
