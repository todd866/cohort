import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyCardReview,
  buildCardArtifacts,
  cardReviewWithholds,
  cardShardPath,
  cohortCardServingFingerprint,
  cohortCardServingRow,
  decideMirrorCard,
  factualStatusFor,
  publicCardContentHash,
  publicCardLeaks,
  toPublicCard,
  type MirrorCardDecisionInput,
  type CardReview,
  type CohortCardRelease,
  type CohortCardShard,
  type PublicMirrorCard,
} from './cohort-mirror-cards';
import { isOpenFigurePath } from '@/lib/figures/open-figure-access';
import type { GeneratedCard } from '@/lib/card-generator';

const baseCard = (over: Partial<GeneratedCard & { stableId: string }> = {}): GeneratedCard & { stableId: string } => ({
  cardType: 'cloze',
  rotation: 'cah',
  week: 3,
  sourceFile: 'week3-respiratory',
  sourceComponent: 'KeyPoint',
  front: 'The first-line treatment for croup is oral [___].',
  back: 'dexamethasone',
  context: 'A single dose reduces return visits and admission.',
  topics: ['Week 3 CSD', 'Respiratory'],
  complexity: 2,
  stableId: 'mdx:0123456789abcdef0123456789abcdef',
  ...over,
});

const input = (over: Partial<MirrorCardDecisionInput> = {}): MirrorCardDecisionInput => ({
  card: baseCard(),
  sourcePath: 'content/cah/week3-respiratory.mdx',
  frontmatterSource: null,
  folderDiscipline: null,
  qualityIssues: [],
  factual: 'clean',
  groundingQuote: null,
  isOpenFigure: () => false,
  ...over,
});

describe('decideMirrorCard', () => {
  it('publishes a rights-clean, audited, single-blank card under its discipline', () => {
    expect(decideMirrorCard(input())).toEqual({ publish: true, discipline: 'paeds', reasons: [] });
  });

  it('refuses imports by source path or frontmatter', () => {
    expect(decideMirrorCard(input({ sourcePath: 'content/cah/anki-imports-y3g/x.mdx' })).reasons.join()).toMatch(/^import/);
    expect(decideMirrorCard(input({ frontmatterSource: 'anki-cah' })).reasons.join()).toMatch(/^import/);
  });

  it('refuses USyd assessment rotations and assessment headings as rights exclusions', () => {
    expect(decideMirrorCard(input({ card: baseCard({ rotation: 'year2-kat5' }) })).reasons).toContain('USyd assessment material');
    expect(decideMirrorCard(input({ card: baseCard({ topics: ['KAT1 Practice Questions'] }) })).reasons).toContain('USyd assessment material');
  });

  it('withholds course markers, local logistics and course references in the text', () => {
    expect(decideMirrorCard(input({ card: baseCard({ context: 'Covered in the KAT 2 paper.' }) })).reasons.join()).toMatch(/USyd marker: kat/);
    expect(decideMirrorCard(input({ card: baseCard({ context: 'At Westmead the triage nurse calls the registrar.' }) })).reasons.join()).toMatch(/local hospital/);
    expect(decideMirrorCard(input({ card: baseCard({ context: 'As the lecture stressed, give it early.' }) })).reasons.join()).toMatch(/course reference/);
  });

  it('withholds personal assessment notes, which describe the learner rather than the medicine', () => {
    for (const note of ['Got this wrong on the quiz.', 'This was a 0.4/1 matching question.', 'The question asks about OUR patient.',
      'This is exactly what the quiz asks.', 'Half the marks in the Part A quiz are for naming the line.']) {
      expect(decideMirrorCard(input({ card: baseCard({ context: note }) })).reasons, note).toContain('personal assessment note');
    }
    expect(decideMirrorCard(input({ card: baseCard({ context: 'Tryptase timing matters most in the first hours.' }) })).publish).toBe(true);
  });

  it('withholds a broken HTML entity left by extraction, but not U&E', () => {
    expect(decideMirrorCard(input({ card: baseCard({ front: 'P/F [___] on FiO2 0.6.', back: '&lt' }) })).reasons).toContain('broken HTML entity');
    expect(decideMirrorCard(input({ card: baseCard({ front: 'Check U&E every [___] hours.', back: '24' }) })).publish).toBe(true);
  });

  it('withholds a factual defect and an unaudited wording', () => {
    expect(decideMirrorCard(input({ factual: 'defect' })).reasons).toContain('factual audit: confirmed defect');
    expect(decideMirrorCard(input({ factual: 'unaudited' })).reasons).toContain('factual audit: not audited at this wording');
  });

  it('withholds card-quality failures and anything but one blank', () => {
    expect(decideMirrorCard(input({ qualityIssues: ['Bad cloze span selection'] })).reasons.join()).toMatch(/card quality/);
    expect(decideMirrorCard(input({ card: baseCard({ front: 'No blank here.' }) })).reasons).toContain('not a single-blank cloze');
    expect(decideMirrorCard(input({ card: baseCard({ front: '[___] and [___]', backs: ['a', 'b'] }) })).reasons).toContain('not a single-blank cloze');
  });

  it('withholds an 8-word run copied from the grounded passage', () => {
    const quote = 'Guideline: the first-line treatment for croup is oral dexamethasone, given once.';
    expect(decideMirrorCard(input({ groundingQuote: quote })).reasons).toContain('verbatim 8-word run from the grounded passage');
    expect(decideMirrorCard(input({ groundingQuote: 'unrelated wording entirely about something else here today' })).publish).toBe(true);
  });

  it('drops a card whose image is the prompt unless the image is an open original', () => {
    const prompt = baseCard({ imageUrl: '/figures/restricted/x.jpg', imageRole: 'prompt', imageCaption: 'Look at the rash' });
    expect(decideMirrorCard(input({ card: prompt })).reasons).toContain('image is the prompt and not an open original');
    expect(decideMirrorCard(input({ card: prompt, isOpenFigure: () => true })).publish).toBe(true);
  });

  it('drops a card whose text points at a non-open image, but keeps one where the image is decoration', () => {
    const pointing = baseCard({ imageUrl: '/figures/cah/x.png', front: 'The rash shown in the image is [___].' });
    expect(decideMirrorCard(input({ card: pointing })).reasons).toContain('text refers to an image that cannot ship');
    expect(decideMirrorCard(input({ card: baseCard({ imageUrl: '/figures/cah/x.png' }) })).publish).toBe(true);
  });

  it('withholds video clips and cards with no discipline', () => {
    expect(decideMirrorCard(input({ card: baseCard({ clipSlug: 'lap-chole' }) })).reasons).toContain('carries a video clip');
    expect(decideMirrorCard(input({ card: baseCard({ rotation: 'usmle-step1' }) })).reasons).toContain('no discipline');
  });

  it('takes the discipline from the content/modules folder first', () => {
    expect(decideMirrorCard(input({ folderDiscipline: 'resp' })).discipline).toBe('resp');
  });
});

describe('factualStatusFor', () => {
  const isDefect = (row: { verdict: string; auDecision?: string }) => row.verdict === 'flagged' && row.auDecision !== 'keep';
  it('is unaudited with no ledger row at the current hash', () => {
    expect(factualStatusFor([], false, isDefect)).toBe('unaudited');
  });
  it('takes the latest verdict per model', () => {
    const rows = [
      { model: 'a', auditedAt: '2026-01-01', verdict: 'flagged' },
      { model: 'a', auditedAt: '2026-02-01', verdict: 'pass' },
    ];
    expect(factualStatusFor(rows, false, isDefect)).toBe('clean');
    expect(factualStatusFor([...rows, { model: 'b', auditedAt: '2026-01-15', verdict: 'flagged' }], false, isDefect)).toBe('defect');
  });
  it('treats a contradicting grounded citation as a defect unless a judge kept the card', () => {
    expect(factualStatusFor([{ model: 'a', auditedAt: '1', verdict: 'pass' }], true, isDefect)).toBe('defect');
    expect(factualStatusFor([{ model: 'a', auditedAt: '1', verdict: 'flagged', auDecision: 'keep' }], true, isDefect)).toBe('clean');
  });
});

describe('toPublicCard', () => {
  const pub = toPublicCard(baseCard({ variantGroupId: 'cah-croup-steroids', variantIndex: 1 }), 'paeds', { isOpenFigure: () => false });

  it('is keyed by an opaque hash of the md3 stableId and carries the stableId as origin', () => {
    expect(pub.id).toMatch(/^cohort:paeds:c-[0-9a-f]{12}:v1$/);
    expect(pub.origin).toBe('mdx:0123456789abcdef0123456789abcdef');
  });

  it('drops heading topics, rotation, week, cluster and the authored variant-group name', () => {
    const text = JSON.stringify(pub);
    expect(text).not.toMatch(/Week 3|week3|cah|cluster/i);
    expect(pub.variantGroup).toMatch(/^cohort:paeds:g-[0-9a-f]{12}$/);
  });

  it('keeps an image only when it is an open original', () => {
    const card = baseCard({ imageUrl: '/figures/originals/x.png', imageCaption: 'Barking cough' });
    expect(toPublicCard(card, 'paeds', { isOpenFigure: () => false }).imageUrl).toBeUndefined();
    expect(toPublicCard(card, 'paeds', { isOpenFigure: () => true })).toMatchObject({ imageUrl: '/figures/originals/x.png', imageCaption: 'Barking cough' });
  });

  it('hashes an origin that is not an opaque md3 stableId', () => {
    expect(toPublicCard(baseCard({ stableId: 'cah-handwritten-id' }), 'paeds', { isOpenFigure: () => false }).origin).toMatch(/^md3:[0-9a-f]{16}$/);
  });
});

describe('publicCardLeaks', () => {
  const clean = toPublicCard(baseCard(), 'paeds', { isOpenFigure: () => false });
  it('finds nothing in a clean card', () => {
    expect(publicCardLeaks(clean)).toEqual([]);
  });
  it('finds rotation codes, cluster ids, course markers and person data', () => {
    const leaky = (patch: Partial<PublicMirrorCard>) => publicCardLeaks({ ...clean, ...patch });
    expect(leaky({ context: 'See pwh-cluster-32.' })).not.toEqual([]);
    expect(leaky({ context: 'A PAAM favourite.' })).not.toEqual([]);
    expect(leaky({ context: 'Posted on Canvas.' })).not.toEqual([]);
    expect(leaky({ context: 'Email someone@example.com.' })).not.toEqual([]);
    expect(leaky({ context: 'Got this wrong on the quiz.' })).not.toEqual([]);
    expect(leaky({ id: 'cohort:cah:c-0123456789ab:v1' })).not.toEqual([]);
  });
});

describe('buildCardArtifacts', () => {
  const cards = ['a', 'b', 'c'].map((s, i) => toPublicCard(
    baseCard({ stableId: `mdx:${s.repeat(32)}`, front: `Answer ${i} is [___].`, back: `x${i}` }),
    i === 2 ? 'resp' : 'paeds',
    { isOpenFigure: () => false },
  ));

  it('shards by discipline and the first hex digit of the id, sorted, and lists every card in the release', () => {
    const built = buildCardArtifacts(cards);
    for (const [path, shard] of built.files) {
      expect(path).toBe(cardShardPath(shard.cards[0]));
      expect(shard.cards.map((c) => c.id)).toEqual([...shard.cards.map((c) => c.id)].sort());
    }
    expect(built.release.cardIds).toEqual(cards.map((c) => c.id).sort());
    expect(Object.keys(built.release.cardFingerprints).sort()).toEqual(built.release.cardIds);
  });

  it('is deterministic', () => {
    expect(JSON.stringify([...buildCardArtifacts(cards).files])).toBe(JSON.stringify([...buildCardArtifacts([...cards].reverse()).files]));
  });

  it('refuses a duplicate public id and a leaking card', () => {
    expect(() => buildCardArtifacts([cards[0], cards[0]])).toThrow(/duplicate/);
    expect(() => buildCardArtifacts([{ ...cards[0], context: 'PWH week 2 favourite' }])).toThrow(/leak/);
  });
});

describe('cohortCardServingFingerprint', () => {
  it('moves when anything a learner reads moves', () => {
    const row = {
      stableId: 'cohort:paeds:c-0123456789ab:v1', rotation: 'cohort-open', cardType: 'cloze',
      front: 'f [___]', back: 'b', context: 'c', imageUrl: null, imageCaption: null,
      moduleNodes: ['cohort/paeds'], variantGroupId: null, variantIndex: null,
    };
    const base = cohortCardServingFingerprint(row);
    expect(cohortCardServingFingerprint({ ...row })).toBe(base);
    expect(cohortCardServingFingerprint({ ...row, back: 'B' })).not.toBe(base);
    expect(cohortCardServingFingerprint({ ...row, context: 'd' })).not.toBe(base);
    expect(cohortCardServingFingerprint({ ...row, imageUrl: '/figures/x.png' })).not.toBe(base);
  });
});

describe('the committed Cohort card files', () => {
  const root = join(process.cwd(), 'open-content/modules');
  const shardPaths = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? shardPaths(join(dir, e.name)) : [join(dir, e.name)]));
  const paths = existsSync(join(root, 'cards')) ? shardPaths(join(root, 'cards')) : [];
  const shards = paths.map((p) => ({ path: relative(process.cwd(), p), shard: JSON.parse(readFileSync(p, 'utf8')) as CohortCardShard }));
  const cards = shards.flatMap((s) => s.shard.cards);
  const release = JSON.parse(readFileSync(join(root, 'cards-release-v1.json'), 'utf8')) as CohortCardRelease;

  const CARD_KEYS = new Set(['id', 'origin', 'discipline', 'cardType', 'sourceComponent', 'front', 'back', 'context',
    'complexity', 'importance', 'variantGroup', 'variantIndex', 'imageUrl', 'imageCaption', 'reference']);

  it('exist, and every card sits in the shard its id names', () => {
    expect(cards.length).toBeGreaterThan(0);
    for (const { path, shard } of shards) {
      expect(Object.keys(shard).sort()).toEqual(['attribution', 'cards', 'discipline', 'licence', 'schemaVersion']);
      expect(shard.licence).toBe('CC-BY-4.0');
      for (const card of shard.cards) {
        expect(cardShardPath(card)).toBe(path);
        expect(card.discipline).toBe(shard.discipline);
      }
    }
  });

  it('carry only public fields: no rotation, week, topics, cluster, source file or md3 id', () => {
    for (const card of cards) {
      for (const key of Object.keys(card)) expect(CARD_KEYS.has(key), `${card.id} has ${key}`).toBe(true);
    }
  });

  it('leak no rotation code, cluster id, course marker or email address', () => {
    const leaking = cards.map((card) => ({ id: card.id, leaks: publicCardLeaks(card) })).filter((c) => c.leaks.length > 0);
    expect(leaking).toEqual([]);
    for (const card of cards) {
      const metadata = [card.id, card.origin, card.discipline, card.variantGroup ?? '', card.sourceComponent].join(' ');
      expect(metadata).not.toMatch(/\b(?:cah|paam|pwh|toc|mnd|year3-common|critical-care|cluster)\b/i);
    }
  });

  it('ship only open-original images', () => {
    for (const card of cards) if (card.imageUrl) expect(isOpenFigurePath(card.imageUrl), card.id).toBe(true);
  });

  it('match the release exactly, fingerprints included', () => {
    expect(release.cardIds).toEqual(cards.map((c) => c.id).sort());
    for (const card of cards) {
      expect(release.cardFingerprints[card.id]).toBe(cohortCardServingFingerprint(cohortCardServingRow(card)));
    }
  });
});

describe('the independent review deny-list', () => {
  const pub = toPublicCard(baseCard(), 'paeds', { isOpenFigure: () => false });
  const entry = (over: Partial<CardReview> = {}): CardReview => ({
    verdict: 'needs-fix', contentHash: publicCardContentHash(pub), reviewer: 'r', reviewedAt: '2026-10-01', ...over,
  });

  it('withholds a card a reviewer found defective at its current wording', () => {
    expect(cardReviewWithholds(pub, { [pub.id]: entry() })).toBe(true);
  });

  it('lets the card through once its wording changes, or when the review passed, or when there is none', () => {
    expect(cardReviewWithholds({ ...pub, back: 'betamethasone' }, { [pub.id]: entry() })).toBe(false);
    expect(cardReviewWithholds(pub, { [pub.id]: entry({ verdict: 'passed' }) })).toBe(false);
    expect(cardReviewWithholds(pub, {})).toBe(false);
  });

  it('hashes everything a learner reads', () => {
    const base = publicCardContentHash(pub);
    expect(publicCardContentHash({ ...pub, context: 'other' })).not.toBe(base);
    expect(publicCardContentHash({ ...pub, reference: { title: 't', publisher: null, url: 'https://x' } })).not.toBe(base);
    expect(publicCardContentHash({ ...pub, complexity: 5 })).toBe(base);
  });
});

describe('applyCardReview', () => {
  const a = toPublicCard(baseCard(), 'paeds', { isOpenFigure: () => false });
  const b = toPublicCard(baseCard({ stableId: `mdx:${'b'.repeat(32)}`, back: 'budesonide' }), 'paeds', { isOpenFigure: () => false });
  const c = toPublicCard(baseCard({ stableId: `mdx:${'c'.repeat(32)}`, back: 'adrenaline' }), 'paeds', { isOpenFigure: () => false });

  it('records a needs-fix for each defect, a pass for each id read without one, and nothing for an unread id', () => {
    const ledger = applyCardReview({}, [a, b, c], {
      defects: [{ id: a.id, category: 'FACTUAL', detail: 'wrong dose' }],
      read: [a.id, b.id],
    }, { reviewer: 'grok', reviewedAt: '2026-10-01' });
    expect(ledger[a.id]).toMatchObject({ verdict: 'needs-fix', category: 'FACTUAL', detail: 'wrong dose', contentHash: publicCardContentHash(a) });
    expect(ledger[b.id]).toMatchObject({ verdict: 'passed', contentHash: publicCardContentHash(b) });
    expect(ledger[c.id]).toBeUndefined();
  });

  it('never lets a pass overwrite an outstanding needs-fix at the same wording', () => {
    const first = applyCardReview({}, [a], { defects: [{ id: a.id, category: 'CLOZE', detail: 'x' }], read: [a.id] }, { reviewer: 'r1', reviewedAt: '1' });
    const second = applyCardReview(first, [a], { defects: [], read: [a.id] }, { reviewer: 'r2', reviewedAt: '2' });
    expect(second[a.id].verdict).toBe('needs-fix');
  });

  it('ignores a defect for an id that is not a current public card', () => {
    expect(applyCardReview({}, [a], { defects: [{ id: 'cohort:paeds:c-000000000000:v1', category: 'X', detail: 'y' }], read: [] }, { reviewer: 'r', reviewedAt: '1' })).toEqual({});
  });
});
