import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageSidecar } from '@/lib/images/types';
import { resolveImage } from './resolve';
import { resolveImageAlternatives } from './resolve-alternatives';
import { getOriginalImageAlternatives } from './original-image-alternatives';
import { lookupSidecar } from './server-loader';
import { signFigureUrl } from './r2';
import { imageAlternativeTeachingFingerprint } from './image-alternative-fingerprint';

vi.mock('./original-image-alternatives', () => ({ getOriginalImageAlternatives: vi.fn(() => []) }));
vi.mock('./server-loader', () => ({ lookupSidecar: vi.fn() }));
vi.mock('./r2', () => ({ signFigureUrl: vi.fn(async (key: string) => `https://signed.example/${key}`) }));

const originalId = 'gowers-sign-standing-sequence';
const originalKey = `/figures/originals/${originalId}.png`;
const primary = '/figures/restricted/existing.png';
const identity = { type: 'card' as const, id: 'existing-card', front: 'Reviewed front', back: 'Reviewed answer', context: 'Reviewed context' };
const sidecar = {
  class: 'diagnostic', accessTier: 'copyright-required', showWhen: 'after-reveal',
  modality: 'photo', condition: 'Existing finding', keyFindings: ['Existing finding'],
  altPolicy: 'generic', attributionText: 'Existing source',
} as ImageSidecar;
const entry = (expectedPrimaryKey: string | null = primary, figureId = originalId) => ({
  figureId, imageCaption: 'Reviewed explanation after reveal', expectedPrimaryKey,
  teachingFingerprint: imageAlternativeTeachingFingerprint(identity)!,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getOriginalImageAlternatives).mockReturnValue([entry()]);
  vi.mocked(lookupSidecar).mockImplementation(key => key === primary ? sidecar : undefined);
});

describe('resolveImageAlternatives', () => {
  it('adds public explanatory choices without replacing or signing the existing primary', async () => {
    const alternatives = await resolveImageAlternatives(identity, primary, null);
    expect(alternatives).toEqual([expect.objectContaining({
      imageKey: originalKey, imageUrl: originalKey, imageCaption: entry().imageCaption,
      imageRole: null, imageMeta: expect.objectContaining({
        accessTier: 'public', class: 'diagram', showWhen: 'after-reveal',
      }),
    })]);
    expect(signFigureUrl).not.toHaveBeenCalled();
    expect(await resolveImage(primary, null)).toBeNull();
    expect(await resolveImage(primary, null, 'copyright-required')).toMatchObject({
      imageKey: primary, imageUrl: 'https://signed.example/restricted/existing.png',
      imageMeta: { accessTier: 'copyright-required' },
    });
    expect(await resolveImageAlternatives(identity, primary, null, 'copyright-required')).toEqual(alternatives);
    expect(signFigureUrl).toHaveBeenCalledTimes(1);
  });

  it('adds a reviewed image to a previously imageless item while requiring the exact null preimage', async () => {
    vi.mocked(getOriginalImageAlternatives).mockReturnValue([entry(null)]);
    expect(await resolveImageAlternatives(identity, null, null)).toHaveLength(1);
    expect(await resolveImageAlternatives(identity, primary, null)).toEqual([]);
    vi.mocked(getOriginalImageAlternatives).mockReturnValue([entry(primary)]);
    expect(await resolveImageAlternatives(identity, null, null)).toEqual([]);
    expect(await resolveImageAlternatives(identity, 'https://different.example/image.png', null)).toEqual([]);
  });

  it.each([
    { role: 'prompt', classification: 'supplementary' },
    { role: null, classification: 'diagnostic' },
    { role: 'unrecognised-role', classification: 'diagnostic' },
    { role: null, classification: 'unknown' },
  ])('never substitutes a $classification primary with role $role', async ({ role, classification }) => {
    if (classification === 'diagnostic') vi.mocked(lookupSidecar).mockReturnValue({ ...sidecar, showWhen: 'always' });
    if (classification === 'unknown') vi.mocked(lookupSidecar).mockReturnValue(undefined);
    expect(await resolveImageAlternatives({ ...identity, imageRole: role }, primary, null, 'copyright-required')).toEqual([]);
    expect(signFigureUrl).not.toHaveBeenCalled();
  });

  it('filters withdrawn, unknown, traversal and duplicate candidates without disturbing valid choices', async () => {
    vi.mocked(getOriginalImageAlternatives).mockReturnValue([
      entry(), entry(), entry(primary, 'neonatal-scalp-comparison'), entry(primary, 'not-reviewed'),
      entry(primary, '../restricted/existing'),
    ]);
    expect(await resolveImageAlternatives(identity, primary, null)).toHaveLength(1);
    expect(signFigureUrl).not.toHaveBeenCalled();
    vi.mocked(getOriginalImageAlternatives).mockReturnValue([entry(originalKey)]);
    expect(await resolveImageAlternatives(identity, originalKey, null)).toEqual([]);
  });

  it('returns no choices for unmapped identities without inspecting the primary', async () => {
    vi.mocked(getOriginalImageAlternatives).mockReturnValue([]);
    expect(await resolveImageAlternatives({ type: 'question', id: 'unmapped' }, primary, null)).toEqual([]);
    expect(getOriginalImageAlternatives).toHaveBeenCalledWith({ type: 'question', id: 'unmapped' });
    expect(lookupSidecar).not.toHaveBeenCalled();
  });

  it('fails optional enrichment closed when registry or metadata lookup fails', async () => {
    vi.mocked(getOriginalImageAlternatives).mockImplementation(() => { throw new Error('Unavailable registry'); });
    expect(await resolveImageAlternatives(identity, primary, null)).toEqual([]);
    vi.mocked(getOriginalImageAlternatives).mockReturnValue([entry()]);
    vi.mocked(lookupSidecar).mockImplementation(() => { throw new Error('Unavailable metadata'); });
    expect(await resolveImageAlternatives(identity, primary, null)).toEqual([]);
  });

  it.each(['front', 'back', 'context'] as const)('rejects a changed %s even when the primary key is unchanged', async field => {
    expect(await resolveImageAlternatives({ ...identity, [field]: 'Changed teaching content' }, primary, null)).toEqual([]);
  });

  it('requires the current teaching body and a matching reviewed question answer', async () => {
    expect(await resolveImageAlternatives({ type: 'card', id: identity.id }, primary, null)).toEqual([]);
    const question = { type: 'question' as const, id: 'reviewed-question', stem: 'Reviewed stem',
      options: [{ text: 'Reviewed correct answer', isCorrect: true }, { text: 'Distractor', isCorrect: false }],
      context: 'Reviewed explanation' };
    vi.mocked(getOriginalImageAlternatives).mockReturnValue([{
      ...entry(), teachingFingerprint: imageAlternativeTeachingFingerprint(question)!,
    }]);
    expect(await resolveImageAlternatives(question, primary, null)).toHaveLength(1);
    expect(await resolveImageAlternatives({ ...question, options: [
      { text: 'New answer', isCorrect: true }, { text: 'Reviewed correct answer', isCorrect: false },
    ] }, primary, null)).toEqual([]);
  });
});
