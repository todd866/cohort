import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cohortCardSeedRow, loadCohortModuleCardsFromDisk } from './cohort-card-corpus';
import { buildCardArtifacts, toPublicCard } from './cohort-mirror-cards';
import type { GeneratedCard } from '@/lib/card-generator';

const card = (n: number, discipline: 'paeds' | 'resp' = 'paeds') => toPublicCard(
  {
    cardType: 'cloze', rotation: 'cah', week: null, sourceComponent: 'KeyPoint', topics: [], complexity: 2,
    front: `Fact number ${n} is [___].`, back: `answer${n}`, context: `Why fact ${n} matters.`,
    stableId: `mdx:${String(n).padStart(32, '0')}`,
  } as GeneratedCard & { stableId: string },
  discipline,
  { isOpenFigure: () => false },
);

function writeRoot(cards = [card(1), card(2), card(3, 'resp')]): string {
  const root = mkdtempSync(join(tmpdir(), 'cohort-cards-'));
  const built = buildCardArtifacts(cards);
  for (const [path, shard] of built.files) {
    const abs = join(root, path.replace('open-content/modules/', ''));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, JSON.stringify(shard));
  }
  writeFileSync(join(root, 'cards-release-v1.json'), JSON.stringify(built.release));
  return root;
}

const firstShard = (root: string) => {
  const built = buildCardArtifacts([card(1), card(2), card(3, 'resp')]);
  const path = [...built.files.keys()][0].replace('open-content/modules/', '');
  return join(root, path);
};

describe('loadCohortModuleCardsFromDisk', () => {
  it('loads every released card from a clean root', () => {
    const loaded = loadCohortModuleCardsFromDisk({ moduleRoot: writeRoot() });
    expect(loaded.errors).toEqual([]);
    expect(loaded.cards.map((c) => c.card.id).sort()).toEqual([card(1), card(2), card(3, 'resp')].map((c) => c.id).sort());
  });

  it('refuses a card whose text was edited after the release', () => {
    const root = writeRoot();
    const path = firstShard(root);
    const shard = JSON.parse(readFileSync(path, 'utf8'));
    shard.cards[0].back = 'edited';
    writeFileSync(path, JSON.stringify(shard));
    const loaded = loadCohortModuleCardsFromDisk({ moduleRoot: root });
    expect(loaded.cards).toEqual([]);
    expect(loaded.errors.join()).toMatch(/fingerprint/);
  });

  it('refuses a hand-dropped card, an extra field and a leak', () => {
    const root = writeRoot();
    const path = firstShard(root);
    const shard = JSON.parse(readFileSync(path, 'utf8'));
    shard.cards.push({ ...shard.cards[0], id: 'cohort:paeds:c-ffffffffffff:v1' });
    shard.cards[0].topics = ['Week 3'];
    shard.cards[1].context = 'A PWH week 2 favourite.';
    writeFileSync(path, JSON.stringify(shard));
    const errors = loadCohortModuleCardsFromDisk({ moduleRoot: root }).errors.join('\n');
    expect(errors).toMatch(/not in the release/);
    expect(errors).toMatch(/unexpected field topics/);
    expect(errors).toMatch(/leak/);
  });

  it('refuses a released card whose file is missing', () => {
    const root = writeRoot();
    const release = JSON.parse(readFileSync(join(root, 'cards-release-v1.json'), 'utf8'));
    release.cardIds.push('cohort:paeds:c-eeeeeeeeeeee:v1');
    writeFileSync(join(root, 'cards-release-v1.json'), JSON.stringify(release));
    expect(loadCohortModuleCardsFromDisk({ moduleRoot: root }).errors.join()).toMatch(/file is missing/);
  });
});

describe('cohortCardSeedRow', () => {
  it('seeds a cohort-open row keyed by the public id, with no rotation, week, topics or cluster from md3', () => {
    const row = cohortCardSeedRow(card(1), 'open-content/modules/cards/paeds/0.json');
    expect(row).toMatchObject({
      stableId: card(1).id,
      rotation: 'cohort-open',
      week: null,
      topics: [],
      clusterId: null,
      moduleNodes: ['cohort/paeds'],
      sourceFile: 'open-content/modules/cards/paeds/0.json',
      cardType: 'cloze',
    });
  });
});

describe('the committed Cohort card release', () => {
  it('loads with no errors, every released card present', () => {
    const loaded = loadCohortModuleCardsFromDisk();
    expect(loaded.errors).toEqual([]);
    const release = JSON.parse(readFileSync(join(process.cwd(), 'open-content/modules/cards-release-v1.json'), 'utf8'));
    expect(loaded.cards.length).toBe(release.cardIds.length);
  });
});
