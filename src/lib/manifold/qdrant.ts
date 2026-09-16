/**
 * Qdrant Vector Store (optional)
 *
 * Optional external vector store for production-scale ANN search.
 * Qdrant stores canonical manifold vectors in the same Gemini 3072D space
 * used by the Postgres embedding tables.
 */

import { STORED_MANIFOLD_DIM } from './config';
import { config } from '@/lib/config';
import crypto from 'crypto';

type ContentType = 'card' | 'question';

type QdrantMatch = { value: string | number | boolean };
type QdrantCondition =
  | { key: string; match: QdrantMatch }
  | { has_id: Array<string | number> };

export type QdrantFilter = {
  must?: QdrantCondition[];
  must_not?: QdrantCondition[];
  should?: QdrantCondition[];
};

export interface QdrantHit {
  id: string;
  score: number;
  payload?: Record<string, unknown> | null;
}

const VECTOR_NAME = 'text';
const DEFAULT_COLLECTION = 'md3';
const MD3_NAMESPACE_UUID = '5f9b1f2e-6f2b-4b61-8c0a-2e9b6c6b9d21';

let _ensured: Promise<void> | null = null;

function assertEmbeddingDimensions(vector: number[]): void {
  if (vector.length !== STORED_MANIFOLD_DIM) {
    throw new Error(
      `Qdrant vector size mismatch: got ${vector.length}, expected ${STORED_MANIFOLD_DIM}. Re-embed with Gemini Embedding 2 and re-sync.`
    );
  }
}

export function isQdrantEnabled(): boolean {
  return Boolean(config.qdrantUrl());
}

export function qdrantPointId(type: ContentType, contentId: string): string {
  return uuidV5(`${type}:${contentId}`, MD3_NAMESPACE_UUID);
}

function qdrantHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = config.qdrantApiKey();
  if (apiKey) {
    headers['api-key'] = apiKey;
  }
  return headers;
}

function qdrantUrl(path: string): string {
  const base = config.qdrantUrl() ?? '';
  return `${base.replace(/\/+$/, '')}${path}`;
}

function uuidV5(name: string, namespaceUuid: string): string {
  const namespaceBytes = uuidToBytes(namespaceUuid);
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = crypto.createHash('sha1').update(namespaceBytes).update(nameBytes).digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  // Set version to 5 (0101)
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // Set variant to RFC 4122 (10xx)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error('Invalid UUID');
  }
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

async function qdrantRequest<T>(
  path: string,
  init: Omit<RequestInit, 'headers'> & { headers?: HeadersInit } = {}
): Promise<{ ok: boolean; status: number; data: T | null }> {
  if (!isQdrantEnabled()) {
    return { ok: false, status: 0, data: null };
  }

  const response = await fetch(qdrantUrl(path), {
    ...init,
    headers: {
      ...qdrantHeaders(),
      ...(init.headers ?? {}),
    },
  });

  let data: T | null = null;
  try {
    data = (await response.json()) as T;
  } catch {
    data = null;
  }

  return { ok: response.ok, status: response.status, data };
}

export async function ensureQdrantCollection(): Promise<void> {
  if (!isQdrantEnabled()) return;
  if (_ensured) return _ensured;

  const collection = config.qdrantCollection() ?? DEFAULT_COLLECTION;

  _ensured = (async () => {
    // Check if collection exists
    const existing = await qdrantRequest<{ result?: unknown }>(`/collections/${collection}`, {
      method: 'GET',
    });

    if (existing.ok) return;

    // Create collection (named vector for future multi-vector expansion)
    const created = await qdrantRequest<{ result?: unknown }>(`/collections/${collection}`, {
      method: 'PUT',
      body: JSON.stringify({
        vectors: {
          [VECTOR_NAME]: { size: STORED_MANIFOLD_DIM, distance: 'Cosine' },
        },
      }),
    });

    if (!created.ok) {
      throw new Error(
        `Failed to create Qdrant collection (${collection}): HTTP ${created.status}`
      );
    }
  })();

  return _ensured;
}

export async function qdrantUpsertPoints(
  points: Array<{
    type: ContentType;
    contentId: string;
    vector: number[];
    payload: Record<string, unknown>;
  }>
): Promise<void> {
  if (!isQdrantEnabled()) return;
  await ensureQdrantCollection();

  for (const point of points) {
    assertEmbeddingDimensions(point.vector);
  }

  const collection = config.qdrantCollection() ?? DEFAULT_COLLECTION;

  const body = {
    points: points.map((p) => ({
      id: qdrantPointId(p.type, p.contentId),
      vector: { [VECTOR_NAME]: p.vector },
      payload: {
        contentType: p.type,
        contentId: p.contentId,
        ...p.payload,
      },
    })),
  };

  const res = await qdrantRequest<{ result?: unknown }>(
    `/collections/${collection}/points?wait=true`,
    { method: 'PUT', body: JSON.stringify(body) }
  );

  if (!res.ok) {
    throw new Error(`Qdrant upsert failed: HTTP ${res.status}`);
  }
}

export async function qdrantSearch(
  vector: number[],
  options: {
    filter?: QdrantFilter;
    limit: number;
    scoreThreshold?: number;
    withPayload?: boolean;
  }
): Promise<QdrantHit[]> {
  if (!isQdrantEnabled()) return [];
  await ensureQdrantCollection();
  assertEmbeddingDimensions(vector);

  const collection = config.qdrantCollection() ?? DEFAULT_COLLECTION;

  const res = await qdrantRequest<{ result?: QdrantHit[] }>(
    `/collections/${collection}/points/search`,
    {
      method: 'POST',
      body: JSON.stringify({
        vector: { [VECTOR_NAME]: vector },
        filter: options.filter,
        limit: options.limit,
        with_payload: options.withPayload ?? true,
        score_threshold: options.scoreThreshold,
      }),
    }
  );

  if (!res.ok) return [];
  return res.data?.result ?? [];
}

export async function qdrantRecommend(
  positiveIds: string[],
  options: {
    filter?: QdrantFilter;
    limit: number;
    scoreThreshold?: number;
    withPayload?: boolean;
  }
): Promise<QdrantHit[]> {
  if (!isQdrantEnabled()) return [];
  await ensureQdrantCollection();

  const collection = config.qdrantCollection() ?? DEFAULT_COLLECTION;

  const res = await qdrantRequest<{ result?: QdrantHit[] }>(
    `/collections/${collection}/points/recommend`,
    {
      method: 'POST',
      body: JSON.stringify({
        positive: positiveIds,
        using: VECTOR_NAME,
        filter: options.filter,
        limit: options.limit,
        with_payload: options.withPayload ?? true,
        score_threshold: options.scoreThreshold,
      }),
    }
  );

  if (!res.ok) return [];
  return res.data?.result ?? [];
}
