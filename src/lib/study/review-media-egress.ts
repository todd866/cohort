import { NextResponse } from 'next/server';
import {
  hasMediaExclusions,
  itemExcludedByMediaPreferences,
  type MediaBearingItem,
  type ReviewMediaPreferences,
  type StoredReviewMediaPreferences,
} from './review-media-preferences';

export interface ReviewMediaEgress {
  /** In force for this request (request `hide=`, else stored, else default). */
  preferences: ReviewMediaPreferences;
  /** The signed-in learner's saved choice; null for a guest. */
  stored: StoredReviewMediaPreferences | null;
}

/**
 * The last boundary every unified-session lane returns through.
 *
 * The cache, instant, rereview and manifold lanes already exclude these items
 * while choosing, so they fill the batch from what is left; this pass is the
 * guarantee for the lanes that do not (starter, follow-up, statement inserts).
 * It also carries the stored choice back so a second device adopts it.
 * Untouched responses are returned as they are: no re-serialisation for the
 * learners who never chose.
 */
export async function withReviewMediaPreferences(
  response: NextResponse,
  egress: ReviewMediaEgress,
): Promise<NextResponse> {
  const filter = hasMediaExclusions(egress.preferences);
  const report = Boolean(egress.stored && egress.stored.rev > 0);
  if (!filter && !report) return response;
  if (!response.ok) return response;
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return response;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.items)) return response;
  const items = filter
    ? record.items.filter((item) => !(item && typeof item === 'object'
      && itemExcludedByMediaPreferences(item as MediaBearingItem, egress.preferences)))
    : record.items;
  if (!report && items.length === record.items.length) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return NextResponse.json(
    { ...record, items, ...(report ? { mediaPreferences: egress.stored } : {}) },
    { status: response.status, headers },
  );
}
