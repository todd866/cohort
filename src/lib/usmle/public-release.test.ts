import { describe, expect, it } from 'vitest';
import {
  parseOpenUsmleReleaseManifest,
  validateOpenUsmleReleaseFingerprints,
  validateOpenUsmleReleaseMembership,
} from './public-release';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

describe('public Step 1 release manifest', () => {
  it('parses an ordered, strict, versioned allowlist', () => {
    expect(parseOpenUsmleReleaseManifest({
      schemaVersion: 2,
      questionIds: ['question-b', 'question-a'],
      questionFingerprints: { 'question-a': FP_A, 'question-b': FP_B },
    })).toEqual({
      schemaVersion: 2,
      questionIds: ['question-b', 'question-a'],
      questionFingerprints: { 'question-a': FP_A, 'question-b': FP_B },
    });
  });

  it('rejects empty, duplicate, and unversioned manifests', () => {
    expect(() => parseOpenUsmleReleaseManifest({
      schemaVersion: 1,
      questionIds: ['question-a'],
      questionFingerprints: { 'question-a': FP_A },
    })).toThrow();
    expect(() => parseOpenUsmleReleaseManifest({
      schemaVersion: 2,
      questionIds: [],
      questionFingerprints: {},
    })).toThrow();
    expect(() => parseOpenUsmleReleaseManifest({
      schemaVersion: 2,
      questionIds: ['question-a', 'question-a'],
      questionFingerprints: { 'question-a': FP_A },
    })).toThrow(/duplicate release question id.*question-a/i);
  });

  it('requires one valid fingerprint for every release member and no others', () => {
    expect(() => parseOpenUsmleReleaseManifest({
      schemaVersion: 2,
      questionIds: ['question-a'],
      questionFingerprints: {},
    })).toThrow(/missing release fingerprint question-a/i);
    expect(() => parseOpenUsmleReleaseManifest({
      schemaVersion: 2,
      questionIds: ['question-a'],
      questionFingerprints: { 'question-a': FP_A, extra: FP_B },
    })).toThrow(/unexpected release fingerprint extra/i);
    expect(() => parseOpenUsmleReleaseManifest({
      schemaVersion: 2,
      questionIds: ['question-a'],
      questionFingerprints: { 'question-a': 'not-a-sha256' },
    })).toThrow();
  });

  it('requires exact source/release membership in both directions', () => {
    const manifest = parseOpenUsmleReleaseManifest({
      schemaVersion: 2,
      questionIds: ['released', 'missing-on-disk'],
      questionFingerprints: { released: FP_A, 'missing-on-disk': FP_B },
    });
    expect(validateOpenUsmleReleaseMembership(
      manifest,
      new Set(['released', 'new-but-unreleased']),
    )).toEqual([
      'Unknown release question missing-on-disk',
      'Unreleased source question new-but-unreleased',
    ]);
  });

  it('treats checked-in fingerprints as assertions and recomputes source authority', () => {
    const manifest = parseOpenUsmleReleaseManifest({
      schemaVersion: 2,
      questionIds: ['question-a', 'question-b'],
      questionFingerprints: { 'question-a': FP_A, 'question-b': FP_B },
    });
    expect(validateOpenUsmleReleaseFingerprints(manifest, {
      'question-a': FP_A,
      'question-b': FP_B,
    })).toEqual([]);
    expect(validateOpenUsmleReleaseFingerprints(manifest, {
      'question-a': FP_B,
      'question-b': FP_B,
    })).toEqual(['Release fingerprint differs from source question-a']);
  });
});
