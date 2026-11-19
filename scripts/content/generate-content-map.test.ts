import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  assertGeneratedContentIsUsable,
  buildRotationSlugMap,
  contentMapDatabaseFailureAction,
  EXCLUDED_FROM_MAP,
  resolveGeneratedContentMode,
  toRotationSlug,
  writeGeneratedContentMapFromRows,
} from './generate-content-map';

describe('generated-content build modes', () => {
  it('uses a deterministic, database-free contract for ordinary code builds', () => {
    expect(resolveGeneratedContentMode({ MD3_GENERATED_CONTENT_MODE: 'offline' })).toEqual({
      name: 'offline',
      readDatabase: false,
      failOnDatabaseError: false,
      requireData: false,
      generatedAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('makes release generation database-backed and fail-closed', () => {
    const mode = resolveGeneratedContentMode({ MD3_GENERATED_CONTENT_MODE: 'release' });

    expect(mode.readDatabase).toBe(true);
    expect(mode.failOnDatabaseError).toBe(true);
    expect(mode.requireData).toBe(true);
    expect(() => assertGeneratedContentIsUsable(mode, 'content map', 0)).toThrow(
      /release mode requires non-empty content map/i,
    );
    expect(() => assertGeneratedContentIsUsable(mode, 'content map', 1)).not.toThrow();
  });

  it('never retains stale answer-bearing artifacts after a database failure', () => {
    expect(contentMapDatabaseFailureAction(
      resolveGeneratedContentMode({ MD3_GENERATED_CONTENT_MODE: 'release' }),
    )).toBe('throw');
    expect(contentMapDatabaseFailureAction(resolveGeneratedContentMode({}))).toBe('write-empty');
  });

  it('preserves the legacy direct-generator flags when no build mode is explicit', () => {
    expect(resolveGeneratedContentMode({})).toMatchObject({
      name: 'database',
      readDatabase: true,
      failOnDatabaseError: false,
      requireData: false,
    });
    expect(resolveGeneratedContentMode({ CONTENT_MAP_STRICT: '1' })).toMatchObject({
      name: 'database',
      failOnDatabaseError: true,
    });
    expect(resolveGeneratedContentMode({ CONTENT_MAP_REQUIRE_DATA: '1' })).toMatchObject({
      name: 'database',
      requireData: true,
    });
    expect(
      resolveGeneratedContentMode(
        { CONTENT_MAP_STRICT: '1', CONTENT_MAP_REQUIRE_DATA: '1' },
        { legacyContentMapFlags: false },
      ),
    ).toMatchObject({
      name: 'database',
      failOnDatabaseError: false,
      requireData: false,
    });
  });

  it('rejects misspelled modes instead of falling back to a permissive build', () => {
    expect(() => resolveGeneratedContentMode({ MD3_GENERATED_CONTENT_MODE: 'relese' })).toThrow(
      /MD3_GENERATED_CONTENT_MODE/i,
    );
  });

  it('routes code, CI, and deploy builds through their explicit safety contracts', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const vercel = JSON.parse(fs.readFileSync(path.resolve('vercel.json'), 'utf8')) as {
      buildCommand: string;
    };
    const completeWorkflowPath = path.resolve('.github/workflows/local-ci-full.yml');
    const workflow = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8')
      + (fs.existsSync(completeWorkflowPath) ? fs.readFileSync(completeWorkflowPath, 'utf8') : '');
    const internalReleaseScriptPath = path.resolve('scripts/ops/release-green-commit.mjs');
    const internalReleaseScript = fs.existsSync(internalReleaseScriptPath)
      ? fs.readFileSync(internalReleaseScriptPath, 'utf8')
      : null;

    expect(packageJson.scripts.build).toContain('MD3_GENERATED_CONTENT_MODE=offline');
    expect(packageJson.scripts['build:release']).toContain('MD3_GENERATED_CONTENT_MODE=release');
    expect(packageJson.scripts['build:release']).toContain(
      'npm run usmle:corpus:release-gate',
    );
    expect(packageJson.scripts['build:isolated:release']).toContain(
      'MD3_GENERATED_CONTENT_MODE=release',
    );
    expect(packageJson.scripts['build:isolated:release']).toContain(
      'npm run usmle:corpus:release-gate',
    );
    // Only md3 deploys from this repo, so the shared buildCommand is the release
    // build again. The profile wrapper existed for the CRS4 presentation project,
    // which moved to its own repo on 2026-09-04.
    expect(vercel.buildCommand).toBe('npm run build:release');
    expect(fs.existsSync(path.resolve('scripts/ops/vercel-build.sh'))).toBe(false);
    expect(workflow).toMatch(/MD3_GENERATED_CONTENT_MODE:\s*['"]?offline['"]?/);
    expect(workflow).toContain('run: npm run usmle:corpus:release-gate');
    expect(workflow).not.toContain('CONTENT_MAP_STRICT');
    // The private operator-only release helper is intentionally absent from
    // the FOSS artifact. Assert its contract when present in the source repo;
    // the public package/workflow/vercel contracts above remain unconditional.
    if (internalReleaseScript !== null) {
      expect(internalReleaseScript).toContain("MD3_GENERATED_CONTENT_MODE: 'release'");
      expect(internalReleaseScript).toContain(
        "runDbStep('npm', ['run', 'build:release'], { env: productionDbEnv })",
      );
    }
  });
});

describe('rotations kept out of md3\'s content map', () => {
  it('keeps shared recall on its due-checked delivery path rather than an ordinary rotation shard', () => {
    expect(EXCLUDED_FROM_MAP).toContain('universal-core');
  });
  it('never inlines the Cohort mirror: its rows are copies of md3 questions served only on cohort.md', () => {
    expect(EXCLUDED_FROM_MAP).toContain('cohort-open');
  });
});

describe('rotation-counts generation', () => {
  beforeAll(async () => {
    const generatedIndex = path.resolve('src/lib/generated/content-map-rotations/index.ts');
    if (!fs.existsSync(generatedIndex)) {
      const mode = resolveGeneratedContentMode({ MD3_GENERATED_CONTENT_MODE: 'offline' });
      await writeGeneratedContentMapFromRows({
        cards: [],
        questions: [],
        mode,
        generatedAt: mode.generatedAt ?? '1970-01-01T00:00:00.000Z',
      });
    }
  });

  it('normalizes rotation names into filesystem-safe slugs', () => {
    expect(toRotationSlug('Critical Care')).toBe('critical_care');
    expect(toRotationSlug('USMLE-Cardio')).toBe('usmle-cardio');
    expect(toRotationSlug('PAAM/Week 1')).toBe('paam_week_1');
  });

  it('throws on slug collisions across different rotations', () => {
    expect(() => buildRotationSlugMap(['Critical Care', 'Critical@Care'])).toThrow(
      /Rotation slug collision/,
    );
  });

  it('exports ROTATION_COUNTS as a Record<string, number>', async () => {
    const { ROTATION_COUNTS } = await import('../../src/lib/generated/rotation-counts');
    expect(typeof ROTATION_COUNTS).toBe('object');
    const keys = Object.keys(ROTATION_COUNTS);
    // CI generates empty maps (no DB) — only assert structure when data exists
    if (keys.length > 0) {
      for (const value of Object.values(ROTATION_COUNTS)) {
        expect(typeof value).toBe('number');
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  it('threads imageCaption through both StaticCard and StaticQuestion at every step of the script', () => {
    // Read the generator source itself rather than the generated artifact.
    // src/lib/generated/ is gitignored, so an artifact-based test silently
    // passes in any environment where the file is missing or stale. The
    // script source is the actual contract, so assert against it directly.
    const scriptPath = path.resolve(__dirname, 'generate-content-map.ts');
    const src = fs.readFileSync(scriptPath, 'utf8');

    const cardInterface = src.match(/interface StaticCard \{[\s\S]*?\}/)?.[0] ?? '';
    const questionInterface = src.match(/interface StaticQuestion \{[\s\S]*?\}/)?.[0] ?? '';
    expect(cardInterface).toMatch(/imageCaption:/);
    expect(questionInterface).toMatch(/imageCaption:/);

    const rowCacheSrc = fs.readFileSync(path.resolve(__dirname, 'content-map-row-cache.ts'), 'utf8');
    const selectBlocks = rowCacheSrc.match(/FIND_MANY_SELECT = \{[\s\S]*?\} as const;/g) ?? [];
    const mediaSelects = selectBlocks.filter((s) => s.includes('imageUrl: true'));
    expect(mediaSelects.length).toBeGreaterThanOrEqual(2);
    for (const block of mediaSelects) {
      expect(block).toContain('imageCaption: true');
    }

    // Normalize blocks for cards and questions both forward imageCaption.
    expect(src).toMatch(/imageCaption:\s*card\.imageCaption\s*\?\?\s*null/);
    expect(src).toMatch(/imageCaption:\s*question\.imageCaption\s*\?\?\s*null/);

    // Emitted type definitions include imageCaption for both interfaces.
    const emittedImageCaption = src.match(/typeLines\.push\(['"]\s*imageCaption: string \| null;['"]\)/g) ?? [];
    expect(emittedImageCaption.length).toBe(2);
  });

  it('serializes the two large database reads for the one-connection release transport', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'generate-content-map.ts'), 'utf8');
    const cardRead = src.indexOf('cards = await loadContentMapCardRows<StaticCard>(prisma, EXCLUDED_FROM_MAP);');
    const questionRead = src.indexOf(
      'questions = await loadContentMapQuestionRows<StaticQuestion>(prisma, EXCLUDED_FROM_MAP);',
    );

    expect(cardRead).toBeGreaterThan(0);
    expect(questionRead).toBeGreaterThan(cardRead);
    expect(src.slice(cardRead, questionRead)).not.toContain('Promise.all');
  });

  it('threads imageRole through both card and question generated contracts', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'generate-content-map.ts'), 'utf8');
    const cardInterface = src.match(/interface StaticCard \{[\s\S]*?\}/)?.[0] ?? '';
    const questionInterface = src.match(/interface StaticQuestion \{[\s\S]*?\}/)?.[0] ?? '';
    expect(cardInterface).toMatch(/imageRole:/);
    expect(questionInterface).toMatch(/imageRole:/);

    const rowCacheSrc = fs.readFileSync(path.resolve(__dirname, 'content-map-row-cache.ts'), 'utf8');
    const selectBlocks = rowCacheSrc.match(/FIND_MANY_SELECT = \{[\s\S]*?\} as const;/g) ?? [];
    const mediaSelects = selectBlocks.filter((block) => block.includes('imageUrl: true'));
    expect(mediaSelects.length).toBeGreaterThanOrEqual(2);
    for (const block of mediaSelects) expect(block).toContain('imageRole: true');

    expect(src).toMatch(/imageRole:\s*card\.imageRole\s*\?\?\s*null/);
    expect(src).toMatch(/imageRole:\s*question\.imageRole\s*\?\?\s*null/);
    const emitted = src.match(/typeLines\.push\(['"]\s*imageRole: string \| null;['"]\)/g) ?? [];
    expect(emitted).toHaveLength(2);
  });

  it('threads clinical question type, format, and variant family into the static fast-path contract', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'generate-content-map.ts'), 'utf8');
    const questionInterface = src.match(/interface StaticQuestion \{[\s\S]*?\}/)?.[0] ?? '';
    expect(questionInterface).toMatch(/questionType:/);
    expect(questionInterface).toMatch(/format:/);
    expect(questionInterface).toMatch(/variantGroupId:/);
    expect(questionInterface).toMatch(/variantType:/);

    const rowCacheSrc = fs.readFileSync(path.resolve(__dirname, 'content-map-row-cache.ts'), 'utf8');
    const questionSelect = rowCacheSrc.match(/CONTENT_MAP_QUESTION_FIND_MANY_SELECT = \{[\s\S]*?\} as const;/)?.[0];
    expect(questionSelect, 'question prisma select block').toBeDefined();
    expect(questionSelect).toContain('questionType: true');
    expect(questionSelect).toContain('format: true');
    expect(questionSelect).toContain('variantGroupId: true');
    expect(questionSelect).toContain('variantType: true');

    expect(src).toMatch(/questionType:\s*question\.questionType/);
    expect(src).toMatch(/format:\s*question\.format\s*\?\?\s*null/);
    expect(src).toMatch(/variantGroupId:\s*question\.variantGroupId\s*\?\?\s*null/);
    expect(src).toMatch(/variantType:\s*question\.variantType\s*\?\?\s*null/);
    expect(src).toMatch(/typeLines\.push\(['"]\s*questionType: string;['"]\)/);
    expect(src).toMatch(/typeLines\.push\(['"]\s*format: string \| null;['"]\)/);
    expect(src).toMatch(/typeLines\.push\(['"]\s*variantGroupId: string \| null;['"]\)/);
    expect(src).toMatch(/typeLines\.push\(['"]\s*variantType: string \| null;['"]\)/);
  });

  it('threads cloze variant fields (variantGroupId/variantIndex/variantType) through StaticCard at every step of the script', () => {
    // Same pattern as the imageCaption test above: assert the script source
    // (the contract) carries the variant fields end-to-end. Generated
    // artifacts are gitignored, so artifact-based assertions are unreliable.
    const scriptPath = path.resolve(__dirname, 'generate-content-map.ts');
    const src = fs.readFileSync(scriptPath, 'utf8');

    // The internal StaticCard interface declares all three variant fields.
    const cardInterface = src.match(/interface StaticCard \{[\s\S]*?\}/)?.[0] ?? '';
    expect(cardInterface).toMatch(/variantGroupId:/);
    expect(cardInterface).toMatch(/variantIndex:/);
    expect(cardInterface).toMatch(/variantType:/);

    // The Card prisma select requests all three fields.
    const rowCacheSrc = fs.readFileSync(path.resolve(__dirname, 'content-map-row-cache.ts'), 'utf8');
    const cardSelect = rowCacheSrc.match(/CONTENT_MAP_CARD_FIND_MANY_SELECT = \{[\s\S]*?\} as const;/)?.[0];
    expect(cardSelect, 'card prisma select block').toBeDefined();
    expect(cardSelect).toContain('variantGroupId: true');
    expect(cardSelect).toContain('variantIndex: true');
    expect(cardSelect).toContain('variantType: true');

    // Normalize block forwards each variant field with `?? null`.
    expect(src).toMatch(/variantGroupId:\s*card\.variantGroupId\s*\?\?\s*null/);
    expect(src).toMatch(/variantIndex:\s*card\.variantIndex\s*\?\?\s*null/);
    expect(src).toMatch(/variantType:\s*card\.variantType\s*\?\?\s*null/);

    // Emitted StaticCard type carries all three fields.
    expect(src).toMatch(/typeLines\.push\(['"]\s*variantGroupId: string \| null;['"]\)/);
    expect(src).toMatch(/typeLines\.push\(['"]\s*variantIndex: number \| null;['"]\)/);
    expect(src).toMatch(/typeLines\.push\(['"]\s*variantType: string \| null;['"]\)/);
  });

  it('carries sourceFile into the shards only for decks with a strand mix', () => {
    // The instant lane tells a strand-mixed deck's strands apart by source file
    // (src/lib/study/deck-strand-mix.ts) and must not query for it. Every other
    // rotation stays as it was, so the shards do not grow for no reader.
    const src = fs.readFileSync(path.resolve(__dirname, 'generate-content-map.ts'), 'utf8');
    expect(src).toMatch(/deckStrandMixFor\(card\.rotation\)\s*\?\s*\{\s*sourceFile:\s*card\.sourceFile\s*\?\?\s*null\s*\}\s*:\s*\{\}/);
    expect(src).toMatch(/deckStrandMixFor\(question\.rotation\)\s*\?\s*\{\s*sourceFile:\s*question\.sourceFile\s*\?\?\s*null\s*\}\s*:\s*\{\}/);
    expect(src.match(/typeLines\.push\(['"]\s*sourceFile\?: string \| null;['"]\)/g) ?? []).toHaveLength(2);
  });

  it('keeps raw public-USMLE questions out of generated legacy content maps', () => {
    const rowCachePath = path.resolve(__dirname, 'content-map-row-cache.ts');
    const rowCacheSrc = fs.readFileSync(rowCachePath, 'utf8');
    const generatorSrc = fs.readFileSync(path.resolve(__dirname, 'generate-content-map.ts'), 'utf8');

    expect(rowCacheSrc).toContain('withoutRawPublicUsmleQuestions');
    expect(rowCacheSrc).toMatch(
      /withoutRawPublicUsmleQuestions\(\{[\s\S]*?excluded:\s*false[\s\S]*?rotation:\s*\{\s*notIn:\s*\[\.\.\.excludedRotations\]\s*\}/,
    );
    const questionInterface = generatorSrc.match(/interface StaticQuestion \{[\s\S]*?\}/)?.[0] ?? '';
    expect(questionInterface).toMatch(/moduleNodes:/);
    expect(rowCacheSrc).toMatch(/moduleNodes:\s*true/);
    expect(generatorSrc).toMatch(/moduleNodes:\s*question\.moduleNodes\s*\?\?\s*\[\]/);
    expect(generatorSrc).toMatch(/typeLines\.push\(['"]\s*moduleNodes: string\[\];['"]\)/);
  });

  it('keeps public-USMLE question-reinforcement cards out of generated legacy maps', () => {
    const rowCachePath = path.resolve(__dirname, 'content-map-row-cache.ts');
    const rowCacheSrc = fs.readFileSync(rowCachePath, 'utf8');
    const generatorSrc = fs.readFileSync(path.resolve(__dirname, 'generate-content-map.ts'), 'utf8');

    expect(rowCacheSrc).toContain('withoutRawPublicUsmleReinforcementCards');
    expect(rowCacheSrc).toMatch(
      /withoutRawPublicUsmleReinforcementCards\(\{[\s\S]*?deletedAt:\s*null[\s\S]*?rotation:\s*\{\s*notIn:\s*\[\.\.\.excludedRotations\]\s*\}/,
    );
    expect(generatorSrc).toMatch(
      /cards\s*=\s*await filterDeliverableReinforcementCardRows\(cards,\s*\{[\s\S]*?client:\s*prisma,[\s\S]*?transport:\s*'generated-content-map'/,
    );
  });

  it('writes each rotation shard as JavaScript data with a declaration beside it', () => {
    // As .ts, the release shards (58 MB) put every card through the type
    // checker: a cold pass needed 5.5 GB of heap and the first build on the
    // 8 GB Standard machine sat in Next's TypeScript pass until Vercel stopped
    // it at 45 minutes (2026-10-03). TypeScript resolves `./<slug>` to the
    // .d.ts and never reads the data; webpack, vitest and tsx load the .js.
    // CI generates no shards (no database), so assert on the generator source.
    const scriptPath = path.resolve(__dirname, 'generate-content-map.ts');
    const src = fs.readFileSync(scriptPath, 'utf8');
    expect(src).toMatch(/path\.join\(rotationMapDir, `\$\{slug\}\.js`\)/);
    expect(src).toMatch(/path\.join\(rotationMapDir, `\$\{slug\}\.d\.ts`\)/);
    expect(src).not.toMatch(/path\.join\(rotationMapDir, `\$\{slug\}\.ts`\)/);
    expect(src).toContain('export declare const CARDS: Record<string, StaticCard>;');
    expect(src).toContain('export declare const QUESTIONS: Record<string, StaticQuestion>;');
  });

  it('exports rotation shard loaders for each available rotation', async () => {
    const { ROTATION_CONTENT_LOADERS, AVAILABLE_ROTATIONS } = await import(
      '../../src/lib/generated/content-map-rotations'
    );
    const keys = Object.keys(ROTATION_CONTENT_LOADERS);
    expect(keys.sort()).toEqual([...AVAILABLE_ROTATIONS].sort());

    // Spot-check one loader when data exists (CI has no DB so maps are empty).
    // Use the loader keys so the empty generated tuple in CI does not collapse
    // the indexed rotation type to `undefined`.
    const sampleRotation = keys[0];
    if (sampleRotation) {
      const sample = await ROTATION_CONTENT_LOADERS[sampleRotation]();
      expect(sample).toHaveProperty('cards');
      expect(sample).toHaveProperty('questions');
    }
    // In release mode the first shard is a ~16 MB generated module. Importing it
    // took over 15 s on a loaded laptop twice on 6 Nov 2026 (release attempts 4
    // and 10) and passes in ~3 s idle: a load budget, not a slow-code signal.
  }, 60_000);
});
