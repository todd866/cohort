import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readAnatomySourceFigure, type AnatomySourceFigure } from './anatomy-source-figure.server';
const bytes = new TextEncoder().encode('reviewed pixels');
const entry: AnatomySourceFigure = {
  id: 'humerus', file: 'humerus.jpg', sha256: createHash('sha256').update(bytes).digest('hex'),
  mime: 'image/jpeg', licence: 'CC-BY-3.0', sourceUrl: 'https://example.org/source', attribution: 'Author, CC BY 3.0',
  review: { status: 'accepted', reviewer: 'independent reviewer', claims: ['humeral head location'] },
};
const read = () => bytes;
describe('reviewed anatomy source figures', () => {
  it('admits only an exact reviewed byte match', () => {
    expect(readAnatomySourceFigure('humerus', { entries: [entry], read })?.bytes).toEqual(bytes);
    expect(readAnatomySourceFigure('humerus', { entries: [entry], read: () => new Uint8Array([1]) })).toBeNull();
  });
  it('refuses unknown ids, duplicates, missing files and path traversal', () => {
    expect(readAnatomySourceFigure('../humerus', { entries: [entry], read })).toBeNull();
    expect(readAnatomySourceFigure('humerus', { entries: [entry, entry], read })).toBeNull();
    expect(readAnatomySourceFigure('humerus', { entries: [{ ...entry, file: '../humerus.jpg' }], read })).toBeNull();
    expect(readAnatomySourceFigure('humerus', { entries: [entry], read: () => { throw Error('missing'); } })).toBeNull();
  });
  it('refuses noncommercial licences and unreviewed figures', () => {
    expect(readAnatomySourceFigure('humerus', { entries: [{ ...entry, licence: 'CC-BY-NC-SA-4.0' } as unknown as AnatomySourceFigure], read })).toBeNull();
    expect(readAnatomySourceFigure('humerus', { entries: [{ ...entry, review: { ...entry.review, status: 'draft' } } as unknown as AnatomySourceFigure], read })).toBeNull();
  });
});
