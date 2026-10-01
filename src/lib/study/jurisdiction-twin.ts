/**
 * AU/US discrepancy twin worklist — pure helpers.
 *
 * The AU adjudication and the US-twin decision are deliberately separate. A
 * grounded contradiction may leave the AU card standing because the retrieved
 * comparator is WHO/European, adult-vs-paediatric, irrelevant, or otherwise a
 * retrieval mismatch. Only an explicit, current US-practice discrepancy needs
 * a sibling (same conceptId, practiceLocale=us). Incomplete pairs (AU tagged,
 * no live US twin) are the morning-check authoring queue.
 */

export const JURISDICTION_TWIN_VERSION = 'jtwin-v2';

export interface TwinTriggerVerdict {
  itemId: string;
  itemType: 'card' | 'question';
  rotation?: string;
  contentHash: string;
  grounding?: { state?: string } | null;
  auDecision?: 'keep' | 'fix' | 'na';
  usTwinDecision?: 'required' | 'not-applicable' | 'na';
  detail?: string;
  auSource?: string | null;
}

export interface JurisdictionTwinWorkItem {
  kind: 'jurisdiction-twin';
  sourceItemId: string;
  sourceItemType: 'card' | 'question';
  rotation: string | null;
  contentHash: string;
  reason: string;
  auSource: string | null;
  usTwinDecision: 'required';
  version: string;
}

/** Explicit current AU-vs-US discrepancy → enqueue a US twin. */
export function selectJurisdictionTwinTriggers(
  verdicts: ReadonlyArray<TwinTriggerVerdict>,
): TwinTriggerVerdict[] {
  return verdicts.filter(
    (v) =>
      v.grounding?.state === 'contradicted'
      && v.auDecision === 'keep'
      && v.usTwinDecision === 'required',
  );
}

export function buildJurisdictionTwinWorkItem(
  verdict: TwinTriggerVerdict,
): JurisdictionTwinWorkItem {
  return {
    kind: 'jurisdiction-twin',
    sourceItemId: verdict.itemId,
    sourceItemType: verdict.itemType,
    rotation: verdict.rotation ?? null,
    contentHash: verdict.contentHash,
    reason: verdict.detail
      ?? 'Grounded contradiction kept for Australian practice; author US twin.',
    auSource: verdict.auSource ?? null,
    usTwinDecision: 'required',
    version: JURISDICTION_TWIN_VERSION,
  };
}

export interface JurisdictionTwinTarget {
  itemId: string;
  itemType: 'card' | 'question';
  /** Audit hash of the exact source content that created the obligation. */
  contentHash: string;
  /** Present when the default queue was sourced from an active ContentIssue. */
  issueId?: string;
}

function inputRows(raw: unknown): unknown[] {
  return Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Array.isArray((raw as { items?: unknown }).items)
        ? (raw as { items: unknown[] }).items
        : Array.isArray((raw as { worklist?: unknown }).worklist)
          ? (raw as { worklist: unknown[] }).worklist
          : []
      : [];
}

/** Extract only explicit v2 twin obligations; raw factual worklists fail closed. */
export function extractRequiredTwinTargets(raw: unknown): JurisdictionTwinTarget[] {
  const byKey = new Map<string, JurisdictionTwinTarget>();
  for (const row of inputRows(raw)) {
    if (!row || typeof row !== 'object') continue;
    const value = row as Record<string, unknown>;
    const fromWorkItem = value.kind === 'jurisdiction-twin'
      && value.usTwinDecision === 'required'
      && value.version === JURISDICTION_TWIN_VERSION;
    const grounding = value.grounding as { state?: unknown } | undefined;
    const fromVerdict = grounding?.state === 'contradicted'
      && value.auDecision === 'keep'
      && value.usTwinDecision === 'required';
    if (!fromWorkItem && !fromVerdict) continue;
    const itemId = fromWorkItem ? value.sourceItemId : value.itemId;
    const itemType = fromWorkItem ? value.sourceItemType : value.itemType;
    const contentHash = value.contentHash;
    const issueId = value.issueId;
    if (
      typeof itemId !== 'string'
      || (itemType !== 'card' && itemType !== 'question')
      || typeof contentHash !== 'string'
      || contentHash.length === 0
    ) continue;
    // Preserve distinct content versions until the queue compares each one to
    // the live source. An old open issue must not mask a newer obligation.
    byKey.set(`${itemType}:${itemId}:${contentHash}`, {
      itemId,
      itemType,
      contentHash,
      ...(typeof issueId === 'string' && issueId.length > 0 ? { issueId } : {}),
    });
  }
  return [...byKey.values()];
}

export interface TwinQuestionRow {
  id: string;
  variantGroupId: string | null;
  practiceLocale: string | null;
  rotation: string;
  stem: string;
  sourceFile: string | null;
}

export interface JurisdictionTwinGap {
  sourceItemId: string;
  sourceItemType: 'card' | 'question';
  rotation: string | null;
  prompt: string;
  pairingKey: string | null;
  needs: Array<'restore-source' | 'tag-source-au' | 'assign-pair-key' | 'author-us-twin'>;
}

/**
 * Resolve explicit obligations against current source rows. Universal and
 * unlinked targets are surfaced as setup work instead of silently disappearing.
 */
export function findJurisdictionTwinGaps(
  targets: ReadonlyArray<JurisdictionTwinTarget>,
  cards: ReadonlyArray<TwinCardRow>,
  questions: ReadonlyArray<TwinQuestionRow>,
): JurisdictionTwinGap[] {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const usCardConcepts = new Set(
    cards.filter((card) => card.practiceLocale === 'us' && card.conceptId)
      .map((card) => card.conceptId as string),
  );
  const usQuestionGroups = new Set(
    questions.filter((question) => question.practiceLocale === 'us' && question.variantGroupId)
      .map((question) => question.variantGroupId as string),
  );
  const gaps: JurisdictionTwinGap[] = [];

  for (const target of targets) {
    if (target.itemType === 'card') {
      const card = cardById.get(target.itemId);
      if (!card) {
        gaps.push({
          sourceItemId: target.itemId,
          sourceItemType: 'card',
          rotation: null,
          prompt: '',
          pairingKey: null,
          needs: ['restore-source'],
        });
        continue;
      }
      const needs: JurisdictionTwinGap['needs'] = [];
      if (card.practiceLocale !== 'au') needs.push('tag-source-au');
      if (!card.conceptId) needs.push('assign-pair-key');
      if (!card.conceptId || !usCardConcepts.has(card.conceptId)) needs.push('author-us-twin');
      if (needs.length) {
        gaps.push({
          sourceItemId: card.id,
          sourceItemType: 'card',
          rotation: card.rotation,
          prompt: card.front,
          pairingKey: card.conceptId,
          needs,
        });
      }
      continue;
    }

    const question = questionById.get(target.itemId);
    if (!question) {
      gaps.push({
        sourceItemId: target.itemId,
        sourceItemType: 'question',
        rotation: null,
        prompt: '',
        pairingKey: null,
        needs: ['restore-source'],
      });
      continue;
    }
    const needs: JurisdictionTwinGap['needs'] = [];
    if (question.practiceLocale !== 'au') needs.push('tag-source-au');
    if (!question.variantGroupId) needs.push('assign-pair-key');
    if (!question.variantGroupId || !usQuestionGroups.has(question.variantGroupId)) {
      needs.push('author-us-twin');
    }
    if (needs.length) {
      gaps.push({
        sourceItemId: question.id,
        sourceItemType: 'question',
        rotation: question.rotation,
        prompt: question.stem,
        pairingKey: question.variantGroupId,
        needs,
      });
    }
  }
  return gaps;
}

export interface TwinCardRow {
  id: string;
  conceptId: string | null;
  practiceLocale: string | null;
  rotation: string;
  front: string;
  stableId: string | null;
}

/** AU-tagged cards whose conceptId has no live US sibling. */
export function findIncompleteJurisdictionTwins(
  cards: ReadonlyArray<TwinCardRow>,
  options?: { scopeItemIds?: ReadonlySet<string> },
): TwinCardRow[] {
  const usConcepts = new Set(
    cards
      .filter((c) => c.practiceLocale === 'us' && c.conceptId)
      .map((c) => c.conceptId as string),
  );
  const incomplete = cards.filter(
    (c) =>
      c.practiceLocale === 'au'
      && c.conceptId
      && !usConcepts.has(c.conceptId),
  );
  if (!options?.scopeItemIds) return incomplete;
  // Morning-check certification scopes to today's lookahead / grounded worklist.
  return incomplete.filter((c) => options.scopeItemIds!.has(c.id));
}

/**
 * Extract item ids from a grounded / factual / served worklist JSON.
 * Accepts a bare array, `{ items: [...] }`, or `{ worklist: [...] }`.
 */
export function extractWorklistItemIds(raw: unknown): Set<string> {
  const rows = inputRows(raw);
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = (row as { itemId?: unknown; cardId?: unknown; id?: unknown }).itemId
      ?? (row as { cardId?: unknown }).cardId
      ?? (row as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids;
}
