import type { CohortTurnRequest } from './cohort-turn.server';
import { CLIENT_REQUEST_ID_MAX_LENGTH, CLIENT_REQUEST_ID_PATTERN } from '@/lib/idempotency';

export const MAX_TURN_BODY_BYTES = 2_048;
const MAX_DRAW_ORDINAL = 1_000_000;
const MAX_TIMEZONE_CHARS = 64;
const MAX_SEARCH_TOPIC_ID_CHARS = 64;
const SEARCH_TOPIC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_KEYS = new Set([
  'serveRequestId', 'journeyId', 'nextDrawOrdinal', 'previousDeliveryId', 'timezone', 'searchTopicId',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= CLIENT_REQUEST_ID_MAX_LENGTH
    && CLIENT_REQUEST_ID_PATTERN.test(value);
}

function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TIMEZONE_CHARS) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export type ParseTurnResult =
  | { ok: true; value: CohortTurnRequest }
  | { ok: false; code?: 'invalid_search_topic' | 'invalid_previous_delivery' };

export function parseTurnBody(value: unknown): ParseTurnResult {
  if (!isRecord(value) || Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) return { ok: false };
  if (
    !isOpaqueId(value.serveRequestId)
    || !isOpaqueId(value.journeyId)
    || !Number.isSafeInteger(value.nextDrawOrdinal)
    || (value.nextDrawOrdinal as number) < 0
    || (value.nextDrawOrdinal as number) > MAX_DRAW_ORDINAL
    || ('previousDeliveryId' in value && !isOpaqueId(value.previousDeliveryId))
    || ('timezone' in value && !isIanaTimezone(value.timezone))
  ) return { ok: false };

  let searchTopicId: string | undefined;
  if ('searchTopicId' in value) {
    if (
      typeof value.searchTopicId !== 'string'
      || value.searchTopicId.length < 1
      || value.searchTopicId.length > MAX_SEARCH_TOPIC_ID_CHARS
      || !SEARCH_TOPIC_ID_PATTERN.test(value.searchTopicId)
    ) return { ok: false, code: 'invalid_search_topic' };
    searchTopicId = value.searchTopicId;
  }
  return {
    ok: true,
    value: {
      serveRequestId: value.serveRequestId,
      journeyId: value.journeyId,
      nextDrawOrdinal: value.nextDrawOrdinal as number,
      ...('previousDeliveryId' in value ? { previousDeliveryId: value.previousDeliveryId as string } : {}),
      ...('timezone' in value ? { timezone: value.timezone as string } : {}),
      ...(searchTopicId ? { searchTopicId } : {}),
    },
  };
}

export async function readBoundedTurnBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TURN_BODY_BYTES) throw new RangeError('Turn body is too large');
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError('Turn body is empty');
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_TURN_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError('Turn body is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
