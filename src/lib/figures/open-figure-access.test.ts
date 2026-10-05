import { describe, expect, it } from 'vitest';
import { REVIEWED_LOCAL_ANATOMY_FIGURE, isOpenFigurePath } from './open-figure-access';
import originalFigurePaths from './original-figure-paths.json';
import { getOriginalFigure, originalFigureManifest } from './original-figure-manifest';

describe('isOpenFigurePath', () => {
  it('accepts a repo-native open Step 1 figure', () => {
    expect(isOpenFigurePath('/figures/usmle/step1/adrenal-zones-v1.svg')).toBe(true);
  });

  it('accepts only the exact reviewed abducens anatomy asset', () => {
    expect(isOpenFigurePath(REVIEWED_LOCAL_ANATOMY_FIGURE)).toBe(true);
    expect(isOpenFigurePath('/figures/anatomy/abducens-local.svg/extra')).toBe(false);
    expect(isOpenFigurePath('/figures/anatomy/../anking/note.svg')).toBe(false);
  });

  it('withdraws the superseded original PNG collection from the public namespace', () => {
    expect(isOpenFigurePath('/figures/originals/gowers-sign-standing-sequence.png')).toBe(false);
    expect(isOpenFigurePath('/figures/originals/phenylalanine-tyrosine-pathway.png')).toBe(false);
    expect(isOpenFigurePath('/figures/originals/unreviewed.png')).toBe(false);
    expect(isOpenFigurePath('/figures/originals/../restricted/a.png')).toBe(false);
    expect(isOpenFigurePath('/figures/originals/%6eeonatal-scalp-comparison.png')).toBe(false);
    expect(isOpenFigurePath('/figures/originals/gowers-sign-standing-sequence.png#x')).toBe(false);
  });

  it('keeps the client path index exactly aligned with the accepted collection', () => {
    expect(originalFigurePaths).toEqual(originalFigureManifest!.figures
      .map((figure) => `/figures/originals/${figure.id}.png`)
      .filter((path) => getOriginalFigure(path) !== undefined).sort());
  });

  it.each([
    ['a rights-managed figure namespace', '/figures/anking/some-image.jpg'],
    ['a sibling usmle namespace that is not the open corpus', '/figures/usmle/step2/x.svg'],
    ['a non-svg asset inside the open namespace', '/figures/usmle/step1/leak.png'],
    ['a traversal attempt out of the open namespace', '/figures/usmle/step1/../../anking/x.svg'],
    ['an encoded traversal attempt', '/figures/usmle/step1/%2e%2e/anking/x.svg'],
    ['a nested path inside the open namespace', '/figures/usmle/step1/nested/x.svg'],
    ['an absolute URL', 'https://example.com/figures/usmle/step1/x.svg'],
    ['an empty path', ''],
  ])('rejects %s', (_label, path) => {
    expect(isOpenFigurePath(path)).toBe(false);
  });

  it('rejects a non-string input', () => {
    expect(isOpenFigurePath(undefined)).toBe(false);
    expect(isOpenFigurePath(null)).toBe(false);
  });
});

