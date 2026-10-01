import type { CohortExperience } from './experience-prior';

export const COHORT_EXPERIENCE_IDS = [
  'just-got-here',
  'high-school',
  'undergrad',
  'premed',
  'medical-student',
] as const satisfies readonly CohortExperience[];

export const COHORT_DEFAULT_DEMAND_TOPICS = [
  { id: 'diabetes', label: 'diabetes' },
  { id: 'heart', label: 'heart' },
  { id: 'blood-pressure', label: 'blood pressure' },
  { id: 'kidneys', label: 'kidneys' },
  { id: 'stroke', label: 'stroke' },
  { id: 'vaccines', label: 'vaccines' },
] as const;

export type CohortDemandTopic = (typeof COHORT_DEFAULT_DEMAND_TOPICS)[number]['id'];

export const COHORT_DEMAND_TOPIC_IDS: readonly CohortDemandTopic[] =
  COHORT_DEFAULT_DEMAND_TOPICS.map((topic) => topic.id);

export const COHORT_PUBLIC_SESSION_TYPES = [
  'cohort-baseline-v1',
  'cohort-daily-v1',
] as const;

export interface CohortDemand {
  topics: CohortDemandTopic[];
  askedAt: string;
  dismissed?: boolean;
}

export interface CohortFeedProfile {
  hookCompletedAt: string | null;
  explicit: {
    experience?: CohortExperience;
    experienceSetAt?: string;
    demand?: CohortDemand;
  };
}

const EXPERIENCE_SET = new Set<string>(COHORT_EXPERIENCE_IDS);
const DEMAND_TOPIC_SET = new Set<string>(COHORT_DEMAND_TOPIC_IDS);
const LEGACY_DEMAND_ASKED_AT = '1970-01-01T00:00:00.000Z';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function asExperience(value: unknown): CohortExperience | undefined {
  return typeof value === 'string' && EXPERIENCE_SET.has(value)
    ? (value as CohortExperience)
    : undefined;
}

export function isCohortDemandTopic(value: unknown): value is CohortDemandTopic {
  return typeof value === 'string' && DEMAND_TOPIC_SET.has(value);
}

export function canonicalCohortDemandTopics(value: unknown): CohortDemandTopic[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(value.filter(isCohortDemandTopic));
  return COHORT_DEMAND_TOPIC_IDS.filter((topic) => selected.has(topic));
}

function parseDemand(value: unknown): CohortDemand | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const hasLegacyDemandSignal = Array.isArray(record.topics)
    || typeof record.text === 'string'
    || record.dismissed === true;
  if (!hasLegacyDemandSignal) return undefined;
  const topics = canonicalCohortDemandTopics(record.topics);
  // Free text, unknown topics, and an empty legacy selection are quarantined
  // data, not evidence that the learner answered the structured prompt. Only
  // a surviving allowlisted choice or an explicit dismissal closes the gate.
  if (topics.length === 0 && record.dismissed !== true) return undefined;
  const askedAt = asIsoTimestamp(record.askedAt) ?? LEGACY_DEMAND_ASKED_AT;
  return {
    topics,
    askedAt,
    ...(record.dismissed === true ? { dismissed: true } : {}),
  };
}

export function parseCohortFeedProfile(raw: unknown): CohortFeedProfile {
  const record = asRecord(raw);
  const sourceExplicit = asRecord(record?.explicit) ?? {};
  const explicit: CohortFeedProfile['explicit'] = {};
  const experience = asExperience(sourceExplicit.experience);
  const experienceSetAt = asIsoTimestamp(sourceExplicit.experienceSetAt);
  const demand = parseDemand(sourceExplicit.demand);
  if (experience) explicit.experience = experience;
  if (experienceSetAt) explicit.experienceSetAt = experienceSetAt;
  if (demand) explicit.demand = demand;
  return {
    hookCompletedAt: asIsoTimestamp(record?.hookCompletedAt) ?? null,
    explicit,
  };
}

export function mergeCohortFeedProfile(
  current: CohortFeedProfile,
  patch: {
    hookCompletedAt?: string;
    experience?: CohortExperience;
    demand?: CohortDemand;
  },
  nowIso: string,
): CohortFeedProfile {
  const explicit = { ...current.explicit };
  if (patch.experience) {
    explicit.experience = patch.experience;
    explicit.experienceSetAt = nowIso;
  }
  if (patch.demand) explicit.demand = patch.demand;
  return {
    hookCompletedAt: patch.hookCompletedAt ?? current.hookCompletedAt,
    explicit,
  };
}

export function hasSameCohortDemandSelection(
  current: CohortDemand | undefined,
  next: Pick<CohortDemand, 'topics' | 'dismissed'>,
): boolean {
  if (!current || Boolean(current.dismissed) !== Boolean(next.dismissed)) return false;
  return current.topics.length === next.topics.length
    && current.topics.every((topic, index) => topic === next.topics[index]);
}

export function isCohortDeep(args: {
  publicGradedCount: number;
  firstPublicGradedAt: Date | null;
  now: Date;
}): boolean {
  if (args.publicGradedCount >= 8) return true;
  if (args.publicGradedCount < 1 || !args.firstPublicGradedAt) return false;
  return args.firstPublicGradedAt.toISOString().slice(0, 10)
    < args.now.toISOString().slice(0, 10);
}

function legacyDemandQuarantine(existingExplicit: Record<string, unknown>): Record<string, unknown> | null {
  const demand = asRecord(existingExplicit.demand);
  if (!demand) return null;
  const text = typeof demand.text === 'string' && demand.text.length > 0
    ? demand.text
    : null;
  const unknownTopics = Array.isArray(demand.topics)
    ? demand.topics.filter((topic): topic is string =>
      typeof topic === 'string' && !isCohortDemandTopic(topic))
    : [];
  const invalidAskedAt = typeof demand.askedAt === 'string' && !asIsoTimestamp(demand.askedAt)
    ? demand.askedAt
    : null;
  if (!text && unknownTopics.length === 0 && !invalidAskedAt) return null;
  return {
    trustState: 'quarantined',
    source: 'explicit.demand',
    automatedProcessing: 'blocked',
    ...(text ? { text } : {}),
    ...(unknownTopics.length > 0 ? { topics: unknownTopics } : {}),
    ...(invalidAskedAt ? { askedAt: invalidAskedAt } : {}),
  };
}

/**
 * Preserve non-Cohort profile fields while moving any legacy free prose into a
 * branch that public responses and automated audits never expose.
 */
export function toStoredFeedProfile(
  existing: unknown,
  cohort: CohortFeedProfile,
): Record<string, unknown> {
  const record = asRecord(existing) ?? {};
  const existingExplicit = asRecord(record.explicit) ?? {};
  const existingQuarantined = asRecord(record.quarantined) ?? {};
  const existingCohortQuarantine = asRecord(existingQuarantined.cohortDemandV1);
  const newCohortQuarantine = legacyDemandQuarantine(existingExplicit);

  const nonCohortExplicit = { ...existingExplicit };
  Reflect.deleteProperty(nonCohortExplicit, 'experience');
  Reflect.deleteProperty(nonCohortExplicit, 'experienceSetAt');
  Reflect.deleteProperty(nonCohortExplicit, 'demand');

  const quarantined = existingCohortQuarantine || newCohortQuarantine
    ? {
        ...existingQuarantined,
        cohortDemandV1: {
          ...(existingCohortQuarantine ?? {}),
          ...(newCohortQuarantine ?? {}),
        },
      }
    : existingQuarantined;

  return {
    ...record,
    hookCompletedAt: cohort.hookCompletedAt,
    explicit: {
      ...nonCohortExplicit,
      ...cohort.explicit,
    },
    ...(Object.keys(quarantined).length > 0 ? { quarantined } : {}),
  };
}
