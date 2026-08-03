import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  parsePublicUsmleAuditArgs,
  runPublicUsmleAudit,
} from './usmle-public-corpus';

describe('parsePublicUsmleAuditArgs', () => {
  it('defaults to the repo-native domain-tree release corpus', () => {
    expect(parsePublicUsmleAuditArgs([])).toEqual({
      bankDir: 'open-content/usmle/step1/questions',
      sources: null,
      baseline: null,
      validateBaseline: true,
      out: null,
      json: false,
      membersOnly: false,
      registeredRootDirs: false,
      releaseGate: false,
      writeReleaseFingerprints: false,
      minEligible: 1,
    });
  });

  it('supports a read-only private candidate scan and explicit release settings', () => {
    expect(parsePublicUsmleAuditArgs([
      '--bank-dir', 'question-bank',
      '--sources', 'open-content/usmle/step1/sources.json',
      '--baseline', 'open-content/usmle/step1/baseline-v1.json',
      '--members-only',
      '--registered-root-dirs',
      '--release-gate',
      '--min-eligible=25',
      '--out=/tmp/report.json',
    ])).toEqual(expect.objectContaining({
      bankDir: 'question-bank',
      sources: 'open-content/usmle/step1/sources.json',
      baseline: 'open-content/usmle/step1/baseline-v1.json',
      validateBaseline: true,
      membersOnly: true,
      registeredRootDirs: true,
      releaseGate: true,
      minEligible: 25,
      out: '/tmp/report.json',
    }));

    expect(parsePublicUsmleAuditArgs([
      '--bank-dir', 'question-bank',
      '--sources', 'open-content/usmle/step1/sources.json',
      '--no-baseline',
    ])).toEqual(expect.objectContaining({
      validateBaseline: false,
      baseline: null,
      releaseGate: false,
    }));
  });

  it('rejects typoed arguments and invalid minimums', () => {
    expect(() => parsePublicUsmleAuditArgs(['--membres-only'])).toThrow(/unknown argument/i);
    expect(() => parsePublicUsmleAuditArgs(['--min-eligible', '-1'])).toThrow(/non-negative integer/i);
    expect(() => parsePublicUsmleAuditArgs(['--min-eligible='])).toThrow(/requires a value/i);
    expect(() => parsePublicUsmleAuditArgs(['--bank-dir'])).toThrow(/requires a value/i);
    expect(() => parsePublicUsmleAuditArgs(['--sources'])).toThrow(/requires a value/i);
    expect(() => parsePublicUsmleAuditArgs(['--bank-dir', 'custom/questions']))
      .toThrow(/--sources is required/i);
    expect(() => parsePublicUsmleAuditArgs([
      '--bank-dir', 'custom/questions',
      '--sources', 'custom/sources.json',
    ])).toThrow(/--baseline is required/i);
    expect(() => parsePublicUsmleAuditArgs(['--no-baseline', '--release-gate']))
      .toThrow(/cannot be used with --release-gate/i);
    expect(() => parsePublicUsmleAuditArgs(['--write-release-fingerprints']))
      .toThrow(/requires --release-gate/i);
    expect(() => parsePublicUsmleAuditArgs([
      '--baseline', 'custom/baseline.json',
      '--no-baseline',
    ])).toThrow(/mutually exclusive/i);
  });

  it('runs the exact checked-in release gate without process side effects', () => {
    const previousExitCode = process.exitCode;
    const result = runPublicUsmleAudit(
      ['--release-gate', '--min-eligible=25'],
      { silent: true },
    );

    expect(result.report.summary).toEqual(expect.objectContaining({
      eligibleCount: 25,
      blockerCount: 0,
    }));
    expect(result.releaseFailures).toEqual([]);
    expect(process.exitCode).toBe(previousExitCode);
  });

  it('refreshes only source-derived fingerprints after the full release gate passes', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md3-usmle-release-'));
    const baselinePath = path.join(tempRoot, 'baseline-v1.json');
    const releasePath = path.join(tempRoot, 'release-v1.json');
    fs.copyFileSync(
      path.resolve('open-content/usmle/step1/baseline-v1.json'),
      baselinePath,
    );
    fs.copyFileSync(
      path.resolve('open-content/usmle/step1/release-v1.json'),
      releasePath,
    );

    try {
      const original = JSON.parse(fs.readFileSync(releasePath, 'utf8')) as {
        schemaVersion: number;
        questionIds: string[];
        questionFingerprints: Record<string, string>;
      };
      const stale = structuredClone(original);
      const firstId = stale.questionIds[0];
      stale.questionFingerprints[firstId] = stale.questionFingerprints[firstId]
        === '0'.repeat(64)
        ? '1'.repeat(64)
        : '0'.repeat(64);
      fs.writeFileSync(releasePath, `${JSON.stringify(stale, null, 2)}\n`);

      const commonArgs = [
        '--baseline', baselinePath,
        '--release-gate',
        '--min-eligible=25',
      ];
      expect(() => runPublicUsmleAudit(commonArgs, { silent: true }))
        .toThrow(/release fingerprint differs from source/i);

      const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('simulated interrupted replacement');
      });
      try {
        expect(() => runPublicUsmleAudit(
          [...commonArgs, '--write-release-fingerprints'],
          { silent: true },
        )).toThrow(/simulated interrupted replacement/i);
      } finally {
        rename.mockRestore();
      }
      expect(JSON.parse(fs.readFileSync(releasePath, 'utf8'))).toEqual(stale);
      expect(
        fs.readdirSync(tempRoot).filter((name) => name.startsWith('.release-v1.json.')),
      ).toEqual([]);

      const result = runPublicUsmleAudit(
        [...commonArgs, '--write-release-fingerprints'],
        { silent: true },
      );
      const refreshed = JSON.parse(fs.readFileSync(releasePath, 'utf8')) as typeof original;

      expect(result.releaseFailures).toEqual([]);
      expect(result.releaseFingerprintWrite).toEqual({
        path: releasePath,
        count: original.questionIds.length,
      });
      expect(refreshed.schemaVersion).toBe(original.schemaVersion);
      expect(refreshed.questionIds).toEqual(original.questionIds);
      expect(refreshed.questionFingerprints).toEqual(original.questionFingerprints);
      expect(fs.statSync(releasePath).mode & 0o777).toBe(0o644);
      expect(
        fs.readdirSync(tempRoot).filter((name) => name.startsWith('.release-v1.json.')),
      ).toEqual([]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
