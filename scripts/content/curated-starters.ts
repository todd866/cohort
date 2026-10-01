import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface CuratedStarterEntry {
  stableId: string;
  sha256: string;
  evidenceUrls: string[];
  topic: string;
}

export interface CuratedStarterManifest {
  schemaVersion: 1;
  reviewedAt: string;
  rotations: Record<string, CuratedStarterEntry[]>;
}

export interface CuratedStarterCardSnapshot {
  front: string;
  back: string;
  backs?: unknown;
  context?: string | null;
  imageUrl?: string | null;
  imageRole?: string | null;
  imageCaption?: string | null;
}

export interface CuratedStarterCardRow extends CuratedStarterCardSnapshot {
  id: string;
  stableId: string | null;
  rotation: string;
  ownerUserId: string | null;
  deletedAt: Date | null;
  shelvedAt: Date | null;
  topics: string[];
  variantGroupId: string | null;
}

export function curatedStarterSnapshotHash(card: CuratedStarterCardSnapshot): string {
  const snapshot = [
    card.front,
    card.back,
    card.backs ?? null,
    card.context ?? null,
    card.imageUrl ?? null,
    card.imageRole ?? null,
    card.imageCaption ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEntry(value: unknown, label: string): CuratedStarterEntry {
  if (!isRecord(value)
    || typeof value.stableId !== 'string' || value.stableId.length === 0
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.topic !== 'string' || value.topic.trim().length === 0
    || !Array.isArray(value.evidenceUrls) || value.evidenceUrls.length === 0
    || !value.evidenceUrls.every((url) => {
      if (typeof url !== 'string') return false;
      try { return new URL(url).protocol === 'https:'; } catch { return false; }
    })) {
    throw new Error(`[curated-starters] Invalid entry at ${label}`);
  }
  return {
    stableId: value.stableId,
    sha256: value.sha256,
    evidenceUrls: [...value.evidenceUrls] as string[],
    topic: value.topic.trim(),
  };
}

export function parseCuratedStarterManifest(value: unknown): CuratedStarterManifest {
  if (!isRecord(value) || value.schemaVersion !== 1
    || typeof value.reviewedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.reviewedAt)
    || Number.isNaN(Date.parse(`${value.reviewedAt}T00:00:00.000Z`))
    || new Date(`${value.reviewedAt}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.reviewedAt
    || !isRecord(value.rotations)) {
    throw new Error('[curated-starters] Invalid manifest header');
  }

  const rotations: Record<string, CuratedStarterEntry[]> = {};
  const seenStableIds = new Set<string>();
  let total = 0;
  for (const [rotation, rawEntries] of Object.entries(value.rotations)) {
    if (!rotation || !Array.isArray(rawEntries)) {
      throw new Error(`[curated-starters] Invalid rotation list: ${rotation}`);
    }
    const entries = rawEntries.map((entry, index) => validateEntry(entry, `${rotation}[${index}]`));
    for (const entry of entries) {
      if (seenStableIds.has(entry.stableId)) {
        throw new Error(`[curated-starters] Duplicate stableId: ${entry.stableId}`);
      }
      seenStableIds.add(entry.stableId);
    }
    total += entries.length;
    if (total > 32) throw new Error('[curated-starters] Manifest exceeds 32 entries');
    rotations[rotation] = entries;
  }

  return { schemaVersion: 1, reviewedAt: value.reviewedAt, rotations };
}

/** Missing data is normal for public/offline checkouts; malformed data is not. */
export async function loadCuratedStarterManifest(filePath: string): Promise<CuratedStarterManifest | null> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    throw new Error('[curated-starters] Manifest is not valid JSON');
  }
  return parseCuratedStarterManifest(data);
}

/** Validate current shared rows and preserve the manifest's editorial order. */
export function resolveCuratedStarterRows<T extends CuratedStarterCardRow>(args: {
  rotation: string;
  entries: readonly CuratedStarterEntry[];
  rows: readonly T[];
  deliverableIds: ReadonlySet<string>;
  excludedTopics: readonly string[];
}): Array<{ entry: CuratedStarterEntry; row: T }> {
  const byStableId = new Map<string, T>();
  for (const row of args.rows) {
    if (row.stableId) byStableId.set(row.stableId, row);
  }

  const seenGroups = new Set<string>();
  return args.entries.map((entry) => {
    const row = byStableId.get(entry.stableId);
    if (!row) throw new Error(`[curated-starters] Missing or ineligible card: ${entry.stableId}`);
    if (row.rotation !== args.rotation || row.ownerUserId !== null || row.deletedAt !== null
      || row.shelvedAt !== null || row.topics.some((topic) => args.excludedTopics.includes(topic))) {
      throw new Error(`[curated-starters] Ineligible card: ${entry.stableId}`);
    }
    if (curatedStarterSnapshotHash(row) !== entry.sha256) {
      throw new Error(`[curated-starters] Snapshot drift: ${entry.stableId}`);
    }
    if (row.variantGroupId !== null) {
      if (seenGroups.has(row.variantGroupId)) {
        throw new Error(`[curated-starters] Duplicate variant group: ${row.variantGroupId}`);
      }
      seenGroups.add(row.variantGroupId);
    }
    if (!args.deliverableIds.has(row.id)) {
      throw new Error(`[curated-starters] Undeliverable derived card: ${entry.stableId}`);
    }
    return { entry, row };
  });
}
