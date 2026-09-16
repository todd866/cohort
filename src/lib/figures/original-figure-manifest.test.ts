import { describe, expect, it } from 'vitest';
import manifestJson from '../../../open-content/medical-figures/manifest.json';
import {
  getOriginalFigure,
  originalFigureSidecar,
  parseOriginalFigureManifest,
} from './original-figure-manifest';

describe('reviewed original figure manifest', () => {
  it('admits only exact reviewed MIT paths and preserves honest placement/provenance', () => {
    const manifest = parseOriginalFigureManifest(manifestJson);
    for (const figure of manifest.figures) {
      expect(getOriginalFigure(`/figures/originals/${figure.id}.png`)?.id).toBe(figure.id);
      const sidecar = originalFigureSidecar(figure, manifest);
      expect(sidecar).toMatchObject({
        class: 'diagram', license: 'MIT', accessTier: 'public',
        clinicalReviewStatus: 'pending', hash: `sha256-${figure.sha256}`,
        dimensions: { w: figure.width, h: figure.height },
        showWhen: figure.teaching.imageRole === 'prompt' ? 'always' : 'after-reveal',
      });
      expect(sidecar.humanReviewedBy).toBeUndefined();
      expect(sidecar.humanReviewedAt).toBeUndefined();
    }
  });

  it.each([
    '/figures/originals/unknown.png',
    '/figures/originals/../restricted/image.png',
    '/figures/originals/%6eeonatal-scalp-comparison.png',
    '/figures/originals/neonatal-scalp-comparison.png?download=1',
    '/figures/originals/nested/neonatal-scalp-comparison.png',
    '/figures/restricted/neonatal-scalp-comparison.png',
  ])('rejects unlisted or nonliteral key %s', (key) => {
    expect(getOriginalFigure(key)).toBeUndefined();
  });

  it.each([
    ['non-MIT rights', (m: any) => { m.license = 'unknown'; }],
    ['unaccepted review', (m: any) => { m.figures[0].review.status = 'pending'; }],
    ['unknown review method', (m: any) => { m.figures[0].review.method = 'auto-caption'; }],
    ['missing checked structure', (m: any) => { delete m.figures[0].review.structure; }],
    ['anatomy hold', (m: any) => { m.figures[0].review.structure.kind = 'spatial-anatomy'; }],
    ['unverified structure', (m: any) => { m.figures[0].review.structure.status = 'pending'; }],
    ['unsafe scaffold path', (m: any) => { m.figures[0].review.structure.specificationFiles = ['../private.json']; }],
    ['external reference pixels', (m: any) => { m.figures[0].generation.externalReferenceImages = ['textbook.png']; }],
    ['missing reference declaration', (m: any) => { delete m.figures[0].generation.externalReferenceImages; }],
    ['traversal', (m: any) => { m.figures[0].file = 'images/../private.png'; }],
    ['malformed hash', (m: any) => { m.figures[0].sha256 = 'abc'; }],
    ['zero width', (m: any) => { m.figures[0].width = 0; }],
    ['duplicate id', (m: any) => { m.figures.push(m.figures[0]); }],
    ['unknown original reference', (m: any) => { m.figures[0].generation.referenceAssetIds = ['unreviewed']; }],
    ['unsafe prompt path', (m: any) => { m.figures[0].generation.promptFiles = ['../private.md']; }],
    ['missing deterministic date', (m: any) => { delete m.createdAt; for (const f of m.figures) delete f.generatedAt; }],
  ])('rejects %s', (_label, mutate) => {
    const manifest = structuredClone(manifestJson);
    mutate(manifest);
    expect(() => parseOriginalFigureManifest(manifest)).toThrow();
  });
});
