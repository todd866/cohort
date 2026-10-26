import registry from './simulation-item-map.json';
import type { SimulationFocus } from './simulation-focus';

export const SIMULATION_ITEM_MAP_VERSION = registry.version;
export type SimulationItemEvidence = (typeof registry.records)[number] & { topics?: readonly string[] };
const byStableId = new Map(registry.records.map(record => [record.stableId, record]));
const byContentHash = new Map(registry.records.map(record => [record.contentHash, record]));

/** Missing identities are unreviewed, even when a topic label looks relevant. */
export function simulationItemEvidence(identity: { stableId?: string | null; contentHash?: string }, focus: SimulationFocus | null | undefined): SimulationItemEvidence | null {
  if (!focus) return null;
  const record:SimulationItemEvidence|undefined = identity.stableId ? byStableId.get(identity.stableId) : identity.contentHash ? byContentHash.get(identity.contentHash) : undefined;
  const topic=record && focus.topics.find(topic=>(record.topics ?? [record.topic]).includes(topic));
  return record && topic ? {...record,topic} : null;
}

/** Keep the existing ladder's tier sequence and every candidate. Only prefer
 * reviewed items within a tier; later selection still applies all budgets. */
export function preferReviewedSimulationCards<T extends { complexity: number }>(items: readonly T[], identity: (item: T) => {stableId?: string | null}, focus: SimulationFocus | null | undefined): T[] {
  if (!focus) return [...items];
  const lanes = new Map<number, T[]>();
  for (const item of items) {
    const lane = lanes.get(item.complexity) ?? [];
    lane.push(item);
    lanes.set(item.complexity, lane);
  }
  const preparation = new Set(focus.preparationStableIds ?? []);
  const priority = (item:T) => {
    const key=identity(item);
    if (!simulationItemEvidence(key,focus)) return 0;
    return key.stableId && preparation.has(key.stableId) ? 2 : 1;
  };
  for (const lane of lanes.values()) lane.sort((a,b) => priority(b) - priority(a));
  const offsets = new Map<number, number>();
  return items.map(item => {
    const offset = offsets.get(item.complexity) ?? 0;
    offsets.set(item.complexity,offset+1);
    return lanes.get(item.complexity)![offset];
  });
}

/** Denominator is the final response, including unreviewed maintenance. A
 * shortfall is visible; it never authorises bypassing spacing or mastery. */
export function simulationQueueReceipt(items: readonly { stableId?: string | null; contentHash?: string }[], focus: SimulationFocus) {
  const matched = items.map(item=>simulationItemEvidence(item,focus));
  const reviewed = matched.filter((item): item is SimulationItemEvidence=>item !== null);
  const targetCount = Math.ceil(items.length * 2 / 3);
  return {
    mapVersion: SIMULATION_ITEM_MAP_VERSION,
    focusFingerprint: focus.fingerprint,
    total: items.length,
    reviewedRelevant: reviewed.length,
    direct: reviewed.filter(item => item.relation === 'direct').length,
    prerequisite: reviewed.filter(item => item.relation === 'prerequisite').length,
    unreviewed: items.length-reviewed.length,
    targetCount,
    targetMet: items.length > 0 && reviewed.length >= targetCount,
    majorityMet: items.length > 0 && reviewed.length > items.length / 2,
    proportion: items.length ? reviewed.length/items.length : 0,
    shortfall: Math.max(0,targetCount-reviewed.length),
    byTopic: Object.fromEntries(focus.topics.map(topic=>[topic,reviewed.filter(item=>item.topic===topic).length])),
  };
}
