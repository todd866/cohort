import { NextResponse } from 'next/server';
import type { PracticeReviewFocus, PracticeReviewProvenance } from './practice-review-focus';

type JsonRecord = Record<string, unknown>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Remove historical topic-derived badges from ordinary cached/live items.
 * Exact retests are served separately from an owned, version-bound delivery;
 * a topic string cannot establish that the learner missed this question.
 */
export async function withPracticeReviewResponseProvenance(
  response: NextResponse,
  _focus: PracticeReviewFocus | null,
  _rotation: string,
  verifiedScaffolds?: ReadonlyMap<string, { questionId: string; provenance: PracticeReviewProvenance }>,
): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!isJsonRecord(payload) || !Array.isArray(payload.items)) return response;

  const items = payload.items.map((rawItem) => {
    if (!isJsonRecord(rawItem)) return rawItem;
    const item = { ...rawItem };
    delete item.practiceReview;
    const verified = typeof item.serveDecisionId === 'string' ? verifiedScaffolds?.get(item.serveDecisionId) : undefined;
    if (verified && item.type === 'question' && item.id === verified.questionId) item.practiceReview = verified.provenance;
    return item;
  });

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return NextResponse.json({ ...payload, items }, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
