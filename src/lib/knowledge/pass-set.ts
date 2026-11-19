/**
 * The pass set: the smallest set of facts that covers most of a rotation's exam.
 *
 * Owner, 2026-11-05: "the cards are variants. Nobody needs to learn all 8000.
 * Pick an estimate of how many it takes to pass the exam, prioritize them, feed
 * the rest as required."
 *
 * UNIT. A fact is a variant group (`variantGroupId`); a card with no group is a
 * fact of its own. Variants of a fact are its repetitions, not more to learn.
 *
 * EXAM MASS. Each official blueprint area (the exam-target registry's
 * `effectiveWeight`) carries a fixed share of the exam no matter how many cards
 * md3 has written for it. That share is spread over the area's facts in
 * proportion to their `examRelevancePct`. So a fact's mass is the share of the
 * exam it stands for, and a fact in a small heavy area is worth more than one
 * in a crowded light area. Facts are ranked by mass, then importance, then
 * whether the course has taught their topic (that ranking is the feed order).
 * Within each blueprint area the pass set takes the smallest prefix whose mass
 * reaches `PASS_SET_TARGET_MASS_SHARE` of that area, so it keeps the exam's
 * shape, plus every importance-3 safety-critical fact.
 *
 * MISSING SCORES. The exam-domain backfill covers under half of CAH and PWH. An
 * unscored fact borrows the domain and mean percentile of scored cards sharing
 * a specific topic; with no such neighbour it has no exam mass and sits outside
 * the pass set unless it is safety-critical. A rotation with no exam-target
 * data at all falls back to importance (+0.5 for a taught topic) as its mass.
 *
 * Pure and deterministic: no database, no clock, no calendar. Callers supply
 * the domain weights and taught-topic set (pass-set-inputs.ts).
 */

import { itemReadiness } from './topic-heat';

/** Share of the rotation's exam mass the pass set must cover. Owner decision. */
export const PASS_SET_TARGET_MASS_SHARE = 0.8;
/** Secured share of the pass set at which intake opens to the rest. Owner decision. */
export const PASS_SET_UNLOCK_SECURED_SHARE = 0.8;
/** Below this many unseen pass-set cards in scope, intake stops filtering. */
export const PASS_SET_MIN_UNSEEN_SUPPLY = 20;
/** New-material intake prefers the pass set. MD3_PASS_SET_INTAKE=0 turns it off. */
export function passSetIntakeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MD3_PASS_SET_INTAKE !== '0';
}

/** Predicted recall today a card needs to count as secured. */
export const SECURED_MIN_RECALL = 0.9;

/** A topic shared by more than this share of scored cards is too generic to vote. */
const GENERIC_TOPIC_SHARE = 0.1;

export interface PassSetCard {
  id: string;
  variantGroupId: string | null;
  /** Absent reads as 1 (the content map carries it only for exam rotations). */
  importance?: number | null;
  examRelevancePct?: number | null;
  examDomain?: string | null;
  topics: readonly string[];
}

export interface PassSetInputs {
  /** Exam domain (label or code, as stored on Card.examDomain) → exam weight. */
  domainWeights: ReadonlyMap<string, number>;
  /** Normalised topic slugs the course teaches in this rotation. */
  taughtTopics: ReadonlySet<string>;
  targetShare?: number;
}

export type FactRelevanceSource = 'measured' | 'imputed' | 'none';

export interface PassSetFact {
  key: string;
  representativeId: string;
  cardIds: string[];
  importance: number;
  taught: boolean;
  domain: string | null;
  relevance: number | null;
  source: FactRelevanceSource;
  /** Share of the exam this fact stands for (exam-target basis) or its fallback weight. */
  mass: number;
  /** 0-based position in the ranking. */
  rank: number;
}

export interface PassSet {
  basis: 'exam-target' | 'importance-taught';
  targetShare: number;
  /** Every fact, ranked. */
  facts: PassSetFact[];
  factKeys: ReadonlySet<string>;
  factKeyByCardId: ReadonlyMap<string, string>;
  rankByFactKey: ReadonlyMap<string, number>;
  size: number;
  totalFacts: number;
  totalMass: number;
  coveredMass: number;
  coverageShare: number;
  /** Facts in the mass prefix. */
  prefixSize: number;
  /** Importance-3 facts added beyond the prefix. */
  safetyAdded: number;
  measuredFacts: number;
  imputedFacts: number;
  unscoredFacts: number;
}

export function factKeyOf(card: { id: string; variantGroupId: string | null }): string {
  return card.variantGroupId ?? card.id;
}

function isTaught(topics: readonly string[], taught: ReadonlySet<string>): boolean {
  if (taught.size === 0) return false;
  return topics.some((topic) => taught.has(normaliseTopic(topic)));
}

function normaliseTopic(value: string): string {
  return value.trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface DraftFact {
  key: string;
  cards: PassSetCard[];
  topics: Set<string>;
  importance: number;
  representative: PassSetCard;
  relevance: number | null;
  domain: string | null;
  source: FactRelevanceSource;
}

function draftFacts(cards: readonly PassSetCard[]): DraftFact[] {
  const byKey = new Map<string, PassSetCard[]>();
  for (const card of cards) {
    const key = factKeyOf(card);
    const list = byKey.get(key);
    if (list) list.push(card); else byKey.set(key, [card]);
  }
  const facts: DraftFact[] = [];
  for (const [key, members] of byKey) {
    const sorted = [...members].sort((a, b) => (
      (b.examRelevancePct ?? -1) - (a.examRelevancePct ?? -1)
      || (b.importance ?? 1) - (a.importance ?? 1)
      || a.id.localeCompare(b.id)
    ));
    const representative = sorted[0];
    const measured = representative.examRelevancePct != null && representative.examDomain != null;
    const repPct = representative.examRelevancePct ?? null;
    const repDomain = representative.examDomain ?? null;
    facts.push({
      key,
      cards: members,
      topics: new Set(members.flatMap((card) => card.topics)),
      importance: Math.max(...members.map((card) => card.importance ?? 1)),
      representative,
      relevance: measured ? repPct : null,
      domain: measured ? repDomain : null,
      source: measured ? 'measured' : 'none',
    });
  }
  return facts;
}

/** Fill domain/relevance for unscored facts from scored facts on a shared, specific topic. */
function imputeRelevance(facts: DraftFact[]): void {
  const scored = facts.filter((fact) => fact.source === 'measured');
  if (scored.length === 0) return;
  const byTopic = new Map<string, DraftFact[]>();
  for (const fact of scored) {
    for (const topic of fact.topics) {
      const list = byTopic.get(topic);
      if (list) list.push(fact); else byTopic.set(topic, [fact]);
    }
  }
  const genericCeiling = Math.max(3, Math.floor(scored.length * GENERIC_TOPIC_SHARE));
  for (const fact of facts) {
    if (fact.source !== 'none') continue;
    const votes = new Map<string, { weight: number; pctWeighted: number }>();
    for (const topic of [...fact.topics].sort()) {
      const mates = byTopic.get(topic);
      if (!mates || mates.length > genericCeiling) continue;
      // Rarer topics are more specific, so each mate's vote is 1/|mates|.
      const w = 1 / mates.length;
      for (const mate of mates) {
        const entry = votes.get(mate.domain!) ?? { weight: 0, pctWeighted: 0 };
        entry.weight += w;
        entry.pctWeighted += w * (mate.relevance ?? 0);
        votes.set(mate.domain!, entry);
      }
    }
    let best: [string, { weight: number; pctWeighted: number }] | null = null;
    for (const entry of [...votes].sort(([a], [b]) => a.localeCompare(b))) {
      if (!best || entry[1].weight > best[1].weight) best = entry;
    }
    if (!best) continue;
    fact.domain = best[0];
    fact.relevance = best[1].pctWeighted / best[1].weight;
    fact.source = 'imputed';
  }
}

export function buildPassSet(cards: readonly PassSetCard[], inputs: PassSetInputs): PassSet {
  const targetShare = inputs.targetShare ?? PASS_SET_TARGET_MASS_SHARE;
  const drafts = draftFacts(cards);
  const measuredFacts = drafts.filter((fact) => fact.source === 'measured').length;
  const basis: PassSet['basis'] = inputs.domainWeights.size > 0 && measuredFacts > 0
    ? 'exam-target'
    : 'importance-taught';
  if (basis === 'exam-target') imputeRelevance(drafts);

  const relevanceByDomain = new Map<string, number>();
  for (const fact of drafts) {
    if (fact.domain == null || fact.relevance == null) continue;
    relevanceByDomain.set(fact.domain, (relevanceByDomain.get(fact.domain) ?? 0) + Math.max(0, fact.relevance));
  }

  const scoredFacts = drafts.map((fact) => {
    const taught = isTaught([...fact.topics], inputs.taughtTopics);
    let mass: number;
    if (basis === 'exam-target') {
      const weight = fact.domain != null ? inputs.domainWeights.get(fact.domain) ?? 0 : 0;
      const domainRelevance = fact.domain != null ? relevanceByDomain.get(fact.domain) ?? 0 : 0;
      mass = weight > 0 && domainRelevance > 0 && fact.relevance != null
        ? weight * Math.max(0, fact.relevance) / domainRelevance
        : 0;
    } else {
      // Importance leads; a taught topic is worth half an importance step.
      mass = Math.max(1, fact.importance) + (taught ? 0.5 : 0);
    }
    return { fact, taught, mass };
  });

  scoredFacts.sort((a, b) => (
    b.mass - a.mass
    || b.fact.importance - a.fact.importance
    || Number(b.taught) - Number(a.taught)
    || a.fact.key.localeCompare(b.fact.key)
  ));

  const totalMass = scoredFacts.reduce((sum, entry) => sum + entry.mass, 0);
  const factKeys = new Set<string>();
  let coveredMass = 0;
  // Float tolerance so a prefix that reaches the target exactly is not extended.
  const EPS = 1e-9;
  const takePrefix = (entries: typeof scoredFacts): void => {
    const pool = entries.reduce((sum, entry) => sum + entry.mass, 0);
    let covered = 0;
    for (const entry of entries) {
      if (pool <= 0 || covered >= pool * targetShare - EPS) break;
      factKeys.add(entry.fact.key);
      covered += entry.mass;
    }
    coveredMass += covered;
  };
  if (basis === 'exam-target') {
    // Per blueprint area, so the pass set has the exam's shape. A single global
    // prefix would buy whole small areas and skip a crowded one entirely (CAH
    // dermatology: 6% of the exam, 0.4% of a global prefix), because md3 having
    // written many cards for an area makes each look cheap.
    const byDomain = new Map<string, typeof scoredFacts>();
    for (const entry of scoredFacts) {
      if (entry.mass <= 0 || entry.fact.domain == null) continue;
      const list = byDomain.get(entry.fact.domain);
      if (list) list.push(entry); else byDomain.set(entry.fact.domain, [entry]);
    }
    for (const domain of [...byDomain.keys()].sort()) takePrefix(byDomain.get(domain)!);
  } else {
    takePrefix(scoredFacts);
  }
  const prefixSize = factKeys.size;
  for (const entry of scoredFacts) {
    if (entry.fact.importance >= 3 && !factKeys.has(entry.fact.key)) {
      factKeys.add(entry.fact.key);
      coveredMass += entry.mass;
    }
  }

  const facts: PassSetFact[] = scoredFacts.map((entry, rank) => ({
    key: entry.fact.key,
    representativeId: entry.fact.representative.id,
    cardIds: entry.fact.cards.map((card) => card.id),
    importance: entry.fact.importance,
    taught: entry.taught,
    domain: entry.fact.domain,
    relevance: entry.fact.relevance,
    source: entry.fact.source,
    mass: entry.mass,
    rank,
  }));
  const factKeyByCardId = new Map<string, string>();
  for (const fact of facts) for (const id of fact.cardIds) factKeyByCardId.set(id, fact.key);

  return {
    basis,
    targetShare,
    facts,
    factKeys,
    factKeyByCardId,
    rankByFactKey: new Map(facts.map((fact) => [fact.key, fact.rank])),
    size: factKeys.size,
    totalFacts: facts.length,
    totalMass,
    coveredMass,
    coverageShare: totalMass > 0 ? coveredMass / totalMass : 0,
    prefixSize,
    safetyAdded: factKeys.size - prefixSize,
    measuredFacts,
    imputedFacts: facts.filter((fact) => fact.source === 'imputed').length,
    unscoredFacts: basis === 'exam-target' ? facts.filter((fact) => fact.source === 'none').length : 0,
  };
}

export interface SecuredProgress {
  lastQuality: number | null;
  correctCount: number;
  stabilityDays: number | null;
  lastReview: Date | null;
  nextDueAt: Date | null;
  suppressed?: boolean | null;
}

/**
 * The CardProgress form of the must-know "secured" test. The full test asks
 * for the last two graded attempts correct on different days; CardProgress
 * keeps a correct count, not their dates, so this uses two correct answers, a
 * passing last grade, predicted recall today >= 0.9 (the profile heatmap's own
 * recall model) and not overdue. The audit script runs the full test.
 */
export function isProgressSecured(progress: SecuredProgress, now: Date): boolean {
  if (progress.suppressed) return false;
  if (progress.lastReview == null || progress.lastQuality == null) return false;
  if (progress.lastQuality < 3 || progress.correctCount < 2) return false;
  if (progress.nextDueAt != null && progress.nextDueAt.getTime() <= now.getTime()) return false;
  const ageDays = (now.getTime() - progress.lastReview.getTime()) / 86_400_000;
  const recall = itemReadiness({
    ageDays,
    stabilityDays: progress.stabilityDays ?? Number.NaN,
    lastQuality: progress.lastQuality,
  });
  return recall >= SECURED_MIN_RECALL;
}

/** Pass-set facts with at least one secured card. */
export function countSecuredFacts(passSet: PassSet, securedCardIds: Iterable<string>): number {
  const secured = new Set<string>();
  for (const id of securedCardIds) {
    const key = passSet.factKeyByCardId.get(id);
    if (key && passSet.factKeys.has(key)) secured.add(key);
  }
  return secured.size;
}

export type PassSetIntakeDecision =
  | 'disabled'
  | 'no-pass-set'
  | 'explicit-scope'
  | 'supply-exhausted'
  | 'unlocked'
  | 'pass-set-first';

export interface PassSetIntakeInput {
  enabled: boolean;
  passSet: PassSet | null;
  /** The session's home rotation; cross-source cards are never filtered. */
  rotation: string;
  unseenCards: ReadonlyArray<{ id: string; rotation: string; variantGroupId: string | null; topics: readonly string[] }>;
  /** Variant groups the learner has already touched: their unseen siblings are repetitions. */
  startedVariantGroups: { has(key: string): boolean };
  /** Focus, week, topic/cluster, session-prep or media scope chosen by the learner. */
  explicitScope: boolean;
  /** Topics the learner asked for more of ("more like this"). */
  requestedTopics?: ReadonlySet<string>;
  /** Secured pass-set facts; null when unknown (counts as not unlocked). */
  securedFacts: number | null;
}

export interface PassSetIntakeResult {
  decision: PassSetIntakeDecision;
  deferredCardIds: Set<string>;
  unseenPassSetSupply: number;
  securedShare: number | null;
}

/**
 * Which unseen cards new-material intake should hold back. Only NEW FACTS
 * outside the pass set are deferred; reviews, repetitions of a started fact,
 * scaffolds and explicitly requested material are untouched.
 */
export function resolvePassSetIntake(input: PassSetIntakeInput): PassSetIntakeResult {
  const none = (decision: PassSetIntakeDecision, supply = 0, securedShare: number | null = null): PassSetIntakeResult => ({
    decision, deferredCardIds: new Set(), unseenPassSetSupply: supply, securedShare,
  });
  if (!input.enabled) return none('disabled');
  const passSet = input.passSet;
  if (!passSet || passSet.size === 0) return none('no-pass-set');
  if (input.explicitScope) return none('explicit-scope');

  const inPassSet = (card: { id: string; variantGroupId: string | null }): boolean => {
    const key = passSet.factKeyByCardId.get(card.id) ?? factKeyOf(card);
    return passSet.factKeys.has(key);
  };
  const home = input.unseenCards.filter((card) => card.rotation === input.rotation);
  const supply = home.filter(inPassSet).length;
  const securedShare = input.securedFacts == null ? null : input.securedFacts / passSet.size;
  if (supply < PASS_SET_MIN_UNSEEN_SUPPLY) return none('supply-exhausted', supply, securedShare);
  if (securedShare != null && securedShare >= PASS_SET_UNLOCK_SECURED_SHARE) {
    return none('unlocked', supply, securedShare);
  }

  const requested = input.requestedTopics;
  const deferredCardIds = new Set<string>();
  for (const card of home) {
    if (inPassSet(card)) continue;
    if (card.variantGroupId && input.startedVariantGroups.has(card.variantGroupId)) continue;
    if (requested && requested.size > 0 && card.topics.some((topic) => requested.has(topic))) continue;
    deferredCardIds.add(card.id);
  }
  return { decision: 'pass-set-first', deferredCardIds, unseenPassSetSupply: supply, securedShare };
}

/**
 * Stable partition for a lane with no ranking stage (the instant lane's
 * shuffle): pass-set facts first, the rest after, each in its incoming order.
 */
export function preferPassSetFacts<T extends { id: string; variantGroupId: string | null }>(
  items: readonly T[],
  passSet: PassSet | null,
): T[] {
  if (!passSet || passSet.size === 0) return [...items];
  const inSet: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    const key = passSet.factKeyByCardId.get(item.id) ?? factKeyOf(item);
    (passSet.factKeys.has(key) ? inSet : rest).push(item);
  }
  return [...inSet, ...rest];
}
