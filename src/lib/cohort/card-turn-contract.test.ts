import { describe, expect, it } from 'vitest';

import { isCohortCardSessionItem, parseCohortCardSessionItem, parseCohortChallengeExhaustion } from './card-turn-contract';

const item = {
  deliveryId: 'd1',
  kind: 'card',
  front: 'The first-line treatment for croup is oral [___].',
  back: 'dexamethasone',
  context: 'A single dose reduces return visits.',
  domain: 'Paediatrics',
  attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
};
const media = {
  figureId: 'abducens-local' as const,
  target: 'lateral-rectus' as const,
  role: 'prompt' as const,
  preAnswerAlt: 'A simplified ocular motor diagram.',
  postAnswerAlt: 'A simplified diagram showing the sixth nerve and lateral rectus.',
};

describe('parseCohortCardSessionItem', () => {
  it('accepts the exact card item shape', () => {
    expect(parseCohortCardSessionItem(item)).toEqual(item);
    expect(parseCohortCardSessionItem({ ...item, context: null })).not.toBeNull();
  });

  it('refuses extra or missing keys, a front without exactly one blank, and an empty answer', () => {
    expect(parseCohortCardSessionItem({ ...item, cardId: 'x' })).toBeNull();
    const { back: _back, ...noBack } = item;
    expect(parseCohortCardSessionItem(noBack)).toBeNull();
    expect(parseCohortCardSessionItem({ ...item, front: 'No blank.' })).toBeNull();
    expect(parseCohortCardSessionItem({ ...item, front: '[___] and [___]' })).toBeNull();
    expect(parseCohortCardSessionItem({ ...item, back: ' ' })).toBeNull();
    expect(parseCohortCardSessionItem({ ...item, kind: 'question' })).toBeNull();
    expect(parseCohortCardSessionItem({ ...item, attribution: { text: 'x' } })).toBeNull();
    expect(parseCohortCardSessionItem({ ...item, media: { ...media, figureId: 'arbitrary-url' } })).toBeNull();
    const { target: _target, ...missingTarget } = media;
    expect(parseCohortCardSessionItem({ ...item, media: missingTarget })).toBeNull();
    expect(parseCohortCardSessionItem({ ...item, media: { ...media, target: 'unreviewed' } })).toBeNull();
    expect(parseCohortCardSessionItem({ ...item, media: { ...media, extra: 'leak' } })).toBeNull();
  });

  it('accepts a reviewed media descriptor while preserving the text-card shape', () => {
    expect(parseCohortCardSessionItem({ ...item, media })).toEqual({ ...item, media });
  });

  it('tells a card item from an MCQ item', () => {
    expect(isCohortCardSessionItem(item)).toBe(true);
    expect(isCohortCardSessionItem({ deliveryId: 'd', stem: 's', options: [] })).toBe(false);
  });
});

describe('parseCohortChallengeExhaustion', () => {
  const receipt = { level: 2, revision: 4, policy: 'review-challenge-v2' };
  it('accepts only a complete current policy receipt', () => {
    expect(parseCohortChallengeExhaustion(receipt)).toEqual(receipt);
    for (const malformed of [null, {}, { ...receipt, level: 1 }, { ...receipt, revision: -1 },
      { ...receipt, policy: 'review-challenge-v1' }, { ...receipt, topics: ['private-gap'] }]) {
      expect(parseCohortChallengeExhaustion(malformed)).toBeNull();
    }
  });
});
