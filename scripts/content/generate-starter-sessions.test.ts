/**
 * Tests for the starter-sessions generator helpers.
 *
 * The generator runs at build time and writes src/lib/generated/starter-sessions.ts,
 * which the tryStarterSession path serves to brand-new users (zero history).
 * Since that artifact bypasses the live scheduler, the generator must apply
 * the same sibling-suppression discipline (one card per variantGroupId).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { suppressSiblingsInStarterCards, type StarterItem } from './generate-starter-sessions';

function makeCard(
  id: string,
  variantGroupId: string | null = null
): StarterItem {
  return {
    type: 'card',
    id,
    front: `Front ${id}`,
    back: 'answer',
    rotation: 'test-rotation',
    week: 1,
    variantGroupId,
  };
}

describe('suppressSiblingsInStarterCards', () => {
  it('does not include two cards with the same variantGroupId in a single starter session', () => {
    const cards = [
      makeCard('a', 'g1'),
      makeCard('b', 'g1'), // sibling of a — should be dropped
      makeCard('c', null),
      makeCard('d', 'g2'),
    ];

    const result = suppressSiblingsInStarterCards(cards);

    const groupsSeen = new Set<string>();
    for (const card of result) {
      if (card.variantGroupId) {
        expect(groupsSeen.has(card.variantGroupId)).toBe(false);
        groupsSeen.add(card.variantGroupId);
      }
    }
    // Solo + group representatives only
    expect(result.map((c) => c.id)).toEqual(['a', 'c', 'd']);
  });

  it('passes through cards with no variantGroupId unchanged', () => {
    const cards = [makeCard('a'), makeCard('b'), makeCard('c')];
    const result = suppressSiblingsInStarterCards(cards);
    expect(result).toEqual(cards);
  });

  it('preserves first-occurrence order across many siblings', () => {
    // Three siblings of g1; only the first should win.
    const cards = [
      makeCard('first', 'g1'),
      makeCard('skip-1', 'g1'),
      makeCard('solo', null),
      makeCard('skip-2', 'g1'),
    ];
    const result = suppressSiblingsInStarterCards(cards);
    expect(result.map((c) => c.id)).toEqual(['first', 'solo']);
  });

  it('handles an empty input', () => {
    expect(suppressSiblingsInStarterCards([])).toEqual([]);
  });
});

describe('starter-session public-USMLE boundary', () => {
  it('selects and forwards Question.imageRole into generated starter items', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'generate-starter-sessions.ts'),
      'utf8',
    );
    const questionSelect = source.match(/prisma\.question\.findMany\([\s\S]*?select:\s*\{[\s\S]*?\}\s*,?\s*\}\)/)?.[0] ?? '';
    expect(questionSelect).toContain('imageRole: true');
    expect(source).toMatch(/imageRole:\s*medium\.imageRole\s*\?\?\s*null/);
  });

  it('filters generated raw questions by both primary rotation and cross-list membership', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'generate-starter-sessions.ts'),
      'utf8',
    );

    expect(source).toContain('withoutRawPublicUsmleQuestions');
    expect(source).toMatch(
      /withoutRawPublicUsmleQuestions\(\s*withDefaultQuestionServingPolicy\(/,
    );
  });

  it('revalidates derived cards through stableId parent lineage before artifact emission', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'generate-starter-sessions.ts'),
      'utf8',
    );

    expect(source).toContain('withoutRawPublicUsmleReinforcementCards');
    expect(source).toMatch(
      /filterDeliverableReinforcementCardRows\(\[card\],\s*\{[\s\S]*?client:\s*prisma,[\s\S]*?generated-starter-session/,
    );
  });
});


describe('curated starter generator path', () => {
  it('uses one shared, live CAH card query and preserves reviewed card order without random questions', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'generate-starter-sessions.ts'),
      'utf8',
    );
    const curatedBlock = source.slice(source.indexOf('const curatedEntries'), source.indexOf('// Load top concepts by exam weight'));
    expect(curatedBlock).toContain('prisma.card.findMany');
    expect(curatedBlock).toContain('ownerUserId: null');
    expect(curatedBlock).toContain('scopedCardWhere(SHARED_CATALOG_CARD_SCOPE');
    expect(curatedBlock).toContain('deletedAt: null');
    expect(curatedBlock).toContain('shelvedAt: null');
    expect(curatedBlock).toContain('withoutRawPublicUsmleReinforcementCards');
    expect(curatedBlock).toContain('resolveCuratedStarterRows');
    expect(curatedBlock).toContain('questions: 0');
    expect(curatedBlock).not.toContain('prisma.question');
    expect(curatedBlock).not.toContain('shuffle(');
  });

  it('retains the complete card/image provenance fields in curated starter output', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, 'generate-starter-sessions.ts'),
      'utf8',
    );
    const curatedBlock = source.slice(source.indexOf('const curatedEntries'), source.indexOf('// Load top concepts by exam weight'));
    for (const field of ['front', 'back', 'context', 'sourceComponent', 'imageUrl', 'imageCaption', 'imageRole', 'rotation', 'week', 'complexity', 'topics', 'difficulty', 'variantGroupId', 'variantIndex', 'variantType']) {
      expect(curatedBlock).toContain(`${field}: row.${field}`);
    }
    expect(curatedBlock).toContain('backs: (row.backs as string[] | null)');
    expect(curatedBlock).toContain('crosslinks: row.crosslinks ?? null');
    expect(curatedBlock).toContain('evidenceUrls: entry.evidenceUrls');
  });
});
