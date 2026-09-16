/**
 * Card Pedagogy Types
 *
 * Pedagogical metadata for flashcards — why this fact matters,
 * what students commonly get wrong, and where it came from.
 *
 * Parallels Question.pedagogy but suited for cloze/recall cards.
 */

export interface CardPedagogy {
  /** Why this fact matters clinically */
  clinicalReasoning: string;
  /** What students commonly get wrong about this */
  commonMisconceptions: string[];
  /** Which source this content came from */
  sourceJustification: string;
  /** Cognitive skill: recall | recognition | application | synthesis */
  cognitiveSkill: 'recall' | 'recognition' | 'application' | 'synthesis';
  /** Knowledge domains this card covers */
  domains: string[];
  /** Who generated this pedagogy record */
  generatedBy: 'seed' | 'agent' | 'admin';
  /** ISO timestamp */
  generatedAt: string;
}

/** Map sourceComponent → cognitive skill */
export function inferCognitiveSkill(
  sourceComponent: string
): CardPedagogy['cognitiveSkill'] {
  switch (sourceComponent) {
    case 'Mnemonic':
      return 'recall';
    case 'KeyPoint':
      return 'recognition';
    case 'MCQ':
      return 'application';
    case 'ClinicalPearl':
      return 'application';
    case 'Danger':
      return 'recognition';
    default:
      return 'recall';
  }
}

/** Derive clinical reasoning from card context and topics */
export function deriveClinicalReasoning(
  context: string | null,
  topics: string[],
  sourceComponent: string
): string {
  if (context && context.length > 10) {
    // Extract first sentence of context as the "why"
    const firstSentence = context.split(/[.!?]/)[0]?.trim();
    if (firstSentence && firstSentence.length > 10) {
      return firstSentence;
    }
  }

  // Fallback: construct from topics and component type
  const topicStr = topics.slice(0, 3).join(', ');
  switch (sourceComponent) {
    case 'Danger':
      return `Critical safety point in ${topicStr} — must be recalled under pressure`;
    case 'ClinicalPearl':
      return `Clinical pearl for ${topicStr} — distinguishes experienced from novice practice`;
    case 'MCQ':
      return `Applied knowledge in ${topicStr} — tests clinical decision-making`;
    default:
      return `Foundational knowledge in ${topicStr}`;
  }
}

/** Infer common misconceptions from card type and topics */
export function inferMisconceptions(
  topics: string[],
  cardType: string,
  sourceComponent: string
): string[] {
  const misconceptions: string[] = [];

  if (sourceComponent === 'Danger') {
    misconceptions.push('Underestimating urgency — this is a safety-critical point that must not be missed');
  }

  if (cardType === 'mcq') {
    misconceptions.push('Selecting a plausible distractor without reading all options carefully');
  }

  if (topics.some(t => t.includes('drug') || t.includes('pharm'))) {
    misconceptions.push('Confusing similar drug names or mechanisms of action');
  }

  if (topics.some(t => t.includes('anatomy'))) {
    misconceptions.push('Mixing up anatomical relationships or spatial orientation');
  }

  if (misconceptions.length === 0) {
    misconceptions.push('Incomplete recall — partial knowledge leading to wrong answers under exam conditions');
  }

  return misconceptions;
}

/** Extract source justification from sourceFile path */
export function extractSourceJustification(
  sourceFile: string | null,
  rotation: string,
  week: number
): string {
  if (sourceFile) {
    return `Extracted from ${rotation}/week${week}/${sourceFile}.mdx`;
  }
  return `Seeded from ${rotation} week ${week} content`;
}
