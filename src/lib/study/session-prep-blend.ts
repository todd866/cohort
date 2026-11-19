/** Pure owner session-prep matching and blending primitives.
 *
 * This module has no database, calendar, learner identity, or history reads.
 * Callers provide the already-authorised upcoming sessions and item evidence;
 * the returned plan can be used by ordinary, instant, and cached feed lanes.
 */

export type PrepContentKind = 'card' | 'question';
export type PrepItemState = 'secured' | 'weak' | 'unseen' | 'blocked';
export type PrepMatchMethod = 'review-intent' | 'topic' | 'canvas' | 'taught-topic' | 'c1-scaffold';

export interface PrepReviewIntent {
  rotation?: string;
  week?: number;
  topics?: readonly string[];
  cluster?: string;
  deckId?: string;
}

export interface PrepSessionContext {
  title: string;
  reviewIntent?: PrepReviewIntent;
  canvasText?: string;
  taughtTopics?: readonly string[];
  prepTopics?: readonly string[];
}

export interface PrepContentItem {
  id: string;
  kind: PrepContentKind;
  title?: string;
  text?: string;
  topics?: readonly string[];
  rotation?: string;
  week?: number;
  cluster?: string;
  c1Of?: string;
  mustKnow?: boolean;
  blocked?: boolean;
}

export interface PrepItemMatch {
  item: PrepContentItem;
  method: PrepMatchMethod;
  evidence: string[];
}

export interface PrepPlanItem {
  cluster?: string;
  itemId: string;
  kind: PrepContentKind;
  state: PrepItemState;
  observedSeconds?: number | null;
  c1Of?: string;
  mustKnow?: boolean;
}

export interface PrepBlendSessionInput {
  sessionId: string;
  startAt: string | Date;
  items: readonly PrepPlanItem[];
  /** Optional when the caller has already applied the readiness calculation. */
  leadDays?: number;
}

export interface PrepBlendSessionPlan {
  cardClusters?: Record<string, string>;
  sessionId: string;
  startAt: string;
  leadDays: number;
  share: number;
  itemIds: string[];
  weakItemIds: string[];
  unseenItemIds: string[];
}

export interface PrepBlendPlan {
  cardClusters?: Record<string, string>;
  sessions: PrepBlendSessionPlan[];
  /** Flattened allocation shape consumed by feed lanes. */
  share: number;
  weakItemIds: string[];
  unseenItemIds: string[];
  /** Unique gaps in session order; shared gaps are counted once. */
  itemIds: string[];
  fingerprint: string;
}

const DAY = 86_400_000;
const MIN_LEAD_DAYS = 3;
const FLOOR_SHARE = 0.15;
const PEAK_SHARE = 0.5;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'session', 'class', 'crs', 'tutorial', 'nicu', 'baby', 'neonatal', 'review', 'guide', 'assigned', 'presenter', 'preparation', 'status', 'unverified', 'teaching', 'compulsory', 'mandatory', 'clinical', 'patient', 'patients', 'management', 'diagnosis', 'treatment', 'assessment', 'objectives', 'learning', 'understand', 'describe', 'explain', 'what', 'when', 'which', 'how', 'why', 'are', 'was', 'should', 'can']);
const norm = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (value: string) => new Set(norm(value).split(/\s+/).filter((token) => token.length > 2 && !STOP.has(token)));

function sameTopic(left: string, right: string): boolean {
  return norm(left) === norm(right);
}

function intentMatches(item: PrepContentItem, intent: PrepReviewIntent): boolean {
  if (intent.deckId && item.id === intent.deckId) return true;
  if (intent.rotation && item.rotation !== intent.rotation) return false;
  if (intent.week !== undefined && item.week !== intent.week) return false;
  if (intent.cluster) return item.cluster != null && norm(intent.cluster) === norm(item.cluster);
  if (intent.topics?.length) return Boolean(item.topics?.some((topic) => intent.topics!.some((wanted) => sameTopic(topic, wanted))));
  return Boolean(intent.rotation || intent.week !== undefined);
}

/** Match explicit intent first, then textual evidence for sessions without it. */
export function matchSessionContent(session: PrepSessionContext, items: readonly PrepContentItem[]): PrepItemMatch[] {
  const matches = new Map<string, PrepItemMatch>();
  const add = (item: PrepContentItem, method: PrepMatchMethod, evidence: string) => {
    const key = `${item.kind}:${item.id}`;
    const previous = matches.get(key);
    matches.set(key, {
      item,
      method: previous?.method ?? method,
      evidence: [...new Set([...(previous?.evidence ?? []), evidence])],
    });
  };
  if (session.reviewIntent) {
    for (const item of items) if (intentMatches(item, session.reviewIntent)) add(item, 'review-intent', 'reviewIntent scope');
  } else {
    // Each phrase (the title, or one prep topic) must match as a whole: every
    // meaningful word present. One shared word let "bleeding in pregnancy"
    // admit GI bleeding and pregnancy dating (6,343 items, 13 Nov 2026).
    // A parenthetical in a calendar title is logistics ("finish TBC"), not topic.
    const phrases = [session.title.replace(/\([^)]*\)/g, ' '), ...(session.prepTopics ?? [])]
      .map((phrase) => [...tokens(phrase)])
      .filter((phrase) => phrase.length > 0);
    const canvas = session.canvasText ?? '';
    for (const item of items) {
      const itemTokens = tokens([item.title, item.text, ...(item.topics ?? [])].filter(Boolean).join(' '));
      const matched = phrases.filter((phrase) => phrase.every((term) => itemTokens.has(term)));
      if (matched.length) add(item, 'topic', `session title/prep topic: ${[...new Set(matched.map((phrase) => phrase.join(' ')))].join(', ')}`);
      const canvasTopics = (item.topics ?? []).filter((topic) => tokens(topic).size > 0 && norm(canvas).includes(norm(topic)));
      if (canvas && canvasTopics.length) add(item, 'canvas', `Canvas topic: ${canvasTopics.join(', ')}`);
      const taught = (session.taughtTopics ?? []).filter((topic) => tokens(topic).size > 0 && (item.topics ?? []).some((itemTopic) => sameTopic(itemTopic, topic)));
      if (taught.length) add(item, 'taught-topic', `taughtTopics: ${taught.join(', ')}`);
    }
  }
  const parents = new Set([...matches.values()].map((match) => match.item.id));
  for (const item of items) if (item.c1Of && parents.has(item.c1Of)) add(item, 'c1-scaffold', `C1 scaffold of ${item.c1Of}`);
  return [...matches.values()].sort((a, b) => a.item.id.localeCompare(b.item.id));
}

/** Return actionable gaps in priority order while preserving input order for ties. */
export function selectPrepItems(items: readonly PrepPlanItem[]): PrepPlanItem[] {
  const gaps = items.filter((item) => item.state === 'weak' || item.state === 'unseen');
  const index = new Map(items.map((item, position) => [`${item.kind}:${item.itemId}`, position]));
  const stateById = new Map(items.map((item) => [item.itemId, item.state]));
  // Keep scaffolds beside their matched parent so a bounded slice cannot
  // consume unrelated unseen items while leaving a weak parent unsupported.
  const rank = (item: PrepPlanItem) => item.state === 'weak' || (item.c1Of != null && stateById.get(item.c1Of) === 'weak') ? 0 : 1;
  return [...gaps].sort((a, b) => rank(a) - rank(b)
    || Number(Boolean(b.mustKnow)) - Number(Boolean(a.mustKnow))
    || (index.get(`${a.kind}:${a.itemId}`) ?? 0) - (index.get(`${b.kind}:${b.itemId}`) ?? 0));
}

/** Readiness CLI lead-time rule, kept pure for request and background callers. */
export function calculatePrepLeadDays(
  unsecuredCount: number,
  observedSecondsPerItem: number | null,
  dailyMinutes: number,
  minimumLeadDays = MIN_LEAD_DAYS,
): number {
  const minimum = Math.max(MIN_LEAD_DAYS, minimumLeadDays);
  const estimatedMinutes = observedSecondsPerItem == null ? null : Math.ceil(Math.max(0, unsecuredCount) * observedSecondsPerItem / 60);
  if (estimatedMinutes == null || dailyMinutes <= 0) return minimum;
  return Math.max(minimum, Math.ceil(estimatedMinutes / dailyMinutes));
}

/** Share of discretionary seats: 15% at lead time, rising linearly to 50% on the day. */
export function sessionPrepBlendShare(daysUntilStart: number, leadDays: number, floor = FLOOR_SHARE, peak = PEAK_SHARE): number {
  if (!Number.isFinite(daysUntilStart) || !Number.isFinite(leadDays) || leadDays <= 0 || daysUntilStart <= 0 || daysUntilStart > leadDays) return 0;
  // The final calendar day (including the day before and the day of a
  // same-day session) is the peak share, leaving room for a second pass.
  const rampDays = Math.max(1, leadDays - 1);
  const progress = daysUntilStart <= 1 ? 1 : Math.min(1, Math.max(0, 1 - (daysUntilStart - 1) / rampDays));
  return floor + (peak - floor) * progress;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

function startMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** Build a deterministic plan from already-read owner evidence. */
export function buildSessionPrepBlendPlan(
  sessions: readonly PrepBlendSessionInput[],
  options: { now: string | Date; dailyMinutes: number; minimumLeadDays?: number },
): PrepBlendPlan {
  const nowMs = startMs(options.now);
  const minimumLead = Math.max(MIN_LEAD_DAYS, options.minimumLeadDays ?? MIN_LEAD_DAYS);
  const result = sessions.map((session) => {
    const selected = selectPrepItems(session.items);
    const observed = median(selected.map((item) => item.observedSeconds ?? 0).filter((seconds) => Number.isFinite(seconds) && seconds > 0));
    const computedLead = calculatePrepLeadDays(selected.length, observed, options.dailyMinutes, minimumLead);
    const leadDays = Math.max(minimumLead, session.leadDays ?? computedLead);
    const until = (startMs(session.startAt) - nowMs) / DAY;
    const itemIds = selected.map((item) => `${item.kind}:${item.itemId}`);
    return {
      cardClusters: Object.fromEntries(selected.filter(item => item.kind === 'card' && item.cluster).map(item => [item.itemId, item.cluster!])),
      sessionId: session.sessionId,
      startAt: new Date(startMs(session.startAt)).toISOString(),
      leadDays,
      share: sessionPrepBlendShare(until, leadDays),
      itemIds,
      weakItemIds: selected.filter((item) => item.state === 'weak').map((item) => `${item.kind}:${item.itemId}`),
      unseenItemIds: selected.filter((item) => item.state === 'unseen').map((item) => `${item.kind}:${item.itemId}`),
    };
  });
  return refreshPrepBlendClock({ sessions: result, share: 0, weakItemIds: [], unseenItemIds: [], itemIds: [], fingerprint: '' }, options.now);
}

/** Recompute only the clock, retaining the background plan's ordering/evidence. */
export function refreshPrepBlendClock(plan: PrepBlendPlan, now: string | Date): PrepBlendPlan {
  const nowMs = startMs(now);
  const result = plan.sessions.map(session => ({ ...session,
    share: sessionPrepBlendShare((startMs(session.startAt) - nowMs) / DAY, session.leadDays),
  }));
  const active = result.filter((session) => session.share > 0);
  const weakItemIds = [...new Set(active.flatMap((session) => session.weakItemIds))];
  const unseenItemIds = [...new Set(active.flatMap((session) => session.unseenItemIds))];
  const activeKeys = new Set([...weakItemIds, ...unseenItemIds]);
  const itemIds = [...new Set(active.flatMap(session => session.itemIds))].filter(key => activeKeys.has(key));
  return {
    cardClusters: Object.assign({}, ...active.map(session => session.cardClusters ?? {})),
    sessions: result,
    share: active.reduce((maximum, session) => Math.max(maximum, session.share), 0),
    weakItemIds,
    unseenItemIds,
    itemIds,
    fingerprint: prepFingerprint(active.map(session => `${session.sessionId}:${session.startAt}:${session.leadDays}:${Math.floor(session.share * 20)}:${session.itemIds.join(',')}:${session.weakItemIds.join(',')}`).join('|')),
  };
}

function prepFingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `prep-v1-${(hash >>> 0).toString(16)}`;
}
