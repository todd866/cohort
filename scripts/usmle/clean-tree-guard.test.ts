import { describe, it, expect } from 'vitest';
import {
  parseDirtyCorpusFiles,
  parseFingerprintBlockingDirt,
  assertCorpusTreeClean,
  DEFAULT_CORPUS_PREFIXES,
} from './clean-tree-guard';

describe('parseDirtyCorpusFiles', () => {
  it('returns empty for a clean tree', () => {
    expect(parseDirtyCorpusFiles('')).toEqual([]);
  });

  it('catches a modified question file', () => {
    const porcelain = ' M open-content/usmle/step1/questions/reproductive/re-x.v1.json';
    expect(parseDirtyCorpusFiles(porcelain)).toEqual([
      'open-content/usmle/step1/questions/reproductive/re-x.v1.json',
    ]);
  });

  it('catches an untracked file under the corpus', () => {
    const porcelain = '?? open-content/usmle/step1/questions/new/n.v1.json';
    expect(parseDirtyCorpusFiles(porcelain)).toEqual([
      'open-content/usmle/step1/questions/new/n.v1.json',
    ]);
  });

  it('takes the destination path of a rename', () => {
    const porcelain =
      'R  open-content/usmle/step1/questions/a/old.v1.json -> open-content/usmle/step1/questions/a/new.v1.json';
    expect(parseDirtyCorpusFiles(porcelain)).toEqual([
      'open-content/usmle/step1/questions/a/new.v1.json',
    ]);
  });

  it('ignores files outside the guarded prefixes', () => {
    const porcelain = [
      ' M src/lib/usmle/public-corpus.ts',
      ' M docs/notes.md',
      '?? /tmp/scratch.json',
    ].join('\n');
    expect(parseDirtyCorpusFiles(porcelain)).toEqual([]);
  });
});

describe('parseFingerprintBlockingDirt', () => {
  it('allows staged-only tracked edits (intentional release content)', () => {
    const porcelain = 'M  open-content/usmle/step1/questions/x/a.v1.json';
    expect(parseFingerprintBlockingDirt(porcelain)).toEqual([]);
  });

  it('blocks unstaged tracked modifications of existing question files', () => {
    const porcelain = ' M open-content/usmle/step1/questions/x/a.v1.json';
    expect(parseFingerprintBlockingDirt(porcelain)).toEqual([
      'open-content/usmle/step1/questions/x/a.v1.json',
    ]);
  });

  it('blocks MM (staged plus further unstaged) as still-dirty WIP', () => {
    const porcelain = 'MM open-content/usmle/step1/questions/x/a.v1.json';
    expect(parseFingerprintBlockingDirt(porcelain)).toEqual([
      'open-content/usmle/step1/questions/x/a.v1.json',
    ]);
  });

  it('allows untracked new question files (intentional ladder landing)', () => {
    const porcelain = '?? open-content/usmle/step1/questions/endocrine/endo-insulin-r1.v1.json';
    expect(parseFingerprintBlockingDirt(porcelain)).toEqual([]);
  });

  it('allows a dirty release-v1.json (the write rewrites it)', () => {
    const porcelain = ' M open-content/usmle/step1/release-v1.json';
    expect(parseFingerprintBlockingDirt(porcelain)).toEqual([]);
  });

  it('still blocks unstaged sources.json edits', () => {
    const porcelain = ' M open-content/usmle/step1/sources.json';
    expect(parseFingerprintBlockingDirt(porcelain)).toEqual([
      'open-content/usmle/step1/sources.json',
    ]);
  });

  it('blocks foreign unstaged WIP even when new files and release are also dirty', () => {
    const porcelain = [
      ' M open-content/usmle/step1/questions/reproductive/re-x.v1.json',
      ' M open-content/usmle/step1/release-v1.json',
      '?? open-content/usmle/step1/questions/endocrine/new.v1.json',
    ].join('\n');
    expect(parseFingerprintBlockingDirt(porcelain)).toEqual([
      'open-content/usmle/step1/questions/reproductive/re-x.v1.json',
    ]);
  });
});

describe('assertCorpusTreeClean', () => {
  it('passes on a clean tree', () => {
    expect(() => assertCorpusTreeClean({ gitStatus: () => '' })).not.toThrow();
  });

  it('passes when only new untracked items + dirty release are present', () => {
    const porcelain = [
      ' M open-content/usmle/step1/release-v1.json',
      '?? open-content/usmle/step1/questions/endocrine/endo-x-r1.v1.json',
    ].join('\n');
    expect(() => assertCorpusTreeClean({ gitStatus: () => porcelain })).not.toThrow();
  });

  it('passes when intentional edits are staged', () => {
    const porcelain = 'M  open-content/usmle/step1/questions/x/a.v1.json';
    expect(() => assertCorpusTreeClean({ gitStatus: () => porcelain })).not.toThrow();
  });

  it('throws and names offending unstaged tracked files', () => {
    const dirty = ' M open-content/usmle/step1/questions/x/a.v1.json';
    expect(() => assertCorpusTreeClean({ gitStatus: () => dirty })).toThrow(
      /unstaged tracked corpus files[\s\S]*a\.v1\.json/,
    );
  });

  it('exposes its default guarded prefixes', () => {
    expect(DEFAULT_CORPUS_PREFIXES).toContain('open-content/usmle/step1/questions/');
  });

  it('treats a non-git working tree as clean (FOSS tarball checkouts)', () => {
    expect(() => assertCorpusTreeClean({
      gitStatus: () => {
        throw new Error('Command failed: git status --porcelain\nfatal: not a git repository');
      },
    })).not.toThrow();
  });
});
