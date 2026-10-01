import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

export interface PatternCacheEntry {
  pattern: string;
  count: number;
  rotation: string | null;
  issueIds: string[];
}

export interface TriageState {
  lastTriagedAt: string | null; // ISO string
  patternCache: PatternCacheEntry[];
}

const PatternCacheEntrySchema = z.object({
  pattern: z.string(),
  count: z.number(),
  rotation: z.string().nullable(),
  issueIds: z.array(z.string()),
});

const TriageStateSchema = z.object({
  lastTriagedAt: z.string().nullable(),
  patternCache: z.array(PatternCacheEntrySchema),
});

const DEFAULT_STATE: TriageState = {
  lastTriagedAt: null,
  patternCache: [],
};

function getStatePath(): string {
  return process.env.FLAGS_STATE_PATH
    ?? path.resolve(process.cwd(), '.flags-triage-state.json');
}

export function readTriageState(): TriageState {
  const filePath = getStatePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return TriageStateSchema.parse(parsed);
  } catch {
    return { ...DEFAULT_STATE, patternCache: [] };
  }
}

export function writeTriageState(state: TriageState): void {
  const filePath = getStatePath();
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}
