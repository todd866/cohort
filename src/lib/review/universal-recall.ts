/** Source-reviewed, stable objectives; IDs are independent of wording/rotation. */
export const UNIVERSAL_RECALL_SOURCE = 'https://www.anzcor.org/home/adult-advanced-life-support/guideline-11-2-protocols-for-adult-advanced-life-support';
export const UNIVERSAL_RECALL_OBJECTIVES = [
  { id: 'universal-recall:arrest-hs:v1', title: '4 H’s', prompt: 'List all four H categories of reversible cardiac arrest causes.',
    components: [
      { id: 'oxygen', label: 'Hypoxaemia' },
      { id: 'volume', label: 'Hypovolaemia' },
      { id: 'metabolic', label: 'Hyper/hypokalaemia and metabolic disorders' },
      { id: 'temperature', label: 'Hypo/hyperthermia' },
    ] },
  { id: 'universal-recall:arrest-ts:v1', title: '4 T’s', prompt: 'List all four T categories of reversible cardiac arrest causes.',
    components: [
      { id: 'tension', label: 'Tension pneumothorax' },
      { id: 'tamponade', label: 'Tamponade' },
      { id: 'toxins', label: 'Toxins, poisons or drugs' },
      { id: 'thrombosis', label: 'Pulmonary or coronary thrombosis' },
    ] },
] as const;
export type UniversalRecallObjective = typeof UNIVERSAL_RECALL_OBJECTIVES[number];
export function universalRecallObjective(id: string | undefined) {
  return UNIVERSAL_RECALL_OBJECTIVES.find(objective => objective.id === id);
}
export type UniversalRecallEvidence = {
  version: 1;
  response: string;
  assisted: boolean;
  omittedComponentIds: string[];
  assessment: 'learner-reported';
  /** Same-session correction is teaching evidence, not another retrieval success. */
  correctionResponse?: string;
};
/** Evidence is self-report, not verified understanding or objective mastery. */
export function parseUniversalRecallEvidence(id: string, value: unknown): UniversalRecallEvidence | null {
  const objective = universalRecallObjective(id);
  if (!objective || !value || typeof value !== 'object') return null;
  const data = value as Partial<UniversalRecallEvidence>;
  if (data.version !== 1 || data.assessment !== 'learner-reported'
    || typeof data.response !== 'string' || data.response.length > 2000
    || (data.correctionResponse !== undefined && (typeof data.correctionResponse !== 'string' || data.correctionResponse.length > 2000))
    || typeof data.assisted !== 'boolean' || !Array.isArray(data.omittedComponentIds)
    || data.omittedComponentIds.length > 4
    || data.omittedComponentIds.some(id => !objective.components.some(component => component.id === id))) return null;
  // A blank response cannot count as a successful unaided retrieval.
  return { ...(data.correctionResponse !== undefined ? { correctionResponse: data.correctionResponse } : {}), version: 1, response: data.response.trim(), assisted: data.assisted,
    assessment: 'learner-reported', omittedComponentIds: data.response.trim()
      ? [...new Set(data.omittedComponentIds)] : objective.components.map(component => component.id) };
}
