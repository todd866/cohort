import {
  canonicalCohortDemandTopics,
  COHORT_DEMAND_TOPIC_IDS,
  COHORT_EXPERIENCE_IDS,
  isCohortDemandTopic,
  type CohortDemandTopic,
} from './feed-profile';
import type { CohortExperience } from './experience-prior';

export interface CohortDemandPatch {
  topics: CohortDemandTopic[];
  dismissed?: boolean;
}

export interface CohortProfilePatch {
  hookCompleted?: boolean;
  experience?: CohortExperience;
  demand?: CohortDemandPatch;
}

const TOP_LEVEL_KEYS = new Set(['hookCompleted', 'experience', 'demand']);
const DEMAND_KEYS = new Set(['topics', 'dismissed', 'text', 'askedAt']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 40) return false;
  return Number.isFinite(new Date(value).getTime());
}

function parseDemandPatch(value: unknown): CohortDemandPatch | null {
  const record = asRecord(value);
  if (!record || !hasOnlyKeys(record, DEMAND_KEYS)) return null;

  // Legacy clients send `text: null`. Any string, including a blank one, is no
  // longer accepted at this public boundary.
  if (record.text !== undefined && record.text !== null) return null;
  if (record.askedAt !== undefined && !isIsoTimestamp(record.askedAt)) return null;
  if (!Array.isArray(record.topics)
    || record.topics.length > COHORT_DEMAND_TOPIC_IDS.length
    || record.topics.some((topic) => !isCohortDemandTopic(topic))) {
    return null;
  }
  const topics = canonicalCohortDemandTopics(record.topics);
  if (topics.length !== record.topics.length) return null;

  if (record.dismissed === true) {
    return topics.length === 0 ? { topics, dismissed: true } : null;
  }
  if (record.dismissed !== undefined && record.dismissed !== false) return null;
  return topics.length > 0 ? { topics } : null;
}

export function parseCohortProfilePatch(raw: unknown): CohortProfilePatch | null {
  const record = asRecord(raw);
  if (!record || !hasOnlyKeys(record, TOP_LEVEL_KEYS)) return null;
  const patch: CohortProfilePatch = {};

  if (record.hookCompleted !== undefined) {
    if (record.hookCompleted !== true) return null;
    patch.hookCompleted = true;
  }

  if (record.experience !== undefined) {
    if (typeof record.experience !== 'string'
      || !(COHORT_EXPERIENCE_IDS as readonly string[]).includes(record.experience)) {
      return null;
    }
    patch.experience = record.experience as CohortExperience;
  }

  if (record.demand !== undefined) {
    const demand = parseDemandPatch(record.demand);
    if (!demand) return null;
    patch.demand = demand;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
