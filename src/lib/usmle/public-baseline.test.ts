import { describe, expect, it } from 'vitest';
import {
  parseOpenUsmleBaselineManifest,
  validateOpenUsmleBaselineReferences,
} from './public-baseline';

describe('public Step 1 baseline manifest', () => {
  it('parses a strict versioned manifest with stable membership order', () => {
    expect(parseOpenUsmleBaselineManifest({
      schemaVersion: 1,
      questionIds: ['question-b', 'question-a'],
    })).toEqual({
      schemaVersion: 1,
      questionIds: ['question-b', 'question-a'],
    });
  });

  it('rejects malformed, empty, and duplicate manifests', () => {
    expect(() => parseOpenUsmleBaselineManifest({
      schemaVersion: 2,
      questionIds: ['question-a'],
    })).toThrow();
    expect(() => parseOpenUsmleBaselineManifest({
      schemaVersion: 1,
      questionIds: [],
    })).toThrow();
    expect(() => parseOpenUsmleBaselineManifest({
      schemaVersion: 1,
      questionIds: ['question-a', 'question-a'],
    })).toThrow(/duplicate baseline question id.*question-a/i);
  });

  it('reports unknown corpus IDs deterministically without question content', () => {
    const manifest = parseOpenUsmleBaselineManifest({
      schemaVersion: 1,
      questionIds: ['missing-z', 'present', 'missing-a'],
    });
    expect(validateOpenUsmleBaselineReferences(manifest, new Set(['present']))).toEqual([
      'Unknown baseline question missing-a',
      'Unknown baseline question missing-z',
    ]);
  });
});
