/** Public-safe policy: learner identities and timetable allocations stay server-side. */
export interface SimulationFocus {
  fingerprint: string;
  deadline: string;
  topics: readonly string[];
  preparationStableIds?: readonly string[];
}

/** Exact reviewed labels, never substring matching against case histories. */
const LABELS: Readonly<Record<string, readonly string[]>> = {
  'pre-eclampsia': ['pre-eclampsia', 'preeclampsia', 'eclampsia', 'hypertensive deterioration', 'magnesium toxicity'],
  'postpartum-haemorrhage': ['postpartum haemorrhage', 'postpartum hemorrhage', 'uterine atony', 'retained placenta'],
  'maternal-collapse': ['maternal collapse', 'maternal cardiac arrest', 'maternal collapse and arrest'],
};
const normal = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
export function isSimulationTopic(topics: readonly string[], focus: SimulationFocus | null | undefined): boolean {
  if (!focus) return false;
  const labels = new Set(focus.topics.flatMap(topic => LABELS[topic] ?? []).map(normal));
  return topics.some(topic => labels.has(normal(topic)));
}

/** Stable 2:1 preference, preserving every eligible candidate and within-lane order. */
export function preferSimulationTopics<T>(items: readonly T[], topics: (item: T) => readonly string[], focus: SimulationFocus | null | undefined): T[] {
  if (!focus) return [...items];
  const focused: T[] = [], maintenance: T[] = [];
  for (const item of items) (isSimulationTopic(topics(item), focus) ? focused : maintenance).push(item);
  const ordered: T[] = [];
  let f = 0, m = 0;
  while (f < focused.length || m < maintenance.length) {
    for (let slot = 0; slot < 2 && f < focused.length; slot++) ordered.push(focused[f++]);
    if (m < maintenance.length) ordered.push(maintenance[m++]);
  }
  return ordered;
}

export function simulationCacheMatches(items: readonly {simulationFocusFingerprint?: string}[], focus: SimulationFocus | null | undefined): boolean {
  return items.every(item => item.simulationFocusFingerprint === focus?.fingerprint);
}
